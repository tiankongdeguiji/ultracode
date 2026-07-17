/**
 * WorkflowRun: top-level orchestration of one run — parse, args validation,
 * sandbox + hostapi wiring, output shaping. Persistence and detachment live
 * in store/ and exec/ (M4); this module is pure engine.
 */
import { parseWorkflowScript, type ParsedWorkflow } from './meta.js';
import { validateWithSchema } from './ajv.js';
import { createSandbox } from './sandbox.js';
import { createHostApi, type AgentSettledRecord, type RunEvent, type SharedRunState } from './hostapi.js';
import { defaultConcurrency, Semaphore } from './semaphore.js';
import { MetaValidationError, errorMessage } from './errors.js';
import { BudgetAccount } from '../budget/account.js';
import type { AgentExecutor, AgentSpec } from '../backends/types.js';

export interface RunOutput {
  result: unknown;
  logs: string[];
  droppedLogs: number;
  failures: string[];
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  durationMs: number;
  /** kept worktree paths (parallel-mutation agents that left changes) */
  workspaces?: string[];
  error?: string;
}

export interface ExecuteOptions {
  executor: AgentExecutor;
  args?: unknown;
  budgetTotal?: number | null;
  /** pre-built budget account (nested workflows share the parent's) */
  budgetAccount?: BudgetAccount;
  maxConcurrency?: number;
  maxAgents?: number;
  logCap?: number;
  signal?: AbortSignal;
  defaultBackend?: string;
  cwd?: string;
  syncTimeoutMs?: number;
  onEvent?: (ev: RunEvent) => void;
  onAgentStarted?: (spec: AgentSpec) => void;
  onAgentSettled?: (record: AgentSettledRecord) => void;
  keyChain?: { next(spec: AgentSpec): string };
  cacheLookup?: (spec: AgentSpec, cacheKey: string | undefined) => { hit: boolean; value?: unknown } | undefined;
  runChild?: (ref: unknown, childArgs: unknown) => Promise<RunOutput>;
  /** resolve a child workflow name/scriptPath → source (enables workflow()) */
  resolveChild?: (nameOrPath: string) => string;
  /** invoked with the parsed script before execution (runner uses it to seed the journal) */
  onParsed?: (parsed: ParsedWorkflow) => void;
  /** shared execution state (nested workflows); created fresh if absent */
  shared?: SharedRunState;
  /** when true, workflow() throws (child workflows cannot nest further) */
  noNesting?: boolean;
}

export function validateArgsAgainstInputSchema(parsed: ParsedWorkflow, args: unknown): void {
  if (!parsed.meta.inputSchema) return;
  const validation = validateWithSchema(parsed.meta.inputSchema, args);
  if (!validation.ok) {
    throw new MetaValidationError(
      `Workflow args do not match ${parsed.meta.name} meta.inputSchema: ${validation.errors.join('; ')}`,
    );
  }
}

export async function executeWorkflow(source: string, opts: ExecuteOptions): Promise<RunOutput> {
  const started = Date.now();
  const parsed = parseWorkflowScript(source);
  validateArgsAgainstInputSchema(parsed, opts.args ?? undefined);
  opts.onParsed?.(parsed);

  const abort = new AbortController();
  const outerSignal = opts.signal;
  // Captured so it can be detached on completion — a nested workflow() forwards
  // the parent's long-lived signal here, and without removal each child leaks a
  // listener on it (only auto-removed if abort actually fires).
  let onOuterAbort: (() => void) | undefined;
  if (outerSignal) {
    if (outerSignal.aborted) abort.abort(outerSignal.reason);
    else {
      onOuterAbort = () => abort.abort(outerSignal.reason);
      outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
  }

  const budget = opts.budgetAccount ?? new BudgetAccount(opts.budgetTotal ?? null);
  const onEvent = opts.onEvent ?? (() => {});

  const shared: SharedRunState = opts.shared ?? {
    semaphore: new Semaphore(opts.maxConcurrency ?? defaultConcurrency()),
    counter: { count: 0 },
  };

  // Build the nested-workflow runner from OUR internal shared primitives so
  // children share this run's semaphore/counter/budget/signal/keyChain.
  let runChild = opts.runChild;
  if (!runChild && !opts.noNesting && opts.resolveChild) {
    const resolver = opts.resolveChild;
    let childCount = 0;
    runChild = async (ref, childArgs) => {
      const { makeChildRunner } = await import('./child.js');
      return makeChildRunner({
        shared,
        budget,
        signal: abort.signal,
        childId: childCount++,
        keyChain: opts.keyChain as never,
        base: {
          executor: opts.executor,
          defaultBackend: opts.defaultBackend ?? 'mock',
          cwd: opts.cwd ?? process.cwd(),
          onEvent,
          onAgentStarted: opts.onAgentStarted,
          onAgentSettled: opts.onAgentSettled,
          cacheLookup: opts.cacheLookup,
          // Propagate caps so a child honors the parent's agent ceiling (the
          // lifetime counter is shared, but softCap is per-hostapi).
          maxAgents: opts.maxAgents,
          logCap: opts.logCap,
        },
        resolveName: resolver,
      })(ref, childArgs);
    };
  }

  const host = createHostApi({
    executor: opts.executor,
    meta: parsed.meta,
    args: opts.args ?? null,
    budget,
    signal: abort.signal,
    defaultBackend: opts.defaultBackend ?? 'mock',
    cwd: opts.cwd ?? process.cwd(),
    maxConcurrency: opts.maxConcurrency ?? defaultConcurrency(),
    maxAgents: opts.maxAgents,
    logCap: opts.logCap,
    onEvent,
    onAgentStarted: opts.onAgentStarted,
    onAgentSettled: opts.onAgentSettled,
    keyChain: opts.keyChain,
    cacheLookup: opts.cacheLookup,
    runChild: opts.noNesting
      ? () => {
          throw new MetaValidationError('workflow() cannot nest more than one level');
        }
      : runChild,
    shared,
  });

  onEvent({ type: 'run_started', name: parsed.meta.name });

  let result: unknown = null;
  let error: string | undefined;
  try {
    const sandbox = createSandbox(parsed.body, {
      globals: host.globals,
      syncTimeoutMs: opts.syncTimeoutMs,
      filename: `${parsed.meta.name}.workflow.js`,
    });
    result = (await sandbox.run()) ?? null;
    onEvent({ type: 'run_completed' });
  } catch (err) {
    error = errorMessage(err);
    onEvent({ type: abort.signal.aborted ? 'run_stopped' : 'run_failed', error });
  } finally {
    host.dispose();
    if (onOuterAbort && outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }

  return {
    result,
    logs: host.state.logs,
    droppedLogs: host.state.droppedLogs,
    failures: host.state.failures,
    agentCount: host.state.agentCount,
    totalTokens: budget.spent(),
    totalToolCalls: host.state.totalToolCalls,
    durationMs: Date.now() - started,
    ...(host.state.workspaces.length > 0 ? { workspaces: host.state.workspaces } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}
