# Supported versions & platform notes

Backend adapters are pinned against the CLI versions verified during
development. These CLIs move fast; when a version bumps, re-record the golden
fixtures (`test/fixtures/*/record.sh` where present) and re-run the live smoke
tests before trusting a new parser path.

| Backend | Verified CLI | Structured output | Notes |
|---|---|---|---|
| codex | codex-cli **0.142.4** (exec stream re-verified live on **0.144.4**) | native `--output-schema` (strict subset) | LIVE-tested (parser + full parity demo). The rollout sidecar (live tokens/model) is verified against **0.144.4** rollout files + the recorder source. `CODEX_API_KEY` is the parallel-safe auth. Worker isolation replaces the ultracode MCP entry with a disabled stub (`-c mcp_servers.ultracode={command="true",enabled=false}`) on every worker spawn — valid TOML whether or not the server is registered, so it is a no-op when absent and a kill-switch when present. LIVE-verified on **0.144.5** across all four cases (user-scope × project-scope `.codex/config.toml`, registered × absent): `-c` is the top config layer and beats both. `exec resume` LIVE-verified on **0.144.5** including resume of a session SIGKILLed mid-turn (same thread id re-emitted; `turn.completed` usage is thread-cumulative): the resume subcommand rejects `--cd`/`--sandbox` with a usage error — the workspace is the process cwd and the sandbox rides `-c sandbox_mode=...`. |
| claude | Claude Code **2.1.200** | native `--json-schema` | LIVE-tested (parser + typed workflow). |
| qoder | @qoder-ai/qodercli **1.0.37** legacy envelope fixtures; **1.1.4** argument surface + live context-telemetry stream | emulated (prompt contract + local ajv) | Envelope compatibility is fixture-verified without a PAT; the request-ID/context-ratio shape is verified from the sanitized live 1.1.4 capture in `test/fixtures/qoder/context-usage.jsonl`. Qoder exposes no supported structured-output schema flag, so schemas are enforced through the shared prompt/validation/repair loop. `--reasoning-effort` and positive-integer `--context-window` require 1.1.1+ and are passed on spawn and resume only when requested; unset controls preserve the older argv. Native Workflow tool is the primary Qoder path. |
| gemini | Gemini CLI (docs) | emulated (prompt contract) | fixture-verified only. |
| mock | built-in | schema-aware stubs | the `--dry-run` and test substrate. |

## MCP hosts

The MCP triad is version-agnostic: `workflow_status` long-polls under the
host's tool timeout (explicit `waitSeconds` ≤3600, default 25s), and the quiet
monitor (`until = "terminal"`) parks silently for the whole hold —
`ultracode install codex` pins `tool_timeout_sec = 3600` (user scope), so one
hold covers ~55 min (stock
codex 300s, Qoder/Gemini 600s). Doctrine states holds as concrete per-host
numbers and the server nudges quiet holds under 240s (models hedge ambiguous
rules toward tiny waits). Verified on codex-rs **0.144.5**: progress
notifications never extend a tool timeout, and a client-side timeout never
cancels the request server-side. Codex per-model instructions mandate a ≤60s
commentary cadence (gpt-5.6\*; 30s on 5.5/5.4; none on 5.2) — the skill and
in-band response nudges reframe a parked hold as idle time, and
`until = "phase"` provides sanctioned milestone wakes. Never declares
`taskSupport` (`required` breaks Qoder; codex pins protocol 2025-06-18 and
rejects `tasks/*`).

## Platform

- **Linux, macOS**: supported (CI runs both). Both bind per-worker process
  groups to an OS-reported process start-time before replaying persisted cleanup
  records. Linux additionally sweeps a high-entropy inherited lifecycle token
  through `/proc` so Codex/bwrap descendants that create a new session are
  still reaped on completion, timeout, stop, and runner failure.
- **Windows**: **not supported in v1** — the engine relies on POSIX process
  groups (`setsid` / `kill(-pgid)`) for stop/kill-tree and O_APPEND atomicity.
  A `win32` startup error points to WSL. A Windows port (Job Objects /
  `taskkill /T`) is future work.

## Live-testing gate

Adapter smoke tests that spend real tokens are opt-in: set `UC_LIVE_TESTS=1`
and provide the backend's credentials. The default test suite is fully offline
(mock backend + golden fixtures).
