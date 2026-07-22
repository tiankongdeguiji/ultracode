#!/bin/bash
# Immutable post-session patch capture. The entrypoint invokes this as the task
# uid after clearing every capability set.
set -euo pipefail

REPO_DIR=$1
BASE_SHA=$2
BENCH=$3
NODE=$4
PRE_DIRTY=$5
PATCH_LIMIT=10000000

export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=core.fsmonitor
export GIT_CONFIG_VALUE_0=false
export GIT_CONFIG_KEY_1=core.hooksPath
export GIT_CONFIG_VALUE_1=/dev/null

cd "$REPO_DIR"
git add -A >/dev/null 2>&1
if [ -s "$PRE_DIRTY" ]; then
  xargs -0 git reset -q -- < "$PRE_DIRTY" >/dev/null 2>&1
fi
"$NODE" - "$REPO_DIR" "$BASE_SHA" "$BENCH" "$PATCH_LIMIT" <<'NODE'
const { closeSync, ftruncateSync, openSync, writeFileSync, writeSync } = require('fs');
const { join } = require('path');
const { spawn } = require('child_process');
const repository = process.argv[2];
const base = process.argv[3];
const bench = process.argv[4];
const limit = Number(process.argv[5]);
const patch = join(bench, 'out', 'patch.diff');
const output = openSync(patch, 'w', 0o600);
const log = openSync(join(bench, 'logs', 'entry.log'), 'a');
let child;
let outputBytes = 0;
let sectionStart = 0;
let binarySection = false;
let stripped = 0;
let pending = Buffer.alloc(0);
let oversized = false;
let spawnFailure = null;

const stopOversized = () => {
  if (oversized) return;
  oversized = true;
  child?.kill('SIGKILL');
};
const consumeLine = (line) => {
  if (line.subarray(0, 11).toString('ascii') === 'diff --git ') {
    sectionStart = outputBytes;
    binarySection = false;
  }
  const text = line.toString('utf8');
  if (!binarySection && (/^Binary files .* differ\r?\n?$/u.test(text) || /^GIT binary patch\r?\n?$/u.test(text))) {
    ftruncateSync(output, sectionStart);
    outputBytes = sectionStart;
    binarySection = true;
    stripped += 1;
    return;
  }
  if (binarySection) return;
  if (outputBytes + line.length > limit) {
    stopOversized();
    return;
  }
  writeSync(output, line, 0, line.length, outputBytes);
  outputBytes += line.length;
};
const consume = (chunk) => {
  if (oversized) return;
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const newline = pending.indexOf(0x0a);
    if (newline < 0) break;
    consumeLine(pending.subarray(0, newline + 1));
    pending = pending.subarray(newline + 1);
    if (oversized) return;
  }
  if (pending.length > limit) stopOversized();
};

child = spawn('git', [
  '-c', 'core.quotePath=false',
  'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--cached', base, '--', '.',
  ':(exclude).ultracode', ':(exclude).agents', ':(exclude).codex', ':(exclude)*.workflow.js',
], { cwd: repository, stdio: ['ignore', 'pipe', log] });
child.stdout.on('data', consume);
child.on('error', (error) => { spawnFailure = error; });
child.on('close', (code, signal) => {
  try {
    if (!oversized && pending.length > 0) consumeLine(pending);
    if (oversized) {
      ftruncateSync(output, limit + 1);
    } else if (spawnFailure !== null || code !== 0 || signal !== null) {
      process.exitCode = 1;
    }
    writeFileSync(join(bench, 'out', 'binary-stripped'), String(stripped));
  } finally {
    closeSync(output);
    closeSync(log);
  }
});
NODE
PATCH_BYTES=$(wc -c < "$BENCH/out/patch.diff" | tr -d '[:space:]')
if [ "$PATCH_BYTES" -gt "$PATCH_LIMIT" ]; then
  exit 0
fi
if [ "$PATCH_BYTES" -gt 0 ]; then
  git reset --hard "$BASE_SHA" >/dev/null 2>&1
  if git apply --check --whitespace=nowarn "$BENCH/out/patch.diff" 2>>"$BENCH/logs/entry.log"; then
    echo ok > "$BENCH/out/apply-check"
  else
    echo fail > "$BENCH/out/apply-check"
  fi
fi
