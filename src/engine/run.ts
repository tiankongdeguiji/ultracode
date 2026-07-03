/**
 * WorkflowRun: top-level orchestration of one run — parse, args validation,
 * sandbox + hostapi wiring, output shaping. Persistence and detachment live
 * in store/ and exec/ (M4); this module is pure engine.
 */
import ajvModule from 'ajv/dist/2020.js';
// ajv ships CJS; under NodeNext the class is on .default (or .Ajv2020).
const Ajv2020 = (ajvModule as unknown as { default?: typeof ajvModule.Ajv2020 }).default ?? ajvModule.Ajv2020;
import { parseWorkflowScript, type ParsedWorkflow } from './meta.js';
import { createSandbox } from './sandbox.js';
import { createHostApi, type AgentSettledRecord, type RunEvent } from './hostapi.js';
import { defaultConcurrency } from './semaphore.js';
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
  error?: string;
}

export interface ExecuteOptions {
  executor: AgentExecutor;
  args?: unknown;
  budgetTotal?: number | null;
  maxConcurrency?: number;
  maxAgents?: number;
  logCap?: number;
  signal?: AbortSignal;
  defaultBackend?: string;
  cwd?: string;
  syncTimeoutMs?: number;
  onEvent?: (ev: RunEvent) => void;
  onAgentSettled?: (record: AgentSettledRecord) => void;
  cacheLookup?: (spec: AgentSpec) => { hit: boolean; value?: unknown } | undefined;
  runChild?: (ref: unknown, childArgs: unknown) => Promise<unknown>;
}

export function validateArgsAgainstInputSchema(parsed: ParsedWorkflow, args: unknown): void {
  if (!parsed.meta.inputSchema) return;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(parsed.meta.inputSchema);
  if (!validate(args)) {
    const details = (validate.errors ?? [])
      .map((e: { instancePath?: string; message?: string }) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim())
      .join('; ');
    throw new MetaValidationError(`Workflow args do not match ${parsed.meta.name} meta.inputSchema: ${details}`);
  }
}

export async function executeWorkflow(source: string, opts: ExecuteOptions): Promise<RunOutput> {
  const started = Date.now();
  const parsed = parseWorkflowScript(source);
  validateArgsAgainstInputSchema(parsed, opts.args ?? undefined);

  const abort = new AbortController();
  const outerSignal = opts.signal;
  if (outerSignal) {
    if (outerSignal.aborted) abort.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', () => abort.abort(outerSignal.reason), { once: true });
  }

  const budget = new BudgetAccount(opts.budgetTotal ?? null);
  const onEvent = opts.onEvent ?? (() => {});

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
    onAgentSettled: opts.onAgentSettled,
    cacheLookup: opts.cacheLookup,
    runChild: opts.runChild,
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
    ...(error !== undefined ? { error } : {}),
  };
}
