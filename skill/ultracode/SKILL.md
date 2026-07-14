---
name: ultracode
description: Dynamic multi-agent workflow orchestration (ultracode mode). Use when the user says "ultracode", sets a token budget like "+500k", asks to use a workflow / fan out agents / orchestrate, or when a substantive task decomposes into 3+ independent agent-sized units (code review, audit, research, migration, test sweep). Author a workflow script in the shared dialect and run it via the host's native Workflow tool or the ultracode engine.
---

# ultracode — dynamic workflow orchestration

You orchestrate a fleet of subagents through a small JavaScript workflow script instead of doing everything in one context. The script is deterministic control flow; the agents are the intelligence. Your job: decompose, author, run, monitor, synthesize.

## Mode semantics (standing opt-in)

- The keyword **"ultracode"** in a message, a budget token like **"+500k"**, or an explicit ask ("use a workflow", "fan out agents") switches ultracode mode ON for the rest of the session.
- While ON: route **every substantive task** through a workflow by default. Work solo only on conversational turns and trivial mechanical edits. Optimize for the most exhaustive, correct answer — not the cheapest.
- The user says **"ultracode off"** → revert to normal single-agent behavior.
- Budgets are **opt-in by the user only.** With no explicit directive, run **uncapped** — do NOT pass `--budget` or a `budget` arg, and never invent a number "to be safe." Only when the user gives a directive ("+500k", "budget 2m") do you set one; it is then a HARD ceiling, passed verbatim to the engine (`--budget` / `budget` arg), never advisory. The engine default is unlimited; keep it that way unless told otherwise.

## When to orchestrate — and when not

Orchestrate when the task has **3+ independent agent-sized units** (files to audit, questions to research, modules to migrate, findings to verify), needs **independent perspectives** (adversarial verification, judge panels), or exceeds what one context can hold.

Do NOT orchestrate: single-file edits; tasks with <3 independent units; anything needing mid-run user input (workflows cannot ask — decompose so decisions happen between workflows); purely conversational turns. Over-triggering is how users uninstall this skill.

## Authoring a workflow (the shared dialect)

Same dialect as Claude Code and Qoder native workflows — one script runs on all three engines. Full reference: `references/dialect.md`.

```js
export const meta = { name: 'uc-audit', description: 'Audit route handlers for auth bugs', phases: [{ title: 'Find' }, { title: 'Verify' }] }
phase('Find')
const found = await agent('List route files under src/. Return JSON.', {
  label: 'lister',
  schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] },
})
phase('Verify')
const audits = await pipeline(found.files, (f) => agent(`Audit ${f} for missing auth checks. You are one agent among many; be self-contained.`, { label: f }))
log(`${audits.filter(Boolean).length}/${found.files.length} audited`)
return { audits: audits.filter(Boolean) }
```

Eight rules:
1. `meta` must be a **pure literal** beginning the script (no variables/calls/spreads).
2. **Prompts must be self-contained** — subagents see nothing of your conversation. Inline every fact they need.
3. Default to `pipeline(items, ...stages)` (no inter-stage barrier; `stage(prev, originalItem, index)`); use `parallel(thunks)` only when a stage genuinely needs ALL prior results (dedup, early-exit, cross-comparison).
4. Failures don't halt: `parallel` throw→`null` slot; `pipeline` throw drops the item. `.filter(Boolean)` before use. An `agent()` that fails after retries **throws** — catch it or let the run fail.
5. Use `schema` for every result you'll consume programmatically — `agent()` then returns a validated object. Keep schemas strict-subset friendly: root `type:"object"`, no `oneOf/allOf`, no map-style `additionalProperties`.
6. `Date.now()`, `Math.random()`, no-arg `new Date()` **throw** (resume determinism) — pass timestamps/seeds via `args`.
7. Don't branch on completion ORDER (breaks resume replay); branch on results.
8. Report every cap/cut you introduce (top-N, sampling) via `log()` — no silent caps.

## Quality patterns (pick per task; details in `references/patterns.md`)

- **Adversarial verify**: N independent skeptics per finding, prompted to REFUTE; majority-refute kills it.
- **Perspective-diverse verify**: distinct lenses (correctness/security/perf/repro) beat N identical refuters.
- **Judge panel**: N independent attempts from different angles → judges → synthesize winner.
- **Loop-until-dry**: keep spawning finders until 2 consecutive rounds add nothing new (dedup vs *seen*, not vs *confirmed*).
- **Multi-modal sweep**: parallel agents each searching a different way.
- **Completeness critic**: final agent asks "what's missing?" — its output is the next round.

Scale to the ask: "find bugs" → few finders, single vote; "thoroughly audit" → large pool + 3-vote adversarial pass + synthesis.

## Running (dispatch — details in `references/invoking.md`)

1. **Qoder with the native Workflow tool available** → use the native tool / save to `.qoder/workflows/`. (Budget is stubbed there: pass it via `args.budgetTokens` and gate manually.)
2. **ultracode MCP tools available** (`workflow_start`/`workflow_status`/`workflow_result`) → `workflow_start` returns a runId in <1s; poll `workflow_status` (a timed-out poll is harmless — re-poll the same runId); fetch `workflow_result` when terminal.
3. **Shell access** → `ultracode run script.workflow.js --backend codex --yes` (append `--budget <the user's number>` ONLY if the user gave one; `--detach` for long runs, then `ultracode status <runId> --watch`). Always `ultracode validate` + `--dry-run` first — the dry run is free and catches dialect errors.
4. Resume after failure/edit: `ultracode resume <runId> [--script edited.js]` — completed agents replay free from the journal.

## Safety rails (engine-enforced; don't fight them)

- Review-before-run is mandatory (`--yes` only after you've shown the user the plan or they pre-authorized).
- Workers default to workspace-write sandbox; use `--permission safe` (read-only) for research/review workflows — prefer it whenever agents don't need to edit.
- Codex on ChatGPT OAuth runs at concurrency 1 (fan-out unsafe); real parallelism needs `CODEX_API_KEY`.
- Budget exhaustion stops dispatch loudly; check `failures[]` in the output — it lists every cap trip, declined action, and failed agent.
