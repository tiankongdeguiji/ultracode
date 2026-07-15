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

- An **AGENTS.md** trigger snippet — standing "ultracode mode" on the keyword / a budget directive.
- An **MCP server** registration (`.mcp.json` / config.toml block) pointing at `ultracode mcp`
  (`tool_timeout_sec = 90`, `default_tools_approval_mode = "approve"` — headless Codex auto-rejects
  MCP calls otherwise).

## Manual install (until marketplace)

```bash
npm i -g ultracode        # or: npm link from a checkout
ultracode install codex   # writes skill + AGENTS.md + MCP registration
ultracode doctor          # verify backend availability and auth topology
```

Then in Codex: `ultracode: review this repo for auth bugs +500k`.
