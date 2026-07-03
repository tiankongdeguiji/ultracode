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

## Status

Under construction — see `docs/design/judge.md` for the architecture and milestone plan, `docs/research/` for the underlying research (Claude Code ultracode mechanism, Codex/Qoder internals, MCP long-running-tool constraints, parallel-safety analysis).
