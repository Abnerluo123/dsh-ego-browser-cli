# dsh-ego-browser-cli

**在 DeepSeek Harness 里用上官方 Ego Lite 浏览器——保留完整能力，同时不放弃文件沙箱。**

这个 DSH 插件从 Harness 主进程启动官方 `ego-browser` CLI，并暴露成一个 `ego_browser` 工具。

[English](README.md) · MIT

---

## 它解决什么问题

`ego-browser` 在受限文件策略下无法启动。沙箱内的 shell 连不上 ego daemon 的 bootstrap 通道：

```
$ ego-browser nodejs -e "console.log(1)"
Failed to connect to ego_cli bootstrap
Agent note: ego-browser cannot connect to the ego_cli bootstrap from the default agent
sandbox. Retry with Full Access or run ego-browser outside the agent sandbox.
```

唯一的官方出路是把会话切成 **Full access**——但那会**对所有工具**放开文件限制，不只是浏览器。于是通常只有两个选择：

- 保住 `workspace-write`，用不了浏览器；
- 用上浏览器，却处处失去限制。

这个插件取消了这道二选一，把边界画在真正的分界线上：

| 能力 | 行为 |
|---|---|
| 浏览器操作（导航、点击、填表、截图、取数据） | 直接运行，**不弹审批** |
| 宿主级原语（裸 fs、子进程、套接字、`eval`） | 每次调用**弹一次审批** |

会话保持 `workspace-write`，`write`、`edit`、`bash` 依旧受限。只有浏览器这条路走主进程。

## 为什么从主进程启动是正当做法

这不是从外面硬撬开沙箱。DSH 自己的 MCP 客户端本来就是这么工作的——`dsh-mcp-client` 通过 MCP SDK 的 `StdioClientTransport` 启动 MCP 服务器，完全不经过 `ctx.sandbox` 或 `ctx.shell`。因此经 MCP 暴露的工具同样不受限制。

本插件只是把这条路径开放给**官方** CLI，让你不必再为了一个浏览器而单独架一个 MCP 服务器。

## 依赖

