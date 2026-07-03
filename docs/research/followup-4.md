# GAP: Safety of N parallel codex exec / qodercli processes: auth-token refresh races, session-file contention, and per-worker home-dir isolation requirements

# Parallel-safety of `codex exec` and `qodercli -p`: auth races, shared-home contention, isolation recipes

All findings verified 2026-07-03/04. Codex evidence is from the `openai/codex` main branch (latest release `rust-v0.142.5`, published 2026-07-01; local install confirmed 0.142.4) plus official docs and issue tracker. Qoder evidence is from docs.qoder.com (CLI npm `@qoder-ai/qodercli`, latest 1.0.37 published 2026-07-03) — Qoder CLI is closed-source, so disk-layout claims are docs/community-based.

---

## 1. Codex: auth.json concurrency — code-level facts

### 1.1 Where the code lives (repo was restructured)
Auth is no longer in `codex-rs/core/src/auth.rs`. Current locations:
- `codex-rs/login/src/auth/storage.rs` — auth.json read/write (`FileAuthStorage`)
- `codex-rs/login/src/auth/manager.rs` — `AuthManager`, refresh logic, env-var handling
- `codex-rs/utils/home-dir/src/lib.rs` — `find_codex_home()` (CODEX_HOME resolution)

### 1.2 auth.json writes are NOT atomic and NOT lock-protected
`FileAuthStorage::save()` in `codex-rs/login/src/auth/storage.rs` (https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs):
```rust
let mut options = OpenOptions::new();
options.truncate(true).write(true).create(true);   // mode 0o600 on unix
let mut file = options.open(auth_file)?;
file.write_all(json_data.as_bytes())?;
```
- **In-place truncate+write. No temp-file+rename, no flock/advisory lock.** A concurrent reader can observe a truncated/partial auth.json (torn read → JSON parse error).
- Reads (`try_read_auth_json`) are plain unlocked reads.
- This hazard is acknowledged by OpenAI's own unmerged PR #8645, whose description says it "adds bounded retries on transient auth.json parse errors to handle **concurrent truncate+write**" (https://github.com/openai/codex/pull/8645 — merged_at: null, i.e. the parse-retry hardening was NOT merged).

### 1.3 Refresh synchronization: in-process only, plus a best-effort cross-process "guarded reload"
In `codex-rs/login/src/auth/manager.rs` (https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs):
- `AuthManager.refresh_lock: Semaphore::new(1)` — serializes refresh **within one process only**. There is **no cross-process file lock anywhere in the auth path**.
- `refresh_token()` implements a guarded reload (doc comment verbatim): *"Attempt to refresh the token by first performing a guarded reload. Auth is reloaded from storage only when the account id matches the currently cached account id. If the persisted token differs from the cached token, we can assume that some other instance already refreshed it. If the persisted token is the same as the cached, then ask the token authority to refresh."* → `ReloadOutcome::ReloadedChanged` skips the network refresh; `ReloadedNoChange` proceeds to `refresh_token_from_authority_impl()`.
- 401 recovery (`UnauthorizedRecovery` state machine): step 1 = **Reload from disk** (pick up a token another process rotated), step 2 = network `RefreshToken`, then Done. Added by PR #8880 "Attempt to reload auth as a step in 401 recovery", merged 2026-01-08 (https://github.com/openai/codex/pull/8880).
- Proactive refresh (`should_refresh_proactively`): refreshes when the access-token JWT `exp` is within `CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5` minutes, or when `last_refresh` is older than `TOKEN_REFRESH_INTERVAL = 8` days. Near-expiry proactive refresh landed via PR #23546, merged 2026-05-28 (https://github.com/openai/codex/pull/23546).
- Refresh failure classification (`classify_refresh_token_failure`): `refresh_token_reused` → `Exhausted`, `refresh_token_expired` → `Expired`, `refresh_token_invalidated` → `Revoked`; permanent failures are cached (`record_permanent_refresh_failure_if_unchanged`). Error string: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."

