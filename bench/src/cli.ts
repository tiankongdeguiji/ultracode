/** Sole public benchmark CLI and terminal-error boundary. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BENCH_SUITES, SYSTEM_CLOCK, type BenchSuite, type CommandContext } from './shared/contracts.js';
import { cleanupActiveBenchProcesses, sanitizeDiagnostic } from './shared/process.js';
import { DEFAULT_BENCH_PATH_ROOTS, validateBenchSuite } from './shared/paths.js';
import { suiteRegistry, type SuiteRegistry } from './registry.js';

export type BenchCliRoute =
  | { kind: 'root-help' }
  | { kind: 'suite-help'; suite: BenchSuite }
  | { kind: 'command-help'; suite: BenchSuite; command: string }
  | { kind: 'command'; suite: BenchSuite; command: string; argv: string[] };

function suiteNames(): string {
  return BENCH_SUITES.join('|');
}

export const BENCH_USAGE = `Usage:
  npm run bench -- --suite <${suiteNames()}> <command> [options]

Suites:
  swebench-pro  fetch | prep | run | eval | report | status | clean
  swe-marathon  prep | run | report
  featurebench  prep | run | report

Results:
  bench/results/<suite>/<runId>/manifest.json`;

function selected(argv: readonly string[]): { suite: BenchSuite; rest: string[] } {
  const first = argv[0];
  let value: string;
  let consumed: number;
  if (first === '--suite') {
    const candidate = argv[1];
    if (candidate === undefined || candidate.length === 0 || candidate.startsWith('-')) {
      throw new Error('--suite requires a value');
    }
    value = candidate;
    consumed = 2;
  } else if (first?.startsWith('--suite=')) {
    value = first.slice('--suite='.length);
    if (value.length === 0) throw new Error('--suite requires a value');
    consumed = 1;
  } else {
    throw new Error(`--suite must precede the command; expected ${BENCH_SUITES.join(', ')}`);
  }
  const rest = argv.slice(consumed);
  if (rest.some((token) => token === '--suite' || token.startsWith('--suite='))) {
    throw new Error('--suite may be provided only once and must precede the command');
  }
  return { suite: validateBenchSuite(value), rest };
}

/** Parse routing and help grammar without importing any native runner. */
export function parseBenchCliRoute(argv: readonly string[], registry: SuiteRegistry = suiteRegistry): BenchCliRoute {
  if (argv.length === 1 && argv[0] === '--help') return { kind: 'root-help' };
  if (argv.length === 0) throw new Error(`--suite is required; expected ${BENCH_SUITES.join(', ')}`);
  if (argv[0] === '-h' || argv[0] === 'help') throw new Error("root help is exactly '--help'");
  const { suite, rest } = selected(argv);
  if (rest.length === 0) throw new Error(`command is required for ${suite}`);
  if (rest.length === 1 && rest[0] === '--help') return { kind: 'suite-help', suite };
  const command = rest[0]!;
  if (command === '-h' || command === 'help') throw new Error("selected help is exactly '--help'");
  const adapter = registry.get(suite);
  const commands = adapter.commands as Record<string, unknown>;
  if (!Object.hasOwn(commands, command)) {
    throw new Error(`command '${command}' is not supported for ${suite}; expected ${Object.keys(commands).join(', ')}`);
  }
  const commandArgv = rest.slice(1);
  if (commandArgv.length === 1 && commandArgv[0] === '--help') return { kind: 'command-help', suite, command };
  if (commandArgv.includes('--help') || commandArgv.includes('-h')) {
    throw new Error(`help for ${suite} ${command} must be invoked with only '--help' after the command`);
  }
  return { kind: 'command', suite, command, argv: commandArgv };
}

function suiteHelp(suite: BenchSuite, registry: SuiteRegistry): string {
  const adapter = registry.get(suite);
  const lines = [
    `Usage: npm run bench -- --suite ${suite} <command> [options]`,
    '',
    `${adapter.displayName}: ${adapter.description}`,
    '',
    'Commands:',
    ...Object.entries(adapter.commands).map(([name, spec]) =>
      `  ${name.padEnd(10)} ${(spec as { summary: string }).summary}`),
  ];
  return `${lines.join('\n')}\n`;
}

function commandHelp(suite: BenchSuite, command: string, registry: SuiteRegistry): string {
  const spec = (registry.get(suite).commands as Record<string, {
    usage: string;
    summary: string;
    options: readonly { name: string; valueName?: string; repeatable?: boolean; summary: string }[];
  }>)[command]!;
  const lines = [
    `Usage: npm run bench -- --suite ${suite} ${command}${spec.usage ? ` ${spec.usage}` : ''}`,
    '',
    spec.summary,
    ...(spec.options.length === 0 ? [] : [
      '',
      'Options:',
      ...spec.options.map((option) => {
        const form = `--${option.name}${option.valueName ? ` <${option.valueName}>` : ''}${option.repeatable ? ' (repeatable)' : ''}`;
        return `  ${form.padEnd(36)} ${option.summary}`;
      }),
    ]),
  ];
  return `${lines.join('\n')}\n`;
}

/** Validate command options before the command lazily imports native code. */
export async function runBenchCli(
  argv: readonly string[],
  registry: SuiteRegistry = suiteRegistry,
  context: CommandContext = {
    stdout: process.stdout,
    stderr: process.stderr,
    paths: DEFAULT_BENCH_PATH_ROOTS,
    clock: SYSTEM_CLOCK,
  },
): Promise<void> {
  const route = parseBenchCliRoute(argv, registry);
  if (route.kind === 'root-help') {
    context.stdout.write(`${BENCH_USAGE}\n`);
    return;
  }
  if (route.kind === 'suite-help') {
    context.stdout.write(suiteHelp(route.suite, registry));
    return;
  }
  if (route.kind === 'command-help') {
    context.stdout.write(commandHelp(route.suite, route.command, registry));
    return;
  }
  const spec = (registry.get(route.suite).commands as Record<string, {
    parse(argv: readonly string[]): unknown;
    run(options: unknown, context: CommandContext): Promise<void>;
  }>)[route.command]!;
  const options = spec.parse(route.argv);
  await spec.run(options, context);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runBenchCli(process.argv.slice(2)).catch(async (error: unknown) => {
    try { await cleanupActiveBenchProcesses(); } catch { /* terminal diagnostic remains singular */ }
    const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
    process.stderr.write(`bench: ${message.replace(/[\r\n]+/g, ' ').trim() || 'benchmark command failed'}\n`);
    process.exitCode = 1;
  });
}
