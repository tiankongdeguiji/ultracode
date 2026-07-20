/** Lightweight SWE-Marathon command declarations; native code stays lazy. */
import type { SuiteAdapter, SuiteCommandSpec } from '../../shared/contracts.js';
import { parseStrictOptions, type OptionDefinition } from '../../shared/options.js';

export interface PrepOptions { recoverStaleLock: boolean }
export interface RunOptions {
  runId: string;
  resume: boolean;
  redo: readonly string[];
  recoverStaleLock: boolean;
  model?: string;
  requestedEffort?: string;
  arm?: 'a' | 'b';
  taskIds?: readonly string[];
}
export interface ReportOptions { runId: string; recoverStaleLock: boolean }

const boolean = (name: string, summary: string): OptionDefinition => ({ name, summary, kind: 'boolean' });
const string = (name: string, valueName: string, summary: string, repeatable = false): OptionDefinition => ({
  name, valueName, summary, repeatable, kind: 'string',
});

function scalar(values: Record<string, boolean | string | readonly string[]>, name: string): string | undefined {
  const observed = values[name];
  return typeof observed === 'string' ? observed : undefined;
}

function repeated(values: Record<string, boolean | string | readonly string[]>, name: string): readonly string[] {
  const observed = values[name];
  return Array.isArray(observed) ? observed : [];
}

function required(values: Record<string, boolean | string | readonly string[]>, name: string): string {
  const observed = scalar(values, name);
  if (observed === undefined) throw new Error(`--${name} is required`);
  return observed;
}

const PREP_OPTIONS = [boolean('recover-stale-lock', 'conservatively recover a stale preparation lock')] as const;
const prepSpec: SuiteCommandSpec<unknown> = {
  summary: 'prepare pinned Harbor, source, images, and the shared toolchain',
  usage: '[--recover-stale-lock]',
  options: PREP_OPTIONS,
  parse(argv): PrepOptions {
    const parsed = parseStrictOptions(argv, PREP_OPTIONS);
    return { recoverStaleLock: parsed.values['recover-stale-lock'] === true };
  },
  async run(options, context) {
    const runner = await import('./runner.js');
    await runner.prepCommand(options as PrepOptions, context);
  },
};

const RUN_OPTIONS = [
  string('run-id', 'id', 'lowercase run identity'),
  string('model', 'model', 'requested model'),
  string('effort', 'effort', 'requested reasoning effort'),
  string('arm', 'a|b', 'one experiment arm'),
  string('task-id', 'id', 'official SWE-Marathon task', true),
  boolean('resume', 'resume the exact immutable run'),
  string('redo', 'task-id', 'invalidate and rerun one task', true),
  boolean('recover-stale-lock', 'conservatively recover a stale lifecycle lock'),
] as const;

const runSpec: SuiteCommandSpec<unknown> = {
  summary: 'run one native Harbor job per task',
  usage: '--run-id <id> [options]',
  options: RUN_OPTIONS,
  parse(argv): RunOptions {
    const parsed = parseStrictOptions(argv, RUN_OPTIONS);
    const arm = scalar(parsed.values, 'arm');
    if (arm !== undefined && arm !== 'a' && arm !== 'b') throw new Error('--arm must be a or b');
    const taskIds = repeated(parsed.values, 'task-id');
    return {
      runId: required(parsed.values, 'run-id'),
      resume: parsed.values.resume === true,
      redo: repeated(parsed.values, 'redo'),
      recoverStaleLock: parsed.values['recover-stale-lock'] === true,
      ...(scalar(parsed.values, 'model') === undefined ? {} : { model: scalar(parsed.values, 'model') }),
      ...(scalar(parsed.values, 'effort') === undefined ? {} : { requestedEffort: scalar(parsed.values, 'effort') }),
      ...(arm === undefined ? {} : { arm }),
      ...(taskIds.length === 0 ? {} : { taskIds }),
    };
  },
  async run(options, context) {
    const runner = await import('./runner.js');
    await runner.runCommand(options as RunOptions, context);
  },
};

const REPORT_OPTIONS = [
  string('run-id', 'id', 'lowercase run identity'),
  boolean('recover-stale-lock', 'conservatively recover a stale lifecycle lock'),
] as const;
const reportSpec: SuiteCommandSpec<unknown> = {
  summary: 'write normalized metrics and the common report envelope',
  usage: '--run-id <id>',
  options: REPORT_OPTIONS,
  parse(argv): ReportOptions {
    const parsed = parseStrictOptions(argv, REPORT_OPTIONS);
    return {
      runId: required(parsed.values, 'run-id'),
      recoverStaleLock: parsed.values['recover-stale-lock'] === true,
    };
  },
  async run(options, context) {
    const runner = await import('./runner.js');
    await runner.reportCommand(options as ReportOptions, context);
  },
};

export const sweMarathonAdapter: SuiteAdapter<'swe-marathon'> = {
  suite: 'swe-marathon',
  displayName: 'SWE-Marathon',
  description: 'Pinned Harbor jobs and their official native verifiers',
  commands: { prep: prepSpec, run: runSpec, report: reportSpec },
};
