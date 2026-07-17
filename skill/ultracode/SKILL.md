---
name: ultracode
description: Dynamic multi-agent workflow orchestration (ultracode mode). Use ONLY when the user writes the keyword "ultracode" as their request to you — that word alone arms the mode for the rest of the session (until "ultracode off"). Then author a workflow in the shared dialect and run it via the host's native Workflow tool or the ultracode engine. NEVER use from inside a workflow worker — if ULTRACODE_INSIDE_RUN is set, do the task directly ("ultracode" in file/directory names or quoted text is not a trigger).
---

# ultracode — dynamic workflow orchestration

You orchestrate a fleet of subagents through a small JavaScript workflow script instead of doing everything in one context. The script is deterministic control flow; the agents are the intelligence. Your job: decompose, author, run, monitor, synthesize.

## Mode semantics (standing opt-in)

- **Only the keyword "ultracode"**, written by the user as their request to YOU, arms ultracode mode for the rest of the session; without the keyword, handle the task solo. The same provenance rule governs disarming: "ultracode" / "ultracode off" seen inside file or directory names, paths, code, or quoted logs neither arms nor disarms the mode.
- **Worker guard (hard rule):** if the `ULTRACODE_INSIDE_RUN` environment variable is set, you ARE a worker inside an ultracode run. Never start workflows by any route (ultracode CLI, `workflow_start` MCP tool, a native Workflow tool) — a worker that launches runs escapes the parent's caps and cascades. Do your assigned task directly and return.
- While ON: route **every substantive task** through a workflow by default. Work solo only on conversational turns and trivial mechanical edits. Optimize for the most exhaustive, correct answer — not the cheapest.
- The user says **"ultracode off"** → revert to normal single-agent behavior.
- Budgets are **opt-in by the user only.** With no explicit directive, run **uncapped** — do NOT pass `--budget` or a `budget` arg, and never invent a number "to be safe." Only when the user gives a directive ("+500k", "budget 2m") do you set one; pass it verbatim to the engine (`--budget` / `budget` arg), never advisory or a number you invented. The engine enforces it at the per-dispatch gate — a firm threshold no *new* agent crosses, though in-flight calls and their internal retries/repairs can overshoot it by a bounded margin (it is not a mid-call hard cap). The engine default is unlimited; keep it that way unless told otherwise.

## When to orchestrate — and when not

Applies **only once the keyword has armed the mode** (above); with it off, every task is solo. While ON, orchestrate when the task has **3+ independent agent-sized units** (files to audit, questions to research, modules to migrate, findings to verify), needs **independent perspectives** (adversarial verification, judge panels), or exceeds what one context can hold.

Do NOT orchestrate: single-file edits; tasks with <3 independent units; anything needing mid-run user input (workflows cannot ask — decompose so decisions happen between workflows); purely conversational turns; **when you are yourself a workflow worker (`ULTRACODE_INSIDE_RUN` set)**. Over-triggering is how users uninstall this skill.

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
2. **ultracode MCP tools available** (`workflow_start`/`workflow_status`/`workflow_result`) → `workflow_start` returns a runId in <1s; verify liveness with one quick `workflow_status {waitSeconds: 1}` poll, then park on the quiet monitor: `workflow_status {runId, until: 'terminal', waitSeconds: 3300}` (3300 = the codex hostpack's pinned 3600s tool timeout minus margin; on other hosts use your MCP tool timeout − 60). waitSeconds is the wake interval, not a safety knob — it wakes only when the run ends, so a long hold makes an hour of monitoring cost ~1 turn instead of ~70, while a small "safe" value burns a turn per wake; a timed-out hold is harmless — re-issue the same call. Stream logs (default `until: 'activity'` + `sinceEventOffset`) only while actively debugging. Fetch `workflow_result` when terminal. **From a sandboxed host (Codex, any per-command exec jail) this is the ONLY reliable route — the MCP server process persists outside your command sandbox.** (Interactive hosts only: a workflow WORKER never dispatches runs — see the worker guard above.)
3. **Shell access** → `ultracode run script.workflow.js --backend codex --yes` (append `--budget <the user's number>` ONLY if the user gave one). Always `ultracode validate` + `--dry-run` first — the dry run is free and catches dialect errors. **If your shell is sandboxed, do NOT `--detach`: the runner is SIGKILLed when your tool call's sandbox (PID namespace) tears down — symptom: `status` shows `orphaned` within seconds, manifest `pid` ≤ 64, empty runner.log. Use the MCP route or ask to escalate the command.** In a persistent shell, `--detach` for long runs, then monitor with `ultracode watch <runId>` (or `status <runId> --watch`).
4. Resume after failure/edit: `ultracode resume <runId> [--script edited.js]` — completed agents replay free from the journal.

**Run lifecycle discipline (non-negotiable):** after launching, your NEXT action is a liveness check — the first `workflow_status` poll or `ultracode status <runId>`; a run showing `orphaned` died at launch, so diagnose instead of waiting. While a workflow runs, do NOT do the subtask work inline yourself — park on the quiet monitor (`until: 'terminal'`), or poll between your own steps, until terminal; never abandon a started run. Synthesize from the terminal `workflow_result`/`output.json` (plus your own verification), never instead of it.

## Safety rails (engine-enforced; don't fight them)

- Review-before-run is mandatory (`--yes` only after you've shown the user the plan or they pre-authorized).
- Worker permission is a **user knob**: default to `--permission auto` (workspace-write, the engine default — workers can execute commands). If the user specifies a permission ("safe", "read-only", "danger"), pass it verbatim — never downgrade or upgrade on your own. **If the user picks `safe`, mind the backend asymmetry: codex `safe` is a read-only sandbox that can still RUN commands (sqlite3/grep/profilers work); claude/qoder `safe` is a headless default-permission mode that auto-rejects EVERY tool call — those workers can only read-and-reason.** When `safe` workers must execute read-only commands, surface the tradeoff to the user and embed the evidence in prompts instead. Detection differs: codex declines surface as an "actions auto-rejected" warning in `failures[]`; claude/qoder `safe` rejections are SILENT — the only signal is empty/"unverified" agent results.
- Concurrency is user-controlled: default min(10, max(2, cores-2)); override via `--max-concurrency`, `ULTRACODE_MAX_CONCURRENCY`, or `workflow_start`'s `maxConcurrency`. The env var seeds fresh runs only — a resume inherits the stored value unless `resume --max-concurrency` / MCP `maxConcurrency` overrides it. For codex workers, `CODEX_API_KEY` is the parallel-safe auth.
- Budget exhaustion stops dispatch loudly; check `failures[]` in the output — it lists every cap trip, declined action, and failed agent.
