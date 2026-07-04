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
import { Semaphore } from './semaphore.js';
import type { AgentExecutor, AgentSpec, JsonSchema } from '../backends/types.js';
import type { BudgetAccount } from '../budget/account.js';
import type { WorkflowMeta } from './meta.js';
import type { WorktreeManager } from '../exec/worktree.js';

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

export type RunEvent =
  | { type: 'run_started'; name: string }
  | { type: 'phase_started'; title: string }
  | { type: 'agent_queued'; seq: number; label: string; phase?: string }
  | { type: 'agent_started'; seq: number; label: string; phase?: string; backend: string }
  | {
      type: 'agent_completed';
      seq: number;
      label: string;
      ok: boolean;
      skipped?: boolean;
      totalTokens: number;
      error?: string;
    }
  | { type: 'workflow_log'; message: string }
  | { type: 'budget_tick'; spent: number }
  | { type: 'run_completed' | 'run_failed' | 'run_stopped'; error?: string };

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
  cwd: string;
  maxConcurrency: number;
  /** effective soft cap; the hard 1000 ceiling always applies on top */
  maxAgents?: number;
  logCap?: number;
  onEvent?: (ev: RunEvent) => void;
  /** journal hook — invoked exactly once per settled agent (cache hits included) */
  onAgentSettled?: (record: AgentSettledRecord) => void;
  /** sequential cache-key chain; next() invoked synchronously at dispatch in seq order */
  keyChain?: { next(spec: AgentSpec): string };
  /** prefix-replay cache lookup (M8); returns {hit, value} */
  cacheLookup?: (spec: AgentSpec, cacheKey: string | undefined) => { hit: boolean; value?: unknown } | undefined;
  /** one-level nested workflow runner (M13) */
  runChild?: (ref: unknown, childArgs: unknown) => Promise<unknown>;
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

/** JSON round-trip so no host object graphs (with live prototypes) leak into the vm. */
function roundTrip(value: unknown): unknown {
  if (value === undefined || value === null) return value ?? null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.parse(JSON.stringify(value));
}

export function createHostApi(opts: HostApiOptions): HostApi {
  const {
    executor,
    meta,
    budget,
    signal,
    onEvent = () => {},
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
    const phaseTitle = o.phase !== undefined ? ensurePhase(String(o.phase)) : currentPhase;
    return {
      seq,
      prompt,
      label: o.label ?? `#${seq}`,
      phase: phaseTitle,
      schema: o.schema ? (JSON.parse(JSON.stringify(o.schema)) as JsonSchema) : undefined,
      model: o.model,
      effort: o.effort,
      agentType: o.agentType ?? o.type ?? o.subagent_type,
      isolation: o.isolation as 'worktree' | undefined,
      backend: o.backend ?? opts.defaultBackend,
      cwd: o.cwd ?? opts.cwd,
      retries,
      stallMs: o.stallMs,
      timeoutMs: o.timeoutMs,
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

    if (spec.skip) {
      onEvent({ type: 'agent_completed', seq, label: spec.label, ok: true, skipped: true, totalTokens: 0 });
      onAgentSettled?.({
        spec,
        status: 'skip',
        error: spec.skipReason,
        usage: { totalTokens: 0, estimated: false },
        cacheKey,
      });
      return null;
    }

    const cached = cacheLookup?.(spec, cacheKey);
    if (cached?.hit) {
      bumpPhase(spec.phase);
      onEvent({ type: 'agent_completed', seq, label: spec.label, ok: true, totalTokens: 0 });
      onAgentSettled?.({
        spec,
        status: 'ok',
        value: cached.value,
        usage: { totalTokens: 0, estimated: false },
        cacheKey,
        cached: true,
      });
      return roundTrip(cached.value);
    }

    onEvent({ type: 'agent_queued', seq, label: spec.label, phase: spec.phase });
    const release = await semaphore.acquire();
    let worktree: Awaited<ReturnType<WorktreeManager['create']>> | undefined;
    try {
      if (signal.aborted) throw new UltracodeError('Workflow stopped', 'aborted');
      // Worktree isolation: fresh git worktree, only when explicitly asked
      // and a manager is configured (the runner supplies it inside a repo).
      if (spec.isolation === 'worktree' && shared.worktrees) {
        worktree = await shared.worktrees.create(shared.runId ?? 'run', seq, spec.label);
        spec.cwd = worktree.path;
      }
      onEvent({ type: 'agent_started', seq, label: spec.label, phase: spec.phase, backend: spec.backend });
      const outcome = await executor.execute(spec, signal);
      if (signal.aborted) throw new UltracodeError('Workflow stopped', 'aborted');
      budget.add(outcome.usage.totalTokens, outcome.usage.estimated);
      onEvent({ type: 'budget_tick', spent: budget.spent() });
      state.totalToolCalls += outcome.toolCalls;

      if (!outcome.ok) {
        const failure = `agent[${seq}] ${spec.label} failed: ${outcome.error ?? 'unknown error'}`;
        state.failures.push(failure);
        onEvent({
          type: 'agent_completed',
          seq,
          label: spec.label,
          ok: false,
          totalTokens: outcome.usage.totalTokens,
          error: outcome.error,
        });
        onAgentSettled?.({
          spec,
          status: 'error',
          error: outcome.error,
          usage: { totalTokens: outcome.usage.totalTokens, estimated: outcome.usage.estimated },
          sessionId: outcome.sessionId,
          cacheKey,
        });
        throw new WorkflowAgentError(failure, seq, spec.label);
      }

      bumpPhase(spec.phase);
      for (const warning of outcome.warnings ?? []) {
        const msg = `agent[${seq}] ${spec.label} warning: ${warning}`;
        state.failures.push(msg);
        pushLog(msg);
      }
      onEvent({
        type: 'agent_completed',
        seq,
        label: spec.label,
        ok: true,
        totalTokens: outcome.usage.totalTokens,
      });
      onAgentSettled?.({
        spec,
        status: 'ok',
        value: outcome.value,
        usage: { totalTokens: outcome.usage.totalTokens, estimated: outcome.usage.estimated },
        sessionId: outcome.sessionId,
        cacheKey,
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
    return roundTrip(await opts.runChild(ref, childArgs));
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