- DeepSeek Harness，且你能够编辑 profile
- 已安装 [Ego Lite](https://lite.ego.app/) 并完成 onboarding（onboarding 才会把 `ego-browser` 注册到 PATH）
- Node.js 22+（仅 macOS/Linux 安装脚本需要）

## 安装

### 1. 获取插件

```bash
git clone https://github.com/Abnerluo123/dsh-ego-browser-cli.git
cd dsh-ego-browser-cli
```

或下载发布包解压。

### 2. 运行安装脚本

**Windows（PowerShell）：**

```powershell
pwsh -File scripts/install.ps1
```

**macOS / Linux：**

```bash
bash scripts/install.sh
```

安装脚本会把插件写入 profile 的 `node_modules`，在 profile 的 `package.json` 中登记
（`dependencies` 与 `dsh.profile.bundles` 两处），先备份原文件，并把 skill 安装到
`~/.agents/skills/ego-browser-cli/`。

常用参数：

```powershell
pwsh -File scripts/install.ps1 -Profile tui      # 指定其他 profile
pwsh -File scripts/install.ps1 -NoSkill          # 不安装 skill
```

```bash
bash scripts/install.sh --profile tui
bash scripts/install.sh --no-skill
```

### 3. 重启 DeepSeek Harness

插件在启动时加载。重启后 `ego_browser` 工具即可使用。

### 验证

让 Harness 执行：

```js
await page.goto("https://example.com");
console.log(JSON.stringify({ title: await page.title(), url: await page.url() }));
```

结果里出现带页面标题的 JSON 行，说明整条链路正常：加载器 → 查找可执行文件 → 无限制启动。

## 用法

工具接收 `script`（通过 stdin 交给 `ego-browser nodejs` 的 Node 脚本体）和一个简短的 `description`。`task` 与默认的 `page`（`"p1"`）已在作用域内，顶层 `await` 可用。

```js
await page.goto("https://xiumi.us");
const info = await page.evaluate(() => ({
  title: document.title,
  links: [...document.querySelectorAll("a")].slice(0, 5).map((a) => a.innerText.trim()),
}));
console.log(JSON.stringify(info));
```

参数：`spaceId` 用于续接任务空间，`timeoutMs` 用于限制单次运行时长。

### 需要知道的几点

- **ego 把脚本的 `console.log` 输出打到 STDERR，不是 stdout。** 两路都会返回，stderr 不代表失败。
- **每次调用都是新进程。** 任务空间按名称/id 持久，但 JavaScript 变量不持久。打印 `task.spaceId` 并作为 `spaceId` 传回来即可续接。
- **尽量用一个脚本跑完整流程。** 中间状态不会进入模型上下文，所以批量执行比多次小调用便宜得多。
- **不要调用无参数的 `task.finish()` 或空的 `keep`**——两者都会抛错。要么完全不调用（进程退出时释放空间），要么 `task.finish({ keep: "all" })`。

完整 API 指南随 Ego Lite 提供：运行 `ego-browser skill`。该命令只打印文本，在受限环境下也能正常工作。

### 容易踩的 API 细节

| 现象 | 原因 |
|---|---|
| `page.screenshot received unknown option: saveAs` | 选项名是 `path` |
| `screenshot scale must be one of css` | `scale` 是字符串，且只接受 `"css"` |
| `loc=href:` 匹配不到 | 它需要**完整 URL**，不支持子串或正则 |
| `matched 2 elements` | 元素操作要求唯一匹配，两个匹配即报错 |
| `page.fetch` 在 `file://` 下失败 | 它走 `window.fetch`，受浏览器 CORS 约束 |

## 安全说明

**官方浏览器 API 面完全放行。** ego skill 里写的一切——`task`、`page` 及其方法、`console`、普通 JavaScript——都不会弹窗。`node:path` 同样放行：它只做字符串计算，不碰文件系统。

只有伸到浏览器**之外**的脚本，才会为该次调用弹**一次**审批：文件系统、子进程、裸套接字、宿主 OS/VM、进程环境或控制、动态求值。扫描时会忽略注释，所以在注释里写 `// uses node:fs` 不会触发。

如果一个任务既需要浏览器、又需要宿主访问，建议**拆开**：一次调用驱动浏览器并把产物存好，然后交给普通的 `pwsh`/文件工具处理宿主那一侧，那边的沙箱与提权流程照常生效。

闸门是**同意机制，不是隔离边界**。

`ego-browser nodejs` 按设计运行真正的 Node.js 并具有宿主权限——官方 skill 明确这么写。闸门扫描脚本文本以暴露有风险的调用，但刻意构造或混淆的脚本可以绕过文本扫描。请把弹窗当作提示信号，而非安全保证。

这是方法本身固有的性质，不是实现的缺陷：任何赋予浏览器完整能力的路径，都会让驱动它的脚本获得同等触达。如果你需要真正的隔离，浏览器必须跑在容器、microVM 或其他隔离环境中——本插件不会假装自己做到了这一点。

在插件配置里设 `requireApproval: "never"` 可完全关闭弹窗。

## 配置

安装脚本以默认值登记插件。要修改，编辑 profile 的 `cordis.patch.yml` 中 `ego-browser-cli` 那一行：

```yaml
- insert:
    - id: ego-browser-cli
      name: dsh-ego-browser-cli
      config:
        requireApproval: host-primitives   # 或 "never"
        timeoutMs: 240000
        # executable: /custom/path/ego-browser   # 仅用于非标准安装
```

`executable` 默认刻意不设置。插件自己按三级顺序查找：

1. 配置里的 `executable`
2. Ego Lite 创建的 junction——`~/.local/share/ego/active_version_dir/ego-browser[.exe]`
3. PATH 上的 `ego-browser`

因为 `active_version_dir` 是指向当前版本的 junction，由 Ego Lite 自己的更新器重定向，所以升级后无需改配置。这也意味着同一份配置在不同用户名、不同机器上都能用。

## 兼容性

- **已在 Windows 上实测**（Ego Lite 0.6.1.13、Chromium 156、Node v24.22.1）。
- **macOS 与 Linux 路径已支持但未实测。** 查找逻辑覆盖 `~/.local/bin/ego-browser` 与
  `/Applications/ego lite.app/Contents/MacOS/ego-browser`，欢迎反馈。
- ego 升级：junction 会原地重定向，插件可跨版本使用。若 ego 有一天改了该机制，PATH 回退依然生效。

## 测试

```bash
node test/mount.test.mjs        # 注册形态、闸门决策、渲染、参数校验
node test/portability.test.mjs  # 可执行文件查找、升级容错、缺失 ego 的报错
```

`portability.test.mjs` 会跑真实的浏览器流程，因此需要已安装 Ego Lite。另外，带管道 stdio 的
`spawn` 在受限 shell 内会返回 `EPERM`，请在普通终端里运行测试，而不是通过受沙箱限制的工具调用。

## 卸载

手动回滚：还原安装脚本打印出的 `package.json.bak.*` 备份，删除
`<profile>/node_modules/dsh-ego-browser-cli`，移除 `~/.agents/skills/ego-browser-cli/`，
然后重启。

## 许可证

MIT
