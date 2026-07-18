#!/bin/bash
# In-container driver for one SWE-bench Pro instance x arm. Contract with
# bench/src/session.ts: the arm dir is bind-mounted at /bench; env carries
# BENCH_ARM (a|b), BENCH_TIMEOUT_SECS, BENCH_MODEL, BENCH_EFFORT,
# BENCH_BASE_COMMIT, BENCH_CHOWN (uid:gid), BENCH_SANITIZE (1|0),
# CODEX_HOME=/bench/codex-home, ULTRACODE_HOME=/bench/uc, and optionally
# CODEX_API_KEY / BENCH_REPO_DIR. Everything of value is written under /bench
# before exit, and the script always exits 0 — failures are reported in
# /bench/out/meta.json, never as a container error.
set -uo pipefail

BENCH=/bench
# Images mix glibc and musl userlands; node-sel carries both builds and runtimes.
NODE=/opt/bench/node-sel
CODEX=/opt/bench/bin/codex
UC_MAIN=/opt/bench/ultracode/dist/cli/main.js
REPO_DIR=${BENCH_REPO_DIR:-/app}
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
  ' || printf '{"failure":"%s","codexExit":%s,"startedAt":0,"endedAt":0,"baseSha":"","expectedBase":"","patchBytes":0,"applyCheck":null,"ucRuns":[],"waitedForTerminalMs":0}\n' "${META_FAILURE:-harness-error}" "$CODEX_EXIT" > "$BENCH/out/meta.json"
}
finish() {
  rm -f "$CODEX_HOME/auth.json" # container-side scrub; the driver scrubs again
  write_meta
  [ -n "${BENCH_CHOWN:-}" ] && chown -R "$BENCH_CHOWN" "$BENCH" 2>/dev/null
  sync
  exit 0
}

log "entrypoint arm=$BENCH_ARM timeout=${BENCH_TIMEOUT_SECS}s model=${BENCH_MODEL:-<unset>}"
"$NODE" --version >&2 || { META_FAILURE="toolchain-incompatible"; finish; }
"$CODEX" --version >&2 || { META_FAILURE="toolchain-incompatible"; finish; }
cd "$REPO_DIR" 2>/dev/null || { META_FAILURE="no-app-dir"; finish; }

# --- git preflight: uid-mismatch + identity so agent-side git always works ---
git config --global --add safe.directory '*'
git config --global user.email bench@ultracode.local
git config --global user.name 'ultracode bench'
git config --global core.autocrlf false
BASE_SHA=$(git rev-parse HEAD 2>/dev/null) || { META_FAILURE="no-app-dir"; finish; }
[ -n "${BENCH_BASE_COMMIT:-}" ] && [ "$BASE_SHA" != "$BENCH_BASE_COMMIT" ] && \
  log "WARN base sha $BASE_SHA != dataset base_commit $BENCH_BASE_COMMIT"
git status --porcelain > "$BENCH/out/pre-status.txt" 2>&1
git status --porcelain -z 2>/dev/null | "$NODE" -e '
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
  })' > /tmp/predirty.z

# --- gold-fix leakage guard: audit then strip refs that could reveal the fix ---
if [ "${BENCH_SANITIZE:-1}" = 1 ]; then
  {
    echo "base $BASE_SHA"
    git for-each-ref --format='%(refname) %(objectname)' | while read -r ref sha; do
      commit=$(git rev-parse -q --verify "$ref^{commit}" 2>/dev/null) || continue
      if ! git merge-base --is-ancestor "$commit" "$BASE_SHA" 2>/dev/null; then
        echo "NON-ANCESTOR $ref $commit"
      fi
    done
  } > "$BENCH/out/git-audit.txt" 2>&1
  git remote 2>/dev/null | while read -r r; do git remote remove "$r" 2>/dev/null; done
  CURRENT=$(git rev-parse --abbrev-ref HEAD)
  git for-each-ref --format='%(refname:short)' refs/heads/ | while read -r b; do
    [ "$b" != "$CURRENT" ] && git branch -D "$b" >/dev/null 2>&1
  done
  git tag -l | xargs -r git tag -d >/dev/null 2>&1
  git stash clear 2>/dev/null
  git reflog expire --expire=now --all 2>/dev/null
  rm -f .git/ORIG_HEAD .git/FETCH_HEAD
  git prune --expire=now 2>/dev/null || true
  log "git history sanitized (audit in out/git-audit.txt)"
