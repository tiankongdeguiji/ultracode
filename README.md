# ultracode

Portable **ultracode** — dynamic multi-agent workflow orchestration — for coding agents that don't ship it natively: OpenAI Codex CLI, Qoder, Gemini CLI, and friends. Faithful to the Claude Code Workflow dialect, so the same `*.workflow.js` script runs on Claude Code (native), Qoder (native), and this engine.

## Plugin, command, or skill? All three — layered

| Layer | Artifact | Why |
|---|---|---|
| **Doctrine** | An Agent Skill (`skill/ultracode/`) | The only cross-host surface with implicit model-triggered invocation and progressive disclosure. Teaches the model *when* to orchestrate, the workflow dialect, and the quality patterns (adversarial verify, judge panel, loop-until-dry, completeness critic). |
| **Engine** | This npm package: CLI (`ultracode run/...`) + MCP server (`ultracode mcp`) | A skill can't host a process, and no host extends MCP tool timeouts on progress, so the MCP surface is a `workflow_start` / `workflow_status` / `workflow_result` triad over a durable on-disk run store. `workflow_status until="terminal"` is the quiet monitor — one long hold that parks the host until the run ends (the codex hostpack raises `tool_timeout_sec` to 3600, so a hold covers ~55 min for ~1 turn/hour). |
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

Workflow scripts are **trusted input** — model-authored and user-reviewed before running (`ultracode run` prints the plan and asks; `--dry-run` rehearses on a mock backend). The `node:vm` sandbox — frozen intrinsics, banned entropy, no fs/net/shell/require, host globals re-wrapped so `.constructor` can't directly reach the host `Function` — is a capability-scoping and determinism device, **not** a hostile-code boundary. Values the host hands back (Promises, timer handles, JSON-parsed results) still expose host-realm constructors, and node:vm cannot preempt a synchronous loop that runs after an `await` (a hung run is killed externally via `ultracode stop`, which SIGKILLs the runner). A genuinely malicious script can therefore escape or hang the runner; true isolation would need a separate OS process (future work). Note `workflow_start` over MCP runs scripts with **no interactive gate**, so only feed it scripts you authored/reviewed. The only sanctioned side-effect channel is `agent()`, and every agent is a subprocess governed by the host CLI's own sandbox. Spawned workers default to `workspace-write` and the engine never passes `--yolo` / `danger-full-access` **below the `danger` tier** — `--permission danger` deliberately removes the worker sandbox (Codex `danger-full-access`, Gemini `--yolo`, Claude/Qoder bypass modes). Do not run workflow scripts you haven't read.

Fan-out concurrency is user-controlled: the default is `min(10, max(2, cores - 2))`, the `ULTRACODE_MAX_CONCURRENCY` env var overrides the default, and an explicit `--max-concurrency` (CLI) or `maxConcurrency` (MCP `workflow_start`) wins over both. The engine never adjusts concurrency based on backend auth; `ultracode doctor` reports each backend's auth mode. The chosen value is stored in the run's config at creation, so a resume inherits it unless overridden explicitly (`resume --max-concurrency` or MCP `maxConcurrency`). Codex: `CODEX_API_KEY` is the parallel-safe auth (ChatGPT-plan OAuth shares one rotating refresh token across workers). Qoder: `QODER_PERSONAL_ACCESS_TOKEN` is stateless and parallel-safe.

Worker-writable run store: the run store (`.ultracode/runs/**`) lives inside the workspace, so a prompt-injected agent that processes hostile repo content runs as the same user and *can* write there. Artifact writes are `O_NOFOLLOW` (no symlink redirect), other backends' credentials are scrubbed from each worker's env, and forced-stop kill targets are bound to the recorded process's kernel start-time (Linux) so a recycled/forged PID isn't signaled. These raise the bar but are **not** a boundary against a same-user attacker: PID start-times are public and unavailable off Linux (best-effort there), and **`resume` re-executes `script.js`/`config.json` from that worker-writable dir with no review gate** — so a poisoned prior run can influence a later resume (including its `permission`). Treat resuming an untrusted run as running its inputs. Two known replay caveats: a `pipeline()` whose later-stage dispatch order depends on completion timing can lose its cache prefix on resume, and fallback token estimates (no-usage backends) are approximate. Full isolation (control-plane outside the workspace, a separate-process sandbox, authenticated signaling) is future work.

## Quick start

```bash
npm install && npm run build      # or: npm link  for a global `ultracode`
ultracode doctor                  # which backends are available + auth modes
ultracode install codex           # skill + AGENTS.md trigger + MCP registration
# then in Codex:  "ultracode: review this repo for auth bugs +500k"

# or drive it directly:
ultracode validate my.workflow.js
ultracode run my.workflow.js --dry-run          # free rehearsal (mock backend)
ultracode run my.workflow.js --backend codex --budget 500k
                                                # ^ foreground run already shows the live panel;
                                                #   `watch` re-attaches from another shell (or after --detach)
ultracode watch <runId>                         # live panel: ↑/↓ select an agent, ⏎ opens its
                                                # prompt/activity/outcome detail, esc back/clear, q detach
ultracode resume <runId> [--script edited.js]   # completed agents replay free
```

## Commands

`run` · `watch` · `status` · `logs` · `stop` · `list` · `resume` · `validate` · `lint` · `doctor` · `mode` · `install <codex|qoder|generic>` · `sync` · `mcp`

## What's proven

End-to-end on real backends: the `uc-review` workflow (3 dimension finders → per-finding adversarial verification → synthesis) run on **Codex** against `examples/sample-repo` found both planted auth bugs — with constructed exploit inputs as evidence — plus a real unplanted one (`examples/parity-demo-output.json`, 12 agents). A typed-schema workflow verified on **Claude**. Codex drove the full `workflow_start → status → result` MCP loop. 200+ offline tests (mock backend + golden fixtures) cover the dialect contract, sandbox bans, journal determinism, resume, structured-output, safety rails, all five adapters, worktree isolation, nested workflows, and the exec-layer hardening (O_NOFOLLOW writers, pgid kill-guard, resume path confinement).

## Design & research

- `docs/design/judge.md` — the synthesized architecture + milestone plan (3 architects + judge).
- The design is grounded in source-level research: the Claude Code ultracode mechanism, Codex/Qoder CLI internals (Qoder's native Workflow tool decompiled), MCP long-running-tool constraints across hosts, parallel-safety analysis, a cross-host survey, and JS-sandbox tradeoffs.
- `SUPPORTED_VERSIONS.md` — pinned CLI versions, platform notes, live-test gate.

## v1 scope

In: engine (sandbox, dialect, journal/resume, budget, watchdogs), 5 backends (mock/codex/qoder/claude/gemini), CLI, MCP triad, codex+qoder+generic installers, worktree isolation, one-level nested workflows. Deferred: Windows, cursor/copilot/opencode/amp adapters, npm publish + marketplace repos (internal-first), MCP Tasks (unsupported by target hosts).
