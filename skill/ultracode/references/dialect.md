# The workflow dialect — full reference

One script text runs on three engines: Claude Code (`.claude/workflows/`), Qoder CLI native (`.qoder/workflows/`), and the ultracode engine (`ultracode run` / MCP). Stick to the portable subset (see `portability.md`) and it stays true.

## Script shape

```js
export const meta = {
  name: 'uc-example',            // [a-zA-Z0-9._:-]+ ; uc- prefix recommended (namespace hygiene)
  description: 'one line',       // required
  title: 'Display title',        // optional
  whenToUse: '...',              // optional; shown in workflow listings
  phases: [{ title: 'Scan', detail: 'grep the logs' }],  // optional; matched by phase() title
  inputSchema: { type: 'object' } // optional; args validated against it before run
}
// body: plain JavaScript, top-level await and top-level return are legal.
// No imports. No filesystem/network/shell — agents are the only side-effect channel.
```

`meta` MUST be a pure literal (no variables, function calls, spreads, or template interpolation) and must be the first statement. Scripts are capped at 512 KB.

## Globals

### `agent(prompt, opts?) → Promise<any>` (also `agent({ prompt, ...opts })`)

| opt | meaning |
|---|---|
| `label` | display name in progress UIs and run artifacts |
| `phase` | progress group; use inside pipeline/parallel stages to avoid races on the global `phase()` pointer |
| `schema` | JSON Schema → subagent forced through structured output; `agent()` returns the **validated object** |
| `model` | per-call model override (omit to inherit — usually correct) |
| `effort` | reasoning effort override (ultracode engine; NOT portable to Qoder native — use agentType there) |
| `agentType` | subagent type from the host's registry |
| `isolation: 'worktree'` | fresh git worktree — ONLY for parallel file mutation that would conflict |
| `backend` | ultracode engine only: route this call to a specific worker CLI (codex/qoder/claude/gemini/mock) |
| `retries` | task retry budget 0–5 (independent of schema-repair retries); a retry resumes the failed attempt's backend session when the backend supports it, so prior progress carries over |
| `timeoutMs` | per-attempt hard timeout (default 20m; run-wide default via `workflow_start`'s `attemptTimeoutMs`) |
| `stallMs` | watchdog: kill + retry if the worker emits nothing for this long |
| `skip: true, skipReason` | resolve to `null` without spawning (journaled) |

Returns final text (no schema) or the validated object (schema). Returns `null` if skipped. **Throws** after exhausted retries — the failure is recorded as `agent[seq] <label> failed: <msg>`.

### `parallel(thunks) → Promise<any[]>`

Array of **functions**. Barrier: awaits all. A throwing thunk resolves to `null` at its index and records `parallel[i] failed: ...`. Never fail-fast. Max 4096 items.

### `pipeline(items, ...stages) → Promise<any[]>`

Each item flows through stages independently — **no inter-stage barrier** (item A can be in stage 3 while item B is in stage 1). Every stage receives `(prevResult, originalItem, index)`. A throwing stage records `pipeline[i] failed: ...` and drops the item to `null`, skipping its remaining stages; a stage returning `null` drops silently (the skip idiom). Max 4096 items.

**Default to pipeline.** A barrier is justified only when stage N needs cross-item context from ALL of stage N−1: dedup/merge, early-exit-on-zero, "compare with the other findings".

### `phase(title)` / `log(message)`

Progress grouping (seeded from `meta.phases`, matched by exact title) and narrator lines (capped at 1000, then dropped+counted).

### `args` / `budget` / `workflow()`

- `args`: the invocation input, verbatim (JSON round-tripped).
- `budget`: `{ total: number|null, spent(), remaining() }` — dispatch-gate enforced; `remaining()` is `Infinity` when no target. Guard loops: `while (budget.total && budget.remaining() > 50_000) { ... }`.
- `workflow(nameOrRef, args?)`: run a child workflow inline, ONE nesting level, sharing the parent's semaphore/agent counter/abort/budget.

### Determinism bans (all engines)

`Date.now()`, `Math.random()`, no-arg `new Date()`/`Date()` **throw** with instructive messages. `new Date(value)`, `Date.parse`, `Date.UTC` are fine. Reason: hash-chained journal resume replays the unchanged prefix of `agent()` calls; entropy would desync the chain.

## Caps (engine-enforced, loudly reported)

Concurrency default `min(10, max(2, cores−2))` — `--max-concurrency`, `ULTRACODE_MAX_CONCURRENCY`, or `workflow_start`'s `maxConcurrency` override it (FIFO queue beyond the cap; the env var seeds fresh runs only — resumes inherit the stored value unless explicitly overridden); lifetime 1000 agents hard / 50 soft default (`--max-agents`); 4096 items per parallel/pipeline call; per-attempt timeout 20m default (per-call `timeoutMs` wins over `workflow_start`'s `attemptTimeoutMs`); run wall-clock 60m default (`--timeout <minutes>` or `workflow_start`'s `wallClockMs`). The `workflow_start` timeout params (`attemptTimeoutMs`, `wallClockMs`) are user-opt-in only, like budgets: set them only when the user explicitly asked for a time limit.

## Failure-handling idioms

```js
const results = (await parallel(list.map((x) => () => agent(promptFor(x))))).filter(Boolean)

let out = null
try { out = await agent('critical step', { retries: 2 }) } catch (e) { log(`step failed: ${e.message}`) }

// loop-until-dry with dedup vs SEEN (not vs confirmed — else rejected findings recur forever)
const seen = new Set(); let dry = 0
while (dry < 2) {
  const found = (await parallel(FINDERS.map((f) => () => agent(f, { schema: FINDINGS })))).filter(Boolean).flatMap((r) => r.items)
  const fresh = found.filter((b) => !seen.has(b.key))
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach((b) => seen.add(b.key))
  // ...verify fresh...
}
```
