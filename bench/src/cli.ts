/** Sole public benchmark CLI and terminal-error boundary. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SYSTEM_CLOCK, type BenchSuite, type CommandContext } from './shared/contracts.js';
import { cleanupActiveBenchProcesses, sanitizeDiagnostic } from './shared/process.js';
import { DEFAULT_BENCH_PATH_ROOTS, validateBenchSuite } from './shared/paths.js';
import { suiteRegistry, type SuiteRegistry } from './registry.js';

export type BenchCliRoute =
  | { kind: 'root-help' }
  | { kind: 'suite-help'; suite: BenchSuite }
  | { kind: 'command-help'; suite: BenchSuite; command: string }
  | { kind: 'command'; suite: BenchSuite; command: string; argv: string[] };

type AsyncCleanup = () => Promise<unknown>;

interface SingleFlightCleanup {
  run: AsyncCleanup;
  pending(): Promise<unknown> | null;
}

export interface BenchExecutableDependencies {
  /** Root process-registry cleanup, replaceable only by offline boundary tests. */
  cleanupActiveProcesses?: AsyncCleanup;
  /** Fatal-cleanup deadline, replaceable only by offline boundary tests. */
  signalCleanupTimeoutMs?: number;
  /** Signal re-delivery seam used only by offline boundary tests. */
  resendSignal?: (signal: NodeJS.Signals) => void;
}

interface BenchSignalCoordinator {
  signalReceived(): boolean;
  waitForSignalCleanup(): Promise<void>;
  settle(): void;
}

let activeSignalCoordinator: BenchSignalCoordinator | null = null;

function suiteNames(registry: SuiteRegistry = suiteRegistry): string {
  return registry.list().map(({ suite }) => suite).join('|');
}

export const BENCH_USAGE = `Usage:
  npm run bench -- --suite <${suiteNames()}> <command> [options]

Suites:
  swebench-pro  fetch | prep | run | eval | report | status | clean

Results:
  bench/results/<suite>/<runId>/manifest.json`;

function selected(argv: readonly string[], registry: SuiteRegistry): { suite: BenchSuite; rest: string[] } {
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
    throw new Error(`--suite must precede the command; expected ${suiteNames(registry)}`);
  }
  const rest = argv.slice(consumed);
  if (rest.some((token) => token === '--suite' || token.startsWith('--suite='))) {
    throw new Error('--suite may be provided only once and must precede the command');
  }
  const suite = validateBenchSuite(value);
  registry.get(suite);
  return { suite, rest };
}

