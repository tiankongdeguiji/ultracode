/** Lightweight Pro command declaration; native code is imported only after parsing. */
import type { SuiteAdapter, SuiteCommandSpec } from '../../shared/contracts.js';
import { parseIntegerOption, parseStrictOptions, type OptionDefinition } from '../../shared/options.js';

interface RunOptions {
  runId: string;
  resume: boolean;
  redo: readonly string[];
  recoverStaleLock: boolean;
  model?: string;
  requestedEffort?: string;
  arm?: 'a' | 'b' | 'both';
  taskIds?: readonly string[];
  count?: number;
  seed?: number;
  taskConcurrency?: number;
  sessionTimeoutMs?: number;
}

interface EvalOptions {
  runId: string;
  resume: boolean;
  recoverStaleLock: boolean;
  gold: boolean;
  nullCheck: boolean;
}

interface CacheOptions { recoverStaleLock: boolean }
interface IdentityOptions { runId: string; recoverStaleLock?: boolean }
interface CleanOptions extends IdentityOptions { images: boolean }

const boolean = (name: string, summary: string): OptionDefinition => ({ name, summary, kind: 'boolean' });
const string = (name: string, valueName: string, summary: string, repeatable = false): OptionDefinition => ({
  name, valueName, summary, repeatable, kind: 'string',
});

function value(values: Record<string, boolean | string | readonly string[]>, name: string): string | undefined {
  const observed = values[name];
  return typeof observed === 'string' ? observed : undefined;
}

function values(valuesByName: Record<string, boolean | string | readonly string[]>, name: string): readonly string[] {
  const observed = valuesByName[name];
  return Array.isArray(observed) ? observed : [];
}

function required(valuesByName: Record<string, boolean | string | readonly string[]>, name: string): string {
  const observed = value(valuesByName, name);
  if (observed === undefined) throw new Error(`--${name} is required`);
  return observed;
}

const CACHE_OPTIONS = [boolean('recover-stale-lock', 'conservatively recover a stale local cache lock')] as const;

const cacheSpec = (
  summary: string,
  handler: 'fetchCommand' | 'prepCommand',
): SuiteCommandSpec<unknown> => ({
  summary,
  usage: '[--recover-stale-lock]',
  options: CACHE_OPTIONS,
  parse(argv): CacheOptions {
    const parsed = parseStrictOptions(argv, CACHE_OPTIONS);
    return { recoverStaleLock: parsed.values['recover-stale-lock'] === true };
  },
  async run(options, context) {
    const runner = await import('./runner.js');
    await runner[handler](options as CacheOptions, context);
  },
});

const RUN_OPTIONS = [
  string('run-id', 'id', 'lowercase run identity'),
  string('model', 'model', 'requested model'),
  string('effort', 'effort', 'requested reasoning effort'),
  string('arm', 'a|b|both', 'experiment arm'),
  string('task-id', 'id', 'explicit task identity', true),
  string('count', 'n', 'sample size'),
  string('seed', 'n', 'sampling seed'),
  string('task-concurrency', 'n', 'parallel task sessions'),
  string('session-timeout-ms', 'ms', 'host task timeout'),
  boolean('resume', 'resume an existing immutable run'),
  string('redo', 'task::arm', 'redo one exact task/arm', true),
  boolean('recover-stale-lock', 'conservatively recover a stale local lock'),
] as const;

const runSpec: SuiteCommandSpec<unknown> = {
  summary: 'run native agent sessions',
  usage: '--run-id <id> [options]',
  options: RUN_OPTIONS,
  parse(argv): RunOptions {
    const parsed = parseStrictOptions(argv, RUN_OPTIONS);
    const arm = value(parsed.values, 'arm');
    if (arm !== undefined && !['a', 'b', 'both'].includes(arm)) throw new Error('--arm must be a, b, or both');
    const integer = (name: string, minimum: number): number | undefined => {
      const observed = value(parsed.values, name);
      return observed === undefined ? undefined : parseIntegerOption(name, observed, minimum);
    };
    const taskIds = values(parsed.values, 'task-id');
    return {
      runId: required(parsed.values, 'run-id'),
      resume: parsed.values.resume === true,
      redo: values(parsed.values, 'redo'),
      recoverStaleLock: parsed.values['recover-stale-lock'] === true,
      ...(value(parsed.values, 'model') === undefined ? {} : { model: value(parsed.values, 'model') }),
      ...(value(parsed.values, 'effort') === undefined ? {} : { requestedEffort: value(parsed.values, 'effort') }),
      ...(arm === undefined ? {} : { arm: arm as 'a' | 'b' | 'both' }),
      ...(taskIds.length === 0 ? {} : { taskIds }),
      ...(integer('count', 1) === undefined ? {} : { count: integer('count', 1) }),
      ...(integer('seed', 0) === undefined ? {} : { seed: integer('seed', 0) }),
      ...(integer('task-concurrency', 1) === undefined ? {} : { taskConcurrency: integer('task-concurrency', 1) }),
      ...(integer('session-timeout-ms', 60_000) === undefined ? {} : { sessionTimeoutMs: integer('session-timeout-ms', 60_000) }),
    };
  },
  async run(options, context) {
    const runner = await import('./runner.js');
    await runner.runCommand(options as RunOptions, context);
  },
};

