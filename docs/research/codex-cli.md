# OpenAI Codex CLI (mid-2026): Extension Surfaces + Programmatic/Subagent Driving

Research date: 2026-07-03/04. Latest release at research time: **0.142.5 (Jul 1, 2026)**; repo is ~96% Rust, 894 releases, docs live at developers.openai.com/codex (repo `docs/*.md` are mostly stubs pointing there) ([github.com/openai/codex](https://github.com/openai/codex)).

---

## 1. Extension surfaces

### 1.1 Custom prompts (~/.codex/prompts/*.md) — DEPRECATED, still works
- Official page: https://developers.openai.com/codex/custom-prompts — banner: "Custom prompts are deprecated. Use skills for reusable instructions that Codex can invoke explicitly or implicitly."
- Mechanics (still functional): Markdown files directly under `~/.codex/prompts/` (top-level only; subdirectories and non-.md ignored). Invoked as `/prompts:<name>` in CLI/IDE slash menu.
- YAML front matter: `description:` (shown in popup), `argument-hint:` (e.g. `[FILES=<paths>] [PR_TITLE="<title>"]`).
- Placeholders: positional `$1`–`$9`, `$ARGUMENTS` (all args); named uppercase `$FILE`, `$TICKET_ID` supplied as `KEY=value` (quote values with spaces); `$$` emits literal `$`. Restart Codex/new chat to reload edited prompts.
- They are local-only (not repo-shared) and explicit-invocation-only — both cited as reasons to prefer skills.

### 1.2 Skills (Agent Skills spec) — the primary reusable-workflow surface
Official page: https://developers.openai.com/codex/skills. "Skills build on the open agent skills standard" (agentskills spec; links to github.com/openai/skills).
- **Timeline** (from merged PRs in openai/codex): experimental support merged **2025-12-02** (PR #7412 "feat: experimental support for skills.md", ~v0.64/0.65 era); rewritten via SkillsManager PR #7914 (2025-12-14); **feature default-on 2025-12-19** (PR #8297) ([github.com/openai/codex/pulls](https://github.com/openai/codex/pulls?q=skills)).
- **Layout**: a skill = directory containing `SKILL.md` (required: `name`, `description` front matter) + optional `scripts/`, `references/`, `assets/`, and optional `agents/openai.yaml` metadata file.
- **Discovery locations** (current, per docs + `codex-rs/core-skills/src/loader.rs`):
  - REPO: `.agents/skills` scanned in **every directory from $CWD up to the repo root** (project-scoped `.codex/skills` also loads as a project config layer root)
  - USER: `$HOME/.agents/skills` (current canonical user location)
  - USER (legacy, deprecated but still scanned for backward compat): `$CODEX_HOME/skills` i.e. `~/.codex/skills` (source comment in loader.rs: "Deprecated user skills location (`$CODEX_HOME/skills`), kept for backward compatibility") ([loader.rs](https://github.com/openai/codex/blob/main/codex-rs/core-skills/src/loader.rs))
  - ADMIN: `/etc/codex/skills`
  - SYSTEM: bundled with Codex (cached under `$CODEX_HOME/skills/.system`), e.g. `$skill-creator`, `$skill-installer`
  - Symlinked skill folders are followed. Duplicate names are NOT merged; both appear.
- **Invocation**: explicit via `/skills` or `$skill-name` mention; implicit when task matches `description`. Progressive disclosure: only name/description/path in initial context; the initial skills list is budgeted to **max 2% of context window or 8,000 chars**; full SKILL.md loaded on selection.
- **Config**: disable per skill via `[[skills.config]]` entries in `~/.codex/config.toml`: `path = "/path/to/skill/SKILL.md"`, `enabled = false`.
- **`agents/openai.yaml`** optional metadata: `interface:` (display_name, short_description, icon_small/large, brand_color, default_prompt), `policy: allow_implicit_invocation: false` (default true), `dependencies: tools:` (e.g. `type: "mcp"`, `value`, `transport: "streamable_http"`, `url`) — Codex can auto-prompt/install missing MCP deps (`features.skill_mcp_dependency_install`, on by default).
- **Distribution**: package skills as **plugins** (`codex plugin add`, `codex plugin marketplace add owner/repo[@ref]`); plugins can bundle skills + MCP servers + hooks + app mappings ([developers.openai.com/codex/plugins](https://developers.openai.com/codex/plugins)).

### 1.3 AGENTS.md
Page: https://developers.openai.com/codex/guides/agents-md
- Discovery: global `~/.codex/AGENTS.override.md` else `~/.codex/AGENTS.md` (first non-empty; `CODEX_HOME` overridable); then project scope from project root (git root by default, customizable via `project_root_markers`) **down to CWD**, one file per directory, checking `AGENTS.override.md` → `AGENTS.md` → names in `project_doc_fallback_filenames`. Concatenated root-down (closer-to-CWD wins by appearing later). Cap: `project_doc_max_bytes` (default 32 KiB). `/init` scaffolds one. `model_instructions_file` replaces built-in instructions entirely.

### 1.4 config.toml
Pages: https://developers.openai.com/codex/config-basic, /codex/config-advanced, /codex/config-reference
- **Precedence (highest first)**: CLI flags & `-c key=value` → project `.codex/config.toml` files (root→CWD, closest wins; trusted projects only) → profile file → user `~/.codex/config.toml` → system `/etc/codex/config.toml` → built-ins.
- **Profiles changed**: since **Codex 0.134.0**, `--profile name` loads a standalone file `$CODEX_HOME/<name>.config.toml` layered over user config; legacy `[profiles.name]` tables and top-level `profile = "..."` selector are **no longer supported** ([config-advanced](https://developers.openai.com/codex/config-advanced)).
- Key keys: `model` (e.g. "gpt-5.5"), `model_reasoning_effort` = `minimal|low|medium|high|xhigh`, `model_reasoning_summary`, `model_verbosity`, `approval_policy` = `untrusted|on-request|never` or granular table `{ granular = { sandbox_approval, rules, mcp_elicitations, request_permissions, skill_approval } }` (`on-failure` deprecated), `approvals_reviewer` = `user|auto_review`, `sandbox_mode` = `read-only|workspace-write|danger-full-access`, `[sandbox_workspace_write]` (writable_roots, network_access, exclude_slash_tmp, exclude_tmpdir_env_var), `web_search` = `cached` (default)|`live`|`disabled`, `personality`, `notify` (command receiving JSON payload), `[shell_environment_policy]` (inherit=all|core|none, include_only, exclude, set), `[features]` table (`multi_agent` stable/on, `hooks` stable/on, `unified_exec`, `shell_snapshot`, `undo`, `memories`, etc.), `[model_providers.<id>]` custom providers (base_url, env_key, wire_api="responses" only, command-backed `[.auth]` token helpers, built-in `amazon-bedrock`), `openai_base_url`, `[otel]` telemetry, named permission profiles `[permissions.<name>]` + `default_permissions` (built-ins `:read-only`, `:workspace`, `:danger-full-access`), `[agents]` (subagents, below), `sqlite_home` (agent-job state DB), `history.persistence`, `project_doc_*`, `projects."<path>".trust_level`.
- `-c/--config key=value`: values parsed as TOML (fall back to string), dot notation for nesting (e.g. `-c mcp_servers.context7.enabled=false`). `--enable/--disable <feature>` = sugar for `-c features.<name>=true|false`. `--strict-config` errors on unknown keys.
- Project config cannot set machine-local keys (ignored with warning): `openai_base_url`, `chatgpt_base_url`, `model_provider(s)`, `notify`, `profile(s)`, `otel`, etc. Enterprise `requirements.toml` can constrain (e.g. forbid `approval_policy="never"`, `sandbox_mode="danger-full-access"`).

### 1.5 MCP client config
Page: https://developers.openai.com/codex/mcp
- `[mcp_servers.<name>]` tables in `~/.codex/config.toml` or trusted project `.codex/config.toml` (shared by CLI + IDE).
- **stdio**: `command` (req), `args`, `env` (map), `env_vars` (allowlist array; entries may be `{ name, source = "local"|"remote" }`), `cwd`, `experimental_environment = "remote"`.
- **Streamable HTTP**: `url` (req), `bearer_token_env_var`, `http_headers` (static map), `env_http_headers` (map header→env var), OAuth via `codex mcp login <name>` (+`scopes`, `oauth_resource`, top-level `mcp_oauth_callback_port` / `mcp_oauth_callback_url`).
- Common: `startup_timeout_sec` (default **10**; `startup_timeout_ms` alias), `tool_timeout_sec` (default **60**), `enabled`, `required = true` (startup fails if it can't init — `codex exec` **exits with error**), `enabled_tools` (allowlist), `disabled_tools` (denylist applied after), `default_tools_approval_mode` = `auto|prompt|approve`, per-tool `tools.<tool>.approval_mode`.
- CLI management: `codex mcp add <name> [--env K=V]... -- <cmd...>` or `--url <https://…> [--bearer-token-env-var VAR] [--oauth-client-id ...]`, `codex mcp list|get|remove|login|logout` (all with `--json`). `/mcp` in TUI. MCP server `instructions` field is read and injected (keep first 512 chars self-contained).

### 1.6 Codex as an MCP server: `codex mcp-server`
Pages: https://developers.openai.com/codex/guides/agents-sdk, [CLI reference](https://developers.openai.com/codex/cli/reference)
- `codex mcp-server` (Experimental) runs Codex itself as an **MCP server over stdio**; exits when client closes. Inspect with `npx @modelcontextprotocol/inspector codex mcp-server`.
- `tools/list` returns exactly **two tools**:
  - **`codex`** — start a session. Properties: `prompt` (required, string), `approval-policy` (`untrusted|on-request|never`), `base-instructions` (replace default instructions), `config` (object; overrides `$CODEX_HOME/config.toml` values), `cwd`, `include-plan-tool` (bool), `model`, `profile`, `sandbox` (`read-only|workspace-write|danger-full-access`). Note kebab-case property names.
  - **`codex-reply`** — continue: `prompt` (required), `threadId` (required; `conversationId` is a deprecated alias).
- Tool result: `structuredContent.threadId` + `structuredContent.content` (final message), plus legacy `content[]` text block. Approval prompts (exec/patch) arrive as MCP elicitations including `threadId` in params.
- Event streaming: intermediate progress is exposed as MCP notifications/elicitations (approvals), but the docs treat `codex mcp-server` mainly as call→final-result; for fine-grained streaming use `codex app-server` or `codex exec --json`.
- OpenAI's official multi-agent guide wires `codex mcp-server` into the **OpenAI Agents SDK** via `MCPServerStdio(params={"command":"codex","args":["mcp-server"]}, client_session_timeout_seconds=360000)` and instructs orchestrator agents to always call `codex` with `{"approval-policy":"never","sandbox":"workspace-write"}` ([agents-sdk guide](https://developers.openai.com/codex/guides/agents-sdk)).

### 1.7 Hooks (lifecycle scripts) — new since ~early 2026, on by default
Page: https://developers.openai.com/codex/hooks
- Sources: `~/.codex/hooks.json`, inline `[hooks]` in `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`, plugin-bundled `hooks/hooks.json`. All matching hooks from all layers run (concurrently per event). Non-managed hooks require interactive trust (`/hooks`) keyed to hook hash; automation bypass: `--dangerously-bypass-hook-trust`.
- Events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart` (matcher: startup|resume|clear|compact), `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `Stop`. Matchers are regex over tool name (`Bash`, `apply_patch` aka `Edit|Write`, `mcp__server__tool`) or event-specific values.
- Handler: `{"type":"command","command":"...","timeout":30,"statusMessage":"..."}` (timeout seconds, default 600; `commandWindows`/`command_windows` Windows override; `prompt`/`agent` handler types parsed but skipped; `async` parsed but unsupported). stdin = one JSON object (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `turn_id`...). stdout JSON: `continue`, `stopReason`, `systemMessage`, `hookSpecificOutput.additionalContext` (SessionStart/SubagentStart inject developer context). Claude-compat: plugin hooks get `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` env vars, and there's a `/import` command to migrate Claude Code setup ([slash-commands](https://developers.openai.com/codex/cli/slash-commands)).
- Also note **rules/execpolicy**: `.rules` files (user `~/.codex/rules`, project) evaluated by `codex execpolicy check --rules <file> <command...>` (JSON verdict: allowed/prompted/blocked); `--ignore-rules` skips them ([CLI reference](https://developers.openai.com/codex/cli/reference), https://developers.openai.com/codex/rules).

---

## 2. Headless automation: `codex exec`

Pages: https://developers.openai.com/codex/noninteractive and https://developers.openai.com/codex/cli/reference (repo `docs/exec.md` is a stub → noninteractive page).

### 2.1 Flags (complete, from CLI reference)
`codex exec` (alias `codex e`), Stable:
- `--cd, -C <path>` — workspace root before executing.
- `--color always|never|auto`
- `--dangerously-bypass-approvals-and-sandbox` / `--yolo` — no approvals, no sandbox ("only inside an isolated runner").
- `--dangerously-bypass-hook-trust`
- `--ephemeral` — do **not** persist session rollout files.
- `--full-auto` — **deprecated** compat flag; prints warning; prefer `--sandbox workspace-write`.
- `--ignore-rules` — skip user/project execpolicy `.rules`.
- `--ignore-user-config` — don't load `$CODEX_HOME/config.toml` (auth still uses CODEX_HOME).
- `--image, -i path[,path...]` — attach images to first message.
- `--json`, `--experimental-json` — newline-delimited JSON events on stdout (both listed together; `--experimental-json` is the legacy alias).
- `--model, -m <string>`
- `--oss` (local provider via Ollama/LM Studio; `oss_provider` picks default)
- `--output-last-message, -o <path>` — write final assistant message to file (still printed to stdout).
- `--output-schema <path>` — JSON Schema file; final response must conform (validated). Combine with `-o` to land the JSON in a file.
- `--profile, -p <name>` — layer `$CODEX_HOME/<name>.config.toml`.
- `--sandbox, -s read-only|workspace-write|danger-full-access` — default comes from config; **exec default is read-only sandbox**.
- `--skip-git-repo-check` — allow running outside a Git repo (otherwise exec refuses outside a repo).
- `-c, --config key=value` (repeatable), plus global flags: `--add-dir <path>` (extra writable dirs), `-a/--ask-for-approval untrusted|on-request|never`, `--enable/--disable <feature>`, `--search` (live web search), `--strict-config`.
- `PROMPT` positional: string, or `-` to read the whole prompt from stdin. If stdin is piped AND a prompt argument is given: prompt = instruction, piped stdin = additional context. `generate_prompt.sh | codex exec - --json > result.jsonl`.

### 2.2 Output contract
- Default (no `--json`): progress → **stderr**, final agent message only → **stdout** (pipe-friendly).
- `--json`: stdout becomes a JSONL event stream. Exact event `type` values (verified in source [`codex-rs/exec/src/exec_events.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs)):
  - `thread.started` `{thread_id}` — **capture thread_id for resume**
  - `turn.started`
  - `turn.completed` `{usage: {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}}`
  - `turn.failed`
  - `item.started` / `item.updated` / `item.completed` — payload `item: {id, type, ...}`
  - `error` (fatal stream error)
- Item `type` values (snake_case, from `ThreadItemDetails`): `agent_message` `{text}` (text is the JSON string when `--output-schema` used), `reasoning` `{text}`, `command_execution` `{command, aggregated_output, exit_code, status: in_progress|completed|failed|declined}`, `file_change` `{changes:[{path, kind: add|delete|update}], status: in_progress|completed|failed}`, `mcp_tool_call` (status in_progress|completed|failed, result incl. `structured_content`), `collab_tool_call` `{tool: spawn_agent|send_input|wait|close_agent, sender_thread_id, receiver_thread_ids, prompt, agents_states{id:{status: pending_init|running|interrupted|completed|errored|shutdown|not_found, message}}, status}` (native subagent activity surfaces here), `web_search`, `todo_list` (plan updates), `error` (non-fatal).
- `hide_agent_reasoning = true` config suppresses reasoning events in exec output.

### 2.3 Sessions / resume
- `codex exec resume <SESSION_ID>` or `codex exec resume --last` (most recent from current working directory; `--all` widens to any directory); accepts follow-up `PROMPT` (or `-` stdin) and `--image`. Interactive counterpart: `codex resume`, `codex fork` (branch a session), `codex archive/unarchive/delete`.
- Rollout files: `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl` (may be zstd-compressed to `.jsonl.zst`; archived under `~/.codex/archived_sessions`) — verified in [`codex-rs/rollout/src/list.rs`](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/list.rs) ("Directory layout: `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`") and recorder.rs. These JSONL rollouts are replayable/journaling artifacts (`jq -C . ~/.codex/sessions/...jsonl`). SQLite state DB (agent jobs, resumable runtime state) location: `sqlite_home`. `--ephemeral` skips writing rollouts.
- `history.jsonl` in CODEX_HOME if history persistence enabled; `auth.json` holds tokens (or OS keyring per `cli_auth_credentials_store`).

### 2.4 Exit codes
- Not formally tabulated in docs. Documented behaviors: non-zero on task submission failure (`codex cloud`), non-zero when `git apply` fails (`codex apply`), error exit if a `required = true` MCP server fails to init, `codex login status` exits 0 when logged in. Community/docs guidance: "codex exec exits non-zero on failure; check $?" ([developertoolkit.ai](https://developertoolkit.ai/en/codex/advanced-techniques/non-interactive/)). Open issue #4721 requests exit 130 on SIGINT ([github](https://github.com/openai/codex/issues/4721)).

### 2.5 Auth in automation
- `CODEX_API_KEY=<key> codex exec ...` — **exec-only** env var, per-invocation. Warning: don't set OPENAI_API_KEY/CODEX_API_KEY job-wide where untrusted repo code runs ([noninteractive](https://developers.openai.com/codex/noninteractive)).
- `codex login` flows: browser ChatGPT OAuth, `--device-auth`, `--with-api-key` (stdin), `--with-access-token` (stdin). `forced_login_method = chatgpt|api` config. ChatGPT-managed auth in CI is possible but "advanced": seed `~/.codex/auth.json`, let Codex refresh it, persist between runs; never for public repos.
- GitHub Actions: use **`openai/codex-action@v1`** (inputs incl. `openai-api-key`, `prompt`); it starts a Responses API proxy so the key isn't exposed to repo code.

---

## 3. Multi-agent / orchestration in Codex itself (state of the art, mid-2026)

### 3.1 Native subagents — YES, shipped and on by default
Page: https://developers.openai.com/codex/subagents (+ concepts page /codex/concepts/subagents)
- `features.multi_agent` is **Stable and enabled by default** ("Enable subagent collaboration tools (spawn_agent, send_input, resume_agent, wait_agent, and close_agent)") ([config-basic features table](https://developers.openai.com/codex/config-basic)). Feature flag renamed from `collab` to `multi_agent` Feb 16, 2026 (PR #11918).
- Codex only spawns subagents **when explicitly asked** in the prompt. Orchestration (spawning, routing follow-ups, waiting, closing threads, consolidating results) is handled by Codex. `/agent` switches threads in TUI.
- Built-in agents: `default` (general), `worker` (implementation), `explorer` (read-heavy exploration). Custom agents override same-name built-ins.
- **Custom agents**: standalone TOML files in `~/.codex/agents/` (personal) or `.codex/agents/` (project). Required: `name`, `description`, `developer_instructions`. Optional: `nickname_candidates`, plus any session config keys (`model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config` ...) — each agent file is a config layer for spawned sessions. There's also `agents.<name>.config_file` for role→config-layer mapping in config.toml.
- Global `[agents]` settings: `max_threads` (concurrent open agent threads, default **6**), `max_depth` (nesting, default **1** — child can spawn, no recursion), `job_max_runtime_seconds` (default 1800/worker for CSV jobs).
- Sandbox/approvals: subagents **inherit** parent sandbox policy + live runtime overrides (incl. `--yolo`), individual custom agents can pin e.g. `sandbox_mode = "read-only"`. In non-interactive flows, actions needing fresh approval **fail and surface the error to the parent** — so for `codex exec` fan-out use `never` + adequate sandbox.
- **`spawn_agents_on_csv`** (experimental batch tool): reads CSV, spawns one worker per row, waits, exports combined CSV. Args: `csv_path`, `instruction` (template with `{column}` placeholders), `id_column`, `output_schema`, `output_csv_path`, `max_concurrency`, `max_runtime_seconds`. Workers must call `report_agent_job_result` exactly once; output CSV adds `job_id, item_id, status, last_error, result_json`. Works under `codex exec` (single-line stderr progress).
- In `codex exec --json`, subagent activity appears as `collab_tool_call` items (see §2.2).
- Subagent lifecycle hooks: `SubagentStart` / `SubagentStop`, and `Agent` matcher alias for `spawn_agent` in tool-use hooks (PRs #23540, #23789, May 2026).

### 3.2 Cloud tasks
- `codex cloud` (Experimental; alias `cloud-tasks`): interactive picker; `codex cloud exec --env ENV_ID [--attempts 1-4] "QUERY"` submits a task (best-of-N attempts); `codex cloud list [--env] [--limit 1-20] [--cursor] --json` → `{tasks:[{id,url,title,status,updated_at,environment_id,environment_label,summary,is_review,attempt_total}], cursor}`. `codex apply <TASK_ID>` applies the task's diff locally (non-zero exit on git apply conflict) ([CLI reference](https://developers.openai.com/codex/cli/reference)). Cloud tasks require ChatGPT-plan auth (not available for API-key auth per [pricing feature matrix](https://developers.openai.com/codex/pricing)).

### 3.3 Other official programmatic surfaces
- **Codex SDK** (https://developers.openai.com/codex/sdk): TypeScript `@openai/codex-sdk` (Node ≥18): `new Codex(); codex.startThread(); thread.run(prompt)`; `codex.resumeThread(threadId)`. Python `openai-codex` (beta, ≥3.10, pinned CLI runtime; drives local app-server over JSON-RPC): `Codex()/AsyncCodex()`, `thread_start(model=..., sandbox=Sandbox.workspace_write)`, `thread.run(...)` returns `result.final_response`; per-turn sandbox override; presets `Sandbox.read_only|workspace_write|full_access`. Docs: "If you are automating jobs or running Codex in CI, use the Codex SDK" (vs app-server).
- **`codex app-server`** (https://developers.openai.com/codex/app-server): JSON-RPC 2.0 (header omitted) over stdio JSONL / WebSocket (`--listen ws://IP:PORT`, experimental; `/readyz`,`/healthz`; auth via `--ws-auth capability-token|signed-bearer-token`) / Unix socket. Lifecycle: `initialize` (+`capabilities.experimentalApi`, `optOutNotificationMethods`) → `initialized` → `thread/start|resume|fork` → `turn/start` (input items; overrides model/personality/cwd/sandbox) → notifications (`item/started`, `item/completed`, `item/agentMessage/delta`, `turn/completed`, `thread/status/changed`...) → `turn/steer`, `turn/interrupt`. Rich API: `thread/list|read|archive|delete|rollback|inject_items`, `command/exec` (+write/resize/terminate — run a sandboxed command w/o a thread), `process/spawn` (unsandboxed, experimental), `model/list`, `skills/list`, `plugin/list`, `review/start`. Schema generation: `codex app-server generate-ts --out ./schemas` / `generate-json-schema`. TUI can attach to a remote app-server via `--remote ws://...` + `--remote-auth-token-env`. Overload: JSON-RPC error `-32001` "Server overloaded; retry later".
- **`codex exec-server`** / `exec-server-protocol` crates exist in-repo (an exec-oriented server variant; `--strict-config` mentions it), still undocumented.
- **Background execution**: `unified_exec` PTY-backed background terminals inside a session (`/ps`, `/stop`); Codex app has "Automations" (scheduled recurring local tasks); no daemon-style detached `codex exec` — background N runs yourself (`&`, CI matrix, etc.).

---

## 4. Practical constraints for N parallel `codex exec` processes

- **Auth**: (a) ChatGPT plan (Free/Go $8/Plus $20/Pro $100+/Business/Enterprise) — usage in "local messages" per **5-hour rolling window** + weekly caps: Plus ≈15–80 GPT-5.5 msgs/5h (GPT-5.4: 20–100, 5.4-mini: 60–350), Pro 5x ≈75–400, Pro 20x ≈300–1600; credits purchasable at token-based rates (GPT-5.5: 125 credits/1M input, 12.5 cached, 750 output) ([pricing](https://developers.openai.com/codex/pricing)). (b) **API key** — usage-based, standard API pricing, works for CLI/SDK/exec but NO cloud features (cloud tasks, GitHub review, Slack); model availability follows your key. For fan-out automation OpenAI recommends API-key auth (simpler provisioning; `CODEX_API_KEY` per-invocation).
- **Shared CODEX_HOME contention**: multiple processes share `~/.codex` (auth.json refresh, sessions dir, sqlite state). Community reports token-refresh races/re-auth loops when many agents share one ChatGPT login; mitigations: one `CODEX_HOME` per worker (env var respected everywhere, e.g. `CODEX_HOME=$(pwd)/.codex codex exec ...` shown in official docs), API-key auth, or `--ephemeral` to avoid rollout writes ([officeclaws.com](https://officeclaws.com/en/blog/how-to-run-multiple-codex-agents), [codex.danielvaughan.com](https://codex.danielvaughan.com/2026/04/18/running-multiple-codex-agents-parallel-orchestration/); not officially documented).
- **Native throttle**: even in-process subagent fan-out is capped by `agents.max_threads` (6) — a reasonable default parallelism heuristic; OpenAI's own docs warn subagent workflows "consume more tokens than comparable single-agent runs".
- **Sandbox nesting**: Codex sandbox = Seatbelt (macOS), Landlock/seccomp+bubblewrap (Linux, needs kernel ≥5.13 & capabilities most containers/CI runners lack), native Windows sandbox. **Inside Docker/CI containers the standard pattern is `--sandbox danger-full-access` or `--yolo` and let the container be the boundary**; docs say `--yolo` is for "externally hardened environments". `codex sandbox` subcommand can run arbitrary commands inside Codex's sandboxes (useful for orchestrators). Workspace-write keeps `.git/` and `.codex/` read-only ([sandbox docs via config-advanced](https://developers.openai.com/codex/config-advanced), [danielvaughan Docker guides](https://codex.danielvaughan.com/2026/03/30/codex-cli-docker-containerised-environments/)).
- **Git requirement**: exec refuses to run outside a git repo unless `--skip-git-repo-check`.
- **Isolation pattern**: official + community standard is **one git worktree per parallel task**: `git worktree add ../task -b task && (cd ../task && codex exec --sandbox workspace-write "...") &` ([firecrawl blog](https://www.firecrawl.dev/blog/codex-multi-agent-orchestration)).

---

## 5. How OSS projects drive `codex exec` programmatically

- **Canonical parse loop**: spawn `codex exec --json ... [--output-schema schema.json] [-o out.json]`, read stdout line-by-line, `JSON.parse` each line, switch on `type`; capture `thread_id` from `thread.started` for later `codex exec resume <id>`; treat `item.completed` with `item.type == "agent_message"` as the final answer; accumulate `turn.completed.usage` for cost accounting. Structured-output enforcement = `--output-schema` (schema validated server-side via Responses API structured outputs) + `-o` file, or parse the last `agent_message.text` as JSON. ([noninteractive docs](https://developers.openai.com/codex/noninteractive), [firecrawl](https://www.firecrawl.dev/blog/codex-multi-agent-orchestration)).
- **leonardsellem/codex-specialized-subagents** — MCP server that lets a parent Codex delegate to isolated `codex exec` subprocesses ("sub-agents"), auto-selecting repo+global skills per task ([github](https://github.com/leonardsellem/codex-specialized-subagents)).
- **tuannvm/codex-mcp-server** — wraps Codex CLI as an MCP server so Claude Code can call Codex ([github](https://github.com/tuannvm/codex-mcp-server)).
- **parallel-code**, **maestro-orchestrate** (22 specialists, parallel subagents, persistent sessions across Claude/Codex/Gemini), and curated lists **RoggeOhta/awesome-codex-cli** (150+ tools/skills/subagents/plugins) and **bradAGI/awesome-cli-coding-agents** track the ecosystem ([awesome-codex-cli](https://github.com/RoggeOhta/awesome-codex-cli)).
- **Elixir codex_sdk** (hexdocs.pm/codex_sdk) — third-party SDK wrapping exec/app-server.
- **Official Agents SDK cookbook pattern** (§1.6): Agents-SDK orchestrator + `codex mcp-server` tools with handoffs — OpenAI's own recommended multi-agent story besides native subagents.
- Codex itself ships `/import` to migrate **Claude Code** configuration/artifacts, and hooks/plugins deliberately keep Claude-compatible env vars — third-party cross-agent tooling is an explicitly supported direction.

## Design implications for a subagent runner (synthesis)
1. Per-worker: `codex exec --json --cd <worktree> --sandbox workspace-write -a never [-m model] [-p profile] [-c key=val]... [--output-schema schema.json -o result.json] [--ephemeral] "task"` with `CODEX_API_KEY` (or shared ChatGPT auth + low concurrency). Parse JSONL; persist `thread_id` for `codex exec resume`.
2. Alternative transports if you need mid-run steering/interrupt: `codex app-server` (JSON-RPC, `turn/steer`, `turn/interrupt`) or Python/TS SDK; `codex mcp-server` if the parent is itself an MCP-capable agent.
3. Extension delivery to workers: AGENTS.md (+`AGENTS.override.md`), `.agents/skills` in repo, `.codex/config.toml` + `.codex/agents/*.toml` (needs trusted project), profiles (`$CODEX_HOME/<name>.config.toml`), `-c` overrides, hooks for journaling/guardrails (but hooks need trust — use managed config or `--dangerously-bypass-hook-trust` in vetted automation).
4. Inside containers, drop to `--yolo`/`danger-full-access` and isolate externally; on bare metal keep `workspace-write` + `--add-dir`.

## KEY FACTS
- codex exec --json emits JSONL with exact event types thread.started, turn.started, turn.completed (with usage token counts), turn.failed, item.started, item.updated, item.completed, error; item types (snake_case) are agent_message, reasoning, command_execution, file_change, mcp_tool_call, collab_tool_call, web_search, todo_list, error [https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs and https://developers.openai.com/codex/noninteractive]
- codex exec flags: -C/--cd, --json/--experimental-json, -o/--output-last-message <path>, --output-schema <path> (JSON Schema-enforced final response), --ephemeral (no session rollout files), --sandbox read-only|workspace-write|danger-full-access (default read-only), --full-auto (deprecated, warns; use --sandbox workspace-write), --dangerously-bypass-approvals-and-sandbox/--yolo, --skip-git-repo-check, --ignore-user-config, --ignore-rules, -m/--model, -p/--profile, -c key=value (TOML-parsed), -i/--image, PROMPT or '-' for stdin [https://developers.openai.com/codex/cli/reference]
- codex exec resume [SESSION_ID] / --last (most recent session from current working directory; --all for any directory) continues a non-interactive session with an optional follow-up prompt [https://developers.openai.com/codex/cli/reference]
- Session rollouts are stored at ~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl (optionally zstd-compressed .jsonl.zst; archived_sessions for archived), replayable JSONL [https://github.com/openai/codex/blob/main/codex-rs/rollout/src/list.rs (line 419) and recorder.rs]
- Codex CLI has native subagents, on by default (features.multi_agent, Stable): collab tools spawn_agent, send_input, resume_agent, wait_agent, close_agent; built-in agents default/worker/explorer; custom agents as TOML files in ~/.codex/agents/ or .codex/agents/ with required name/description/developer_instructions plus optional model, model_reasoning_effort, sandbox_mode, mcp_servers, skills.config; [agents] max_threads default 6, max_depth default 1; batch tool spawn_agents_on_csv with output_schema and report_agent_job_result [https://developers.openai.com/codex/subagents]
- codex mcp-server runs Codex as an MCP server over stdio exposing exactly two tools: codex (prompt required; approval-policy, base-instructions, config object, cwd, include-plan-tool, model, profile, sandbox) and codex-reply (prompt, threadId; conversationId deprecated); responses carry structuredContent.threadId [https://developers.openai.com/codex/guides/agents-sdk]
- Skills: SKILL.md folders per open Agent Skills standard; scanned at repo .agents/skills (every dir CWD→repo root), $HOME/.agents/skills, legacy deprecated $CODEX_HOME/skills (~/.codex/skills, still scanned), /etc/codex/skills (admin), bundled system skills; initial skills list budgeted to 2% of context or 8000 chars; disable via [[skills.config]] path/enabled in config.toml; optional agents/openai.yaml (allow_implicit_invocation, MCP tool dependencies) [https://developers.openai.com/codex/skills and https://github.com/openai/codex/blob/main/codex-rs/core-skills/src/loader.rs]
- Skills support timeline: experimental merge 2025-12-02 (PR #7412), default-on 2025-12-19 (PR #8297) [https://github.com/openai/codex/pulls?q=is%3Apr+skills]
- Custom prompts (~/.codex/prompts/*.md, /prompts:name, front matter description/argument-hint, $1-$9/$ARGUMENTS/named $VAR placeholders, $$ literal) are officially deprecated in favor of skills but still function [https://developers.openai.com/codex/custom-prompts]
- config.toml precedence: CLI flags/-c > project .codex/config.toml (root→cwd, closest wins, trusted only) > profile file > ~/.codex/config.toml > /etc/codex/config.toml > defaults; since Codex 0.134.0 profiles are standalone files $CODEX_HOME/<name>.config.toml and legacy [profiles.name] tables no longer work [https://developers.openai.com/codex/config-basic and https://developers.openai.com/codex/config-advanced]
- Key config keys: model, model_reasoning_effort (minimal|low|medium|high|xhigh), approval_policy (untrusted|on-request|never or granular table; on-failure deprecated), sandbox_mode (read-only|workspace-write|danger-full-access), [sandbox_workspace_write] writable_roots/network_access, web_search (cached default|live|disabled), [features] table, model_providers, [permissions.<name>] profiles [https://developers.openai.com/codex/config-reference]
- MCP client config: [mcp_servers.<id>] with stdio (command/args/env/env_vars/cwd) or streamable HTTP (url, bearer_token_env_var, http_headers, env_http_headers, OAuth via codex mcp login); startup_timeout_sec default 10, tool_timeout_sec default 60, enabled, required (exec fails hard if required server can't init), enabled_tools/disabled_tools, default_tools_approval_mode auto|prompt|approve, per-tool approval_mode [https://developers.openai.com/codex/mcp]
- AGENTS.md discovery: ~/.codex/AGENTS.override.md or AGENTS.md (global), then project root→cwd one file per dir (AGENTS.override.md > AGENTS.md > project_doc_fallback_filenames), concatenated root-down, capped by project_doc_max_bytes (32 KiB default); /init scaffolds [https://developers.openai.com/codex/guides/agents-md]
- Auth for automation: CODEX_API_KEY env var is supported only by codex exec (per-invocation); codex login --with-api-key/--with-access-token/--device-auth; ChatGPT-managed auth in CI is possible by seeding ~/.codex/auth.json (advanced, discouraged for public repos); GitHub Actions should use openai/codex-action@v1 which proxies the API key [https://developers.openai.com/codex/noninteractive]
- ChatGPT-plan rate limits share a 5-hour window (plus weekly caps): Plus ~15-80 GPT-5.5 local messages/5h, Pro 5x ~75-400, Pro 20x ~300-1600; API-key usage is pay-per-token with no cloud features (no cloud tasks/GitHub review/Slack); credits at token-based rates (GPT-5.5: 125/12.5/750 credits per 1M input/cached/output) [https://developers.openai.com/codex/pricing]
- In containers/CI, Codex's Linux Landlock sandbox needs kernel >=5.13 and capabilities most runners lack; standard practice is --sandbox danger-full-access or --yolo with the container as the isolation boundary; docs say --yolo only inside externally hardened environments; codex sandbox subcommand runs arbitrary commands in Codex sandboxes [https://developers.openai.com/codex/cli/reference and https://codex.danielvaughan.com/2026/03/30/codex-cli-docker-containerised-environments/]
- codex app-server is a JSON-RPC 2.0 protocol over stdio JSONL/WebSocket/Unix socket for deep integrations: initialize→thread/start→turn/start, streaming notifications (item/started, item/agentMessage/delta, turn/completed), turn/steer, turn/interrupt, thread/list/fork/rollback, command/exec; schema export via codex app-server generate-ts/generate-json-schema; official SDKs: @openai/codex-sdk (TS) and openai-codex (Python, beta) [https://developers.openai.com/codex/app-server and https://developers.openai.com/codex/sdk]
- Hooks (on by default): events PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SubagentStart, SubagentStop, UserPromptSubmit, Stop; sources ~/.codex/hooks.json, inline [hooks] in config.toml, repo .codex/, plugins; command handlers only, JSON on stdin, timeout default 600s; non-managed hooks require trust (bypass: --dangerously-bypass-hook-trust) [https://developers.openai.com/codex/hooks]
- codex cloud (experimental): codex cloud exec --env ENV_ID --attempts 1-4 "query"; codex cloud list --json returns tasks[{id,url,title,status,updated_at,environment_id,...}]+cursor; codex apply <TASK_ID> applies a cloud task diff locally [https://developers.openai.com/codex/cli/reference]
- OSS drivers: leonardsellem/codex-specialized-subagents (MCP server delegating to isolated codex exec subagents), tuannvm/codex-mcp-server (Codex for Claude Code), firecrawl worktree fan-out pattern (git worktree add + background codex exec per task), maestro-orchestrate, parallel-code, awesome-codex-cli list [https://github.com/leonardsellem/codex-specialized-subagents and https://www.firecrawl.dev/blog/codex-multi-agent-orchestration]

## UNCERTAINTIES
- Exit codes for codex exec are not formally documented anywhere I could find (no table of codes). Docs and community only state 'non-zero on failure'; SIGINT→130 is a still-open feature request (issue #4721). Treat specific numeric codes as unspecified.
- The developers.openai.com/codex/changelog page is client-rendered and could not be scraped, so feature-introduction dates were reconstructed from GitHub PR merge dates and release tags rather than an official changelog; the skills dates (2025-12-02 experimental, 2025-12-19 default-on) are PR merge dates, and the exact release version that first shipped skills GA was not pinned.
- codex mcp-server intermediate event streaming: docs describe tool call → final structuredContent plus approval elicitations; I could not confirm from official docs whether per-item progress notifications (MCP notifications) are emitted during a codex tool call in current builds. If fine-grained streaming matters, prefer codex exec --json or app-server.
- auth.json token-refresh races when many processes share one ChatGPT-authenticated ~/.codex come from third-party writeups (officeclaws.com, danielvaughan.com, a hermes-agent issue), not official docs; severity/current status unverified. Per-worker CODEX_HOME or API-key auth is the safe pattern either way.
- Model names/limits (GPT-5.5, GPT-5.4, gpt-5.3-codex-spark) and the pricing/rate-limit ranges are as displayed on the pricing page at research time and change frequently.
- --experimental-json is listed alongside --json in the current CLI reference; older versions only had --experimental-json. I did not verify at which version --json became the primary name.
- Whether --output-schema validation is enforced client-side, server-side (Responses API structured outputs), or both is not spelled out in docs ('Codex validates tool output against it'); the failure mode when the model can't satisfy the schema is undocumented.
- The 'MCP Server' entry under the docs Automation nav resolves to no standalone page (/codex/mcp-server 404s); codex mcp-server is documented inside the CLI reference and the Agents SDK guide instead.
- codex exec-server / exec-server-protocol crates exist in the repo and are referenced by --strict-config docs, but have no public documentation; capabilities unknown.
- Community claims about typical per-message credit cost (GPT-5.5 averages 5-45 credits/message) and 'three to five parallel agents is the sweet spot' are soft guidance, not hard limits.