**Net verdict on the race:** OAuth refresh tokens are single-use (rotating). The guarded reload closes most of the window, but N processes that decide to refresh within the same few hundred ms (e.g., N workers spawned simultaneously with a token <5 min from expiry, or all >8 days since last_refresh) can all pass the "reload showed no change" check and race the POST to `https://auth.openai.com/oauth/token`; losers get `refresh_token_reused`. Losers usually self-heal on the next 401 via the disk-reload step, *provided* the winner's tokens hit disk intact (see 1.2 torn-write risk). Reuse detection can also invalidate the token family server-side — numerous open issues show persistent "refresh token was already used" states requiring re-login: #24365, #17340, #12755, #25379, #25599 (all open as of 2026-06). The canonical race issue #10332 ("Race condition in OAuth token refresh ... when multiple app-server instances run concurrently", codex 0.93.0) was **closed as not planned** with no fix (https://github.com/openai/codex/issues/10332).

### 1.4 Copying auth.json into per-worker homes is explicitly unsupported
- Official CI/CD doc (https://developers.openai.com/codex/auth/ci-cd-auth): copy `auth.json` once, let Codex refresh it in place, and — verbatim — **"Do not share the same file across concurrent jobs or multiple machines."** After refresh, "Codex writes the new tokens and a new `last_refresh` back to `auth.json`". If `last_refresh` is older than ~8 days it refreshes before the run continues.
- Issue #15410 "[FEATURE] CODEX_HOME should support shared auth with isolated config/skills" — **closed not_planned** (https://github.com/openai/codex/issues/15410): refresh tokens are effectively single-use; once one instance refreshes, other copies become invalid.
- Issue #15502 (open, codex 0.116.0) documents the copy flow failing even cross-machine: refresh executes, `last_refresh` updates, session still rejected (https://github.com/openai/codex/issues/15502).
- Issue #26303 (open, codex 0.136.0, 2026-06): even **sequential** batched `codex exec` runs under ChatGPT auth die after ~3 runs with `401 / token_invalidated / Failed to refresh token / app_session_terminated`, then stall ~7 minutes reconnecting (https://github.com/openai/codex/issues/26303). ChatGPT-auth automation fan-out is fragile server-side, not just file-race fragile.

**Implication:** for ChatGPT auth, per-worker CODEX_HOME with N copies of auth.json is WORSE than one shared home (N independent refresh attempts on the same single-use refresh token, with no shared file for losers to reload from). The only robust fan-out auth is env-key auth.

### 1.5 CODEX_API_KEY fully bypasses auth.json for `codex exec` — confirmed in code
`codex-rs/login/src/auth/manager.rs`, `load_auth()`:
```rust
// API key via env var takes precedence over any other auth method.
if enable_codex_api_key_env && let Some(api_key) = read_codex_api_key_from_env() {
    return Ok(Some(CodexAuth::from_api_key(api_key.as_str())));
}
```
This short-circuits before any auth.json read. `codex-rs/exec/src/lib.rs` sets `enable_codex_api_key_env: true` (the TUI path uses `false` — CODEX_API_KEY is **exec-only**, matching the docs: "Set `CODEX_API_KEY` inline for a single run. The variable is only supported in `codex exec`" — https://developers.openai.com/codex/noninteractive). API-key auth is excluded from refresh entirely (`refresh_token()` early-returns for `is_api_key_auth() || is_personal_access_token_auth()`), and `UnauthorizedRecovery` does nothing for it. Env var names in code: `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` (accepts a Codex Personal Access Token or agent-identity JWT; PAT is classified "not_refreshable_auth" — no refresh, no race), `OPENAI_API_KEY` (NOT consulted by `load_auth` from env; it only appears as the `"OPENAI_API_KEY"` field *inside* auth.json written by `codex login --api-key`).

### 1.6 CODEX_HOME relocates everything — with one gotcha
`find_codex_home()` (`codex-rs/utils/home-dir/src/lib.rs`): uses `$CODEX_HOME` if set and non-empty, else `~/.codex`. **Gotcha: if CODEX_HOME is set, the path must already exist and be a directory, else Codex errors out** ("CODEX_HOME points to ... but that path does not exist"). Orchestrator must `mkdir -p` per-worker homes before spawn.

Everything lives under CODEX_HOME (verified against a live ~/.codex on 0.142.x): `config.toml`, `auth.json`, `sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuidv7>.jsonl`, `archived_sessions/`, `session_index.jsonl`, `history.jsonl`, `state_5.sqlite`, `logs_2.sqlite(+-wal/-shm)`, `goals_1.sqlite`, `memories_1.sqlite`, `models_cache.json`, `skills/`, `plugins/`, `hooks.json`, `log/`, `shell_snapshots/`, `cache/`, `.tmp/`. Exceptions/overrides: `sqlite_home` config key / `$CODEX_SQLITE_HOME` env relocates only the SQLite DBs (`codex-rs/state/src/lib.rs`: `pub const SQLITE_HOME_ENV: &str = "CODEX_SQLITE_HOME";`); `log_dir` config key relocates logs (default `$CODEX_HOME/log`). Docs: https://developers.openai.com/codex/config-reference

### 1.7 Non-auth shared-home contention (N concurrent `codex exec`, one CODEX_HOME)
- **Rollout/session files:** one file per session, unique name `rollout-{timestamp}-{uuid_v7}.jsonl` under `sessions/YYYY/MM/DD/` — no cross-process contention. `--ephemeral` skips writing them entirely (https://developers.openai.com/codex/noninteractive).
- **history.jsonl:** `codex-rs/message-history/src/lib.rs` — O_APPEND single-write(2) lines plus **advisory file locking (`File::try_lock`) with retry (10 tries × 100 ms)** — cross-process safe by design ("concurrent writes from multiple TUI processes do not interleave").
- **session_index.jsonl:** `codex-rs/rollout/src/session_index.rs` — O_APPEND + in-process mutex only; appends of one small JSON line are effectively atomic; rewrite-on-delete uses tmp+rename. Low risk.
- **SQLite DBs (state_5/logs_2/goals_1/memories_1):** `codex-rs/state/src/runtime.rs` opens with `journal_mode(WAL)`, `synchronous(NORMAL)`, `busy_timeout(5s)`. WAL supports multi-process use; 6–16 concurrent writers is within design, though sustained bursts can exceed the 5 s busy timeout (the code has `sqlite_error_detail_is_lock` detection and rollout-fallback metrics, i.e. lock errors degrade gracefully to file-based rollouts rather than corrupt).
- Nothing session-related is written into the repo working dir by codex itself (AGENTS.md is read-only input), so N `codex exec` in one repo conflict only through whatever the agents themselves edit.

### 1.8 Per-host verdict — Codex
- **ChatGPT (OAuth) auth + shared ~/.codex:** tolerable for short bursts (guarded reload + 401-reload recovery, merged Jan 2026, are specifically for concurrent CLI instances), but genuinely racy at refresh boundaries; failure mode ranges from transient turn failures to a family-revoked login (re-auth required). Official guidance prohibits sharing auth.json across concurrent jobs. Issue #26303 shows even sequential exec batches can be killed server-side.
- **ChatGPT auth + per-worker CODEX_HOME (auth.json copies): DO NOT.** Single-use refresh tokens make copies mutually invalidating (#15410 not_planned, #15502, ci-cd-auth doc).
- **CODEX_API_KEY (or CODEX_ACCESS_TOKEN PAT): fully safe for any N.** No auth.json read, no refresh, no state. This is the orchestrator-grade answer.
- Non-auth shared-home state is concurrency-safe enough (WAL sqlite, locked history appends, unique rollout files) that **shared CODEX_HOME + CODEX_API_KEY is the recommended topology**: keeps one config.toml (MCP servers, profiles), one skills/plugins dir, and all rollouts in one `sessions/` tree so `codex exec resume <SESSION_ID>` works from any worker.

### 1.9 Minimal env recipe — Codex worker
```bash
# Preferred: shared home, key auth (no auth races; config/MCP/skills/sessions shared)
CODEX_API_KEY=$OPENAI_KEY codex exec --json --skip-git-repo-check \
  -o /out/w1.last.md "…prompt…"

# Full isolation variant (only if state separation is required):
mkdir -p "$WORK/home"                              # must pre-exist!
cp ~/.codex/config.toml "$WORK/home/"              # MCP servers/profiles live here
ln -s ~/.codex/skills "$WORK/home/skills"          # optional; plugins likewise
CODEX_HOME="$WORK/home" CODEX_API_KEY=$KEY codex exec --json "…"
# never copy auth.json into worker homes under ChatGPT auth
# resume note: rollouts + state DB live in that worker's CODEX_HOME; resume must use the same CODEX_HOME
# knobs: --ignore-user-config, --ephemeral, -c key=value overrides, CODEX_SQLITE_HOME
```

---

## 2. Qoder CLI (`qodercli`)

### 2.1 PAT auth is stateless/per-process — with a precedence trap
- Env var: `QODER_PERSONAL_ACCESS_TOKEN`, documented for "non-interactive sessions or automated environments (e.g., CI/CD pipelines)" (https://docs.qoder.com/en/cli/quick-start). Token from https://qoder.com/account/integrations.
- The SDK/CLI reads the env var at each invocation; SDK auth doc: PATs are **not auto-refreshed** — *"The SDK does not automatically refresh PATs"*; custom env names supported via `accessTokenFromEnv('MY_QODER_PAT')`; `options.env` beats `process.env` (https://docs.qoder.com/en/cli/sdk/authentication). No rotation → no refresh race by construction.
- **Precedence trap (verbatim from quick-start):** *"If a valid token is set both via the `/login` command and this environment variable, the token provided through `/login` will take precedence."* So a stored interactive login in the (shared) home silently overrides per-worker env PATs. For deterministic fan-out, ensure no `/login` credential exists on the orchestrator host (or isolate `HOME`). Corollary: env-PAT auth writes nothing — *"If you authenticated using the `QODER_PERSONAL_ACCESS_TOKEN` environment variable, you must unset the variable before running `/logout`"* (logout only operates on stored credentials).
- CI proof-of-pattern: `QoderAI/qoder-action` passes `qoder_personal_access_token` → env on a fresh runner every run — pure stateless PAT (https://github.com/QoderAI/qoder-action). Community `qoder-proxy` spawns a `qodercli` process **per request** concurrently with a single env PAT and documents no locking/corruption issues, only CPU/RAM spikes (~1 active request per 1–2 vCPU guidance) (https://github.com/foxy1402/qoder-proxy).

### 2.2 ~/.qoder writes during `-p` runs
Documented ~/.qoder contents: `~/.qoder/settings.json` (user settings incl. user-scope MCP servers), `~/.qoder/AGENTS.md` (user memory), `~/.qoder/agents/<name>.md` (https://docs.qoder.com/en/cli/quick-start, https://docs.qoder.com/en/cli/using-cli, https://docs.qoder.com/en/cli/mcp-servers.md). Sessions ARE persisted somewhere CLI-side — resume works (`qodercli -c`, `-r <session-id>`, and SDK `resume`/`continue`/`forkSession` fields; sessions are UUID-keyed "persisted conversation history on the CLI side (including context, tool call records, compaction boundaries)" — https://docs.qoder.com/en/cli/sdk/session-control.md) — but **the on-disk session path is undocumented** (presumed under ~/.qoder; unverifiable without an install, CLI is closed-source). No lock files documented; no public reports of session-file contention or PAT/auth corruption under parallelism were found on forum.qoder.com or GitHub as of 2026-07-04 (only unrelated IDE bugs, e.g. runaway `qoder` processes OOM thread: https://forum.qoder.com/t/runaway-child-processes-qoder-sh-accumulate-1000-leading-to-system-wide-oom-unrelated-desktop-apps-killed-first/8389).
- Sessions are UUID-keyed → concurrent `-p` runs write distinct session records; contention surface is at most a shared index, for which no corruption reports exist.
- Qoder ships first-class parallelism: `--worktree [name]` "Git worktrees to run tasks in parallel, avoiding read/write conflicts", `qodercli jobs --worktree`, resume prints `cd <worktree-path> && qodercli --resume <session-id>` (https://docs.qoder.com/en/cli/using-cli) — parallel sessions against one repo are an intended, supported mode, implying shared-home session storage is concurrency-tolerant.

### 2.3 No home-override env var; project config travels with the repo
- No `QODER_HOME`/`QODER_CONFIG_DIR`-style variable is documented anywhere. Isolation, if wanted, is `HOME=<dir> qodercli …` (qodercli is a Node CLI; `os.homedir()` honors `$HOME` on POSIX — inference, not doc-verified).
- Per-worker HOME isolation loses little: project-level config lives in the repo and is inherited regardless — `${project}/.qoder/settings.json` + `settings.local.json` (highest precedence), `${project}/.mcp.json` (project-scope MCP), `${project}/AGENTS.md` / `AGENTS.local.md`, `${project}/agents/`. Only user-level `~/.qoder/settings.json`, `~/.qoder/AGENTS.md`, `~/.qoder/agents/` would need copying into an isolated HOME (https://docs.qoder.com/en/cli/mcp-servers.md, https://docs.qoder.com/en/cli/using-cli).

### 2.4 Rate limits per PAT
No documented per-PAT request rate limits or concurrency caps in docs.qoder.com, qoder-action, or the forum. Qoder bills by plan Credits (forum thread "Coding / Token plan use": https://forum.qoder.com/t/coding-token-plan-use/7861); N parallel workers burn Credits N× faster but no explicit 429/concurrency policy is published. Treat as unknown; add retry-on-429 defensively.

### 2.5 Per-host verdict — Qoder
**Shared home is safe** for N parallel `qodercli -p --yolo` workers using env-PAT auth: auth is stateless per process (no refresh, nothing written), sessions are UUID-scoped, and parallel same-repo work is a first-class feature via `--worktree`. Per-worker HOME is unnecessary; only do it if you need different PATs per worker *and* a `/login` credential exists (precedence trap), or to quarantine session history.

### 2.6 Minimal env recipe — Qoder worker
```bash
export QODER_PERSONAL_ACCESS_TOKEN="$PAT"   # ensure no /login credential is stored, it would win
qodercli -p "…prompt…" --yolo --output-format=stream-json \
  --max-turns 40 -w "$REPO"                  # or --worktree jobname --branch fix/x for same-repo parallel
# resume later: qodercli -r <session-id>  (same $HOME required, since session store is under it)
# full isolation variant: HOME="$WORK/home" (copy ~/.qoder/settings.json in if user-level MCP needed);
# project .qoder/settings.json, .mcp.json, AGENTS.md are picked up from the repo either way
```

---

## 3. Orchestrator decision table

| Host + auth | Shared home, N workers | Per-worker home | Recommendation |
|---|---|---|---|
| codex exec + ChatGPT OAuth | Racy at refresh boundaries (guarded reload mitigates; torn truncate+write unfixed; family revocation possible); officially discouraged for concurrent jobs | **Broken** — auth.json copies mutually invalidate (single-use refresh tokens, #15410 not_planned) | Don't fan out on ChatGPT auth. If forced: single shared home, cap concurrency, expect transient 401s, and pre-warm the token (run one `codex exec` to completion before spawning the fleet, so no worker starts inside the 5-min refresh window) |
| codex exec + `CODEX_API_KEY` | Safe (auth bypassed; sqlite WAL 5s busy timeout; history flock; unique rollout files) | Works but unnecessary; CODEX_HOME dir must pre-exist and needs config.toml copied for MCP/profiles | **Shared CODEX_HOME + per-process `CODEX_API_KEY`** — keeps MCP config, skills, and resumable sessions centralized |
| codex exec + `CODEX_ACCESS_TOKEN` (Codex PAT) | Safe (classified not-refreshable; no refresh path) | Same as API key | Alternative when org policy provides PATs, not API keys |
| qodercli -p + env PAT | Safe (stateless per-process auth; no refresh; UUID sessions; `--worktree` designed for parallel) | Only needed to defeat the `/login`-beats-env precedence or to shard session stores; via `HOME=` override (no QODER_HOME var exists) | **Shared home + `QODER_PERSONAL_ACCESS_TOKEN`**, guard: never `/login` on the orchestrator account |

## KEY FACTS
- Codex auth.json save() is a non-atomic in-place truncate+write (OpenOptions truncate(true).write(true).create(true), mode 0600) with no flock and no temp-file rename; concurrent readers can see torn/partial JSON [https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs (FileAuthStorage::save)]
- Codex token refresh is serialized only in-process (AuthManager.refresh_lock: tokio Semaphore(1)); cross-process protection is a best-effort 'guarded reload' that re-reads auth.json and skips refresh if the persisted token changed — no cross-process lock exists [https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs (refresh_token, refresh_lock)]
- 401 recovery in Codex reloads auth.json from disk (account-id-matched) before attempting a network refresh — merged 2026-01-08 via PR #8880 'Attempt to reload auth as a step in 401 recovery' [https://github.com/openai/codex/pull/8880]
- Proactive refresh triggers when access-token JWT exp is within 5 minutes (CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES=5, PR #23546 merged 2026-05-28) or last_refresh older than 8 days (TOKEN_REFRESH_INTERVAL=8) [https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs and https://github.com/openai/codex/pull/23546]
- Issue #10332 (multi-instance OAuth refresh race, 'refresh token was already used', codex 0.93.0) was closed as not planned; multiple issues with the same error remain open as of June 2026 (#24365, #17340, #12755, #25379, #25599) [https://github.com/openai/codex/issues/10332]
- Official CI/CD auth doc: seed auth.json once, let Codex refresh in place, and 'Do not share the same file across concurrent jobs or multiple machines' [https://developers.openai.com/codex/auth/ci-cd-auth]
- Copying auth.json into multiple CODEX_HOMEs is mutually invalidating because refresh tokens are single-use; feature request for shared-auth/isolated-config CODEX_HOME (#15410) closed not_planned; #15502 documents the copy flow failing; #26303 shows even sequential codex exec batches on ChatGPT auth get token_invalidated [https://github.com/openai/codex/issues/15410 , https://github.com/openai/codex/issues/15502 , https://github.com/openai/codex/issues/26303]
- CODEX_API_KEY fully bypasses auth.json: load_auth() returns CodexAuth::from_api_key before any storage read when enable_codex_api_key_env is true, which codex exec sets (exec-only; TUI does not); API-key and PAT auth are excluded from refresh entirely. CODEX_ACCESS_TOKEN (Codex PAT / agent-identity JWT) is also env-only and non-refreshable [https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs (load_auth) and https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs (enable_codex_api_key_env: true); https://developers.openai.com/codex/noninteractive]
- CODEX_HOME env relocates all state (config.toml, auth.json, sessions/, session_index.jsonl, history.jsonl, sqlite DBs, skills/, plugins/, log/), but the directory must already exist or Codex errors; CODEX_SQLITE_HOME can separately relocate the sqlite DBs; log_dir config relocates logs [https://github.com/openai/codex/blob/main/codex-rs/utils/home-dir/src/lib.rs (find_codex_home) and https://github.com/openai/codex/blob/main/codex-rs/state/src/lib.rs (SQLITE_HOME_ENV)]
- Non-auth shared-CODEX_HOME state is concurrency-tolerant: rollout files are per-session unique (sessions/YYYY/MM/DD/rollout-<ts>-<uuidv7>.jsonl), history.jsonl appends use advisory File::try_lock with 10x100ms retry, sqlite DBs open with WAL + busy_timeout(5s) + synchronous(NORMAL) [https://github.com/openai/codex/blob/main/codex-rs/message-history/src/lib.rs and https://github.com/openai/codex/blob/main/codex-rs/state/src/runtime.rs (base_sqlite_options)]
- QODER_PERSONAL_ACCESS_TOKEN is read per-invocation and never auto-refreshed ('The SDK does not automatically refresh PATs'); env-PAT auth stores nothing on disk (must unset the var before /logout); custom env names via accessTokenFromEnv() [https://docs.qoder.com/en/cli/sdk/authentication and https://docs.qoder.com/en/cli/quick-start]
- Qoder precedence trap: 'If a valid token is set both via the /login command and this environment variable, the token provided through /login will take precedence' — a stored interactive login overrides per-worker env PATs [https://docs.qoder.com/en/cli/quick-start]
- qodercli has first-class parallel support: --worktree [name] runs sessions in separate git worktrees 'to run tasks in parallel, avoiding read/write conflicts'; sessions are UUID-keyed and resumable via -c / -r <session-id>; no QODER_HOME-style env var is documented (HOME override is the only isolation lever) [https://docs.qoder.com/en/cli/using-cli and https://docs.qoder.com/en/cli/sdk/session-control.md]
- Qoder config propagation survives HOME isolation: project-level ${project}/.qoder/settings.json + settings.local.json, ${project}/.mcp.json, ${project}/AGENTS.md travel with the repo; only user-level ~/.qoder/settings.json (user-scope MCP), ~/.qoder/AGENTS.md, ~/.qoder/agents/ would need copying [https://docs.qoder.com/en/cli/mcp-servers.md and https://docs.qoder.com/en/cli/using-cli]
- No public reports of qodercli auth/session corruption under concurrency exist (forum.qoder.com + GitHub searched 2026-07-04); community qoder-proxy spawns qodercli per-request concurrently on one env PAT with no locking issues reported; no per-PAT rate limits are documented (billing is plan Credits) [https://github.com/foxy1402/qoder-proxy and https://forum.qoder.com/t/coding-token-plan-use/7861]
- Versions checked: codex latest release rust-v0.142.5 (2026-07-01); @qoder-ai/qodercli latest 1.0.37 (2026-07-03) [https://github.com/openai/codex/releases and https://registry.npmjs.org/@qoder-ai/qodercli]

## UNCERTAINTIES
- Qoder CLI's on-disk session storage path and format are undocumented and the CLI is closed-source; 'sessions are persisted CLI-side' is confirmed (resume works) but whether any shared index/lock file under ~/.qoder is written during -p runs could not be verified without an installed copy (qodercli was not installed on this machine).
- HOME= override as the qodercli isolation mechanism is an inference from it being a Node CLI (os.homedir() honors $HOME on POSIX); no doc confirms a home-relocation mechanism, and Windows behavior (USERPROFILE) is untested.
- Per-PAT rate limits / concurrency caps for Qoder are not published anywhere found; absence of evidence, not evidence of absence — defensive 429 handling is advised.
- Whether OpenAI's OAuth server revokes the whole refresh-token family on reuse detection (turning a transient race loss into a forced re-login) is not confirmable from code; open issues (#24365, #17340, #25379) are consistent with it happening at least sometimes, and #26303 suggests additional server-side session heuristics kill batched exec runs on ChatGPT auth for reasons beyond the file race.
- ChatGPT access-token TTL (and hence how often the 5-minute proactive-refresh window is hit during a long parallel run) was not determined; the refresh-race exposure per hour of fan-out is therefore unquantified.
- The 'guarded reload' race window (all N workers reload-then-refresh within the same ~100s of ms) is reasoned from the code path, not reproduced experimentally.
- codex-rs models_cache.json write atomicity was not fully traced (cache-only data; worst case is a re-fetch).
- Qoder docs' claim that /login-stored tokens beat the env PAT was quoted from the official quick-start page, but which on-disk file holds the /login credential (keychain vs ~/.qoder file) is undocumented.