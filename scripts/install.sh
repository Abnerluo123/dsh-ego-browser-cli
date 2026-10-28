#!/usr/bin/env bash
# dsh-ego-browser-cli installer for macOS and Linux.
#
# Installs the plugin into a DSH profile and wires it into that profile's
# package.json (both `dependencies` and `dsh.profile.bundles`). Idempotent.
#
# Usage:
#   bash install.sh                          # default profile: desktop
#   bash install.sh --profile tui            # another profile
#   bash install.sh --skill-dir ~/my/skills  # custom skill location
#   bash install.sh --no-skill               # skip the skill
#
# Never uses sudo. Fails loudly instead of guessing a path.

set -euo pipefail

PROFILE="desktop"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SKILL_DIR=""
INSTALL_SKILL=1

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)    PROFILE="$2"; shift 2 ;;
    --dsh-home)   DSH_HOME_DIR="$2"; shift 2 ;;
    --skill-dir)  SKILL_DIR="$2"; shift 2 ;;
    --no-skill)   INSTALL_SKILL=0; shift ;;
    -h|--help)    sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

step() { printf '  %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

printf 'dsh-ego-browser-cli installer\n\n'

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SOURCE/index.js" ] || fail "index.js not found at $SOURCE"

# Locate Node. It edits package.json, so it must be present; DSH ships one, but
# it is not always on PATH (for example inside a minimal shell).
NODE=""
for candidate in node \
  "$DSH_HOME_DIR/../dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
  "/usr/local/bin/node" "/opt/homebrew/bin/node" "/usr/bin/node"; do
  if command -v "$candidate" >/dev/null 2>&1; then NODE="$(command -v "$candidate")"; break; fi
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
[ -n "$NODE" ] || fail "node not found on PATH. Install Node.js 22+ (or add DSH's bundled node to PATH) and retry."
step "node: $NODE"

PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
if [ ! -d "$PROFILE_DIR" ]; then
  AVAILABLE="(none)"
  [ -d "$DSH_HOME_DIR/profiles" ] && AVAILABLE="$(ls -1 "$DSH_HOME_DIR/profiles" 2>/dev/null | tr '\n' ' ')"
  fail "profile '$PROFILE' not found at $PROFILE_DIR. Available: $AVAILABLE"
fi
step "profile: $PROFILE_DIR"

TARGET="$PROFILE_DIR/node_modules/dsh-ego-browser-cli"
mkdir -p "$TARGET"
for f in index.js package.json cordis.patch.yml LICENSE; do
  [ -f "$SOURCE/$f" ] && cp -f "$SOURCE/$f" "$TARGET/$f"
done
if [ -f "$SOURCE/skill/SKILL.md" ]; then
  mkdir -p "$TARGET/skill"
  cp -f "$SOURCE/skill/SKILL.md" "$TARGET/skill/SKILL.md"
fi
step "installed plugin files -> $TARGET"

PKG="$PROFILE_DIR/package.json"
[ -f "$PKG" ] || fail "profile package.json not found: $PKG"
# Rendered new package.json; written only when it differs from the current one.
BACKUP=""
NEW_PKG="$PKG.new.$$"

# Rewrite package.json with node (no jq dependency).
"$NODE" --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const [pkgPath, outPath, target] = process.argv.slice(1);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.dependencies ??= {};
pkg.dependencies["dsh-ego-browser-cli"] = "file:" + target.replace(/\\/g, "/");
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
if (!pkg.dsh.profile.bundles.includes("dsh-ego-browser-cli")) {
  pkg.dsh.profile.bundles.push("dsh-ego-browser-cli");
}
writeFileSync(outPath, JSON.stringify(pkg, null, 2) + "\n");
' "$PKG" "$NEW_PKG" "$TARGET"

if cmp -s "$PKG" "$NEW_PKG"; then
  rm -f "$NEW_PKG"
  step "package.json already up to date"
else
  BACKUP="$PKG.bak.$(date +%Y%m%d%H%M%S)"
  cp -f "$PKG" "$BACKUP"
  mv -f "$NEW_PKG" "$PKG"
  step "package.json updated (backup: $(basename "$BACKUP"))"
fi

if [ "$INSTALL_SKILL" -eq 1 ]; then
  if [ -z "$SKILL_DIR" ]; then
    SKILL_DIR="$HOME/.agents/skills/ego-browser-cli"
  fi
  mkdir -p "$SKILL_DIR"
  if [ -f "$SOURCE/skill/SKILL.md" ]; then
    cp -f "$SOURCE/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
    step "skill installed -> $SKILL_DIR/SKILL.md"
  fi
else
  step "skill skipped (--no-skill)"
fi

echo ""
if command -v ego-browser >/dev/null 2>&1; then
  step "ego-browser found: $(command -v ego-browser)"
elif [ -x "$HOME/.local/bin/ego-browser" ]; then
  step "ego-browser found: $HOME/.local/bin/ego-browser"
else
  echo "NOTE: ego-browser was not found on this machine."
  echo "      Install Ego Lite from https://lite.ego.app/ and finish its onboarding."
  echo "      The plugin resolves it at startup, so finish that first."
fi

echo ""
echo "Done. Restart DeepSeek Harness to load the plugin."
echo "After restart, the 'ego_browser' tool becomes available."
echo ""
if [ -n "$BACKUP" ]; then
  echo "Rollback: restore $BACKUP over package.json, delete $TARGET, then restart."
else
  echo "Rollback: delete $TARGET and remove the dsh-ego-browser-cli entry from"
  echo "          $PKG, then restart."
fi
