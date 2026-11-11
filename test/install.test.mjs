import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Every invocation uses a disposable synthetic home and copied installer. No real
// profile or installed plugin is read, changed, or used as a fixture.
const repo = fileURLToPath(new URL('../', import.meta.url));
const plugin = 'dsh-ego-browser-cli';
const payloadFiles = ['index.js', 'proxy.js', 'package.json', 'cordis.patch.yml', 'LICENSE'];
const available = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 });
  return !result.error && result.status === 0;
};
const powershell = process.platform === 'win32'
  ? ['powershell.exe', 'pwsh.exe'].find(c => available(c, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']))
  : ['pwsh'].find(c => available(c, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']));
const bash = [
  'bash',
  ...(process.platform === 'win32' ? [path.resolve(repo, '../tools/git/bin/bash.exe'), 'C:/Program Files/Git/bin/bash.exe'] : []),
].find(c => available(c, ['-c', 'exit 0']));

function fixture(t, manifest = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh installer 空间 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source 插件 with spaces');
  const home = path.join(root, 'synthetic home 用户');
  const profile = path.join(home, 'profiles', 'desktop');
  const target = path.join(profile, 'node_modules', plugin);
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['install.ps1', 'install.sh']) {
    fs.copyFileSync(path.join(repo, 'scripts', name), path.join(source, 'scripts', name));
  }
  for (const name of payloadFiles) fs.writeFileSync(path.join(source, name), `new ${name}\n`);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: plugin, version: '2.0.0' }));
  fs.writeFileSync(path.join(target, 'index.js'), 'old payload\n');
  fs.writeFileSync(path.join(target, 'old-only.txt'), 'preserve in backup\n');
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { root, source, home, profile, target, manifest: path.join(profile, 'package.json') };
}
function snapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name);
    return [name, fs.statSync(file).isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  }));
}
function run(kind, f, { fault } = {}) {
  const env = { ...process.env, DSH_HOME: f.home, HOME: f.home, USERPROFILE: f.home };
  // Git Bash needs the actual Node executable, not a workspace .cmd shim.
  env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '');
  let command, args, input;
  if (kind === 'powershell') {
    command = powershell;
    const installer = path.join(f.source, 'scripts', 'install.ps1');
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer, '-DshHome', f.home];
    if (fault) {
      const wrapper = path.join(f.root, 'fault wrapper.ps1');
      // Fail once at a move/copy boundary, allowing the real rollback to run.
      const cmdlet = fault === 'stage' ? 'Copy-Item' : 'Move-Item';
      const count = fault === 'stage' ? 3 : 4;
      fs.writeFileSync(wrapper, `param($Installer, $SyntheticHome)\n$script:calls = 0\nfunction ${cmdlet} {\n  param($LiteralPath, $Destination)\n  $script:calls++\n  if ($script:calls -eq ${count}) { throw 'injected installer failure' }\n  Microsoft.PowerShell.Management\\${cmdlet} -LiteralPath $LiteralPath -Destination $Destination\n}\n& $Installer -DshHome $SyntheticHome\nexit $LASTEXITCODE\n`);
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper, installer, f.home];
    }
  } else {
    if (kind === 'node-transaction') {
      // Also exercise the POSIX installer's embedded transaction on machines
      // without Bash. This supplements, rather than replaces, the shell suite.
      command = process.execPath;
      args = ['--input-type=module', '-', f.source, f.home, 'desktop'];
      input = fs.readFileSync(path.join(f.source, 'scripts', 'install.sh'), 'utf8').match(/<<'NODE_INSTALL'\n([\s\S]*?)\nNODE_INSTALL/)[1];
    } else {
      command = bash;
      args = [path.join(f.source, 'scripts', 'install.sh'), '--dsh-home', f.home];
    }
    if (fault) {
      const preload = path.join(f.root, 'inject-failure.cjs');
      const method = fault === 'stage' ? 'copyFileSync' : 'renameSync';
      const count = fault === 'stage' ? 3 : 4;
      fs.writeFileSync(preload, `const fs = require('node:fs');\nconst original = fs.${method};\nlet calls = 0;\nfs.${method} = (...args) => { if (++calls === ${count}) throw new Error('injected installer failure'); return original(...args); };\nrequire('node:module').syncBuiltinESMExports();\n`);
      env.NODE_OPTIONS = `--require "${preload.replace(/\\/g, '/')}"`;
    }
  }
  const result = spawnSync(command, args, { env, input, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}
function success(result) { assert.equal(result.status, 0, result.output); }
function failed(result) { assert.notEqual(result.status, 0, result.output); }
function backups(f) {
  return fs.readdirSync(f.profile).filter(name => name.startsWith(`.${plugin}.backup.`)).map(name => path.join(f.profile, name));
}
function noStaging(f) {
  assert.deepEqual(fs.readdirSync(f.profile).filter(name => name.startsWith(`.${plugin}.stage.`)), []);
}

for (const [kind, runtime] of [['powershell', powershell], ['bash', bash], ['node-transaction', process.execPath]]) {
  test(`${kind}: installer integration with synthetic profiles`, { skip: !runtime && `${kind} unavailable` }, async t => {
    await t.test('preserves unrelated fields and bundles; backs up full old payload and manifest; repeat upgrade', t => {
      const original = {
        name: 'synthetic-profile', bundles: ['root-one'], custom: { bundles: ['quote"', '斜线\\', { nested: [1] }] },
        dependencies: { unrelated: '1.0.0' },
        dsh: { bundles: ['dsh-one'], profile: { keep: true, bundles: ['unrelated-bundle'] } },
      };
      const f = fixture(t, original);
      const beforeManifest = fs.readFileSync(f.manifest);
      const beforePayload = snapshot(f.target);
      success(run(kind, f));
      const installed = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
      assert.deepEqual(installed.bundles, original.bundles);
      assert.deepEqual(installed.custom, original.custom);
      assert.deepEqual(installed.dsh.bundles, original.dsh.bundles);
      assert.equal(installed.dsh.profile.keep, true);
      assert.deepEqual(installed.dsh.profile.bundles, ['unrelated-bundle', plugin]);
      assert.equal(installed.dependencies.unrelated, '1.0.0');
      assert.equal(installed.dependencies[plugin], 'file:' + f.target.replace(/\\/g, '/'));
      assert.deepEqual(Object.keys(snapshot(f.target)).sort(), payloadFiles.toSorted());
      for (const name of payloadFiles) assert.deepEqual(fs.readFileSync(path.join(f.target, name)), fs.readFileSync(path.join(f.source, name)));
      assert.equal(backups(f).length, 1);
      assert.deepEqual(fs.readFileSync(path.join(backups(f)[0], 'package.json')), beforeManifest);
      assert.deepEqual(snapshot(path.join(backups(f)[0], 'payload')), beforePayload);
      fs.writeFileSync(path.join(f.source, 'proxy.js'), 'upgrade payload\n');
      success(run(kind, f));
      assert.equal(fs.readFileSync(path.join(f.target, 'proxy.js'), 'utf8'), 'upgrade payload\n');
      assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest, 'utf8')), installed);
      assert.equal(backups(f).length, 2);
      noStaging(f);
    });
    await t.test('single-element profile bundles stays an array, including repeated registration', t => {
      const f = fixture(t, { dsh: { profile: { bundles: [plugin] } }, bundles: ['other'] });
      success(run(kind, f));
      success(run(kind, f));
      const pkg = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
      assert.deepEqual(pkg.dsh.profile.bundles, [plugin]);
      assert.deepEqual(pkg.bundles, ['other']);
    });
    await t.test('creates missing registration objects and an array', t => {
      const f = fixture(t);
      success(run(kind, f));
      assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest, 'utf8')).dsh.profile.bundles, [plugin]);
    });
    for (const [label, value] of [
      ['malformed JSON', '{bad'], ['root array', '[{}]'], ['dependencies array', '{"dependencies":[]}'],
      ['dsh array', '{"dsh":[]}'], ['profile array', '{"dsh":{"profile":[]}}'],
      ['bundles string', '{"dsh":{"profile":{"bundles":"other"}}}'],
    ]) {
      await t.test(`${label}: leaves old files byte-for-byte unchanged`, t => {
        const f = fixture(t);
        fs.writeFileSync(f.manifest, value);
        const before = snapshot(f.profile);
        failed(run(kind, f));
        assert.deepEqual(snapshot(f.profile), before);
      });
    }
    await t.test('missing profile manifest leaves old payload unchanged', t => {
      const f = fixture(t);
      fs.unlinkSync(f.manifest);
      const before = snapshot(f.profile);
      failed(run(kind, f));
      assert.deepEqual(snapshot(f.profile), before);
    });
    for (const missing of payloadFiles) {
      await t.test(`missing source ${missing}: leaves old files unchanged`, t => {
        const f = fixture(t);
        fs.unlinkSync(path.join(f.source, missing));
        const before = snapshot(f.profile);
        failed(run(kind, f));
        assert.deepEqual(snapshot(f.profile), before);
      });
    }
    await t.test('invalid source manifest leaves old files unchanged', t => {
      const f = fixture(t);
      fs.writeFileSync(path.join(f.source, 'package.json'), '{bad');
      const before = snapshot(f.profile);
      failed(run(kind, f));
      assert.deepEqual(snapshot(f.profile), before);
    });
    for (const fault of ['stage', 'swap']) {
      await t.test(`${fault} error restores old manifest and payload`, t => {
        const f = fixture(t, { preserve: ['old'] });
        const beforeManifest = fs.readFileSync(f.manifest);
        const beforePayload = snapshot(f.target);
        const result = run(kind, f, { fault });
        failed(result);
        assert.match(result.output, /injected installer failure/);
        assert.deepEqual(fs.readFileSync(f.manifest), beforeManifest);
        assert.deepEqual(snapshot(f.target), beforePayload);
        noStaging(f);
      });
    }
  });
}