/** Parse routing and help grammar without importing any native runner. */
export function parseBenchCliRoute(argv: readonly string[], registry: SuiteRegistry = suiteRegistry): BenchCliRoute {
  if (argv.length === 1 && argv[0] === '--help') return { kind: 'root-help' };
  if (argv.length === 0) throw new Error(`--suite is required; expected ${suiteNames(registry)}`);
  if (argv[0] === '-h' || argv[0] === 'help') throw new Error("root help is exactly '--help'");
  const { suite, rest } = selected(argv, registry);
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

function singleFlightAsync(cleanup: AsyncCleanup): SingleFlightCleanup {
  let pending: Promise<unknown> | null = null;
  return {
    run: () => {
      pending ??= Promise.resolve().then(cleanup).finally(() => { pending = null; });
      return pending;
    },
    pending: () => pending,
  };
}

function installSignalCoordinator(
  cleanupActiveProcesses: AsyncCleanup,
  selectedSuiteCleanup: () => SingleFlightCleanup | undefined,
  timeoutMs: number,
  resendSignal: (signal: NodeJS.Signals) => void,
): BenchSignalCoordinator {
  if (activeSignalCoordinator !== null) return activeSignalCoordinator;
  let signalCleanup: Promise<void> | null = null;
  let finishBoundedCleanup: (() => void) | null = null;
  let forcedResend = false;
  let installed = true;
  const remove = (): void => {
    if (!installed) return;
    installed = false;
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    activeSignalCoordinator = null;
  };
  const resend = (signal: NodeJS.Signals): void => {
    remove();
    resendSignal(signal);
  };
  const handle = (signal: NodeJS.Signals): void => {
    if (signalCleanup !== null) {
      forcedResend = true;
      finishBoundedCleanup?.();
      resend(signal);
      return;
    }
    const suiteCleanup = selectedSuiteCleanup();
    const adoptedSuiteCleanup = suiteCleanup?.pending() ?? null;
    const cleanup = async (): Promise<void> => {
      await Promise.allSettled([cleanupActiveProcesses()]);
      await Promise.allSettled([adoptedSuiteCleanup ?? suiteCleanup?.run() ?? Promise.resolve()]);
      await Promise.allSettled([cleanupActiveProcesses()]);
      await Promise.allSettled([suiteCleanup?.run() ?? Promise.resolve()]);
    };
    let resolveBoundedCleanup!: () => void;
    const boundedCleanup = new Promise<void>((resolvePromise) => {
      resolveBoundedCleanup = resolvePromise;
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let boundedCleanupFinished = false;
    const finish = (): void => {
      if (boundedCleanupFinished) return;
      boundedCleanupFinished = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      finishBoundedCleanup = null;
      resolveBoundedCleanup();
    };
    finishBoundedCleanup = finish;
    signalCleanup = boundedCleanup.then(() => {
      if (!forcedResend) resend(signal);
    });
    timer = setTimeout(finish, timeoutMs);
    void cleanup().finally(finish);
  };
  const onSigint = (): void => handle('SIGINT');
  const onSigterm = (): void => handle('SIGTERM');
  const coordinator: BenchSignalCoordinator = {
    signalReceived: () => signalCleanup !== null,
    waitForSignalCleanup: () => signalCleanup ?? Promise.resolve(),
    settle: () => {
      if (signalCleanup === null) remove();
    },
  };
  activeSignalCoordinator = coordinator;
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return coordinator;
}

async function dispatchBenchCliRoute(
  route: BenchCliRoute,
  registry: SuiteRegistry,
  context: CommandContext,
  cleanup?: AsyncCleanup,
  cleanupOwnedElsewhere: () => boolean = () => false,
): Promise<void> {
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
  try {
    await spec.run(options, context);
  } catch (error) {
    if (cleanup !== undefined && !cleanupOwnedElsewhere()) {
      try {
        await cleanup();
      } catch (cleanupError) {
        const commandMessage = error instanceof Error ? error.message : String(error);
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new AggregateError(
          [error, cleanupError],
          `${commandMessage}; suite runtime cleanup failed: ${cleanupMessage}`,
        );
      }
    }
    throw error;
  }
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
  const cleanup = 'suite' in route ? registry.get(route.suite).cleanup : undefined;
  await dispatchBenchCliRoute(route, registry, context, cleanup);
}

/** Run the terminal executable with one signal owner and one final diagnostic. */
export async function runBenchExecutable(
  argv: readonly string[],
  registry: SuiteRegistry = suiteRegistry,
  context: CommandContext = {
    stdout: process.stdout,
    stderr: process.stderr,
    paths: DEFAULT_BENCH_PATH_ROOTS,
    clock: SYSTEM_CLOCK,
  },
  dependencies: BenchExecutableDependencies = {},
): Promise<void> {
  const activeProcessCleanup = singleFlightAsync(
    dependencies.cleanupActiveProcesses ?? cleanupActiveBenchProcesses,
  );
  let selectedSuiteCleanup: SingleFlightCleanup | undefined;
  const signalCleanupTimeoutMs = dependencies.signalCleanupTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(signalCleanupTimeoutMs) || signalCleanupTimeoutMs <= 0) {
    throw new Error('signal cleanup timeout must be a positive safe integer');
  }
  const coordinator = installSignalCoordinator(
    activeProcessCleanup.run,
    () => selectedSuiteCleanup,
    signalCleanupTimeoutMs,
    dependencies.resendSignal ?? ((signal) => { process.kill(process.pid, signal); }),
  );
  try {
    const route = parseBenchCliRoute(argv, registry);
    const cleanup = 'suite' in route ? registry.get(route.suite).cleanup : undefined;
    selectedSuiteCleanup = cleanup === undefined ? undefined : singleFlightAsync(cleanup);
    await dispatchBenchCliRoute(
      route,
      registry,
      context,
      selectedSuiteCleanup?.run,
      coordinator.signalReceived,
    );
  } catch (error) {
    if (coordinator.signalReceived()) {
      await coordinator.waitForSignalCleanup();
      return;
    }
    try { await activeProcessCleanup.run(); } catch { /* terminal diagnostic remains singular */ }
    const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
    context.stderr.write(`bench: ${message.replace(/[\r\n]+/g, ' ').trim() || 'benchmark command failed'}\n`);
    process.exitCode = 1;
  } finally {
    coordinator.settle();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  void runBenchExecutable(process.argv.slice(2));
}
