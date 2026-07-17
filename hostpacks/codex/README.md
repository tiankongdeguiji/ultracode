# ultracode — Codex plugin

Brings dynamic multi-agent workflow orchestration ("ultracode") to OpenAI Codex CLI.

This plugin bundle is a **build output**: `npm run build:plugins` assembles it
into `dist-codex/` from `skill/` and `hostpacks/codex/` — edit those sources,
never the generated `dist-codex/` tree. For local use you do not need this
plugin — `ultracode install codex` sets everything up directly; the bundle
exists for marketplace distribution (deferred; internal-first).

## What's in the bundle

- The `ultracode` **skill** (`skills/ultracode/`) — teaches Codex when and how to orchestrate.

## What `ultracode install codex` additionally writes

Bundled MCP registration is deferred with marketplace distribution, so today
the installer writes these directly into your Codex config:

- An **AGENTS.md** trigger snippet — standing "ultracode mode", armed only by the keyword "ultracode".
- An **MCP server** registration (`~/.codex/config.toml` `[mcp_servers.ultracode]` block) pointing at `ultracode mcp`
  (`tool_timeout_sec = 3600`, `default_tools_approval_mode = "approve"` — headless Codex auto-rejects
  MCP calls otherwise). The 3600s timeout is the **quiet-monitor hold budget**: Codex never extends
  tool timeouts on progress notifications (verified against codex-rs 0.144.5 — it does not set rmcp's
  `reset_timeout_on_progress`) and does not poll MCP Tasks, so the only zero-token way to babysit a
  long run is one blocking `workflow_status {until: "terminal", waitSeconds: 3300}` call per ~55 min.
  While it holds, the model spends nothing; interrupting it is harmless (the run is detached — re-poll).
  Installs made before this default re-run `ultracode install codex` to update the managed block
  (older blocks pinned `tool_timeout_sec = 90`, which kills any hold at 90s).

## Manual install (until marketplace)

```bash
npm i -g ultracode        # or: npm link from a checkout
ultracode install codex   # writes skill + AGENTS.md + MCP registration
ultracode doctor          # verify backend availability and auth topology
```

Then in Codex: `ultracode: review this repo for auth bugs +500k`.

## Why Codex must use the MCP route

Codex runs shell commands inside a bubblewrap sandbox with a fresh PID
namespace per exec call. A `ultracode run --detach` launched there is
SIGKILLed the moment the tool call returns (namespace teardown) — the run
shows `orphaned` within seconds with an empty runner.log. The registered MCP
server is a persistent process outside that sandbox, so `workflow_start` runs
survive. Additionally, codex *workers* cannot spawn inside Codex's own
sandbox (`~/.codex` state is read-only there and network is off) — another
reason the shell route from within a Codex session is a trap. The skill text
teaches the model this; this section is for humans debugging it.
