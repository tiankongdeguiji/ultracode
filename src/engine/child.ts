/**
 * Nested workflow() support: resolve a child reference and run it inline,
 * sharing the parent's semaphore, agent counter, abort signal, budget, and
 * key chain — one level deep only. Child agents keep chaining the same
 * journal keys so resume replays through the nesting boundary.
 */
import { executeWorkflow, type ExecuteOptions, type RunOutput } from './run.js';
import { UltracodeError } from './errors.js';
import type { SharedRunState } from './hostapi.js';
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
  keyChain?: { next(spec: never): string };
  base: Pick<ExecuteOptions, 'executor' | 'defaultBackend' | 'cwd' | 'onEvent' | 'onAgentSettled' | 'cacheLookup'>;
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

export function makeChildRunner(deps: ChildRunnerDeps): (ref: unknown, childArgs: unknown) => Promise<unknown> {
  return async (ref: unknown, childArgs: unknown): Promise<unknown> => {
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
    deps.onChildEnter?.(label, childArgs);
    const out = await executeWorkflow(childSource, {
      ...deps.base,
      args: childArgs,
      signal: deps.signal,
      budgetAccount: deps.budget,
      shared: deps.shared,
      keyChain: deps.keyChain as ExecuteOptions['keyChain'],
      noNesting: true, // one level only
    });
    deps.onChildExit?.(label, out);
    if (out.error) {
      throw new UltracodeError(`child workflow '${label}' failed: ${out.error}`, 'child-failed');
    }
    return out.result;
  };
}
