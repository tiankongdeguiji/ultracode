/**
 * Host API: the fixed set of globals injected into the workflow sandbox —
 * agent, parallel, pipeline, phase, log, workflow, args, budget, console,
 * setTimeout/clearTimeout — with the exact reference dialect semantics:
 *
 *  - parallel(thunks): allSettled BARRIER; a throwing thunk resolves to null
 *    at its index and records `parallel[i] failed: <msg>`. Never fail-fast.
 *  - pipeline(items, ...stages): NO inter-stage barrier; every stage receives
 *    (prevResult, originalItem, index); a throwing stage records
 *    `pipeline[i] failed: <msg>` and drops the item to null, skipping its
 *    remaining stages; a stage returning null drops silently (skip idiom).
 *  - agent(): FIFO semaphore concurrency, lifetime caps, budget dispatch
 *    gate; exhausted retries THROW WorkflowAgentError, recorded as
 *    `agent[seq] <label> failed: <msg>`. Skipped agents resolve to null.
 */
import {
  UltracodeError,
  WorkflowAgentCapError,
  WorkflowAgentError,
  WorkflowBudgetError,
  errorMessage,
} from './errors.js';
import { isPositiveInt, Semaphore } from './semaphore.js';
import type { AgentExecutor, AgentSpec, JsonSchema } from '../backends/types.js';
import type { BudgetAccount } from '../budget/account.js';
import type { WorkflowMeta } from './meta.js';
import type { WorktreeManager } from '../exec/worktree.js';
import type { RunOutput } from './run.js';
import { backendOverrideWarning, resolveSubagentProfile, validateSubagentProfile } from '../config.js';

/**
 * State shared across a parent workflow and its one level of nested
 * workflow() children: the concurrency semaphore, the lifetime agent
 * counter (also the seq source), and the worktree manager. The budget and
 * abort signal are shared by being passed identically to each hostapi.
 */
export interface SharedRunState {
  semaphore: Semaphore;
  counter: { count: number };
  worktrees?: WorktreeManager;
  runId?: string;
}

export const HARD_AGENT_CAP = 1000;
export const MAX_ITEMS_PER_CALL = 4096;
export const DEFAULT_SOFT_AGENT_CAP = 50;
export const DEFAULT_LOG_CAP = 1000;
export const MAX_TASK_RETRIES = 5;

type RunEventBody =
  | { type: 'run_started'; name: string }
  | { type: 'phase_started'; title: string }
  | { type: 'agent_queued'; seq: number; label: string; phase?: string }
  | {
      type: 'agent_started';
      seq: number;
      label: string;
      phase?: string;
      backend: string;
      model?: string;
      effort?: string;
      contextWindow?: number;
      agentType?: string;
    }
  /** throttled live token tick (cumulative per agent); display-only — budget accounting stays on agent_completed */
  | { type: 'agent_usage'; seq: number; totalTokens: number; estimated: boolean }
  | {
      type: 'agent_retry';
      seq: number;
      label: string;
      attempt: number;
      maxAttempts: number;
      kind: 'task' | 'schema-repair';
      reason?: string;
    }
  /** backend-resolved model (from the stream), vs the requested one on agent_started */
  | { type: 'agent_model'; seq: number; model: string }
  /** discrete tool-call tick (unthrottled, display-only; name bounded at emission,
   *  ≤ TOOL_EVENT_CAP per dispatch — agent_completed.toolCalls is authoritative) */
  | { type: 'agent_tool'; seq: number; name: string; status: 'started' | 'completed' | 'failed' | 'declined' }
  | {
      type: 'agent_completed';
      seq: number;
      label: string;
      phase?: string;
      ok: boolean;
      skipped?: boolean;
      /** resolved from a prior run's journal (prefix replay) — consumed zero tokens */
      cached?: boolean;
      totalTokens: number;
      /** the total includes an inferred portion whose authoritative telemetry was unavailable */
      estimated?: boolean;
      /** authoritative tool-call count (started ticks); absent on skip/cached */
      toolCalls?: number;
      error?: string;
    }
  | { type: 'workflow_log'; message: string }
  | { type: 'budget_tick'; spent: number }
  /** nested workflow() boundaries, emitted by the PARENT (child.ts) — the child's own run_* events are dropped */
  | { type: 'child_started'; childId: number; name: string; argsHash: string }
  | { type: 'child_completed'; childId: number; name: string; ok: boolean; agentCount: number; error?: string }
  /** written by the runner on SIGTERM, before the engine unwinds */
  | { type: 'stop_requested' }
  | { type: 'run_completed' | 'run_failed' | 'run_stopped'; error?: string };

