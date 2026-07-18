# ultracode-engine — Host-Agnostic Core Design

npm package: **`ultracode`** (single package, TypeScript, Node >= 20, ESM). Ships three executables from one codebase: `ultracode` (CLI), `ultracode mcp` (MCP stdio server), and an internal `ultracode-runner` entry (detached run process). Zero native deps.

---

## 0. Package / module layout

```
ultracode/
├── package.json            # bin: { ultracode: "dist/cli/main.js" }; deps: acorn, ajv (2020-12), commander, @modelcontextprotocol/sdk
├── src/
│   ├── index.ts            # public API: runWorkflow(), resumeWorkflow(), RunStore, BackendRegistry
│   ├── engine/
│   │   ├── run.ts          # WorkflowRun: top-level orchestration of one run
│   │   ├── sandbox.ts      # node:vm context factory + hardening bootstrap
│   │   ├── determinism.ts  # bootstrap source: Date/Math.random bans, intrinsic freeze list
│   │   ├── meta.ts         # acorn parse, pure-literal meta validation, body extraction
│   │   ├── hostapi.ts      # agent()/parallel()/pipeline()/phase()/log()/workflow()/budget/console/timers
│   │   ├── semaphore.ts    # counting semaphore, FIFO
│   │   ├── journal.ts      # hash-chain journal, prefix-replay cache
│   │   ├── agentcall.ts    # single agent() lifecycle: cache→spawn→parse→validate→retry→journal
│   │   └── errors.ts       # WorkflowError taxonomy
│   ├── backends/
│   │   ├── types.ts        # BackendAdapter, AgentEvent, NormalizedUsage, ExitClass
│   │   ├── registry.ts     # id→adapter map, probe/doctor
│   │   ├── ndjson.ts       # incremental JSONL splitter (handles partial lines, non-JSON stderr noise)
│   │   ├── structured.ts   # emulated schema loop: prompt suffix builder + ajv validate + repair prompts
│   │   ├── schema-strict.ts# codex strict-subset validator/normalizer
│   │   ├── usage.ts        # per-backend usage → NormalizedUsage
│   │   ├── codex.ts qoder.ts claude.ts gemini.ts cursor.ts copilot.ts opencode.ts amp.ts
│   ├── store/
│   │   ├── layout.ts       # path resolution (.ultracode/, $ULTRACODE_HOME)
│   │   ├── manifest.ts     # atomic tmp+rename manifest writer, heartbeat
│   │   ├── runstore.ts     # create/list/get/liveness; single-writer discipline
│   │   └── events.ts       # events.jsonl append + tail/follow (fs.watch + offset cursor)
│   ├── exec/
│   │   ├── spawn.ts        # child spawn in own process group (setsid), kill-tree, stdout/stderr plumbing
│   │   ├── daemonize.ts    # detached runner launch, pidfile
│   │   └── worktree.ts     # git worktree add/remove for isolation:'worktree'
│   ├── budget/
│   │   ├── parse.ts        # "+500k" / "500k" / "2m" → tokens
│   │   └── account.ts      # BudgetAccount: spent()/remaining(), atomic accumulation
│   ├── cli/
│   │   ├── main.ts run.ts status.ts logs.ts resume.ts stop.ts list.ts validate.ts doctor.ts runner.ts
│   └── mcp/
│       ├── server.ts       # stdio MCP server, tool registration
│       └── tools.ts        # workflow_start/status/result/stop/list handlers, long-poll
└── test/ …                 # golden NDJSON fixtures per backend, journal replay tests, sandbox escape tests
```

---

## 1. Workflow script runtime

### 1.1 Sandbox: hardened `node:vm` (Qoder-style), engine in a dedicated child process

**Choice: `node:vm` with frozen intrinsics, running inside the detached `ultracode-runner` process — the exact architecture Qoder ships in production.** Not quickjs-emscripten, not SES, not isolated-vm.

The decisive technical reason to reject quickjs-emscripten: the dialect requires **arbitrary guest-side concurrent awaits over host promises**. `parallel(thunks)` invokes guest closures that each `await agent(...)`, and scripts legally write `await Promise.all([agent(a), agent(b)])` directly. quickjs Asyncify permits **one suspension at a time** per module — implementing the dialect faithfully would require rewriting all concurrency host-side and banning direct `Promise.all` over `agent()` calls, i.e. a different dialect. SES-in-a-worker is the runner-up (better intrinsic hardening, native async), but adds `lockdown()` compat risk with zero additional security payoff given our trust model, and diverges from the reference implementation we are cloning bit-for-bit.

Trust model (same as Qoder/Claude Code): scripts are **model-authored and user-reviewed before run** ("Review dynamic workflow before running"). The sandbox is a *capability-scoping and determinism* device, not a hostile-code boundary. Defense in depth comes from process architecture: the script runs inside `ultracode-runner`, which itself holds no credentials beyond spawn rights; scripts have **no** fs/net/shell/require/process — the only side-effect channel is `agent()`, and each agent is a subprocess governed by the host CLI's own permission system.

