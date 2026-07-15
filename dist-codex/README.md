# ultracode — Codex plugin

Brings dynamic multi-agent workflow orchestration ("ultracode") to OpenAI Codex CLI.

This directory is a **build output**: `ultracode install codex` writes the same
artifacts directly to your Codex config, so for local use you do not need this
plugin. It exists for marketplace distribution (deferred; internal-first).
Only this README and `.codex-plugin/plugin.json` are committed; regenerate the
`skills/` subtree with `npm run build:plugins`.

## What it installs

- The `ultracode` **skill** (`skills/ultracode/`) — teaches Codex when and how to orchestrate.
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