/**
 * Events emitted from inside a nested workflow() child carry childId/childName
 * tags (child agents share the parent's seq space and can interleave with
 * concurrently-running parent agents, so attribution must be per-event, not
 * boundary-interval).
 */
export type RunEvent = RunEventBody & { childId?: number; childName?: string };

export interface PhaseState {
  title: string;
  agentsDone: number;
}

export interface HostState {
  logs: string[];
  droppedLogs: number;
  failures: string[];
  agentCount: number;
  totalToolCalls: number;
  phases: PhaseState[];
  /** kept worktree paths (agents that left changes to merge) */
  workspaces: string[];
}

export interface AgentSettledRecord {
  spec: AgentSpec;
  status: 'ok' | 'error' | 'skip';
  value?: unknown;
  error?: string;
  usage: { totalTokens: number; estimated: boolean };
  sessionId?: string;
  /** hash-chain key assigned at dispatch (when a keyChain is configured) */
  cacheKey?: string;
  /** true when resolved from a prior run's journal (prefix replay) */
  cached?: boolean;
}

export interface HostApiOptions {
  executor: AgentExecutor;
  meta: WorkflowMeta;
  args: unknown;
  budget: BudgetAccount;
  signal: AbortSignal;
  defaultBackend: string;
  defaultModel?: string;
  defaultEffort?: string;
  /** Default applied only to agents whose resolved backend is Qoder. */
  defaultContextWindow?: number;
  cwd: string;
  maxConcurrency: number;
  /** effective soft cap; the hard 1000 ceiling always applies on top */
  maxAgents?: number;
  logCap?: number;
  onEvent?: (ev: RunEvent) => void;
  /** fired once per LIVE dispatch, right before executor.execute (skips and
   *  cache hits never fire it) — the runner's early prompt.md write hook */
  onAgentStarted?: (spec: AgentSpec) => void;
  /** journal hook — invoked exactly once per settled agent (cache hits included) */
  onAgentSettled?: (record: AgentSettledRecord) => void;
  /** sequential cache-key chain; next() invoked synchronously at dispatch in seq order */
  keyChain?: { next(spec: AgentSpec): string };
  /** prefix-replay cache lookup (M8); returns {hit, value} */
  cacheLookup?: (spec: AgentSpec, cacheKey: string | undefined) => { hit: boolean; value?: unknown } | undefined;
  /** one-level nested workflow runner (M13) — returns the child's full output so
   *  the parent can merge its diagnostics (failures/logs/workspaces/counters) */
  runChild?: (ref: unknown, childArgs: unknown) => Promise<RunOutput>;
  /** shared execution state for nested workflows; created fresh if absent */
  shared?: SharedRunState;
}

export interface HostApi {
  globals: Record<string, unknown>;
  state: HostState;
  /** clears wrapped timers; invoked on abort/end */
  dispose(): void;
}

interface AgentOptions {
  prompt?: string;
  label?: string;
  phase?: string;
  schema?: JsonSchema;
  model?: string;
  effort?: string;
  contextWindow?: number;
  agentType?: string;
  type?: string;
  subagent_type?: string;
  isolation?: string;
  backend?: string;
  cwd?: string;
  retries?: number;
  stallMs?: number;
  timeoutMs?: number;
  skip?: boolean;
  skipReason?: string;
}

