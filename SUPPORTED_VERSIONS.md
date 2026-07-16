# Supported versions & platform notes

Backend adapters are pinned against the CLI versions verified during
development. These CLIs move fast; when a version bumps, re-record the golden
fixtures (`test/fixtures/*/record.sh` where present) and re-run the live smoke
tests before trusting a new parser path.

| Backend | Verified CLI | Structured output | Notes |
|---|---|---|---|
| codex | codex-cli **0.142.4** (exec stream re-verified live on **0.144.4**) | native `--output-schema` (strict subset) | LIVE-tested (parser + full parity demo). The rollout sidecar (live tokens/model) is verified against **0.144.4** rollout files + the recorder source. `CODEX_API_KEY` is the parallel-safe auth. Worker isolation replaces the ultracode MCP entry with a disabled stub (`-c mcp_servers.ultracode={command="true",enabled=false}`) on every worker spawn — valid TOML whether or not the server is registered, so it is a no-op when absent and a kill-switch when present. LIVE-verified on **0.144.5** across all four cases (user-scope × project-scope `.codex/config.toml`, registered × absent): `-c` is the top config layer and beats both. |
| claude | Claude Code **2.1.200** | native `--json-schema` | LIVE-tested (parser + typed workflow). |
| qoder | @qoder-ai/qodercli **1.0.37** (decompiled) | native `--json-schema` (undocumented) | fixture-verified only (no PAT at build time). Native Workflow tool is the primary Qoder path. |
| gemini | Gemini CLI (docs) | emulated (prompt contract) | fixture-verified only. |
| mock | built-in | schema-aware stubs | the `--dry-run` and test substrate. |

## MCP hosts

The MCP triad is version-agnostic by design: `workflow_status` long-polls ≤50s,
under every host's tool timeout (60s legacy Codex, 300s current Codex, 600s
Qoder/Gemini). Never declares `taskSupport` (a `required` declaration breaks
Qoder clients).

## Platform

- **Linux, macOS**: supported (CI runs both).
- **Windows**: **not supported in v1** — the engine relies on POSIX process
  groups (`setsid` / `kill(-pgid)`) for stop/kill-tree and O_APPEND atomicity.
  A `win32` startup error points to WSL. A Windows port (Job Objects /
  `taskkill /T`) is future work.

## Live-testing gate

Adapter smoke tests that spend real tokens are opt-in: set `UC_LIVE_TESTS=1`
and provide the backend's credentials. The default test suite is fully offline
(mock backend + golden fixtures).
