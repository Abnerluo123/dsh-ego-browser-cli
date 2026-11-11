# dsh-ego-browser-cli

在 DSH 的 `workspace-write` 会话中使用完整官方 Ego Lite，无需为每次浏览器调用切换 Full access。

[English](README.md) · MIT

## 2.0 的权限范围

本插件面向作为 agent 专用浏览器的 Ego Lite。它给 `ego_browser` 工具和 `ego-browser` shell 命令提供专用的宿主执行入口，不扫描或改写官方脚本，不向 DSH 注册审批/权限钩子，不修改其它工具、文件策略或权限预设。

| 入口 | 行为 |
|---|---|
| `ego_browser` | 原样运行官方 `ego-browser nodejs` 脚本，不弹插件审批 |
| shell 中的 `ego-browser` | argv、stdin、cwd 转发给固定的官方可执行文件；所有 CLI 子命令透传 |
| 普通 DSH `pwsh` / 文件 / 其它工具 | 继续使用 DSH 原有沙箱及审批策略 |

**这里信任的是 Ego 的完整脚本运行环境。** 官方 `nodejs` 是真实的宿主 Node，包含模块导入、本地脚本、网络与文件能力；截图、上传和下载也能访问主机路径。插件不声称在同一个 Ego 脚本内隔离这些能力。全局 DSH 策略未被放宽，但 Ego 入口本身具有宿主能力；通用宿主任务应继续使用普通工具。

浏览器内部的用户接管、设备选择、网站授权提示仍由 Ego/网站处理。插件不会伪造用户同意，不自动抢回用户持有的任务空间。无人监管运行时应使用已配置好的专用 profile。

## 安装与更新

需要已安装并完成 onboarding 的 Ego Lite，以及可编辑的 DSH profile。

```powershell
git clone https://github.com/Abnerluo123/dsh-ego-browser-cli.git
cd dsh-ego-browser-cli
pwsh -File scripts/install.ps1
```

macOS/Linux 使用 `bash scripts/install.sh`。可选 `-Profile tui`、`-DshHome C:\path`，默认 desktop。安装脚本登记插件并备份 profile 的包配置；更新前另行保留旧插件副本以便回退。然后重启 DSH；支持实时插件管理的 DSH 也可通过插件管理器重装此本地 bundle。不要同时挂载两份插件。

插件不安装额外 skill，不修改官方 Ego skill。执行文件默认通过 Ego 的版本 junction、标准安装路径和 PATH 查找，升级 Ego 后通常无需改路径。

## 默认：官方脚本原样执行

`ego_browser` 接收 `description` 和 `script`。默认 `mode: "official"`，**不会预先创建任务空间，也不注入 task/page**。直接照官方 skill 编写：

```js
const task = await taskSpace("my-browser-goal");
const page = task.page("p1");
await page.goto("https://example.com");
console.log(JSON.stringify({ id: task.spaceId, title: await page.title() }));
await task.finish({ keep: [] });
```

只列 profile、查看 help、恢复接管或运行文件也不再受隐藏的任务空间创建影响：

```js
console.log(await profiles());
help("taskSpace");
```

```js
await import("file:///C:/automation/round-01.mjs");
```

- 每次调用是新 Node 进程，JavaScript 变量不会跨调用保留；任务空间可按官方方式续接。
- `console.log` 通常出现在 stderr；两路输出都会返回，stderr 本身不表示失败。
- 成功完成后默认 `await task.finish({ keep: [] })`。需要给用户留下结果才保留指定页面。
- 用户接管后按官方 skill 处理 handoff / takeover / claim；插件不会自动 claim。
- `timeoutMs` 默认 240000，支持 1 到 3600000。输出过长会明确标记截断。

## 可选：兼容短脚本

旧的 `await page.goto(...)` 短脚本应添加 `mode: "managed"`。此模式注入 `task` 和 `page`，并按 DSH 会话复用同名空间：

