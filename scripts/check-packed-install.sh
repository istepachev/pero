#!/usr/bin/env bash
# Installs the `npm pack` artifact into a temporary global prefix and drives
# `pero` from a fresh home directory: the package as users get it, not the
# source checkout. Run from the repository root after `npm ci`.
set -euo pipefail

work="$(mktemp -d "${TMPDIR:-/tmp}/pero-pack.XXXXXX")"
work="$(cd "$work" && pwd -P)"
prefix="$work/prefix"
export HOME="$work/home"
export npm_config_prefix="$prefix"
export PATH="$prefix/bin:$PATH"
unset PERO_WORKSPACE PERO_TELEGRAM_BOT_TOKEN
mkdir -p "$HOME" "$prefix"

cleanup() {
  for ws in workspace clone; do
    [ -d "$HOME/$ws" ] && pero stop -w "$HOME/$ws" >/dev/null 2>&1 || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

step() { printf '\n==> %s\n' "$*"; }
fail() {
  echo "$*" >&2
  exit 1
}
git() { command git -c user.name=Pero -c user.email=pero@example.com "$@"; }

step 'Packing'
npm pack --pack-destination "$work" >/dev/null
tarball="$(ls "$work"/*.tgz)"
tar -tzf "$tarball" | sort

step 'Installing globally'
npm install --global --no-audit --no-fund "$tarball"
package="$prefix/lib/node_modules/@perokit/pero"
command -v pero

step 'Loading better-sqlite3 from the installed package'
node --input-type=module -e "
  import { createRequire } from 'node:module';
  const require = createRequire('$package/package.json');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  console.log('SQLite', db.prepare('SELECT sqlite_version() AS v').get().v);
  db.close();
"

cd "$HOME"
step 'pero -v'
pero -v

step 'pero run without a workspace (not interactive)'
code=0
pero run </dev/null || code=$?
if [ "$code" -ne 1 ]; then
  fail "Expected exit status 1 without a workspace, got $code"
fi

step 'pero init ~/workspace, a Git repository'
pero init "$HOME/workspace"
cd "$HOME/workspace"
git init --quiet

step 'pero run (not interactive)'
pero run </dev/null

step 'pero status'
pero status

step 'The guide is in .pero/'
grep -q '^# Pero guide$' .pero/guide.md || fail 'Pero did not write .pero/guide.md'

step 'Committing the workspace commits config.yaml and nothing secret'
printf 'PERO_TELEGRAM_BOT_TOKEN=123456789:not-a-real-token\n' >.env
chmod 600 .env
git add -A
staged="$(git diff --cached --name-only)"
printf '%s\n' "$staged"
grep -qx '.pero/config.yaml' <<<"$staged" || fail 'config.yaml is not staged'
grep -qx 'data/System/Pero.md' <<<"$staged" || fail 'Pero.md is not staged'
if grep -Eq '^\.env$|pero\.sqlite|^\.pero/(logs|run|guide\.md)' <<<"$staged"; then
  fail 'Git would commit a secret or Pero state'
fi
git commit --quiet -m 'Pero workspace'

step 'pero backup --include-data'
pero backup --include-data "$work/backup.tgz"

step 'pero stop'
pero stop

step 'pero status (stopped)'
code=0
pero status || code=$?
if [ "$code" -ne 3 ]; then
  fail "Expected exit status 3 from a stopped Pero, got $code"
fi

step 'pero restore into a fresh clone'
cd "$HOME"
git clone --quiet "$HOME/workspace" "$HOME/clone"
rm -rf "$HOME/clone/data"
pero restore "$work/backup.tgz" -w "$HOME/clone"
[ -f "$HOME/clone/data/System/Persona.md" ] || fail 'The data folder was not restored'
pero run -w "$HOME/clone" </dev/null
pero status -w "$HOME/clone"
pero stop -w "$HOME/clone"

step 'Packed install works'
