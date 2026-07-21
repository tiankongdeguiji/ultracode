#!/bin/bash
# In-container driver for one SWE-bench Pro instance x arm. Contract with
# bench/src/suites/swebench-pro/runner.ts: the arm dir is bind-mounted at /bench; env carries
# BENCH_ARM (a|b), BENCH_TIMEOUT_SECS, BENCH_MODEL, BENCH_EFFORT,
# BENCH_BASE_COMMIT, host-distinct nonzero BENCH_TASK_UID/BENCH_TASK_GID,
# BENCH_ARTIFACT_OWNER (host uid:gid), BENCH_SANITIZE=1,
# CODEX_HOME=/runtime/codex-home, ULTRACODE_HOME=/bench/uc, and the attested
# BENCH_MODEL_RELAY_BASE_URL. The repository is fixed at /app. Everything of
# value is written under /bench before exit, and the script always exits 0 — failures are reported in
# /bench/out/meta.json, never as a container error.
set -uo pipefail

BENCH=/bench
# Images mix glibc and musl userlands; node-sel carries both builds and runtimes.
NODE=/opt/bench/node-sel
CODEX=/opt/bench/bin/codex
UC_MAIN=/opt/bench/ultracode/dist/cli/main.js
REPO_DIR=${BENCH_REPO_DIR:-}
export HOME=${HOME:-/root}
export PATH=/opt/bench/bin:$PATH

mkdir -p "$BENCH/logs" "$BENCH/out"
exec 2>>"$BENCH/logs/entry.log"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# meta.json is written exactly once, via node for correct JSON encoding.
META_FAILURE=""
CODEX_EXIT=-1
START=0
END=0
BASE_SHA=""
WAITED_MS=0
GIT_AUDIT_DIR=""
cleanup_git_audit() {
  case "$GIT_AUDIT_DIR" in
    /tmp/ucbench-git-audit.*) rm -rf "$GIT_AUDIT_DIR" ;;
  esac
  GIT_AUDIT_DIR=""
}
write_meta() {
  M_FAILURE="$META_FAILURE" M_EXIT="$CODEX_EXIT" M_START="$START" M_END="$END" \
  M_BASE="$BASE_SHA" M_EXPECTED="${BENCH_BASE_COMMIT:-}" M_WAITED="$WAITED_MS" \
  M_UC_HOME="${ULTRACODE_HOME:-}" M_BENCH="$BENCH" "$NODE" -e '
    const fs = require("fs"), path = require("path");
    const e = process.env;
    const patchFile = path.join(e.M_BENCH, "out", "patch.diff");
    const patchBytes = fs.existsSync(patchFile) ? fs.statSync(patchFile).size : 0;
    let applyCheck = null;
    const acFile = path.join(e.M_BENCH, "out", "apply-check");
    if (fs.existsSync(acFile)) applyCheck = fs.readFileSync(acFile, "utf8").trim() === "ok";
    const ucRuns = [];
    const runsDir = e.M_UC_HOME ? path.join(e.M_UC_HOME, "runs") : "";
    if (runsDir && fs.existsSync(runsDir)) {
      for (const d of fs.readdirSync(runsDir)) {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(runsDir, d, "manifest.json"), "utf8"));
          ucRuns.push({ runId: d, status: String(m.status ?? "unknown") });
        } catch { ucRuns.push({ runId: d, status: "unreadable" }); }
      }
    }
    const readInt = (p) => { try { return Number(fs.readFileSync(p, "utf8").trim()) || 0; } catch { return 0; } };
    let preDirty = 0;
    try { preDirty = fs.readFileSync("/tmp/predirty.z", "utf8").split("\0").filter(Boolean).length; } catch { /* absent pre-git */ }
    const meta = {
      codexExit: Number(e.M_EXIT), startedAt: Number(e.M_START), endedAt: Number(e.M_END),
      baseSha: e.M_BASE, expectedBase: e.M_EXPECTED, patchBytes,
      applyCheck: patchBytes === 0 ? null : applyCheck,
      ucRuns, waitedForTerminalMs: Number(e.M_WAITED),
      preDirtyPaths: preDirty,
      binaryHunksStripped: readInt(path.join(e.M_BENCH, "out", "binary-stripped")),
      failure: e.M_FAILURE || null,
    };
    fs.writeFileSync(path.join(e.M_BENCH, "out", "meta.json"), JSON.stringify(meta, null, 2));
  ' || printf '{"failure":"%s","codexExit":%s,"startedAt":0,"endedAt":0,"baseSha":"","expectedBase":"","patchBytes":0,"applyCheck":null,"ucRuns":[],"waitedForTerminalMs":0}\n' "${META_FAILURE:-harness-setup-failed}" "$CODEX_EXIT" > "$BENCH/out/meta.json"
}
finish() {
  cleanup_git_audit
  write_meta
  if [[ ${BENCH_ARTIFACT_OWNER:-} =~ ^[0-9]+:[0-9]+$ ]]; then
    chown -R "$BENCH_ARTIFACT_OWNER" "$BENCH" "$HOME" "$CODEX_HOME" 2>/dev/null
    chmod 0700 "$BENCH" "$HOME" "$CODEX_HOME" 2>/dev/null
  fi
  sync
  exit 0
}

