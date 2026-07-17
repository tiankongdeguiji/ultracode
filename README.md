# ultracode

[![ci](https://github.com/tiankongdeguiji/ultracode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tiankongdeguiji/ultracode/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/tiankongdeguiji/ultracode)](LICENSE)
[![stars](https://img.shields.io/github/stars/tiankongdeguiji/ultracode)](https://github.com/tiankongdeguiji/ultracode/stargazers)

**Say the word, get a fleet.** Portable **ultracode** — dynamic multi-agent workflow orchestration — for coding agents that don't ship it natively: OpenAI Codex CLI, Qoder, Gemini CLI, and friends. Faithful to the Claude Code Workflow dialect, so the same `*.workflow.js` script runs on Claude Code (native), Qoder (native), and this engine.

*Linux & macOS · not on npm yet — build from source.*

Type the keyword `ultracode` in your coding agent and it stops doing everything in one context: the **skill** (doctrine) teaches it to author a small deterministic JS workflow — `agent()` calls are the only side effects — and hand it to the **engine** (this npm package: CLI + MCP server), which fans each `agent()` out as a real coding-agent subprocess. **Delivery** is a plugin where plugins exist and `ultracode install <host>` everywhere else; on Qoder the pack rides the native Workflow tool instead of replacing it. Watch the fleet live, stop it, resume it, get one structured result back. Full layering: `docs/architecture.md`.

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

## What a workflow looks like

```js
export const meta = { name: 'audit-routes', description: 'Audit route handlers for missing auth', phases: [{ title: 'Find' }, { title: 'Audit' }] }

phase('Find')
const { files } = await agent('List every route file under src/. Return JSON.', {
  schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] },
})

phase('Audit')
const audits = await pipeline(files, (f) => agent(`Audit ${f} for missing auth checks. Be self-contained.`, { label: f }))
return { audits: audits.filter(Boolean) }
```

That's most of the surface — the rest is `parallel()`, `log()`, `args`, `budget`, and one level of `workflow()` nesting. Entropy is banned (`Date.now()` / `Math.random()` throw), so every run can replay. `ultracode run audit.workflow.js --dry-run` rehearses it for free on the mock backend. Full dialect reference: `skill/ultracode/references/dialect.md`.

## Why ultracode

- **One dialect, three engines** — the same script text runs on Claude Code (native), Qoder (native), and this engine; `ultracode lint` checks it stays in the portable subset.
- **Real agents, not simulations** — every `agent()` is a coding-agent subprocess. Five backends: codex, qoder, claude, gemini, mock — `--dry-run` rehearses a whole workflow for zero tokens.
- **Journal-based resume** — deterministic scripts + a hash-chained journal mean `ultracode resume <runId>` replays completed agents free and runs only what's left; edit the script and the unchanged prefix still replays.
- **Live fleet panel** — foreground runs show it; `ultracode watch` re-attaches from any shell: per-agent tokens and elapsed time, arrow-select an agent, open its prompt/activity/outcome detail. In `watch`, Ctrl-C detaches and never stops the run (in an attached foreground run it stops the fleet).
- **Opt-in budgets and timeouts** — no default caps. Pass `--budget 500k` and the engine enforces it at the dispatch gate: no new agent starts past the ceiling. Timeouts are the same deal — unlimited unless you set one.
- **Structured output that survives sloppy models** — give `agent()` a JSON Schema and it returns a validated object; non-conforming replies get up to two schema-repair round-trips before counting as a failure.
- **Detached, durable runs** — the runner outlives your session; state lives in `.ultracode/runs/`. Over MCP, the `workflow_start` / `workflow_status` / `workflow_result` triad drives the same run store, so sandboxed hosts orchestrate fire-and-forget across turns.

## Quick start

```bash
npm install && npm run build && npm link   # build, then link a global `ultracode`
ultracode doctor                  # which backends are available + auth modes
ultracode install codex           # skill + AGENTS.md trigger + MCP registration

# the keyword path — inside Codex (or Qoder, Gemini CLI, Claude Code):
#   "ultracode: review this repo for auth bugs +500k"
#   the word arms the mode; "+500k" is an optional budget — omit it to run uncapped

# or drive the engine directly:
ultracode validate my.workflow.js
ultracode run my.workflow.js --dry-run          # free rehearsal (mock backend)
ultracode run my.workflow.js --backend codex    # foreground live panel; --detach to background
ultracode watch <runId>                         # re-attach from another shell
ultracode resume <runId> [--script edited.js]   # completed agents replay free
```

## Commands

| | Command | What it does |
|---|---|---|
| author | `validate <script>` | check the meta block, dialect constraints, and compilability |
| | `lint <script>` | cross-engine portability check (Claude Code / Qoder native / ultracode) |
| run | `run <script>` | run a workflow: live panel in the foreground, `--detach` to background, `--dry-run` for a free mock rehearsal |
| | `resume <runId>` | completed agents replay free from the journal; `--script edited.js` keeps the unchanged prefix |
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

## What's proven

End-to-end on real backends: the `uc-review` workflow (3 dimension finders → per-finding adversarial verification → synthesis) run on **Codex** against `examples/sample-repo` found both planted auth bugs — with constructed exploit inputs as evidence — plus a real unplanted one (`examples/parity-demo-output.json`, 12 agents). A typed-schema workflow verified on **Claude**. Codex drove the full `workflow_start → status → result` MCP loop. 200+ offline tests (mock backend + golden fixtures) cover the dialect contract, sandbox bans, journal determinism, resume, structured-output, safety rails, all five adapters, worktree isolation, nested workflows, and the exec-layer hardening (O_NOFOLLOW writers, pgid kill-guard, resume path confinement).

## Security

Workflow scripts are **trusted input** — model-authored and user-reviewed before running; the `node:vm` sandbox is a capability-scoping and determinism device, **not** a hostile-code boundary, and MCP `workflow_start` runs scripts with no interactive gate — do not run scripts you haven't read. Every agent is a subprocess governed by the host CLI's own sandbox; `--permission danger` deliberately removes it. The run store is worker-writable and `resume` re-executes its inputs with no review gate — treat resuming an untrusted run as running it. Full analysis: `docs/threat-model.md`.

## Docs

- `docs/architecture.md` — why skill + engine + plugin are layered, the Qoder native-engine strategy, and v1 scope.
- `docs/threat-model.md` — trust model, sandbox honesty, concurrency & auth, the worker-writable run store.
- `skill/ultracode/references/dialect.md` — the full workflow dialect reference; `portability.md` beside it covers the cross-engine subset.
- `docs/design/judge.md` — design history: the synthesized architecture + milestone plan (3 architects + judge), grounded in source-level research (the Claude Code ultracode mechanism, Codex/Qoder CLI internals, MCP long-running-tool constraints, JS-sandbox tradeoffs).
- `SUPPORTED_VERSIONS.md` — pinned CLI versions, platform notes, live-test gate.

## Status

Internal-first: not published to npm. Linux and macOS only — Windows is unsupported by design (POSIX process groups). Scope and deferred items: `docs/architecture.md`.
