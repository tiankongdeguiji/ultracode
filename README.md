# ultracode

Portable **ultracode** — dynamic multi-agent workflow orchestration — for coding agents that don't ship it natively: OpenAI Codex CLI, Qoder, Gemini CLI, and friends. Faithful to the Claude Code Workflow dialect, so the same `*.workflow.js` script runs on Claude Code (native), Qoder (native), and this engine.

## Plugin, command, or skill? All three — layered

| Layer | Artifact | Why |
|---|---|---|
| **Doctrine** | An Agent Skill (`skill/ultracode/`) | The only cross-host surface with implicit model-triggered invocation and progressive disclosure. Teaches the model *when* to orchestrate, the workflow dialect, and the quality patterns (adversarial verify, judge panel, loop-until-dry, completeness critic). |
| **Engine** | This npm package: CLI (`ultracode run/...`) + MCP server (`ultracode mcp`) | A skill can't host a process. A single blocking MCP call dies at every host's 300–600s tool timeout, so the MCP surface is a `workflow_start` / `workflow_status` (long-poll) / `workflow_result` triad over a durable on-disk run store. |
| **Delivery** | Plugin where plugins exist (Codex, Qoder); `ultracode install <host>` everywhere else | Plugins bundle the skill + MCP registration + templates in one install. |
| **Command** | Emergent — skills auto-register as `$ultracode` / `/ultracode` | No separate command artifact needed. |

On **Qoder**, the native Workflow tool ships the same engine already — the pack rides it (skill + rule + `uc-*` templates) instead of replacing it.

## The dialect (shared with Claude Code and Qoder)

```js
export const meta = { name: 'audit-routes', description: 'Audit route handlers', phases: [{ title: 'Find' }, { title: 'Audit' }] }
phase('Find')
const found = await agent('List every route file.', { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'], additionalProperties: false } })
phase('Audit')
const audits = await pipeline(found.files, f => agent(`Audit ${f} for missing auth checks.`, { label: f }))
return { audits: audits.filter(Boolean) }
```

`agent()`, `parallel()` (barrier, throw→null), `pipeline()` (no inter-stage barrier), `phase()`, `log()`, `args`, `budget`, one-level `workflow()` nesting. Deterministic by construction: `Date.now()` / `Math.random()` / no-arg `new Date()` throw, enabling hash-chained journal resume (`ultracode resume <runId>`).

## Threat model (blunt version)

Workflow scripts are **model-authored and user-reviewed before running** (`ultracode run` prints the plan and asks; `--dry-run` rehearses on a mock backend). The sandbox — hardened `node:vm`, frozen intrinsics, no fs/net/shell/require — is a capability-scoping and determinism device, **not** a hostile-code boundary. The only side-effect channel a script has is `agent()`, and every agent is a subprocess governed by the host CLI's own sandbox and permission system. Spawned workers default to `workspace-write`; the engine never passes `--yolo` / `danger-full-access`. Do not run workflow scripts you haven't read.

Fan-out auth: Codex ChatGPT-plan OAuth is unsafe to fan out (single-use rotating refresh tokens) — `ultracode doctor` enforces concurrency 1 (`--force-oauth-fanout` caps at 3). Use `CODEX_API_KEY` for real parallelism. Qoder: `QODER_PERSONAL_ACCESS_TOKEN` is stateless and parallel-safe.

## Quick start

```bash
npm install && npm run build      # or: npm link  for a global `ultracode`
ultracode doctor                  # which backends are available + auth safety
ultracode install codex           # skill + AGENTS.md trigger + MCP registration
# then in Codex:  "ultracode: review this repo for auth bugs +500k"

# or drive it directly:
ultracode validate my.workflow.js
ultracode run my.workflow.js --dry-run          # free rehearsal (mock backend)
ultracode run my.workflow.js --backend codex --budget 500k
ultracode status <runId> --watch                # long runs: add --detach above
ultracode resume <runId> [--script edited.js]   # completed agents replay free
```

## Commands

`run` · `status` · `logs` · `stop` · `list` · `resume` · `validate` · `lint` · `doctor` · `mode` · `install <codex|qoder|generic>` · `sync` · `mcp`

## What's proven

End-to-end on real backends: the `uc-review` workflow (3 dimension finders → per-finding adversarial verification → synthesis) run on **Codex** against `examples/sample-repo` found both planted auth bugs — with constructed exploit inputs as evidence — plus a real unplanted one (`examples/parity-demo-output.json`, 12 agents). A typed-schema workflow verified on **Claude**. Codex drove the full `workflow_start → status → result` MCP loop. 187 offline tests (mock backend + golden fixtures) cover the dialect contract, sandbox bans, journal determinism, resume, structured-output, safety rails, all five adapters, worktree isolation, and nested workflows.

## Design & research

- `docs/design/judge.md` — the synthesized architecture + milestone plan (3 architects + judge).
- `docs/research/` — the underlying research: the Claude Code ultracode mechanism, Codex/Qoder CLI internals (Qoder's native Workflow tool decompiled), MCP long-running-tool constraints across hosts, parallel-safety analysis, cross-host survey, JS-sandbox tradeoffs.
- `SUPPORTED_VERSIONS.md` — pinned CLI versions, platform notes, live-test gate.

## v1 scope

In: engine (sandbox, dialect, journal/resume, budget, watchdogs), 5 backends (mock/codex/qoder/claude/gemini), CLI, MCP triad, codex+qoder+generic installers, worktree isolation, one-level nested workflows. Deferred: Windows, cursor/copilot/opencode/amp adapters, npm publish + marketplace repos (internal-first), MCP Tasks (unsupported by target hosts).