log "entrypoint arm=$BENCH_ARM timeout=${BENCH_TIMEOUT_SECS}s model=${BENCH_MODEL:-<unset>}"
"$NODE" --version >&2 || { META_FAILURE="toolchain-incompatible"; finish; }
"$CODEX" --version >&2 || { META_FAILURE="toolchain-incompatible"; finish; }
[ "$REPO_DIR" = /app ] || { META_FAILURE="harness-setup-failed"; finish; }
cd "$REPO_DIR" 2>/dev/null || { META_FAILURE="harness-setup-failed"; finish; }

# --- git preflight: uid-mismatch + identity so agent-side git always works ---
git config --global --add safe.directory '*'
git config --global user.email bench@ultracode.local
git config --global user.name 'ultracode bench'
git config --global core.autocrlf false
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_INDEX_FILE GIT_REPLACE_REF_BASE
unset GIT_NAMESPACE GIT_SHALLOW_FILE GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS
export GIT_NO_REPLACE_OBJECTS=1
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=core.fsmonitor
export GIT_CONFIG_VALUE_0=false
export GIT_CONFIG_KEY_1=core.hooksPath
export GIT_CONFIG_VALUE_1=/dev/null
BASE_SHA=$(git rev-parse HEAD 2>/dev/null) || { META_FAILURE="harness-setup-failed"; finish; }
[ -n "${BENCH_BASE_COMMIT:-}" ] && [ "$BASE_SHA" != "$BENCH_BASE_COMMIT" ] && {
  log "base sha $BASE_SHA != dataset base_commit $BENCH_BASE_COMMIT"
  META_FAILURE="base-mismatch"
  finish
}
if ! [[ ${BENCH_TASK_UID:-} =~ ^[0-9]+$ ]] \
  || ! [[ ${BENCH_TASK_GID:-} =~ ^[0-9]+$ ]] \
  || [ "$BENCH_TASK_UID" = 0 ] || [ "$BENCH_TASK_GID" = 0 ] \
  || ! [[ ${BENCH_ARTIFACT_OWNER:-} =~ ^[0-9]+:[0-9]+$ ]]; then
  META_FAILURE="harness-setup-failed"
  finish
fi
ARTIFACT_UID=${BENCH_ARTIFACT_OWNER%%:*}
ARTIFACT_GID=${BENCH_ARTIFACT_OWNER##*:}
if [ "$BENCH_TASK_UID" = "$ARTIFACT_UID" ] || [ "$BENCH_TASK_GID" = "$ARTIFACT_GID" ]; then
  META_FAILURE="harness-setup-failed"
  finish
fi
TASK_UID=$BENCH_TASK_UID
TASK_GID=$BENCH_TASK_GID
if ! git status --porcelain > "$BENCH/out/pre-status.txt" 2>&1; then
  log "image checkout status is unreadable; refusing to launch"
  META_FAILURE="invalid-instance"
  finish
fi
if ! TRACKED_DIRTY=$(git status --porcelain --untracked-files=no 2>/dev/null); then
  log "image checkout tracked status is unreadable; refusing to launch"
  META_FAILURE="invalid-instance"
  finish
fi
[ -n "$TRACKED_DIRTY" ] && {
  log "image checkout has tracked changes; refusing to score a patch against a different base"
  META_FAILURE="invalid-instance"
  finish
}
if ! git status --porcelain -z 2>/dev/null | "$NODE" -e '
  let buf = ""; process.stdin.on("data", (d) => (buf += d)).on("end", () => {
    const paths = [];
    const parts = buf.split("\0").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      // Untracked entries only: image runtime droppings. Tracked files the
      // image shipped modified stay in the diff — resetting them would
      // silently discard agent edits to those same files.
      if (p.startsWith("?? ")) paths.push(":(literal)" + p.slice(3));
      if (p[0] === "R" || p[0] === "C") i++; // rename/copy: next token is the origin path
    }
    process.stdout.write(paths.join("\0"));
  })' > /tmp/predirty.z; then
  log "image checkout pre-dirty paths are unreadable; refusing to launch"
  META_FAILURE="invalid-instance"
  finish