Hardening bootstrap (`determinism.ts`, executed via `vm.runInContext` before the script, mirroring Qoder's decoded bootstrap):
- Replace `Date.now` → throws `"Date.now() is unavailable in workflow scripts; pass timestamps via args."`; no-arg `new Date()` and bare `Date()` throw likewise; `new Date(args...)`, `Date.parse`, `Date.UTC` remain legal (Proxy-wrapped Date constructor installed as context global).
- `Math.random` → throws `"Math.random() is unavailable in workflow scripts; pass deterministic values via args."`
- `delete globalThis.WebAssembly; delete globalThis.ShadowRealm; delete globalThis.Atomics; delete globalThis.SharedArrayBuffer;`
- `Object.freeze` on the prototypes + constructors of the 28 core intrinsics (Object, Array, Function, Promise, String, Number, Boolean, Symbol, RegExp, Error family, Map, Set, WeakMap, WeakSet, ArrayBuffer, TypedArrays, Proxy, Reflect, JSON, Math, …).

Context globals (fixed set, nothing else): `agent, parallel, pipeline, phase, log, workflow, args, budget, console (log/info/debug→log; warn/error prefixed "[warn]"/"[error]"), setTimeout/clearTimeout` (wrapped: registered against the run's AbortController, all cleared on abort). Host-function returns are **JSON round-tripped** before crossing into the context so no host object graphs (with live prototypes) leak in.

Execution: script body wrapped as `(async () => {\n<body>\n})()`, compiled via `new vm.Script(src, { filename: 'workflow.js' })`, run with `{ timeout: 30_000 }` (guards synchronous runaway only; async is governed by run-level `--timeout` and per-agent `stallMs` watchdogs). Script size cap **524,288 bytes**.

### 1.2 Meta parsing (`meta.ts`)

acorn with `{ ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }` (top-level `return` is legal and becomes the run result).

- Locate the single `ExportNamedDeclaration` of `const meta = {...}`. It MUST be a **pure literal**: recursive walk permitting only `ObjectExpression` (non-computed Identifier/string keys), `ArrayExpression`, `Literal`, `TemplateLiteral` with zero expressions, and `UnaryExpression('-', Literal)`. Any Identifier value, call, spread, or interpolation → `MetaValidationError` with node location.
- Required: `name` (matches `[a-zA-Z0-9._:-]+`), `description`. Optional: `title`, `whenToUse`, `phases: [{title, detail?, model?}]`, `inputSchema` (JSON Schema; if present, `args` is ajv-validated against it before run: error `"Workflow args do not match <name> meta.inputSchema"`).
- The `export const meta` statement (and any other `export`) is stripped by source-range splice; the remainder is the body. Any other import/export → error ("workflow scripts cannot import modules").
- `ultracode validate <file>` runs exactly this pass plus a dry sandbox compile and prints phase/agent-callsite summary.

### 1.3 Host API semantics (`hostapi.ts`) — exact contract

```ts
agent(prompt: string, opts?: AgentOptions): Promise<unknown>
agent(opts: AgentOptions & { prompt: string }): Promise<unknown>

interface AgentOptions {
  label?: string; phase?: string;
  schema?: JsonSchema;              // forces structured output; agent() resolves to the VALIDATED OBJECT
  model?: string; effort?: 'low'|'medium'|'high'|'xhigh'|'max';
  isolation?: 'worktree';
  agentType?: string;               // aliases: type, subagent_type; default 'general-purpose'
  backend?: BackendId;              // ultracode extension: per-call backend override
  cwd?: string; retries?: number;   // clamped 0–5, default 0
  stallMs?: number;                 // no-progress watchdog → auto-retry up to 5 attempts
  skip?: boolean; skipReason?: string; // returns null immediately, journaled 'user-skip'
}
```

- **Semaphore**: global FIFO counting semaphore over every `agent()` (shared with nested `workflow()` children), permits = `min(16, max(2, os.cpus().length - 2))`, overridable via `--max-concurrency`. Extra calls queue. *(Superseded in 0.1.1: default is `min(10, max(2, cores-2))`, overridable via `--max-concurrency`, `ULTRACODE_MAX_CONCURRENCY`, or MCP `maxConcurrency`.)*
- **Lifetime cap**: 1000 agents/run (shared counter with children) → throw `"Workflow reached max agents (1000)"`. **Item cap**: `parallel`/`pipeline` inputs > 4096 → `TypeError`.
- **Budget gate**: before dispatch, `budget.remaining() <= 0` → throw `"Workflow budget exceeded"`.
- **`parallel(thunks)`**: TypeError unless array of functions. `Promise.allSettled` **barrier**; a rejected thunk → `null` at its index + `failures.push("parallel[i] failed: <msg>")` + log entry. Never fail-fast. Order preserved.
- **`pipeline(items, ...stages)`**: all items processed concurrently (allSettled over items — concurrency throttled only by the agent semaphore); each item flows its stages sequentially; `stage(prevResult, originalItem, index)`; a stage throwing **or returning null** drops the item to `null`, skips remaining stages, records `"pipeline[i] failed: <msg>"`. No inter-stage barrier.
- **`agent()` failure**: exhausted retries → **throws** inside the script (`WorkflowAgentError`), recorded in `failures[]` as `agent[<seq>] <label> failed: <msg>`. Caller context determines fate (parallel→null slot, pipeline→dropped item, bare top-level→run fails with partials preserved).
- **`phase(title)`**: creates/reuses named phase index (seeded from `meta.phases`); subsequent agents group under it. `opts.phase` on agent() sets the group directly (documented for use inside parallel/pipeline stages to avoid races on the global phase pointer — we implement it, closing Qoder's doc-ahead-of-code gap).
- **`log(msg)`**: appends `workflow_log` event; cap 1000 entries then drop+count.
- **`budget`**: `{ total: number|null, spent(): number, remaining(): number }` — real, wired (see §5).
- **`workflow(nameOrRef | {name|scriptPath, args?}, args?)`**: runs a child workflow **inline, one nesting level max** (child attempting `workflow()` throws). Child shares parent's semaphore, agent counter, AbortSignal, and BudgetAccount; child journal entries interleave into the parent chain with a `child-enter(name, argsHash)` boundary record so prefix replay stays coherent. Child events surface tagged `childId`/`childName`, bounded by `child_started`/`child_completed` (see §1.5).
- **Run result**: `{ result, logs, failures, agentCount, totalTokens, totalToolCalls, durationMs, error? }` → `output.json`.

### 1.4 Journal + resume (`journal.ts`) — hash-chain prefix replay

Append-only `journal.jsonl`, one writer (the runner). Cache key chain, Qoder-compatible in construction:

```
key_0 = "u1:" + sha256("ultracode-seed" + "\0" + stableStringify(args) + "\0" + permission)
# (script hash deliberately EXCLUDED from the seed — resume-after-edit must keep the unchanged prefix)
key_n = "u1:" + sha256(key_{n-1} + "\0" + prompt + "\0"
        + stableStringify({ agentType, isolation, model, effort, schema, backend, cwd }))
```

(`stableStringify` = sorted-key deterministic JSON; absent fields omitted.) Records: `{t:'started', runId, engineVersion, scriptHash, argsHash}`, `{t:'agent', seq, key, status:'ok'|'error'|'skip', label, phase, backend, model?, cached?, sessionId?, totalTokens, resultRef, error?}`, `{t:'child-enter'|'child-exit', name}`.

**Resume** (`resumeFromRunId`): prior run must be terminal (pid dead + manifest status ∉ running). New run gets fresh runId + fresh journal; the old journal is loaded as an ordered replay queue. `nextCachedResult(key)` compares sequentially; every hit resolves that `agent()` **instantly** from `resultRef` (re-read from the old run's `agents/` dir); the **first miss sets `prefixMissed = true` and disables all later hits** — exactly the longest-unchanged-prefix contract. Determinism holds because banned entropy sources + instant cached resolution make the microtask interleaving reproducible up to the first live call; beyond that everything runs live anyway. Same script + same args ⇒ full cache hit.

### 1.5 Progress events

The runner appends every state change to `events.jsonl` (separate from the journal so cache logic stays pure): `run_started, phase_started, agent_queued, agent_started {seq,label,phase,backend,model?,effort?,agentType?}, agent_usage {seq,totalTokens,estimated}` (throttled ≤1/s cumulative live token tick, display-only — budget accounting stays on `budget_tick`), `agent_retry {seq,label,attempt,maxAttempts,kind:'task'|'schema-repair',reason?}, agent_model {seq,model}` (backend-resolved), `agent_tool {seq,name,status:'started'|'completed'|'failed'|'declined'}` (unthrottled discrete tool-call tick, display-only — name sanitized + capped at 80 chars at emission, ≤5000 events per dispatch; feeds the panel's live count and detail-view activity feed), `agent_completed {seq,label,phase,ok,skipped?,cached?,totalTokens,estimated?,toolCalls?,error?}` (`toolCalls` is the authoritative started-tool count; absent on skip/cached and on streams from engines predating `agent_tool`), `workflow_log, budget_tick {spent}, child_started {childId,name,argsHash} | child_completed {childId,name,ok,agentCount}, stop_requested, run_completed|run_failed|run_stopped`. Events emitted inside a nested `workflow()` child carry `childId`/`childName` tags (per-event attribution — child agents can interleave with concurrent parent agents); the child's own `run_*` lifecycle events are dropped. CLI `watch` (the live panel), `logs --follow`, and MCP long-poll all tail this file by byte offset (`status --watch` polls manifest.json instead); the MCP long-poll wakes only on *renderable* lines, so usage and tool ticks never spin it.

---

## 2. BackendAdapter interface

```ts
export type BackendId = 'codex'|'qoder'|'claude'|'gemini'|'cursor'|'copilot'|'opencode'|'amp';

export interface AgentRequest {
  prompt: string; schema?: JsonSchema; model?: string; effort?: string;
  agentType?: string; cwd: string;             // resolved (worktree path if isolation)
  permission: 'safe'|'auto'|'danger';           // maps to per-backend approval flags
  env: Record<string,string>;                   // auth passthrough resolved by config
}

export interface SpawnPlan { bin: string; argv: string[]; env: Record<string,string>;
  stdinData?: string;                            // prompt via stdin when argv length is a risk
  schemaTempFile?: { content: string };          // codex --output-schema wants a file path
}

export type AgentEvent =
  | { kind:'session';  sessionId: string; model?: string }  // model when the stream reports one (init lines)
  | { kind:'message';  text: string }                       // assistant text; consumers keep the LAST
  | { kind:'tool';     name: string; status:'started'|'completed'|'failed'|'declined' }
  | { kind:'usage';    usage: Partial<NormalizedUsage>; interim?: boolean; threadCumulative?: boolean }
  | { kind:'result';   text?: string; structured?: unknown; isError: boolean;
      errorKind?: ErrorKind; raw?: unknown }
  | { kind:'notice';   message: string };                    // benign (e.g. codex "Reconnecting… n/5")

export type ErrorKind = 'auth'|'schema-rejected'|'max-turns'|'budget'|'rate-limit'
  |'structured-output-retries'|'interrupted'|'stalled'|'infra'|'unknown';

export interface ExitClass { ok: boolean; errorKind?: ErrorKind; retryable: boolean; message: string; }

export interface NormalizedUsage { inputTokens: number; outputTokens: number;
  cachedInputTokens: number; reasoningTokens: number; totalTokens: number;
  costUSD?: number; estimated: boolean; }

export interface BackendAdapter {
  readonly id: BackendId;
  readonly structuredOutput: 'native'|'emulated';
  probe(): Promise<{ available: boolean; version?: string; authHint?: string }>;
  /** Reject/normalize schema BEFORE spawn where the backend enforces a subset. */
  checkSchema?(schema: JsonSchema): { ok: true; wireSchema: JsonSchema } | { ok: false; reason: string };
  buildSpawn(req: AgentRequest): SpawnPlan;
  buildResume(sessionId: string, followupPrompt: string, req: AgentRequest): SpawnPlan | null;
  createParser(): { push(line: string): AgentEvent[]; end(): AgentEvent[] };  // stateful NDJSON parser
  classifyExit(code: number|null, signal: NodeJS.Signals|null, events: AgentEvent[], stderrTail: string): ExitClass;
  extractUsage(events: AgentEvent[]): NormalizedUsage;
}
```

### 2.1 Per-backend implementations (quirks are load-bearing)

**codex** (`codex.ts`)
- Spawn: `codex exec --json --cd <cwd> --skip-git-repo-check -a never --sandbox <workspace-write|danger-full-access per permission> [-m model] [-c model_reasoning_effort=<effort>] [--output-schema <tmpfile>] -` (prompt on stdin). Never use `-o` (stale-file trap: not written/truncated on failure). Auth: pass `CODEX_API_KEY` through env only; shared `CODEX_HOME`; document ChatGPT-OAuth fan-out as unsupported (single-use refresh-token races) — `doctor` warns when no `CODEX_API_KEY`/`CODEX_ACCESS_TOKEN` is set and concurrency > 2.
- `checkSchema`: local strict-subset validation (`schema-strict.ts`): root `type:'object'`, every property listed in `required`, `additionalProperties:false` at every object level, keyword allowlist. Auto-normalize when losslessly possible (inject `required`/`additionalProperties:false` into the **wire** copy); the ORIGINAL schema remains the ajv validation target. Untransformable schema → immediate `agent()` error `schema-rejected` (zero spawns — a 400 is deterministic on every attempt).
- Parser: capture `thread.started.thread_id` → sessionId; `item.completed` with `item.type==='agent_message'` → `message` (keep **LAST** — intermediate messages are also schema-shaped, issue #19816); `turn.completed.usage` → usage; standalone `{"type":"error"}` → `notice` (includes benign retry chatter); `turn.failed` → result isError.
- `classifyExit`: ok ⇔ exit 0 AND a `turn.completed` seen. exit 1 + `turn.failed` message matched against `invalid_json_schema` → `schema-rejected` (non-retryable), `usage_limit|quota` → `rate-limit` (non-retryable at agent level), else `infra` (retryable ≤1: codex already burned 5 internal retries). exit 1 without turn.failed → `interrupted`.
- Resume: `codex exec resume <threadId> --json --output-schema <tmp> -` (schema flag is global, re-attaches on resume). Requires session persistence — engine never passes `--ephemeral`.

**qoder** (`qoder.ts`)
- Spawn: `qodercli --print --output-format stream-json [--json-schema '<json>'] [--model <tier>] [--effort low|medium|high|max] [--agent <agentType>] --permission-mode <dont_ask|bypass per permission> --max-turns N -w <cwd>`; env `QODER_PERSONAL_ACCESS_TOKEN` (stateless, N-parallel safe). `probe()` warns if a `/login` credential exists (it silently beats the env PAT).
- Parser: terminal `type:'result'` line → `result` with `structured_output`, `total_cost_usd`, `usage` + camelCase `modelUsage`; subtypes `error_max_turns|error_during_execution|error_max_budget_usd|error_max_structured_output_retries` → mapped ErrorKinds; `session_id` on every line.
- `classifyExit`: exit **41 = auth (terminal)**; other non-zero = infra (retryable ≤1); exit 0 with `is_error:true` result = semantic failure per subtype. `--json-schema` is undocumented ⇒ ALWAYS ajv-revalidate `structured_output`; if the flag ever disappears the adapter degrades automatically to the emulated loop (feature-detect on first schema failure signature).
- Resume: `qodercli --print -r <session_id> …`.

**claude** (`claude.ts`)
- Spawn: `claude -p --output-format stream-json --verbose [--json-schema '<json>'] [--model m] --permission-mode acceptEdits -w`-equivalent cwd via spawn cwd. Envelope is the qoder envelope's ancestor (same `result` line, `session_id`, `total_cost_usd`). Resume `--resume <session_id>`.

**gemini** (`gemini.ts`) — the canonical **emulated** structured-output backend
- Spawn: `gemini -p <prompt> --output-format stream-json [--yolo per permission] [-m model]`. Events `init/message/tool_use/tool_result/error/result`.
- No native schema flag → `structured.ts` loop: (1) append a schema contract suffix to the prompt (`Respond with ONLY a JSON object conforming to this JSON Schema… no prose, no fences`); (2) take final `result.response` text, strip code fences, `JSON.parse`, ajv-validate; (3) on failure, up to `schemaRetries` (default 2) **fresh** spawns with a repair prompt embedding the previous answer and the ajv error list (Gemini headless has no documented resume). Exit codes: 0 ok, 1 general, 42 input error (non-retryable), 53 turn-limit (`max-turns`).

**cursor** (`cursor.ts`): `cursor-agent -p --output-format stream-json`; NDJSON `system/user/assistant/tool_call/result`; sessionId from result; emulated schema; resume via `cursor-agent --resume <session_id>` when available else fresh-spawn repair.

**copilot** (`copilot.ts`): `copilot -p <prompt> -s --output-format=json --allow-tool/--deny-tool per permission profile, --session-id <generated>`; JSONL parsed leniently (schema less documented — parser treats unknown line types as `notice`); emulated schema; resume `--resume <session-id>`.

**opencode** (`opencode.ts`): `opencode run <prompt> --format json [-m provider/model] [--agent type] [--auto]`; emulated schema; resume `-s <session> -c`.

**amp** (`amp.ts`): `amp -x <prompt> --stream-json`; `parent_tool_use_id:null` filters main-thread messages; effort maps natively; emulated schema; resume `amp threads continue`.

### 2.2 Structured-output pipeline (uniform, `agentcall.ts`)

For every `agent({schema})` regardless of backend: (1) `checkSchema` where defined; (2) spawn with native flag or emulated prompt suffix; (3) extract candidate (native `structured_output` field, or last message text parsed); (4) **always** ajv-validate (draft 2020-12) against the ORIGINAL schema engine-side; (5) on invalid → repair loop: prefer `buildResume(sessionId, repairPrompt)` (codex/qoder/claude/copilot/opencode/amp), else fresh spawn (gemini/cursor); max 2 repairs; (6) still invalid → `WorkflowSchemaError` (agent failure; does NOT consume `retries` — schema repair and task retry are independent budgets). On success `agent()` resolves to the validated object; without schema it resolves to the final text.

### 2.3 Agent transcript persistence

Every spawn streams raw stdout JSONL to `agents/<seq(0-pad)>-<slug(label)>/transcript.jsonl`, stderr tail (last 64KB) to `stderr.log`, plus `prompt.md`, `schema.json`, `result.json` (`{ ok, value|text, usage, sessionId, backend, exit, attempts }`). `resultRef` in the journal points here; resume replay reads `result.json` only.

---

## 3. Run persistence & concurrency safety

### 3.1 On-disk layout

Default root: `<project>/.ultracode/` (git-ignorable), overridable `$ULTRACODE_HOME` or `--home`. Deliberately **outside** `.qoder/sessions/**` and `.claude/**` (namespace-defensive per the Qoder report).

```
.ultracode/
├── config.json                     # defaults: backend, per-backend {bin, model, effort, permission, envVar}, maxConcurrency, budget
├── workflows/                      # saved named workflows (*.js), registry for `ultracode run <name>`
└── runs/
    └── wf_<12 lowercase hex>/      # runId matches Qoder's ^wf_[a-z0-9-]{6,}$ for muscle-memory compat
        ├── manifest.json           # single-writer, atomic tmp+rename; see below
        ├── script.js               # exact script text executed (edit + resume workflow)
        ├── args.json
        ├── journal.jsonl           # hash-chain cache records (§1.4)
        ├── events.jsonl            # append-only progress stream (§1.5)
        ├── output.json             # final {result, logs, failures, agentCount, totalTokens, totalToolCalls, durationMs, error?}
        ├── runner.pid
        └── agents/<seq>-<label>/{prompt.md, schema.json, transcript.jsonl, stderr.log, result.json}
```

`manifest.json`: `{ runId, name, title, status: 'running'|'completed'|'failed'|'stopped'|'orphaned', pid, startedAt, endedAt?, heartbeatAt, phases:[{title, agentsDone, agentsTotal?}], agentCount, budget:{total, spent}, backendDefault, resumedFrom?, engineVersion }`.

### 3.2 Concurrency & crash safety

- **Single-writer**: only the runner process writes inside its run dir. CLI/MCP are pure readers. No locks needed for readers; `manifest.json` is atomic-swapped; `events.jsonl`/`journal.jsonl` are O_APPEND single-`write()` lines (atomic under PIPE_BUF-sized records).
- **Liveness**: runner refreshes `heartbeatAt` every 5s. Readers report `orphaned` only when `status==='running'` but the recorded pid is dead (or, on Linux where `/proc` exposes start-time, a recycled PID — macOS detects a dead pid but not a recycled live one); a stale heartbeat alone keeps a live-but-wedged runner `running`, so `stop` can still signal it; `ultracode list` offers `--reap` to finalize orphans (`status:'orphaned', error:'runner died without finalizing'`), which also unblocks resume.
- **runId** from `crypto.randomBytes` (host-side; the determinism ban applies to scripts, not the engine). Distinct dirs ⇒ no cross-run contention. Worktrees live at `.ultracode/worktrees/<runId>/<seq>/` on branch `ultracode/<runId>/<seq>`, branched from the default branch; removed post-run if clean, kept (path recorded in result.json) if the agent left changes.
- **Stop**: SIGTERM to runner → runner aborts the run AbortController, sends SIGTERM to each child's **process group** and, on Linux, every process carrying that attempt's lifecycle token; escalates survivors to SIGKILL, marks `stopped`, and flushes partial `output.json`. The token sweep is required because Codex/bwrap tool sandboxes can create a new session and leave the worker PGID.

### 3.3 Resume semantics

`ultracode resume <runId> [--script edited.js] [--args …]` → verifies prior run terminal → creates new run dir with `resumedFrom`, copies (possibly edited) script → prefix replay per §1.4. Cross-process/cross-session resume works by construction (everything is plain files) — an improvement over Claude Code's same-session-only contract, at zero fidelity cost.

---

## 4. Front-ends

### 4.1 Execution model: detached runner, no daemon

There is **no long-lived daemon**. Every run is its own detached process: `daemonize.ts` spawns `node dist/cli/main.js __runner --run <dir>` with `detached:true, stdio:['ignore', runnerLog, runnerLog]`, `unref()`s it, and returns once `manifest.json` appears with status running. The run store on disk is the sole coordination plane. Consequences: if the CLI exits, the MCP server crashes, or the *host agent* dies mid-run, the workflow keeps executing; any future CLI/MCP process re-attaches by runId by reading the same files. This is the property that makes the MCP long-poll triad safe, including hour-long quiet-monitor holds.

### 4.2 CLI

```
ultracode run <script.js | name> [--args '<json>'] [--backend id]
              [--budget 500k|+500k] [--max-concurrency N] [--permission safe|auto|danger]
              [--timeout minutes] [--detach] [--json] [--plain] [--no-color]
   # default: FOREGROUND attach (live panel on a TTY), exit 0/1 mirrors run status; --detach prints runId + paths
ultracode watch  <runId> [--plain] [--no-color] # live panel: phases, per-agent tokens/elapsed, budget; Ctrl-C detaches.
                                                # Interactive on a TTY: ↑/↓ (j/k) select an agent, ⏎ opens its detail view
                                                # (prompt / tool activity / outcome), esc back (overview: clear selection), q detach
ultracode status <runId> [--watch] [--json]     # phases, agent table, budget, heartbeat
ultracode logs   <runId> [--follow] [--agent seq]
ultracode resume <runId> [--script f] [--args j]
ultracode stop   <runId>
ultracode list   [--all] [--count <n>] [--reap] [--json]   # default: up to 10 active-or-last-24h runs
ultracode validate <script.js>                   # meta + acorn + dry compile
ultracode doctor                                 # probe all backends: binary, version, auth mode, parallel-safety warnings
ultracode mcp                                    # start MCP stdio server
```

### 4.3 MCP server (`mcp/server.ts`)

stdio transport, no session-affinity assumptions (2026-07-28-ready). Tools (never declare `taskSupport:'required'` — it hard-breaks Qoder client-side):

- **`workflow_start`** `{script?|scriptPath?|name?, args?, backend?, budget?, resumeFromRunId?}` → returns in <1s: `{ runId, scriptPath, monitor: 'call workflow_status with runId', summary }`. Mirrors the Workflow tool's fire-and-forget contract.
- **`workflow_status`** `{runId, until?: 'activity'|'phase'|'terminal', waitSeconds?: number /* explicit honored ≤3600, default 25 */, sinceEventOffset?: number}` → **long-poll**. `until:'activity'` (default): returns immediately if terminal or new renderable lines exist past the offset, else waits out `waitSeconds`. `until:'terminal'` is the **quiet monitor** (2026-07): wakes on terminal status, a stale runner heartbeat (>30s — the wedged-but-alive escape hatch, waking every mode with `stale: true` and a diagnose-don't-re-park `next`), or deadline (`until:'phase'` additionally wakes on `phase_started`, batching boundaries crossed in one read — the sanctioned milestone-commentary channel; quiet non-terminal responses carry an in-band "park silently" nudge countering codex's 60s commentary mandate) — renderable lines roll into a 40-line tail (each line capped at 400 chars) carried on every response instead of waking the host. The cursor is a consumed byte position, NOT lossless delivery: lines beyond the 40-line cap pass through the tail and drop (the full log stays in the run store / `workflow_result`), and any terminal-mode hold facing a multi-page backlog jumps to the final 4 MB window — late attach to a running run included — so a terminal wake serves the run's true tail with the cursor at EOF; the host parks one cheap turn per hold instead of streaming. Concurrent holds are admission-capped at 4 per runId (oldest preempted with a normal still-running payload — clients that time out never cancel server-side, so abandoned holds would otherwise accumulate). Doctrine sizes `waitSeconds` ≥60s under the host's tool timeout (`ultracode install codex` pins `tool_timeout_sec = 3600` → hold 3300; stock codex 300s, Qoder/Gemini 600s). Response: `{ runId, status, phases, agentCount, budget, logTail, nextEventOffset, terminal, stale?, next?, hint? }`. Activity-mode waits emit `notifications/progress` against the caller's progressToken, throttled to one per 10s (UX for Qoder/Gemini; Codex just logs it); quiet parks emit none.
- **`workflow_result`** `{runId}` → `output.json` content as `structuredContent` + failures + artifact paths; error `-32602`-style tool error if not terminal (with current status so the model self-corrects).
- **`workflow_stop`** `{runId}`, **`workflow_list`** `{all?, count?}` → `{runs, hidden}` (up to 10 active-or-last-24h runs unless `all`/`count`).

Because runs are detached, the MCP server is stateless over the run store: it can be killed and restarted (or run as multiple instances for multiple host sessions) with no run loss.

---

## 5. Budget accounting (`budget/`)

- `parse.ts`: `+500k` → add 500,000 to configured default; `500k`/`2m`/`1.5m` → absolute token target; absent → `config.budget` or `null` (unlimited, `remaining()===Infinity`).
- `account.ts` `BudgetAccount`: single accumulator in the runner. On every `agent_completed`, add `NormalizedUsage.totalTokens = inputTokens + outputTokens + reasoningTokens + round(0.1 × cachedInputTokens)` (cached discounted; documented). `spent()`/`remaining()` are O(1) reads exposed to the script; `budget_tick` events keep manifest/monitors fresh.
- Normalization (`usage.ts`): codex `turn.completed.usage {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}`; qoder/claude result `usage` (+ `total_cost_usd`, per-model camelCase `modelUsage` for costUSD); gemini `result.stats.models` token counts; amp/opencode/copilot per envelope where present. **Fallback** when a backend omits usage (cursor sometimes): estimate `ceil(chars/4)` over prompt+final text with `estimated:true`, surfaced in status so budget enforcement degrades transparently rather than silently.
- Enforcement is a **dispatch gate** (pre-spawn check), not mid-flight kill: in-flight agents complete; the next `agent()` throws `"Workflow budget exceeded"` — matching the no-silent-caps doctrine (the throw lands in `failures[]` and the final report).

---

## 6. Execution data flow (one agent call, end to end)

```
script: await agent(prompt, {schema, label})
  → hostapi: caps check (lifetime<1000) → budget gate → semaphore.acquire()
  → journal.nextCachedResult(chainKey)  ── hit → resolve instantly from old run's result.json
  → miss (prefix broken from here on):
      adapter.checkSchema → adapter.buildSpawn → spawn.ts (own pgid + Linux lifecycle token, cwd=worktree if isolation)
      stdout → ndjson splitter → adapter.createParser() → AgentEvent[]
        → events.jsonl (agent_usage/agent_retry/agent_model/agent_tool ticks), transcript.jsonl (raw)
      exit → adapter.classifyExit → retryable? (retries/stallMs budget) → respawn or fail
      structured pipeline: extract → ajv(original schema) → repair-resume ≤2 → value | WorkflowSchemaError
      usage → BudgetAccount.add → journal.append({t:'agent', key, status, totalTokens, resultRef})
  → semaphore.release() → resolve/throw into script
script ends → output.json + manifest(status) → events.jsonl run_completed → (foreground CLI exits / MCP long-poll returns)
```


## KEY DECISIONS
- **Sandbox = hardened node:vm (frozen intrinsics, Date/Math.random bans, WebAssembly/ShadowRealm/Atomics deleted) inside a dedicated detached runner process — not quickjs-emscripten, SES, or isolated-vm.** — The dialect requires arbitrary guest closures concurrently awaiting host promises (parallel(thunks), bare Promise.all over agent()). quickjs Asyncify allows only one suspension at a time, so faithful semantics are impossible without changing the dialect. node:vm is what Qoder ships for the identical feature, giving us a decompiled reference to clone (same error strings, same freeze list). Trust model is model-authored + user-reviewed scripts whose only capability is agent(); process-level isolation of the runner supplies the residual containment. (rejected: quickjs-emscripten (async model breaks dialect fidelity; marshaling boundary); SES lockdown in worker (better hardening but compat risk and no added security payoff for this trust model); isolated-vm (native dep, maintenance-mode); vm2 (CVE-2026-22709, dead).)
- **No daemon: every run is a self-contained detached runner process coordinating exclusively through the on-disk run store; CLI and MCP server are stateless readers/launchers over the same store.** — Solves the MCP-client-death problem structurally (run survives anything), makes the long-poll triad safe at any hold length, allows multiple concurrent front-ends, and eliminates daemon lifecycle/upgrade/socket complexity. Single-writer-per-run-dir plus atomic manifest swaps and O_APPEND journals make readers lock-free. (rejected: Long-lived daemon with IPC (state to babysit, upgrade races, one more failure mode); in-process execution in the MCP server (run dies with the client — exactly the Codex timeout-orphaning trap).)
- **Journal hash-chain uses Qoder's construction (sequential chain, sha256 over prevKey\0prompt\0stableStringify(options), longest-unchanged-prefix, first-miss-disables-rest) but with prefix 'u1:' and backend/effort/cwd added to the option hash.** — Semantics-faithful replay is the requirement, not byte-compatibility with Qoder's on-disk runs (different directories, never interchanged). Backend and effort materially change agent results, so omitting them from the cache key would replay wrong results after a backend switch on resume. (rejected: Byte-identical 'v2:' Qoder keys (would silently cache-hit across backend changes); per-callsite keying via stack introspection (fragile, diverges from reference behavior under concurrency).)
- **Structured output: native flag per backend where it exists (codex --output-schema with local strict-subset pre-validation + wire-schema normalization; qoder/claude --json-schema) with mandatory engine-side ajv validation against the ORIGINAL schema on every path, plus a bounded (≤2) resume-based repair loop; gemini/cursor/copilot/opencode/amp use an injected prompt-contract + validate-and-retry loop.** — Codex 400s deterministically on non-strict schemas (zero point retrying — pre-validate and fail fast or normalize); qoder's flag is undocumented/unstable so trust-but-verify; engine-side ajv makes agent({schema}) return a guaranteed-valid object uniformly, which is the contract the dialect promises. (rejected: Trusting native enforcement alone (qoder flag undocumented; codex --oss providers may ignore text.format; truncation edge cases); unlimited repair retries (burns budget, violates no-silent-caps — bounded and reported instead).)
- **Backend auth topology defaults: codex = shared CODEX_HOME + per-process CODEX_API_KEY (doctor warns on ChatGPT-OAuth + concurrency); qoder = shared home + QODER_PERSONAL_ACCESS_TOKEN (doctor warns if a /login credential exists since it silently beats the env PAT).** — Source-verified: ChatGPT OAuth refresh tokens are single-use and racy across processes (issue #10332 closed not-planned; copies mutually invalidate per #15410), while CODEX_API_KEY bypasses auth.json entirely; Qoder PATs are stateless per-invocation. Shared homes keep config/MCP/skills/sessions centralized so resume works from any worker. (rejected: Per-worker CODEX_HOME with auth.json copies (officially unsupported, mutually invalidating); per-worker HOME for qoder (unnecessary; loses user-level config).)
- **MCP surface is exactly the workflow_start / workflow_status(long-poll, event-offset cursor) / workflow_result / workflow_stop triad; no MCP Tasks declaration, and never taskSupport:'required'.** — Source-verified that no target host extends timeouts on progress and none polls Tasks; taskSupport:'required' throws client-side in Qoder before the request is sent. Event-offset cursor makes each poll return fresh log tail so the orchestrating model always has new context. (rejected: Single blocking tool call with progress notifications (hard-capped at 300–600s, and Codex orphans the run silently on timeout without notifications/cancelled); MCP Tasks extension (unsupported everywhere in-target, actively breaks Qoder).) **Superseded in part (2026-07):** the original ≤50s clamp burned a host turn per 50s of monitoring (measured ~78% of a codex session's tokens); `until:'terminal'` + explicit `waitSeconds ≤3600` + installer-raised codex `tool_timeout_sec=3600` turn monitoring into ~1 parked turn/hour, while a timed-out hold stays a survivable re-poll (Codex's silent orphaning still costs nothing — the run store is truth).
- **Run store lives at <project>/.ultracode/ (overridable via $ULTRACODE_HOME), runIds shaped wf_<12hex>, and codex result extraction always takes the LAST agent_message and never uses -o.** — Namespace defensiveness against .qoder/sessions and .claude; wf_ format matches Qoder's resumeFromRunId regex for cross-tool ergonomics; codex issue #19816 (intermediate messages are schema-shaped) and the stale -o-file-on-failure behavior are confirmed footguns. (rejected: ~/.claude-style user-home run store (breaks per-project resume and git-adjacent workflows); -o file extraction (stale artifact masquerades as fresh output after a failed run).)

## RISKS
- Prefix-replay determinism under concurrency is best-effort, same as Qoder: if live agent completion ORDER influenced control flow in the original run (e.g. racing pipeline stages mutating shared state), replay interleaving can diverge after long cached prefixes. Mitigation: first-miss-disables-rest already bounds the blast radius; document that scripts should not branch on completion order.
- qodercli --json-schema and the stream-json envelope are undocumented/SDK-derived and Qoder ships near-daily releases — the adapter needs a feature-detect fallback to the emulated loop and a pinned-version integration test; same for the exit-41 auth contract.
- Several envelopes were pinned by static analysis, not live runs (qoder --output-format json non-stream shape, codex 400-path JSONL sequence, copilot JSONL line types). First implementation milestone must include a live golden-fixture capture per backend; parsers are written lenient (unknown line types → notice) to absorb drift.
- node:vm is not a hostile-code boundary; a malicious script that escapes could reach the runner process (which can spawn agent CLIs). Trust model assumes review-before-run; if unreviewed third-party workflow distribution ever becomes a goal, the sandbox tier must be revisited (SES-in-worker or subprocess-per-script).
- Usage/cost normalization is lossy: cursor (and sometimes copilot) omit token counts, forcing chars/4 estimates; budget enforcement across mixed backends is therefore approximate. Surfaced via estimated:true rather than hidden, but '+500k' directives will be soft targets on those backends.
- Backend CLI drift is the structural maintenance burden (8 adapters × fast-moving CLIs): flag renames (--experimental-json→--json precedent), envelope changes, exit-code changes. Mitigate with probe() version gates, golden fixtures in CI, and adapter-local quirk tables keyed by version range.
- Detached-runner model has no daemon supervisor. Every physical backend spawn records its PGID, OS start-time identity, and lifecycle token under `agents/*/pgid.attempt*`; a normal settle removes the record only after descendant cleanup. A hard-stop, fatal runner exit, or later `ultracode stop` replays remaining records only when the live group leader's identity still matches. Linux token discovery also covers leaderless groups and descendants that called `setsid()`; macOS remains process-group-only, with identity read through `ps`.
- Explicit waitSeconds is honored up to 3600s, so a hold longer than the host's actual tool timeout dies client-side (survivable — the model re-polls, but each death wastes a turn); doctrine pins per-host numbers (codex hostpack 3600→3300, stock codex 300→240, Qoder/Gemini 600→540) and the omitted-waitSeconds default stays 25s so a naive poll is safe everywhere, with the tool description telling the model to just re-call on timeout.

## OPEN QUESTIONS
- Does the top-level orchestrator want Qoder-native delegation (emit scripts into .qoder/workflows and drive the built-in Workflow tool, engine as fallback — the Qoder-internals research recommended integrating with the native Workflow tool rather than replacing it) to live inside this package as a ninth 'qoder-native' pseudo-backend, or entirely in the host-integration layer? The engine is designed so either works, but the resume story differs (qodercli journal vs ours).
- Package naming/scoping: single npm package 'ultracode' vs scoped @ultracode/{core,cli,mcp} split — single package assumed here for install ergonomics (npx ultracode mcp); confirm against the host-integration architect's plugin packaging needs (codex plugin add expects a repo layout).
- Budget semantics for '+500k': relative to what baseline when no session budget exists (treat as absolute 500k? current design does) — needs a doctrine ruling from the mode/skill designer.
- Worktree merge-back: engine records surviving worktree paths but takes no merge action. Should the CLI grow 'ultracode merge <runId>' or is merge-back the host agent's job (recommended: host's job, keep engine mechanism-only)?
- agentType portability: mapping table degrades gracefully (warn + default agent) on backends without an agent concept in headless mode (gemini). Is a hard-error mode wanted when a script demands a specific agentType for correctness (e.g. a read-only auditor)?
- Windows support scope for v1: process-group kill (setsid/-pgid) and O_APPEND atomicity assumptions are POSIX; Windows needs taskkill /T and a different liveness check. Propose POSIX-only v1 with explicit platform check.
