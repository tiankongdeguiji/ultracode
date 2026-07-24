# ultracode

**English** · [简体中文](README.zh-CN.md)

[![ci](https://github.com/tiankongdeguiji/ultracode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tiankongdeguiji/ultracode/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/tiankongdeguiji/ultracode)](LICENSE)
[![stars](https://img.shields.io/github/stars/tiankongdeguiji/ultracode)](https://github.com/tiankongdeguiji/ultracode/stargazers)

**Say the word, get an agent fleet.** Portable **ultracode** — dynamic multi-agent workflow orchestration — for coding agents that don't ship it natively: OpenAI Codex CLI, Gemini CLI, and friends. Faithful to the Claude Code Workflow dialect, so the same `*.workflow.js` script runs on Claude Code (native), Qoder (native), and this engine.

*Linux & macOS · one-line install.*

Type `ultracode` in your coding agent and it stops working in one context: the **skill** has your agent author a deterministic JS workflow; the **engine** runs each `agent()` as a subprocess.

```text
"ultracode: audit src/ for auth bugs"      <- the keyword arms the skill
    |
    v
your agent authors audit.workflow.js      <- deterministic JS; agent() is
    |                                         the only side-effect channel
    v   ultracode run ...   or   MCP workflow_start
ultracode engine: sandboxed script + scheduler + journal
    |
    +--> codex worker   +--> claude worker   +--> gemini worker   ...
    |        real coding-agent subprocesses, fanned out concurrently
    v
.ultracode/runs/<id>/ --> watch | status | logs | stop | resume
```

## Why ultracode

One agent, one context window, one linear transcript — that's the ceiling. `ultracode` trades it for a coordinated fleet: fresh-context sub-agents working in parallel, with only their conclusions flowing back to you.

### What the fleet buys you

- **Divide and conquer** — typing the keyword `ultracode` arms a skill (doctrine) that has *your* agent break a big task into a workflow of small `agent()` calls, each a subprocess with its own fresh context.
- **Fan out, bounded** — one task spreads across many sub-agents: up to `50` by default (the soft cap), a hard ceiling of `1000` per run, up to 10 at a time (`min(10, max(2, cores-2))`) — concurrency and the soft cap yours via `--max-concurrency` and `--max-agents`.
- **Nothing floods your session** — a sub-agent's transcript (every tool call, file read, streamed token) stays in its run dir; only its final value comes back — a structured object or last message, plus a short error excerpt if it fails.
- **Cross-check by construction** — `parallel()` and `pipeline()` are first-class, and the doctrine teaches quality patterns: adversarial verify (independent skeptics prompted to refute, majority kills a finding), judge panels, perspective-diverse review, loop-until-dry. The shipped `uc-review` workflow runs parallel finders → adversarial verification → synthesis.
- **Kick it off, walk away** — each run is its own detached OS process (no daemon), so it keeps going after the launching CLI or MCP server exits; watch, stop, or resume it from any shell.
- **Reusable assets, not one-shots** — workflows are plain deterministic JS: read them, rehearse them free with `--dry-run`, keep them in `.ultracode/workflows/`, and nest one inside another with `workflow()` (one level deep).

### The engine that runs it

- **One dialect, three engines** — the same `*.workflow.js` text runs on Claude Code (native), Qoder (native), and this engine; `ultracode lint` keeps it in the portable subset, and `ultracode sync` mirrors workflows into `.claude/workflows/` and `.qoder/workflows/`.
- **Journal-based resume** — deterministic scripts plus a hash-chained journal let `ultracode resume <runId>` replay the longest unchanged, successful prefix of `agent()` calls for free, then run the rest live — even after a script edit (the first divergence ends the cached prefix).
- **Live fleet panel** — foreground runs show it, and `ultracode watch` re-attaches from any shell: per-agent tokens and elapsed time, arrow-select an agent, open its prompt/activity/outcome detail (in `watch`, Ctrl-C detaches and never stops the run; in an attached foreground run it stops the fleet).
- **Opt-in budgets and timeouts** — no default caps (unset = unlimited); `--budget 500k` gates dispatch: once spend passes it, no new agent starts (running agents still finish, so the total can overshoot). A timeout is opt-in the same way, unlimited until you set one.
- **Structured output that survives sloppy models** — give `agent()` a `JSON Schema` and it returns a validated object; non-conforming replies get up to two schema-repair retries before counting as a failure.

## Quick start

```bash
curl -fsSL https://hongsheng-jhs.oss-cn-hangzhou.aliyuncs.com/ultracode/install.sh | sh
ultracode doctor                  # which backends are available + auth modes
```

If `ultracode` isn't found afterwards, the installer has already printed the one-line `PATH` fix for your shell.

### Use with your coding agent

The intended daily path — install the skill and the host wiring:

```bash
ultracode install codex           # skill + AGENTS.md trigger + MCP registration
                                  # other hosts: `install qoder` · `install generic`
```

Then type the keyword inside Codex (or Qoder, Gemini CLI, Claude Code):

```text
"ultracode: review this repo for auth bugs"
```

The keyword arms the mode: your agent authors and runs a workflow — native on Qoder/Claude Code, over MCP on Codex, via the `ultracode` CLI elsewhere. `workflow_start` runs with no confirmation gate, so have the agent show you the workflow first (`docs/threat-model.md`). Follow runs from a shell:

```bash
ultracode watch <runId>
```

```text
⏺ uc-audit-routes   running · 6m05s
  ⏺ Find (1/1)
    ⎿ ✓ #1                       12.4k tok · 18s · model-name
  ⠧ Audit (12/14)
    ⎿ … +9 done (1.37m tok)
    ⎿ ✓ src/routes/billing.ts    148.7k tok · 3m02s · model-name
    ⎿ ✓ src/routes/webhooks.ts   132.1k tok · 2m48s · model-name
    ⎿ ✓ src/routes/uploads.ts    121.9k tok · 2m35s · model-name
    ⎿ ⠧ src/routes/auth.ts       96.3k tok · 2m41s · model-name
    ⎿ ⠧ src/routes/admin.ts      88.9k tok · 2m37s · model-name
agents 13/15 · 2 running | tokens 2.0m | elapsed 6m05s
↑/↓ select · ⏎ details · esc clear · q detach · ctrl-c detach
```

### Upgrading

```bash
ultracode update                  # self-update; --check reports without installing
```

Re-running the install one-liner does the same for a default-location install. After upgrading, re-run `ultracode install <host>` so host integrations pick up the new engine path.

### Driving the engine directly

The skill normally does this for you; the same surface is there for authoring and debugging workflows by hand. A workflow is a small deterministic JS script:

```js
export const meta = { name: 'uc-audit-routes', description: 'Audit route handlers for missing auth', phases: [{ title: 'Find' }, { title: 'Audit' }] }

phase('Find')
const { files } = await agent('List every route file under src/. Return JSON.', {
  schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] },
})

phase('Audit')
const audits = await pipeline(files, (f) => agent(`Audit ${f} for missing auth checks. Be self-contained.`, { label: f }))
return { audits: audits.filter(Boolean) }
```

That's most of the surface — the rest is `parallel()`, `log()`, `args`, `budget`, and one level of `workflow()` nesting. Entropy is banned (`Date.now()` / `Math.random()` throw), so every run can replay — full dialect reference in `skill/ultracode/references/dialect.md`.

```bash
ultracode validate my.workflow.js
ultracode run my.workflow.js --dry-run          # free rehearsal (mock backend)
ultracode run my.workflow.js --backend codex    # foreground live panel; --detach to background
ultracode resume <runId> [--script edited.js]   # unchanged journal prefix replays free
```

### Subagent defaults

Set user-wide defaults in `~/.ultracode/config.json`, then override individual fields per project in `<cwd>/.ultracode/config.json`:

```json
{
  "subagent": {
    "backend": "qoder",
    "model": "auto",
    "effort": "high",
    "context_window": 200000
  }
}
```

Per-call parameters on workflow `agent()` override CLI/MCP, project-level, and user-level parameters. CLI/MCP must specify a backend through an argument or configuration; `--dry-run` uses the `mock` backend.

### Build from source

If you need to develop ultracode, build from source:

```bash
git clone https://github.com/tiankongdeguiji/ultracode.git
cd ultracode
npm install && npm run build && npm link
```

## Commands

| | Command | What it does |
|---|---|---|
| author | `validate <script>` | check the meta block, dialect constraints, and compilability |
| | `lint <script>` | cross-engine portability check (Claude Code / Qoder native / ultracode) |
| run | `run <script>` | run a workflow: live panel in the foreground, `--detach` to background, `--dry-run` for a free mock rehearsal |
| | `resume <runId>` | the unchanged, successful journal prefix replays free (also with `--script edited.js`); the rest runs live |
| | `stop <runId>` | stop a running workflow (SIGTERM → 7s → SIGKILL) |
| observe | `watch <runId>` | live panel: phases, per-agent tokens/elapsed; ↑/↓ select an agent, ⏎ opens its detail, q detaches |
| | `status <runId>` | show run status: phases, agents, budget (`--watch` polls until terminal) |
| | `logs <runId>` | print run events (`--follow` tails) |
| | `list` | recent runs in the run store (`--all` for every run) |
| integrate | `install <codex\|qoder\|generic>` | skill + host trigger (AGENTS.md snippet / Qoder rule); codex user-scope also registers the MCP server |
| | `update` | self-update from the release server (`--check` reports only; `--to <version>` pins a version) |
| | `doctor` | probe backends: availability, versions, auth topology |
| | `mode [on\|off]` | read or set the standing ultracode-mode marker (`.ultracode/mode`) |
| | `sync` | mirror canonical `.ultracode/workflows` into `.claude/` and `.qoder/` copies |
| | `mcp` | stdio MCP server: `workflow_start` / `workflow_status` (long-poll `until="terminal"` for a quiet monitor) / `workflow_result` (+ stop/list) |

## Docs

- `docs/architecture.md` — why skill + engine + plugin are layered, the Qoder native-engine strategy, v1 scope, and what's proven end-to-end.
- `docs/threat-model.md` — trust model, sandbox honesty, concurrency & auth, the worker-writable run store.
- `skill/ultracode/references/dialect.md` — the full workflow dialect reference; `portability.md` beside it covers the cross-engine subset.
- `docs/design/judge.md` — design history: the synthesized architecture + milestone plan (3 architects + judge), grounded in source-level research (the Claude Code ultracode mechanism, Codex/Qoder CLI internals, MCP long-running-tool constraints, JS-sandbox tradeoffs).
- `SUPPORTED_VERSIONS.md` — pinned CLI versions, platform notes, live-test gate.

## Status

`ultracode` installs via the OSS one-liner above and self-updates via `ultracode update`. Linux and macOS only — Windows is unsupported by design (POSIX process groups). Scope and deferred items: `docs/architecture.md`.