fi

# --- gold-fix leakage guard: privately audit, replace all Git metadata with a
# --- fresh BASE_SHA-only database, and fail before launch on any uncertainty ---
[ "${BENCH_SANITIZE:-}" = 1 ] || {
  META_FAILURE="harness-setup-failed"
  finish
}
GIT_AUDIT_DIR=$(mktemp -d /tmp/ucbench-git-audit.XXXXXX) || {
  META_FAILURE="harness-setup-failed"
  finish
}
chmod 700 "$GIT_AUDIT_DIR"
if ! /opt/bench/sanitize-git.sh "$REPO_DIR" "$BASE_SHA" "$GIT_AUDIT_DIR" \
  > "$GIT_AUDIT_DIR/stdout.log" 2>> "$GIT_AUDIT_DIR/private.log"; then
  log "git history sanitization failed before session launch"
  META_FAILURE="harness-setup-failed"
  finish
fi
AUDIT_OWNER=0
[ "$TASK_UID" = 0 ] && AUDIT_OWNER=65534
chmod -R u+rwX,go-rwx "$GIT_AUDIT_DIR" \
  && chown -R "$AUDIT_OWNER:$AUDIT_OWNER" "$GIT_AUDIT_DIR" || {
  META_FAILURE="ownership-unsafe"
  finish
}
log "git history sanitized and verified at base"

# Root-only image setup is complete. Task-controlled processes run as the host
# owner with no capability or privilege-escalation path, so bind-mounted
# artifacts cannot become hostile root-owned trees.
command -v setpriv >/dev/null 2>&1 || { META_FAILURE="toolchain-incompatible"; finish; }
chown -R "$TASK_UID:$TASK_GID" "$REPO_DIR" "$BENCH" "$HOME" "$CODEX_HOME" "${ULTRACODE_HOME:-$BENCH/uc}" 2>/dev/null || {
  META_FAILURE="ownership-unsafe"
  finish
}

# --- CODEX_HOME from the credential-free arm template. config.toml is rebuilt
# --- from the template every attempt (a stale copy from
# --- a retried run would get keys prepended twice and break codex's parser) ---
mkdir -p "$CODEX_HOME"
rm -f "$CODEX_HOME/config.toml"
cp -an "/opt/bench/codex-home-$BENCH_ARM/." "$CODEX_HOME/"
cp -f "/opt/bench/codex-home-$BENCH_ARM/config.toml" "$CODEX_HOME/config.toml"
case ${BENCH_MODEL_RELAY_BASE_URL:-} in
  http://*/v1|https://*/v1) ;;
  *) META_FAILURE="harness-setup-failed"; finish ;;
esac
if [ -n "${BENCH_MODEL:-}" ] || [ -n "${BENCH_EFFORT:-}" ]; then
  { # top-level keys must precede any [table] in the template
    [ -n "${BENCH_MODEL:-}" ] && printf 'model = "%s"\n' "$BENCH_MODEL"
    [ -n "${BENCH_EFFORT:-}" ] && printf 'model_reasoning_effort = "%s"\n' "$BENCH_EFFORT"
    printf 'model_provider = "swebench_pro_relay"\n'
    cat "$CODEX_HOME/config.toml"
    printf '\n[model_providers.swebench_pro_relay]\n'
    printf 'name = "SWE-bench Pro attested model relay"\n'
    printf 'base_url = "%s"\n' "$BENCH_MODEL_RELAY_BASE_URL"
    printf 'wire_api = "responses"\n'
    printf 'requires_openai_auth = false\n'
  } > /tmp/bench-config.toml && mv /tmp/bench-config.toml "$CODEX_HOME/config.toml"
