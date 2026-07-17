/**
 * Nested workflow() support: resolve a child reference and run it inline,
 * sharing the parent's semaphore, agent counter, abort signal, budget, and
 * key chain — one level deep only. Child agents keep chaining the same
 * journal keys so resume replays through the nesting boundary.
 */
import { executeWorkflow, type ExecuteOptions, type RunOutput } from './run.js';
import { UltracodeError, errorMessage } from './errors.js';
import { argsHash } from './journal.js';
import type { RunEvent, SharedRunState } from './hostapi.js';
import type { BudgetAccount } from '../budget/account.js';

export interface ChildRef {
  name?: string;
  scriptPath?: string;
  script?: string;
}

export interface ChildRunnerDeps {
  shared: SharedRunState;
  budget: BudgetAccount;
  signal: AbortSignal;
  /** ordinal of this workflow() call within the parent run (tags child events) */
  childId?: number;
  keyChain?: { next(spec: never): string };
  base: Pick<
    ExecuteOptions,
    'executor' | 'defaultBackend' | 'cwd' | 'onEvent' | 'onAgentStarted' | 'onAgentSettled' | 'cacheLookup' | 'maxAgents' | 'logCap'
  >;
  /** resolve a child by name → source text (registry lookup lives in the runner/CLI) */
  resolveName?: (name: string) => string;
  /** journal boundary hooks */
  onChildEnter?: (name: string, args: unknown) => void;
  onChildExit?: (name: string, out: RunOutput) => void;
}

function normalizeRef(ref: unknown): { source?: string; name?: string; scriptPath?: string } {
  if (typeof ref === 'string') return { name: ref };
  if (ref && typeof ref === 'object') {
    const r = ref as ChildRef;
    if (r.script) return { source: r.script };
    if (r.scriptPath) return { scriptPath: r.scriptPath };
    if (r.name) return { name: r.name };
  }
  throw new UltracodeError('workflow() expects a name string or { name | scriptPath | script }', 'bad-child-ref');
}

export function makeChildRunner(deps: ChildRunnerDeps): (ref: unknown, childArgs: unknown) => Promise<RunOutput> {
  return async (ref: unknown, childArgs: unknown): Promise<RunOutput> => {
    const { source, name, scriptPath } = normalizeRef(ref);
    let childSource = source;
    if (childSource === undefined) {
      if (scriptPath) {
        // The engine layer avoids fs; the runner supplies resolveName which
        // also handles scriptPath. Fall back to an explicit error otherwise.
        if (!deps.resolveName) throw new UltracodeError('workflow({scriptPath}) requires a resolver', 'no-resolver');
        childSource = deps.resolveName(scriptPath);
      } else if (name) {
        if (!deps.resolveName) throw new UltracodeError(`workflow('${name}') requires a workflow registry`, 'no-registry');
        childSource = deps.resolveName(name);
      }
    }
    if (childSource === undefined) throw new UltracodeError('workflow() could not resolve a child script', 'unresolved-child');

    const label = name ?? scriptPath ?? '(inline)';
    const childId = deps.childId ?? 0;
    const emit = deps.base.onEvent ?? (() => {});
    deps.onChildEnter?.(label, childArgs);
    emit({ type: 'child_started', childId, name: label, argsHash: argsHash(childArgs) });
    // Tag every event from inside the child (child agents share the parent's
    // seq space and may interleave with concurrent parent agents — attribution
    // must ride on each event) and drop the child's own run_* lifecycle so the
    // parent stream contains exactly one run_started/run_completed.
    const childOnEvent = (ev: RunEvent): void => {
      switch (ev.type) {
        case 'run_started':
        case 'run_completed':
        case 'run_failed':
        case 'run_stopped':
          return;
        default:
          emit({ ...ev, childId, childName: label });
      }
    };
    let out: RunOutput;
    try {
      out = await executeWorkflow(childSource, {
        ...deps.base,
        onEvent: childOnEvent,
        args: childArgs,
        signal: deps.signal,
        budgetAccount: deps.budget,
        shared: deps.shared,
        keyChain: deps.keyChain as ExecuteOptions['keyChain'],
        noNesting: true, // one level only
      });
    } catch (e) {
      // Pre-execution failures (e.g. a child script that does not parse) still
      // close the boundary so event consumers never see a dangling child group.
      emit({ type: 'child_completed', childId, name: label, ok: false, agentCount: 0, error: errorMessage(e) });
      throw e;
    }
    deps.onChildExit?.(label, out);
    emit({ type: 'child_completed', childId, name: label, ok: !out.error, agentCount: out.agentCount, error: out.error });
    if (out.error) {
      throw new UltracodeError(`child workflow '${label}' failed: ${out.error}`, 'child-failed');
    }
    // Return the full output so the parent's workflow() can merge the child's
    // diagnostics (failures/logs/workspaces/counters) — the caller extracts
    // .result for the script.
    return out;
  };
}
