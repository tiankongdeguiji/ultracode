# ultracode

[![ci](https://github.com/tiankongdeguiji/ultracode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tiankongdeguiji/ultracode/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/tiankongdeguiji/ultracode)](LICENSE)
[![stars](https://img.shields.io/github/stars/tiankongdeguiji/ultracode)](https://github.com/tiankongdeguiji/ultracode/stargazers)

**Say the word, get a fleet.** Portable **ultracode** — dynamic multi-agent workflow orchestration — for coding agents that don't ship it natively: OpenAI Codex CLI, Qoder, Gemini CLI, and friends. Faithful to the Claude Code Workflow dialect, so the same `*.workflow.js` script runs on Claude Code (native), Qoder (native), and this engine.

*Linux & macOS · not on npm yet — build from source.*

Type the keyword `ultracode` in your coding agent and it stops doing everything in one context. Three layers take over. The **skill** (doctrine) teaches the agent to author a small deterministic JS workflow whose only side effects are `agent()` calls. The agent hands that workflow to the **engine** — this npm package, a CLI + MCP server — which fans each `agent()` out as a real coding-agent subprocess. **Delivery** ships it as a plugin on hosts that have plugins, and via `ultracode install <host>` everywhere else; on Qoder the pack rides the host's native Workflow tool instead of replacing it. Watch the fleet live, stop it, resume it, and get one structured result back. Full layering: `docs/architecture.md`.

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

- **One dialect, three engines** — the same script text runs on Claude Code (native), Qoder (native), and this engine; `ultracode lint` checks it stays in the portable subset.
- **Real agents, not simulations** — on the four real backends (codex, qoder, claude, gemini) every `agent()` is a coding-agent subprocess; the fifth, mock, is an in-process test double that powers `--dry-run` rehearsals for zero tokens.
- **Journal-based resume** — deterministic scripts + a hash-chained journal mean `ultracode resume <runId>` replays the longest unchanged, successful prefix of `agent()` calls free and runs the rest live — including after a script edit (the first divergence ends the cached prefix).
- **Live fleet panel** — foreground runs show it; `ultracode watch` re-attaches from any shell: per-agent tokens and elapsed time, arrow-select an agent, open its prompt/activity/outcome detail. In `watch`, Ctrl-C detaches and never stops the run (in an attached foreground run it stops the fleet).
- **Opt-in budgets and timeouts** — no default caps. Pass `--budget 500k` and the engine enforces it at the dispatch gate: no new agent starts past the ceiling. Timeouts are the same deal — unlimited unless you set one.
- **Structured output that survives sloppy models** — give `agent()` a JSON Schema and it returns a validated object; non-conforming replies get up to two schema-repair round-trips before counting as a failure.
- **Detached, durable runs** — the runner outlives your session; state lives in `.ultracode/runs/`. Over MCP, the `workflow_start` / `workflow_status` / `workflow_result` triad drives the same run store, so sandboxed hosts orchestrate fire-and-forget across turns.

## Quick start

```bash
npm install && npm run build && npm link   # build, then link a global `ultracode`
ultracode doctor                  # which backends are available + auth modes
```

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

The keyword arms the mode: your agent authors a workflow and runs it. Qoder and Claude Code run it natively through their own Workflow tools. Codex runs it over MCP — `workflow_start` → `workflow_status` → `workflow_result`, wired up by `install codex`. Hosts without MCP registration — where `install generic` copies only the skill + trigger — fall back to driving the `ultracode` CLI, or you can register `ultracode mcp` with the host yourself. One safety note: `workflow_start` has no confirmation gate, so ask the agent to show the workflow before running it (`docs/threat-model.md`). Follow engine runs from any shell — the runId is in the agent's reply, or from `ultracode list`:

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
| | `doctor` | probe backends: availability, versions, auth topology |
| | `mode [on\|off]` | read or set the standing ultracode-mode marker (`.ultracode/mode`) |
| | `sync` | mirror canonical `.ultracode/workflows` into `.claude/` and `.qoder/` copies |
| | `mcp` | stdio MCP server: `workflow_start` / `workflow_status` / `workflow_result` (+ stop/list) |

## Docs

- `docs/architecture.md` — why skill + engine + plugin are layered, the Qoder native-engine strategy, v1 scope, and what's proven end-to-end.
- `docs/threat-model.md` — trust model, sandbox honesty, concurrency & auth, the worker-writable run store.
- `skill/ultracode/references/dialect.md` — the full workflow dialect reference; `portability.md` beside it covers the cross-engine subset.
- `docs/design/judge.md` — design history: the synthesized architecture + milestone plan (3 architects + judge), grounded in source-level research (the Claude Code ultracode mechanism, Codex/Qoder CLI internals, MCP long-running-tool constraints, JS-sandbox tradeoffs).
- `SUPPORTED_VERSIONS.md` — pinned CLI versions, platform notes, live-test gate.

## Status

Internal-first: not published to npm. Linux and macOS only — Windows is unsupported by design (POSIX process groups). Scope and deferred items: `docs/architecture.md`.