```json
{
  "description": "Open example page",
  "mode": "managed",
  "spaceName": "my-goal",
  "script": "await page.goto('https://example.com'); console.log(task.spaceId);"
}
```

`spaceId`、`spaceName` 或 `profileId` 参数在未写 mode 时也会启用 managed。`spaceId` 优先；`profileId` 仅用于新建空间，不能与 `spaceId` 同传。官方模式应在脚本里管理空间，不传这些选择参数。

managed 不会自动抢回交还用户的空间。若空间名已由用户持有，会保留官方错误；需要恢复该空间时使用官方模式调用官方控制 helper。推荐长流程使用官方模式，准确管理每个目标的生命周期。

## 多用户 profile

官方模式完整保留创建时的 profile 选择：

```js
const list = await profiles();
console.log(list);
// 按用户指定的 ID 创建；已有空间不能通过这个参数切换 profile。
const task = await taskSpace("requested-profile-goal", { profileId: "Profile 5" });
const page = task.page("p1");
// ...
await task.finish({ keep: [] });
```

managed 模式也可传 `profileId`。profile 列表由 Ego 返回，插件不维护数量、不隐藏 profile；可见配置与实际登录状态需分别验证。

## 官方 shell 命令

插件启动时生成临时 shim，加入 PATH，并通过带随机密钥的本机回环端点转发到固定 Ego 程序。脚本、文件导入和所有子命令均按官方 CLI 处理，不用正则猜测意图。未知命令由官方 CLI 报错；这不代表会自动运行 upgrade/import，是否执行仍应遵守用户授权与官方 skill。

PowerShell 按官方指南写 UTF-8 `.mjs` 文件后：

```powershell
ego-browser nodejs -e "await import('file:///C:/automation/round-01.mjs')"
```

shim 只覆盖 Ego 命令，不提供通用 shell 或任意可执行文件参数。代理不可用时回退到本地 Ego，原样重放已读取的 stdin；在受限 shell 中该回退可能仍被 DSH 拦截，此时应恢复插件或使用 `ego_browser`，不要修改其它工具权限。

## 配置

```yaml
- id: ego-browser-cli
  config:
    timeoutMs: 240000
    shellProxy: true
    # executable: C:/custom/ego-browser.exe
    # cwd: C:/automation
```

`requireApproval` 已在 2.0 移除。2.0.1 起检测到旧的 block/ask/host-primitives 配置会停止挂载并提示迁移，避免旧用户意外扩大信任范围；确认迁移后删除旧设置，或显式设置 `trustedRuntime: true`。新安装和本次已确认的专用浏览器配置不产生逐次审批。`shellProxy: false` 可关闭 shell shim，保留专用工具。不要为此修改 DSH 核心或全局权限预设。

代理只接受预先解析的绝对程序路径，找不到 Ego 时不安装 shim；Windows 密钥目录使用显式受限 DACL。超时/取消会尝试终止进程树并在短暂清理期限后关闭输出管道，避免已经退出的 CLI 遗留管道使工具永久挂起。它不是操作系统 Job Object：主动脱离进程树的子进程、或 Windows 上父进程先退出后的孤儿进程，不能保证由该清理机制回收。

## 验证

```powershell
npm test        # 无需 Ego：注册、原样脚本、任务空间与代理传输回归
npm run test:live  # 需要 Ego：合成网页、文件、截图、上传下载等
```

Live 测试只使用合成数据并关闭自己的空间，产物写入临时测试目录。受限 shell 下单元测试里的子进程可能遇到 DSH 的 EPERM，应在正常开发终端运行；实际浏览器工具由插件宿主执行。Windows 已验证；macOS/Linux 逻辑有自动测试，尚未进行本机 Ego 实测。

## 回退

2.0 默认采用官方脚本语法，是有意的兼容性变更。旧短脚本加 `mode: "managed"` 即可。若要回退整个插件，恢复更新前的插件副本及 profile 包配置，然后重启 DSH。卸载时从 profile bundle 注册中移除插件；shim 会在正常卸载时清理。
