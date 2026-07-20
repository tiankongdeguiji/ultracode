/**
 * Dependency-free contracts shared by the benchmark registry and suite
 * adapters. Adapters import this leaf module, never the registry that owns
 * them, which keeps the control-plane dependency graph acyclic.
 */

export const BENCH_SUITES = [
  'swebench-pro',
  'swe-marathon',
  'featurebench',
] as const;

export type BenchSuite = typeof BENCH_SUITES[number];
export type Arm = 'a' | 'b';
export type ExperimentArm = Arm | 'both';

export interface CommandNames {
  'swebench-pro': 'fetch' | 'prep' | 'run' | 'eval' | 'report' | 'status' | 'clean';
  'swe-marathon': 'prep' | 'run' | 'report';
  featurebench: 'prep' | 'run' | 'report';
}

export type CommandBySuite<S extends BenchSuite> = CommandNames[S];

export const SUITE_COMMANDS = {
  'swebench-pro': ['fetch', 'prep', 'run', 'eval', 'report', 'status', 'clean'],
  'swe-marathon': ['prep', 'run', 'report'],
  featurebench: ['prep', 'run', 'report'],
} as const satisfies { [S in BenchSuite]: readonly CommandBySuite<S>[] };

export interface BenchClock {
  now(): Date;
  monotonicMs(): number;
}

export interface BenchPathRoots {
  /** Absolute path to the tracked bench directory. */
  benchRoot: string;
  /** Absolute path to the ignored prepared-input cache. */
  cacheRoot: string;
  /** Absolute path whose children are suite namespaces. */
  resultsRoot: string;
}

export interface CommandContext {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  paths: BenchPathRoots;
  clock: BenchClock;
}

export interface OptionHelp {
  name: string;
  summary: string;
  valueName?: string;
  repeatable?: boolean;
}

export interface SuiteCommandSpec<Options> {
  summary: string;
  usage: string;
  options: readonly OptionHelp[];
  parse(argv: readonly string[]): Options;
  run(options: Options, context: CommandContext): Promise<void>;
}

export interface SuiteAdapter<S extends BenchSuite> {
  suite: S;
  displayName: string;
  description: string;
  commands: Readonly<{
    [C in CommandBySuite<S>]: SuiteCommandSpec<unknown>;
  }>;
}

export type AnySuiteAdapter = {
  [S in BenchSuite]: SuiteAdapter<S>;
}[BenchSuite];

export const FAILURE_CODES = [
  'agent-crash',
  'agent-timeout',
  'empty-patch',
  'patch-too-large',
  'unapplyable-diff',
  'driver-watchdog',
  'driver-interrupted',
  'spawn-failed',
  'descendant-cleanup-failed',
  'native-runner-failed',
  'image-failed',
  'image-identity-drift',
  'toolchain-incompatible',
  'provenance-drift',
  'invalid-instance',
  'base-mismatch',
  'auth-failed',
  'rate-limited',
  'broker-failed',
  'network-policy-failed',
  'verifier-timeout',
  'verifier-process-failed',
  'verifier-output-missing',
  'verifier-output-malformed',
  'receipt-incomplete',
  'artifact-unsafe',
  'ownership-unsafe',
  'harness-setup-failed',
  'unattributed-verifier-absence',
  'unknown-terminal',
] as const;

export type FailureCode = typeof FAILURE_CODES[number];

export const SYSTEM_CLOCK: BenchClock = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};
