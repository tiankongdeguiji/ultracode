#!/bin/bash
# Immutable post-session patch capture. The entrypoint invokes this as the task
# uid after clearing every capability set.
set -euo pipefail

REPO_DIR=$1
BASE_SHA=$2
BENCH=$3
NODE=$4
PRE_DIRTY=$5

cd "$REPO_DIR"
git add -A >/dev/null 2>&1
if [ -s "$PRE_DIRTY" ]; then
  xargs -0 git reset -q -- < "$PRE_DIRTY" >/dev/null 2>&1
fi
git -c core.quotePath=false diff --no-color --no-ext-diff --cached "$BASE_SHA" -- . \
  ':(exclude).ultracode' ':(exclude).agents' ':(exclude).codex' ':(exclude)*.workflow.js' \
  > "$BENCH/out/patch.full.diff" 2>>"$BENCH/logs/entry.log"
"$NODE" - "$BENCH" <<'NODE'
const fs = require('fs');
const path = require('path');
const bench = process.argv[2];
const full = fs.readFileSync(path.join(bench, 'out', 'patch.full.diff'), 'utf8');
const sections = full.length ? full.split(/^(?=diff --git )/m) : [];
let stripped = 0;
const kept = sections.filter((section) => {
  if (/^Binary files .* differ$/m.test(section) || /^GIT binary patch$/m.test(section)) {
    stripped += 1;
    return false;
  }
  return true;
});
fs.writeFileSync(path.join(bench, 'out', 'patch.diff'), kept.join(''));
fs.writeFileSync(path.join(bench, 'out', 'binary-stripped'), String(stripped));
NODE
if [ -s "$BENCH/out/patch.diff" ]; then
  git reset --hard "$BASE_SHA" >/dev/null 2>&1
  if git apply --check --whitespace=nowarn "$BENCH/out/patch.diff" 2>>"$BENCH/logs/entry.log"; then
    echo ok > "$BENCH/out/apply-check"
  else
    echo fail > "$BENCH/out/apply-check"
  fi
fi
