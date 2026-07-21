/** SWE-bench Pro native and policy-adjusted A/B analysis report hook. */
import type {
  PairedAnalysis,
  RateAnalysis,
  SuiteAnalysisHook,
  SwebenchProAnalysis,
  TaskResult,
  ThesisStratum,
} from '../../shared/report.js';

const Z_95 = 1.96;

/** Wilson score interval at 95%; an empty denominator spans the full range. */
export function wilson(successes: number, trials: number): { lo: number; hi: number } {
  if (trials === 0) return { lo: 0, hi: 1 };
  const proportion = successes / trials;
  const squared = Z_95 * Z_95;
  const denominator = 1 + squared / trials;
  const center = (proportion + squared / (2 * trials)) / denominator;
  const half = Z_95 / denominator
    * Math.sqrt(proportion * (1 - proportion) / trials + squared / (4 * trials * trials));
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** Exact two-sided binomial McNemar p-value for discordant paired outcomes. */
export function mcnemarExact(aOnly: number, bOnly: number): number {
  const discordant = aOnly + bOnly;
  if (discordant === 0) return 1;
  let term = Math.pow(0.5, discordant);
  let sum = term;
  const smaller = Math.min(aOnly, bOnly);
  for (let index = 0; index < smaller; index += 1) {
    term *= (discordant - index) / (index + 1);
    sum += term;
  }
  return Math.min(1, 2 * sum);
}

function rate(values: readonly boolean[]): RateAnalysis {
  const resolved = values.filter(Boolean).length;
  return {
    evaluated: values.length,
    resolved,
    rate: values.length === 0 ? null : resolved / values.length,
    wilson95: wilson(resolved, values.length),
  };
}

function nativeValue(result: TaskResult): boolean | null {
  return result.nativeVerifier.verification === 'verified' ? result.nativeVerifier.resolved : null;
}

function policyValue(result: TaskResult): boolean | null {
  if (result.nativeVerifier.verification === 'verified') return result.nativeVerifier.resolved;
  return result.disposition === 'agent-loss' ? false : null;
}

function pairResults(
  results: readonly TaskResult[],
  value: (result: TaskResult) => boolean | null,
): { arms: { a: RateAnalysis; b: RateAnalysis }; paired: PairedAnalysis } {
  const a = results.filter((result) => result.arm === 'a').flatMap((result) => {
    const observed = value(result);
    return observed === null ? [] : [observed];
  });
  const b = results.filter((result) => result.arm === 'b').flatMap((result) => {
    const observed = value(result);
    return observed === null ? [] : [observed];
  });
  const byTask = new Map<string, Partial<Record<'a' | 'b', boolean>>>();
  for (const result of results) {
    const observed = value(result);
    if (observed === null) continue;
    const pair = byTask.get(result.taskId) ?? {};
    pair[result.arm] = observed;
    byTask.set(result.taskId, pair);
  }
  let bothResolved = 0;
  let aOnly = 0;
  let bOnly = 0;
  let neither = 0;
  for (const pair of byTask.values()) {
    if (pair.a === undefined || pair.b === undefined) continue;
    if (pair.a && pair.b) bothResolved += 1;
    else if (pair.a) aOnly += 1;
    else if (pair.b) bOnly += 1;
    else neither += 1;
  }
  return {
    arms: { a: rate(a), b: rate(b) },
    paired: {
      paired: bothResolved + aOnly + bOnly + neither,
      bothResolved,
      aOnly,
      bOnly,
      neither,
      mcnemarExactP: mcnemarExact(aOnly, bOnly),
    },
  };
}

function stratum(pairs: readonly { a: boolean; b: boolean }[]): ThesisStratum {
  const aResolved = pairs.filter((pair) => pair.a).length;
  const bResolved = pairs.filter((pair) => pair.b).length;
  const aRate = pairs.length === 0 ? null : aResolved / pairs.length;
  const bRate = pairs.length === 0 ? null : bResolved / pairs.length;
  return {
    paired: pairs.length,
    aResolved,
    bResolved,
    aRate,
    bRate,
    delta: aRate === null || bRate === null ? null : bRate - aRate,
  };
}

export const swebenchProAnalysisHook: SuiteAnalysisHook<'swebench-pro'> = {
  suite: 'swebench-pro',
  analyze(context): SwebenchProAnalysis {
    const native = pairResults(context.taskResults, nativeValue);
    const adjusted = pairResults(context.taskResults, policyValue);
    const pressuredTasks = new Set(context.metrics.sessions.items
      .filter((session) => session.scope.arm === 'a' && session.underContextPressure)
      .map((session) => session.scope.taskId));
    const observedATasks = new Set(context.metrics.sessions.items
      .filter((session) => session.scope.arm === 'a')
      .map((session) => session.scope.taskId));
    const byTask = new Map<string, Partial<Record<'a' | 'b', boolean>>>();
    for (const result of context.taskResults) {
      const observed = nativeValue(result);
      if (observed === null) continue;
      const pair = byTask.get(result.taskId) ?? {};
      pair[result.arm] = observed;
      byTask.set(result.taskId, pair);
    }
    const inside: Array<{ a: boolean; b: boolean }> = [];
    const outside: Array<{ a: boolean; b: boolean }> = [];
    let unclassified = 0;
    for (const [taskId, pair] of byTask) {
      if (pair.a === undefined || pair.b === undefined) continue;
      if (!observedATasks.has(taskId)) unclassified += 1;
      else (pressuredTasks.has(taskId) ? inside : outside).push({ a: pair.a, b: pair.b });
    }
    return {
      suite: 'swebench-pro',
      native: {
        ...native,
        thesisCut: { inside: stratum(inside), outside: stratum(outside), unclassified },
      },
      policyAdjusted: adjusted,
    };
  },
};
