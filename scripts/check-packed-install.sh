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
unset PERO_HOME PERO_TELEGRAM_BOT_TOKEN
mkdir -p "$HOME" "$prefix"

cleanup() {
  for dir in "$HOME/.pero" "$HOME/restored"; do
    [ -d "$dir" ] && pero stop --data-dir "$dir" >/dev/null 2>&1 || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

step() { printf '\n==> %s\n' "$*"; }

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
step 'pero --version'
pero --version

step 'pero run (not interactive)'
pero run </dev/null

step 'pero status'
pero status

step 'pero backup'
pero backup "$work/backup.tgz"

step 'pero stop'
pero stop

step 'pero status (stopped)'
code=0
pero status || code=$?
if [ "$code" -ne 3 ]; then
  echo "Expected exit status 3 from a stopped Pero, got $code" >&2
  exit 1
fi

step 'pero restore into a fresh data directory'
pero restore "$work/backup.tgz" --data-dir "$HOME/restored"
pero run --data-dir "$HOME/restored" </dev/null
pero status --data-dir "$HOME/restored"
pero stop --data-dir "$HOME/restored"

step 'Packed install works'
