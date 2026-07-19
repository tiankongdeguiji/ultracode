/**
 * Public benchmark dispatcher. It validates the suite selector without loading
 * suite code, then delegates the remaining argv to exactly one benchmark CLI.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Suite names accepted by the public benchmark selector. */
export type BenchSuite = 'swebench-pro' | 'swe-marathon' | 'featurebench';

/** Fully validated routing outcome for one user argv vector. */
export type BenchCliRoute =
  | { kind: 'root-help' }
  | { kind: 'missing-suite'; showUsage: boolean }
  | { kind: 'missing-command' }
  | { kind: 'suite'; suite: BenchSuite; command: string; argv: string[] };

/** Optional delegates used by unit tests to verify routing without loading suite code. */
export interface BenchCliDelegates {
  runSwebenchProCli?: (argv: string[]) => Promise<void>;
  runExternalCli?: (argv: string[]) => Promise<void>;
}

const EXTERNAL_COMMANDS = new Set(['prep', 'run', 'report']);
const HELP_COMMANDS = new Set(['--help', '-h', 'help']);
const SUITES = new Set<BenchSuite>(['swebench-pro', 'swe-marathon', 'featurebench']);

/** Unified usage text shown only when no suite parser owns the request. */
export const BENCH_USAGE = `Usage:
  npm run bench -- --suite <swebench-pro|swe-marathon|featurebench> <command> [options]

Suites and commands:
  swebench-pro  fetch | prep | run | eval | report | status | clean
  swe-marathon  prep | run | report
  featurebench  prep | run | report

Run manifests:
  swebench-pro  bench/results/<runId>/run.json
  external      bench/results/external/<suite>/<runId>/external-run.json

Examples:
  npm run bench -- --suite swebench-pro run --run-id <id>
  npm run bench -- --suite swe-marathon prep
  npm run bench -- --suite featurebench report --run-id <id>`;

interface SuiteSelector {
  index: number;
  length: 1 | 2;
  value: string;
}

function parseSuiteSelectors(argv: readonly string[]): SuiteSelector[] {
  const selectors: SuiteSelector[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') break;
    if (token === '--suite') {
      const value = argv[index + 1];
      if (value === undefined || value === '--' || value.startsWith('--')) {
        throw new Error('--suite requires a value');
      }
      selectors.push({ index, length: 2, value });
      index += 1;
      continue;
    }
    if (token.startsWith('--suite=')) {
      const value = token.slice('--suite='.length);
      if (!value) throw new Error('--suite requires a value');
      selectors.push({ index, length: 1, value });
    }
  }
  return selectors;
}

function removeSelector(argv: readonly string[], selector: SuiteSelector | undefined): string[] {
  if (selector === undefined) return [...argv];
  return argv.filter((_token, index) => (
    index < selector.index || index >= selector.index + selector.length
  ));
}

/** Parse and normalize suite routing without importing a suite driver or performing I/O. */
export function parseBenchCliRoute(argv: readonly string[]): BenchCliRoute {
  const selectors = parseSuiteSelectors(argv);
  if (selectors.length > 1) throw new Error('--suite may be provided only once (duplicate selector)');

  const selector = selectors[0];
  if (selector !== undefined && !SUITES.has(selector.value as BenchSuite)) {
    throw new Error(`--suite value '${selector.value}' is unknown; expected swebench-pro, swe-marathon, or featurebench`);
  }

  const routedArgv = removeSelector(argv, selector);
  if (selector === undefined) {
    if (routedArgv.length === 1 && HELP_COMMANDS.has(routedArgv[0]!)) {
      return { kind: 'root-help' };
    }
    return { kind: 'missing-suite', showUsage: routedArgv.length === 0 };
  }
  if (routedArgv.length === 0) return { kind: 'missing-command' };

  const suite = selector.value as BenchSuite;
  const command = routedArgv[0]!;
  if (suite !== 'swebench-pro') {
    if (!EXTERNAL_COMMANDS.has(command) && !HELP_COMMANDS.has(command)) {
      throw new Error(`command '${command}' is not supported for ${suite}; expected prep, run, or report`);
    }
    routedArgv.splice(1, 0, '--suite', suite);
  }
  return { kind: 'suite', suite, command, argv: routedArgv };
}

/** Route one user argv vector to a single lazily loaded benchmark CLI. */
export async function runBenchCli(
  argv: string[],
  delegates: BenchCliDelegates = {},
): Promise<void> {
  const route = parseBenchCliRoute(argv);
  if (route.kind === 'root-help') {
    process.stdout.write(`${BENCH_USAGE}\n`);
    return;
  }
  if (route.kind === 'missing-suite') {
    if (route.showUsage) process.stdout.write(`${BENCH_USAGE}\n`);
    throw new Error('--suite is required; expected swebench-pro, swe-marathon, or featurebench');
  }
  if (route.kind === 'missing-command') {
    process.stdout.write(`${BENCH_USAGE}\n`);
    throw new Error('command is required');
  }
  if (route.suite === 'swebench-pro') {
    const run = delegates.runSwebenchProCli
      ?? (await import('./cli.js')).runSwebenchProCli;
    await run(route.argv);
    return;
  }
  const run = delegates.runExternalCli
    ?? (await import('./external-cli.js')).runExternalCli;
  await run(route.argv);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runBenchCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`bench: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