const errMsg = errorMessage;

/** Ceiling on agent_tool events per dispatch: a pathological backend spewing
 *  tool lines must not bloat events.jsonl unboundedly. Display-only — the
 *  authoritative count still lands on agent_completed.toolCalls. */
export const TOOL_EVENT_CAP = 5000;
const TOOL_NAME_MAX = 80;

/** Bound an untrusted backend-reported tool name before it enters the event
 *  stream: strip control bytes, cap length. Render-time hardening (bidi etc.)
 *  still happens in the panel's sanitizeText. */
function boundToolName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return clean.length <= TOOL_NAME_MAX ? clean : clean.slice(0, TOOL_NAME_MAX - 1) + '…';
}

/** JSON round-trip so no host object graphs (with live prototypes) leak into the vm. */
function roundTrip(value: unknown): unknown {
  if (value === undefined || value === null) return value ?? null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.parse(JSON.stringify(value));
}

export function createHostApi(opts: HostApiOptions): HostApi {
  if (opts.defaultContextWindow !== undefined && !isPositiveInt(opts.defaultContextWindow)) {
    throw new TypeError('defaultContextWindow must be a positive integer');
  }
  const {
    executor,
    meta,
    budget,
    signal,
    onEvent = () => {},
    onAgentStarted,
    onAgentSettled,
    cacheLookup,
  } = opts;
  const softCap = Math.min(opts.maxAgents ?? DEFAULT_SOFT_AGENT_CAP, HARD_AGENT_CAP);
  const logCap = opts.logCap ?? DEFAULT_LOG_CAP;
  const shared: SharedRunState = opts.shared ?? { semaphore: new Semaphore(opts.maxConcurrency), counter: { count: 0 } };
  const semaphore = shared.semaphore;

  const state: HostState = {
    logs: [],
    droppedLogs: 0,
    failures: [],
    agentCount: 0,
    totalToolCalls: 0,
    phases: (meta.phases ?? []).map((p) => ({ title: p.title, agentsDone: 0 })),
    workspaces: [],
  };

  let currentPhase: string | undefined = undefined;

  const ensurePhase = (title: string): string => {
    if (!state.phases.some((p) => p.title === title)) {
      state.phases.push({ title, agentsDone: 0 });
    }
    return title;
  };

  const pushLog = (message: string): void => {
    if (state.logs.length >= logCap) {
      state.droppedLogs++;
      return;
    }
    state.logs.push(message);
    onEvent({ type: 'workflow_log', message });
  };

  const fmtConsoleArgs = (args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');

  function normalizeAgentArgs(promptOrOpts: unknown, maybeOpts: unknown, seq: number): AgentSpec & { skip?: boolean; skipReason?: string } {
    let prompt: unknown;
    let o: AgentOptions;
    if (typeof promptOrOpts === 'string') {
      prompt = promptOrOpts;
      o = (maybeOpts ?? {}) as AgentOptions;
    } else if (promptOrOpts !== null && typeof promptOrOpts === 'object') {
      o = promptOrOpts as AgentOptions;
      prompt = o.prompt;
    } else {
      throw new TypeError('agent() expects a prompt string or an options object with a prompt');
    }
    if (typeof o !== 'object' || o === null) {
      throw new TypeError('agent() options must be an object');
    }
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new TypeError('agent() requires a non-empty prompt string');
    }
    if (o.isolation !== undefined && o.isolation !== 'worktree') {
      throw new TypeError(`agent() isolation must be 'worktree', got ${JSON.stringify(o.isolation)}`);
    }
    if (o.schema !== undefined && (typeof o.schema !== 'object' || o.schema === null)) {
      throw new TypeError('agent() schema must be a JSON Schema object');
    }
    const retries = Math.max(0, Math.min(MAX_TASK_RETRIES, Math.trunc(o.retries ?? 0)));
    // Junk timeoutMs (strings, NaN, ≤0) is dropped: a 0 must not insta-kill
    // every attempt and a '30m'-style string must not NaN the deadline. With
    // no run-level attemptTimeoutMs the result is the unlimited default.
    const timeoutMs = typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : undefined;
    const phaseTitle = o.phase !== undefined ? ensurePhase(String(o.phase)) : currentPhase;
    const label = o.label ?? `#${seq}`;
    if (
      o.contextWindow !== undefined &&
      (typeof o.contextWindow !== 'number' || !isPositiveInt(o.contextWindow))
    ) {
      throw new TypeError('agent() contextWindow must be a positive integer');
    }
    const defaults = {
      backend: opts.defaultBackend,
      model: opts.defaultModel,
      effort: opts.defaultEffort,
      contextWindow: opts.defaultContextWindow,
    };
    const resolvedProfile = resolveSubagentProfile(defaults, {
      backend: o.backend,
      model: o.model,
      effort: o.effort,
      contextWindow: o.contextWindow,
    });
    const backend = resolvedProfile.profile.backend ?? opts.defaultBackend;
    try {
      validateSubagentProfile({ ...resolvedProfile.profile, backend }, 'agent() profile');
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : String(error));
    }
    const warning = backendOverrideWarning(defaults, resolvedProfile);
    if (warning) pushLog(`agent[${seq}] ${label}: ${warning}`);
    return {
      seq,
      prompt,
      label,
      phase: phaseTitle,
      schema: o.schema ? (JSON.parse(JSON.stringify(o.schema)) as JsonSchema) : undefined,
      model: resolvedProfile.profile.model,
      effort: resolvedProfile.profile.effort,
      contextWindow: resolvedProfile.profile.contextWindow,
      agentType: o.agentType ?? o.type ?? o.subagent_type,
      isolation: o.isolation as 'worktree' | undefined,
      backend,
      cwd: o.cwd ?? opts.cwd,
      retries,
      stallMs: o.stallMs,
      timeoutMs,
      skip: o.skip === true,
      skipReason: o.skipReason,
    };
  }

  async function agentFn(promptOrOpts: unknown, maybeOpts?: unknown): Promise<unknown> {
    if (signal.aborted) throw new UltracodeError('Workflow stopped', 'aborted');
    // Caps use the SHARED counter so a parent + its nested workflow() share
    // the 1000 lifetime ceiling and the soft cap.
    if (shared.counter.count >= HARD_AGENT_CAP) throw new WorkflowAgentCapError(HARD_AGENT_CAP);
    if (shared.counter.count >= softCap) throw new WorkflowAgentCapError(softCap);
    if (budget.remaining() <= 0) throw new WorkflowBudgetError();

    const seq = shared.counter.count++;
    state.agentCount++;
    const spec = normalizeAgentArgs(promptOrOpts, maybeOpts, seq);
    // Chain key must advance for every dispatched agent — including skips —
    // in seq order, synchronously (no await between seq assignment and here).
    const cacheKey = opts.keyChain?.next(spec);

    // NOTE: onAgentSettled always fires BEFORE the agent_completed event, here
    // and at every settle site below. Watchers treat the event as "artifacts
    // are final on disk" — the reverse order would open a window where a
    // worker-planted result.json/prompt.md could be read (and cached) as if
    // the runner had written it.
    if (spec.skip) {
      onAgentSettled?.({
        spec,
        status: 'skip',
        error: spec.skipReason,
        usage: { totalTokens: 0, estimated: false },
        cacheKey,
      });
      onEvent({ type: 'agent_completed', seq, label: spec.label, phase: spec.phase, ok: true, skipped: true, totalTokens: 0 });
      return null;
    }

    const cached = cacheLookup?.(spec, cacheKey);
    if (cached?.hit) {
      bumpPhase(spec.phase);
      onAgentSettled?.({
        spec,
        status: 'ok',
        value: cached.value,
        usage: { totalTokens: 0, estimated: false },
        cacheKey,
        cached: true,
      });
      onEvent({ type: 'agent_completed', seq, label: spec.label, phase: spec.phase, ok: true, cached: true, totalTokens: 0 });
      return roundTrip(cached.value);
    }

    onEvent({ type: 'agent_queued', seq, label: spec.label, phase: spec.phase });
    const release = await semaphore.acquire();
    let worktree: Awaited<ReturnType<WorktreeManager['create']>> | undefined;
    try {
      if (signal.aborted) throw new UltracodeError('Workflow stopped', 'aborted');
      // Real dispatch gate: re-check the budget AFTER acquiring the permit,
      // just before dispatch. The pre-acquire check races a parallel()/pipeline()
      // batch (all N pass at spent=0 before any completes and calls budget.add).
      // This gate is per-dispatch, not per-attempt: executor.execute() may run
      // several internal attempts (retries + schema repairs) before it returns
      // and budget.add runs once, so worst-case overshoot is
      // permits × (retries + repairs) × per-attempt-tokens — larger than a single
      // concurrency window, but still bounded. Released in finally.
      if (budget.remaining() <= 0) throw new WorkflowBudgetError();
      // Worktree isolation: a fresh git worktree, when explicitly asked for.
      // If the caller requested it but no manager exists (e.g. not inside a git
      // repo), FAIL LOUD rather than silently running in the shared cwd —
      // parallel mutating agents would otherwise collide despite asking to be
      // isolated. The runner supplies the manager only inside a repo.
      if (spec.isolation === 'worktree') {
        if (!shared.worktrees) {
          throw new UltracodeError(
            `agent[${seq}] ${spec.label} requested worktree isolation, but it is unavailable (not inside a git repo) — refusing to run unisolated`,
            'worktree-unavailable',
          );
        }
        worktree = await shared.worktrees.create(shared.runId ?? 'run', seq, spec.label);
        spec.cwd = worktree.path;
      }
      onEvent({
        type: 'agent_started',
        seq,
        label: spec.label,
        phase: spec.phase,
        backend: spec.backend,
        model: spec.model,
        effort: spec.effort,
        contextWindow: spec.contextWindow,
        agentType: spec.agentType,
      });
      onAgentStarted?.(spec);
      let toolEvents = 0;
      const outcome = await executor.execute(spec, signal, (p) => {
        if (p.type === 'usage') {
          onEvent({ type: 'agent_usage', seq, totalTokens: p.usage.totalTokens, estimated: p.usage.estimated });
        } else if (p.type === 'retry') {
          onEvent({ type: 'agent_retry', seq, label: spec.label, attempt: p.attempt, maxAttempts: p.maxAttempts, kind: p.kind, reason: p.reason });
        } else if (p.type === 'model') {
          onEvent({ type: 'agent_model', seq, model: p.model });
        } else if (p.type === 'tool' && toolEvents < TOOL_EVENT_CAP) {
          toolEvents++;
          onEvent({ type: 'agent_tool', seq, name: boundToolName(p.name), status: p.status });
        }
      });
      budget.add(outcome.usage.totalTokens, outcome.usage.estimated);
      onEvent({ type: 'budget_tick', spent: budget.spent() });
      state.totalToolCalls += outcome.toolCalls;

      // Stopped while this call was in flight: still record what it consumed and
      // produced (budget above + the journal record here) BEFORE propagating the
      // stop — otherwise stopped runs underreport tokens and drop the journal
      // entry (which also lets a completed-then-stopped agent replay on resume).
      if (signal.aborted) {
        onAgentSettled?.({
          spec,
          status: outcome.ok ? 'ok' : 'error',
          value: outcome.ok ? outcome.value : undefined,
          error: outcome.error,
          usage: { totalTokens: outcome.usage.totalTokens, estimated: outcome.usage.estimated },
          sessionId: outcome.sessionId,
          cacheKey,
        });
        onEvent({
          type: 'agent_completed',
          seq,
          label: spec.label,
          phase: spec.phase,
          ok: outcome.ok,
          totalTokens: outcome.usage.totalTokens,
          estimated: outcome.usage.estimated,
          toolCalls: outcome.toolCalls,
          error: outcome.error,
        });
        throw new UltracodeError('Workflow stopped', 'aborted');
      }

      if (!outcome.ok) {
        const failure = `agent[${seq}] ${spec.label} failed: ${outcome.error ?? 'unknown error'}`;
        state.failures.push(failure);
        onAgentSettled?.({
          spec,
          status: 'error',
          error: outcome.error,
          usage: { totalTokens: outcome.usage.totalTokens, estimated: outcome.usage.estimated },
          sessionId: outcome.sessionId,
          cacheKey,
        });
        onEvent({
          type: 'agent_completed',
          seq,
          label: spec.label,
          phase: spec.phase,
          ok: false,
          totalTokens: outcome.usage.totalTokens,
          estimated: outcome.usage.estimated,
          toolCalls: outcome.toolCalls,
          error: outcome.error,
        });
        throw new WorkflowAgentError(failure, seq, spec.label);
      }

      bumpPhase(spec.phase);
      for (const warning of outcome.warnings ?? []) {
        const msg = `agent[${seq}] ${spec.label} warning: ${warning}`;
        state.failures.push(msg);
        pushLog(msg);
      }
      onAgentSettled?.({
        spec,
        status: 'ok',
        value: outcome.value,
        usage: { totalTokens: outcome.usage.totalTokens, estimated: outcome.usage.estimated },
        sessionId: outcome.sessionId,
        cacheKey,
      });
      onEvent({
        type: 'agent_completed',
        seq,
        label: spec.label,
        phase: spec.phase,
        ok: true,
        totalTokens: outcome.usage.totalTokens,
        estimated: outcome.usage.estimated,
        toolCalls: outcome.toolCalls,
      });
      return roundTrip(outcome.value);
    } finally {
      release();
      if (worktree) {
        try {
          const fin = await worktree.finalize();
          if (!fin.removed) {
            const msg = `agent[${seq}] ${spec.label} left changes in worktree ${fin.path} (branch kept for merge)`;
            state.workspaces.push(fin.path);
            pushLog(msg);
          }
        } catch (e) {
          pushLog(`agent[${seq}] worktree cleanup failed: ${errMsg(e)}`);
        }
      }
    }
  }

  function bumpPhase(title: string | undefined): void {
    if (!title) return;
    const p = state.phases.find((ph) => ph.title === title);
    if (p) p.agentsDone++;
  }

  async function parallelFn(thunks: unknown): Promise<unknown[]> {
    if (!Array.isArray(thunks) || thunks.some((t) => typeof t !== 'function')) {
      throw new TypeError('parallel() expects an array of functions');
    }
    if (thunks.length > MAX_ITEMS_PER_CALL) {
      throw new TypeError(`parallel() accepts at most ${MAX_ITEMS_PER_CALL} items, got ${thunks.length}`);
    }
    const settled = await Promise.allSettled(
      thunks.map((t) => Promise.resolve().then(() => (t as () => unknown)())),
    );
    return settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const failure = `parallel[${i}] failed: ${errMsg(s.reason)}`;
      state.failures.push(failure);
      pushLog(failure);
      return null;
    });
  }

  async function pipelineFn(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
    if (!Array.isArray(items)) {
      throw new TypeError('pipeline() expects an array of items');
    }
    if (items.length > MAX_ITEMS_PER_CALL) {
      throw new TypeError(`pipeline() accepts at most ${MAX_ITEMS_PER_CALL} items, got ${items.length}`);
    }
    if (stages.length === 0 || stages.some((s) => typeof s !== 'function')) {
      throw new TypeError('pipeline() stages must be functions');
    }
    return Promise.all(
      items.map(async (item, i) => {
        let prev: unknown = item;
        for (const stage of stages as Array<(p: unknown, o: unknown, i: number) => unknown>) {
          try {
            prev = await stage(prev, item, i);
          } catch (e) {
            const failure = `pipeline[${i}] failed: ${errMsg(e)}`;
            state.failures.push(failure);
            pushLog(failure);
            return null;
          }
          // A stage returning null drops the item and skips its remaining
          // stages — the skip idiom (agent skipped → null propagates).
          if (prev === null) return null;
        }
        return prev;
      }),
    );
  }

  function phaseFn(title: unknown): void {
    if (typeof title !== 'string' || title.length === 0) {
      throw new TypeError('phase() expects a non-empty title string');
    }
    currentPhase = ensurePhase(title);
    onEvent({ type: 'phase_started', title });
  }

  function logFn(message: unknown): void {
    pushLog(typeof message === 'string' ? message : fmtConsoleArgs([message]));
  }

  async function workflowFn(ref: unknown, childArgs?: unknown): Promise<unknown> {
    if (!opts.runChild) {
      throw new UltracodeError('workflow() is not available: no child workflow registry configured', 'no-child-registry');
    }
    const childOut = await opts.runChild(ref, childArgs);
    // Merge the child's diagnostics into the parent run — otherwise caught
    // parallel()/pipeline() agent failures, warnings, kept workspaces, and
    // counters vanish and the parent can report an empty failures[] despite
    // failed child agents.
    for (const f of childOut.failures) state.failures.push(f);
    // The child already emitted its log lines live (it shares onEvent) —
    // merge into parent state WITHOUT re-emitting, or every line shows twice.
    for (const l of childOut.logs) {
      if (state.logs.length >= logCap) state.droppedLogs++;
      else state.logs.push(l);
    }
    state.droppedLogs += childOut.droppedLogs;
    if (childOut.workspaces) for (const w of childOut.workspaces) state.workspaces.push(w);
    state.agentCount += childOut.agentCount;
    state.totalToolCalls += childOut.totalToolCalls;
    return roundTrip(childOut.result);
  }

  // Timers: wrapped so everything is cleared on abort.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const wrappedSetTimeout = (fn: unknown, ms?: unknown, ...rest: unknown[]) => {
    if (typeof fn !== 'function') throw new TypeError('setTimeout expects a function');
    const t = setTimeout(
      () => {
        timers.delete(t);
        (fn as (...a: unknown[]) => void)(...rest);
      },
      typeof ms === 'number' ? ms : 0,
    );
    timers.add(t);
    return t;
  };
  const wrappedClearTimeout = (t: unknown) => {
    timers.delete(t as ReturnType<typeof setTimeout>);
    clearTimeout(t as ReturnType<typeof setTimeout>);
  };
  const dispose = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
  signal.addEventListener('abort', dispose, { once: true });

  const globals: Record<string, unknown> = {
    agent: agentFn,
    parallel: parallelFn,
    pipeline: pipelineFn,
    phase: phaseFn,
    log: logFn,
    workflow: workflowFn,
    args: roundTrip(opts.args),
    budget: budget.scriptView(),
    console: {
      log: (...a: unknown[]) => pushLog(fmtConsoleArgs(a)),
      info: (...a: unknown[]) => pushLog(fmtConsoleArgs(a)),
      debug: (...a: unknown[]) => pushLog(fmtConsoleArgs(a)),
      warn: (...a: unknown[]) => pushLog(`[warn] ${fmtConsoleArgs(a)}`),
      error: (...a: unknown[]) => pushLog(`[error] ${fmtConsoleArgs(a)}`),
    },
    setTimeout: wrappedSetTimeout,
    clearTimeout: wrappedClearTimeout,
  };

  return { globals, state, dispose };
}