const EVAL_OPTIONS = [
  string('run-id', 'id', 'lowercase run identity'),
  boolean('resume', 'continue native verifier execution'),
  boolean('gold', 'run the official gold sanity check'),
  boolean('null', 'run the official null sanity check'),
  boolean('recover-stale-lock', 'conservatively recover a stale local lock'),
] as const;

const evalSpec: SuiteCommandSpec<unknown> = {
  summary: 'run the official native evaluator',
  usage: '--run-id <id> --resume [--gold|--null]',
  options: EVAL_OPTIONS,
  parse(argv): EvalOptions {
    const parsed = parseStrictOptions(argv, EVAL_OPTIONS);
    return {
      runId: required(parsed.values, 'run-id'),
      resume: parsed.values.resume === true,
      recoverStaleLock: parsed.values['recover-stale-lock'] === true,
      gold: parsed.values.gold === true,
      nullCheck: parsed.values.null === true,
    };
  },
  async run(options, context) {
    const runner = await import('./runner.js');
    await runner.evalCommand(options as EvalOptions, context);
  },
};

function identitySpec(
  summary: string,
  handler: 'reportCommand' | 'statusCommand',
): SuiteCommandSpec<unknown> {
  const definitions = [
    string('run-id', 'id', 'lowercase run identity'),
    boolean('recover-stale-lock', 'recover stale lifecycle lock'),
  ];
  return {
    summary,
    usage: '--run-id <id>',
    options: definitions,
    parse(argv): IdentityOptions {
      const parsed = parseStrictOptions(argv, definitions);
      return {
        runId: required(parsed.values, 'run-id'),
        ...(parsed.values['recover-stale-lock'] === true ? { recoverStaleLock: true } : {}),
      };
    },
    async run(options, context) {
      const runner = await import('./runner.js');
      await runner[handler](options as IdentityOptions, context);
    },
  };
}

const CLEAN_OPTIONS = [
  string('run-id', 'id', 'lowercase run identity'),
  boolean('images', 'remove exact manifest-owned overlays'),
  boolean('recover-stale-lock', 'conservatively recover a stale local lock'),
] as const;

export const swebenchProAdapter: SuiteAdapter<'swebench-pro'> = {
  suite: 'swebench-pro',
  displayName: 'SWE-bench Pro',
  description: 'Docker sessions and the pinned official SWE-bench Pro evaluator',
  async cleanup() {
    const runner = await import('./runner.js');
    await runner.cleanupSwebenchProRuntime();
  },
  commands: {
    fetch: cacheSpec('verify and freeze the pinned unaudited dataset descriptor', 'fetchCommand'),
    prep: cacheSpec('prepare immutable toolchain and evaluator inputs', 'prepCommand'),
    run: runSpec,
    eval: evalSpec,
    report: identitySpec('write the shared report envelope', 'reportCommand'),
    status: identitySpec('show exact task/arm status', 'statusCommand'),
    clean: {
      summary: 'clean run-owned containers, invalidate reports, and optionally remove overlays',
      usage: '--run-id <id> [--images]',
      options: CLEAN_OPTIONS,
      parse(argv): CleanOptions {
        const parsed = parseStrictOptions(argv, CLEAN_OPTIONS);
        return {
          runId: required(parsed.values, 'run-id'),
          images: parsed.values.images === true,
          recoverStaleLock: parsed.values['recover-stale-lock'] === true,
        };
      },
      async run(options, context) {
        const runner = await import('./runner.js');
        await runner.cleanCommand(options as CleanOptions, context);
      },
    },
  },
};