fi

# --- pre-session snapshot: images ship with untracked runtime state (caches,
# --- redis AOFs, ...); committing it lets the final diff isolate agent work ---
git add -A >/dev/null 2>&1
git commit -q -m 'ucbench pre-session snapshot' --no-verify --allow-empty 2>>"$BENCH/logs/entry.log"
PRE_SHA=$(git rev-parse HEAD)
log "pre-session snapshot $PRE_SHA (base $BASE_SHA)"

# --- CODEX_HOME from the arm template; pre-placed auth.json survives cp -n.
# --- config.toml is rebuilt from the template every attempt (a stale copy from
# --- a retried run would get keys prepended twice and break codex's parser) ---
mkdir -p "$CODEX_HOME"
rm -f "$CODEX_HOME/config.toml"
cp -an "/opt/bench/codex-home-$BENCH_ARM/." "$CODEX_HOME/"
cp -f "/opt/bench/codex-home-$BENCH_ARM/config.toml" "$CODEX_HOME/config.toml"
if [ -n "${BENCH_MODEL:-}" ] || [ -n "${BENCH_EFFORT:-}" ]; then
  { # top-level keys must precede any [table] in the template
    [ -n "${BENCH_MODEL:-}" ] && printf 'model = "%s"\n' "$BENCH_MODEL"
    [ -n "${BENCH_EFFORT:-}" ] && printf 'model_reasoning_effort = "%s"\n' "$BENCH_EFFORT"
    cat "$CODEX_HOME/config.toml"
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
    [ -n "${CODEX_API_KEY:-}" ] && printf 'CODEX_API_KEY = "%s"\n' "$CODEX_API_KEY"
  } >> "$CODEX_HOME/config.toml"
fi

# --- the session ---
START=$(date +%s)
timeout -k 60 "$BENCH_TIMEOUT_SECS" "$CODEX" exec --json \
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
  [ "$REMAIN" -lt 300 ] && REMAIN=300
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

# --- patch capture: diff agent work against the pre-session snapshot, keeping
# --- pre-dirty runtime paths and bench droppings out; binary hunks stripped to
# --- mirror the official harness (it strips them before git apply) ---
git add -A >/dev/null 2>&1
if [ -s /tmp/predirty.z ]; then
  xargs -0 git reset -q -- < /tmp/predirty.z >/dev/null 2>&1
fi
git -c core.quotePath=false diff --no-color --no-ext-diff --cached "$PRE_SHA" -- . \
  ':(exclude).ultracode' ':(exclude).agents' ':(exclude).codex' ':(exclude)*.workflow.js' \
  > "$BENCH/out/patch.full.diff" 2>>"$BENCH/logs/entry.log"
"$NODE" -e '
  const fs = require("fs");
  const full = fs.readFileSync("/bench/out/patch.full.diff", "utf8");
  const sections = full.length ? full.split(/^(?=diff --git )/m) : [];
  let stripped = 0;
  const kept = sections.filter((s) => {
    if (/^Binary files .* differ$/m.test(s) || /^GIT binary patch$/m.test(s)) { stripped++; return false; }
    return true;
  });
  fs.writeFileSync("/bench/out/patch.diff", kept.join(""));
  fs.writeFileSync("/bench/out/binary-stripped", String(stripped));
' 2>>"$BENCH/logs/entry.log" || cp "$BENCH/out/patch.full.diff" "$BENCH/out/patch.diff"
if [ -s "$BENCH/out/patch.diff" ]; then
  git reset --hard "$BASE_SHA" >/dev/null 2>&1  # junk from the snapshot drops out: eval-faithful base tree
  if git apply --check --whitespace=nowarn "$BENCH/out/patch.diff" 2>>"$BENCH/logs/entry.log"; then
    echo ok > "$BENCH/out/apply-check"
  else
    echo fail > "$BENCH/out/apply-check"
  fi
fi
finish