fi
if [ "$BENCH_ARM" = b ]; then
  mkdir -p "$HOME/.agents"
  cp -a /opt/bench/agents-home-b/. "$HOME/.agents/"
  { # codex spawns MCP servers with a sanitized env — everything the engine and
    # its codex workers need must ride the config env table, not docker -e
    printf '\n[mcp_servers.ultracode.env]\n'
    printf 'CODEX_HOME = "%s"\n' "$CODEX_HOME"
    printf 'ULTRACODE_HOME = "%s"\n' "$ULTRACODE_HOME"
    printf 'ULTRACODE_CODEX_BIN = "%s"\n' "$CODEX"
    printf 'PATH = "%s"\n' "$PATH"
    printf 'HOME = "%s"\n' "$HOME"
  } >> "$CODEX_HOME/config.toml"
fi

# --- the session ---
START=$(date +%s)
timeout -k 60 "$BENCH_TIMEOUT_SECS" setpriv \
  --reuid "$TASK_UID" --regid "$TASK_GID" --clear-groups \
  --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- \
  "$CODEX" exec --json \
  --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  --cd "$REPO_DIR" - < "$BENCH/prompt.txt" \
  > "$BENCH/logs/host.jsonl" 2> "$BENCH/logs/host.stderr.log"
CODEX_EXIT=$?
END=$(date +%s)
log "codex exit=$CODEX_EXIT after $((END - START))s"

# --- arm b: detached ultracode runs outlive codex exec; wait, then stop stragglers ---
active_runs() {
  UC_HOME="$ULTRACODE_HOME" "$NODE" -e '
    const fs = require("fs"), path = require("path");
    const dir = path.join(process.env.UC_HOME, "runs");
    if (!fs.existsSync(dir)) process.exit(0);
    const terminal = new Set(["completed", "failed", "stopped", "orphaned"]);
    for (const d of fs.readdirSync(dir)) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, d, "manifest.json"), "utf8"));
        if (!terminal.has(m.status)) console.log(d);
      } catch { /* half-written manifest: treat as active this tick */ console.log(d); }
    }'
}
if [ "$BENCH_ARM" = b ]; then
  WAIT_START=$(date +%s)
  REMAIN=$((BENCH_TIMEOUT_SECS - (END - START)))
  [ "$REMAIN" -lt 0 ] && REMAIN=0
  DEADLINE=$((WAIT_START + REMAIN))
  while [ -n "$(active_runs)" ] && [ "$(date +%s)" -lt "$DEADLINE" ]; do sleep 10; done
  STRAGGLERS=$(active_runs)
  if [ -n "$STRAGGLERS" ]; then
    log "stopping straggler runs: $STRAGGLERS"
    for r in $STRAGGLERS; do "$NODE" "$UC_MAIN" stop "$r" >&2 || true; done
    STOP_DEADLINE=$(( $(date +%s) + 120 ))
    while [ -n "$(active_runs)" ] && [ "$(date +%s)" -lt "$STOP_DEADLINE" ]; do sleep 5; done
  fi
  WAITED_MS=$(( ($(date +%s) - WAIT_START) * 1000 ))
fi
sleep 2 # settle: let final writes land before capture

# The detailed audit never leaves its root-only directory. Publish only the
# identifier-free proof after Codex and detached task work have ended.
if [ -n "$GIT_AUDIT_DIR" ]; then
  if ! install -m 0644 "$GIT_AUDIT_DIR/safe.txt" "$BENCH/out/git-audit.txt"; then
    log "safe git audit publication failed"
    META_FAILURE="harness-setup-failed"
  fi
  cleanup_git_audit
fi

# Patch capture is immutable harness code but operates on task-controlled Git
# state, so it runs as the task uid with every capability set cleared.
if ! setpriv --reuid "$TASK_UID" --regid "$TASK_GID" --clear-groups \
  --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- \
  /opt/bench/capture-git.sh "$REPO_DIR" "$BASE_SHA" "$BENCH" "$NODE" /tmp/predirty.z; then
  log "post-session Git capture failed"
  META_FAILURE="harness-setup-failed"
fi
finish
