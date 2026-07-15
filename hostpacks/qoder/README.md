# ultracode — Qoder plugin

Adds "ultracode mode" to Qoder. Qoder's CLI already ships the **native Workflow
tool** — a faithful port of the same dialect — so this pack does not rebuild the
engine. It supplies what Qoder lacks: the *doctrine* (when/how to orchestrate)
and the standing-mode *trigger*.

This directory is a **build output** assembled by `npm run build:plugins` from
`skill/`, `workflows/`, and `hostpacks/qoder/` — do not edit it in place.

## What it installs

- The `ultracode` **skill** (`.qoder/skills/ultracode/`).
- An **always_on rule** (`.qoder/rules/ultracode-mode.md`) — keyword / budget → orchestrate.
- **uc-\* workflow templates** (`.qoder/workflows/`) in the portable dialect.
- **Effort-routing agents** (`.qoder/agents/uc-xhigh.md`, `uc-verifier.md`) — Qoder's `budget`
  global is stubbed and per-call `effort` isn't portable, so budget rides `args.budgetTokens`
  and effort rides `agentType`.

## Manual install (until marketplace)

```bash
ultracode install qoder --project   # or omit --project for user scope
```

If the remote Workflow feature gate is off for your account, the external
ultracode MCP engine is the fallback (`ultracode install generic` + register
`ultracode mcp`).
