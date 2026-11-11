#!/usr/bin/env bash
# dsh-ego-browser-cli installer for macOS and Linux.
# Usage: bash install.sh [--profile desktop] [--dsh-home /path/to/.dsh]
# Never uses sudo. Successful upgrades retain the previous payload and manifest.
set -euo pipefail

PROFILE="desktop"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
while [ $# -gt 0 ]; do
  case "$1" in
    --profile|--dsh-home|--skill-dir)
      [ $# -ge 2 ] || { printf 'missing value for %s\n' "$1" >&2; exit 1; }
      case "$1" in
        --profile) PROFILE="$2" ;;
        --dsh-home) DSH_HOME_DIR="$2" ;;
        --skill-dir) : ;; # Retained for compatibility; this plugin installs no skill.
      esac
      shift 2 ;;
    --no-skill) shift ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$SOURCE/index.js" ]; then SOURCE="$(cd "$SOURCE/.." && pwd)"; fi
NODE=""
for candidate in node \
  "$DSH_HOME_DIR/../dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
  "/usr/local/bin/node" "/opt/homebrew/bin/node" "/usr/bin/node"; do
  if command -v "$candidate" >/dev/null 2>&1; then NODE="$(command -v "$candidate")"; break; fi
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
[ -n "$NODE" ] || { echo 'ERROR: node not found. Add Node.js 22+ to PATH and retry.' >&2; exit 1; }

"$NODE" --input-type=module - "$SOURCE" "$DSH_HOME_DIR" "$PROFILE" <<'NODE_INSTALL'
import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const [source, dshHome, profile] = process.argv.slice(2);
const name = 'dsh-ego-browser-cli';
const files = ['index.js', 'proxy.js', 'package.json', 'cordis.patch.yml', 'LICENSE'];
const profileDir = path.join(dshHome, 'profiles', profile);
const manifest = path.join(profileDir, 'package.json');
const modules = path.join(profileDir, 'node_modules');
const target = path.join(modules, name);
let stage, backup;
let oldPayloadMoved = false, oldManifestMoved = false;
let newPayloadMoved = false, newManifestMoved = false;
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value;
};
try {
  // Validate the full runtime payload and manifest before touching the install.
  for (const file of files) {
    if (!fs.statSync(path.join(source, file)).isFile()) throw new Error(`required source payload missing: ${file}`);
  }
  const sourcePkg = object(JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')), 'source package.json');
  if (sourcePkg.name !== name) throw new Error('unexpected source package name');
  const pkg = object(JSON.parse(fs.readFileSync(manifest, 'utf8')), 'profile package.json');
  pkg.dependencies = object(pkg.dependencies ?? {}, 'dependencies');
  pkg.dsh = object(pkg.dsh ?? {}, 'dsh');
  pkg.dsh.profile = object(pkg.dsh.profile ?? {}, 'dsh.profile');
  const bundles = pkg.dsh.profile.bundles ?? [];
  if (!Array.isArray(bundles)) throw new Error('dsh.profile.bundles must be a JSON array');
  if (!bundles.includes(name)) bundles.push(name);
  pkg.dsh.profile.bundles = bundles;
  pkg.dependencies[name] = 'file:' + target.replace(/\\/g, '/');
  const json = JSON.stringify(pkg, null, 2) + '\n';
  if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) throw new Error(`payload target must be a directory: ${target}`);

  const id = randomUUID();
  stage = path.join(profileDir, `.${name}.stage.${id}`);
  backup = path.join(profileDir, `.${name}.backup.${id}`);
  const stagedPayload = path.join(stage, 'payload');
  fs.mkdirSync(stagedPayload, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(source, file), path.join(stagedPayload, file));
  fs.writeFileSync(path.join(stage, 'package.json'), json);
  fs.mkdirSync(modules, { recursive: true });
  fs.mkdirSync(backup);
  // Same-filesystem moves with rollback for caught errors. Swapping these two
  // paths is not atomic across an OS crash or power loss.
  if (fs.existsSync(target)) {
    fs.renameSync(target, path.join(backup, 'payload'));
    oldPayloadMoved = true;
  }
  fs.renameSync(manifest, path.join(backup, 'package.json'));
  oldManifestMoved = true;
  fs.renameSync(stagedPayload, target);
  newPayloadMoved = true;
  fs.renameSync(path.join(stage, 'package.json'), manifest);
  newManifestMoved = true;
  console.log(`Installed plugin files -> ${target}`);
  console.log(`Registered bundle and dependency in ${manifest}`);
  console.log(`Previous manifest and payload (when present): ${backup}`);
  console.log('No skill installed (permission-only plugin).');
  console.log(`For manual rollback, restore package.json and payload from ${backup}.`);
} catch (error) {
  try {
    if (newManifestMoved) fs.rmSync(manifest);
    if (newPayloadMoved) fs.rmSync(target, { recursive: true });
    if (oldManifestMoved) fs.renameSync(path.join(backup, 'package.json'), manifest);
    if (oldPayloadMoved) fs.renameSync(path.join(backup, 'payload'), target);
  } catch (rollbackError) {
    console.error(`ERROR: rollback failed: ${rollbackError.message}. Recovery files: ${backup}`);
  }
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (stage) {
    try { fs.rmSync(stage, { recursive: true, force: true }); }
    catch { console.error(`WARNING: could not remove staging directory: ${stage}`); }
  }
}
NODE_INSTALL

if command -v ego-browser >/dev/null 2>&1; then
  printf '  ego-browser found: %s\n' "$(command -v ego-browser)"
elif [ -x "$HOME/.local/bin/ego-browser" ]; then
  printf '  ego-browser found: %s\n' "$HOME/.local/bin/ego-browser"
else
  echo 'NOTE: ego-browser was not found on this machine.'
  echo '      Install Ego Lite from https://lite.ego.app/ and finish its onboarding.'
  echo '      The plugin resolves it at startup, so finish that first.'
fi
echo 'Done. Restart DeepSeek Harness to load the plugin.'
echo "After restart, the 'ego_browser' tool becomes available."
