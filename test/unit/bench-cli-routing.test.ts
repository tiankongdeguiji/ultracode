/** Unified benchmark CLI grammar, lazy dispatch, and executable boundary. */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BENCH_USAGE,
  parseBenchCliRoute,
  runBenchCli,
  runBenchExecutable,
} from '../../bench/src/cli.js';
import type { SuiteRegistry } from '../../bench/src/registry.js';
import type { CommandContext } from '../../bench/src/shared/contracts.js';

const REPO_ROOT = process.cwd();
const SUBPROCESS_ENV = { NO_COLOR: '1', PATH: process.env.PATH ?? '' };
const subprocessProbe = spawnSync(process.execPath, ['--version'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  env: SUBPROCESS_ENV,
});
const SUBPROCESS_BLOCKED = (subprocessProbe.error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';

interface InvocationResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

function invokeNode(argv: readonly string[]): InvocationResult {
  const result = spawnSync(process.execPath, argv, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: SUBPROCESS_ENV,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function invokeCli(argv: readonly string[]): InvocationResult {
  return invokeNode(['--import', 'tsx', 'bench/src/cli.ts', ...argv]);
}

function benchLines(stderr: string): string[] {
  return stderr.split(/\r?\n/u).filter((line) => line.startsWith('bench:'));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('unified benchmark CLI routing', () => {
  it('requires a suite-first selector and supports both selector spellings', () => {
    expect(parseBenchCliRoute(['--suite', 'swebench-pro', 'run', '--run-id', 'trial1'])).toEqual({
      kind: 'command',
      suite: 'swebench-pro',
      command: 'run',
      argv: ['--run-id', 'trial1'],
    });
    expect(parseBenchCliRoute(['--suite=swebench-pro', 'report', '--run-id', 'trial1'])).toEqual({
      kind: 'command',
      suite: 'swebench-pro',
      command: 'report',
      argv: ['--run-id', 'trial1'],
    });
    expect(parseBenchCliRoute(['--suite', 'swe-marathon', 'run', '--run-id', 'marathon1'])).toEqual({
      kind: 'command',
      suite: 'swe-marathon',
      command: 'run',
      argv: ['--run-id', 'marathon1'],
    });
    expect(parseBenchCliRoute(['--suite', 'featurebench', 'run', '--run-id', 'feature1'])).toEqual({
      kind: 'command',
      suite: 'featurebench',
      command: 'run',
      argv: ['--run-id', 'feature1'],
    });
    expect(() => parseBenchCliRoute(['swebench-pro', 'run'])).toThrow(/--suite must precede/);
    expect(() => parseBenchCliRoute(['run', '--suite', 'swebench-pro'])).toThrow(/--suite must precede/);
    expect(() => parseBenchCliRoute(['--suite', 'swebench-pro', 'run', '--suite', 'swebench-pro'])).toThrow(
      /only once/,
    );
    expect(() => parseBenchCliRoute([
      '--suite', 'swebench-pro', 'run', '--', '--suite=swebench-pro',
    ])).toThrow(/only once/);
  });

  it('has exact, unambiguous root, suite, and command help forms', () => {
    expect(parseBenchCliRoute(['--help'])).toEqual({ kind: 'root-help' });
    expect(parseBenchCliRoute(['--suite', 'swebench-pro', '--help'])).toEqual({
      kind: 'suite-help', suite: 'swebench-pro',
    });
    expect(parseBenchCliRoute(['--suite', 'swebench-pro', 'run', '--help'])).toEqual({
      kind: 'command-help', suite: 'swebench-pro', command: 'run',
    });
    expect(() => parseBenchCliRoute(['help'])).toThrow(/exactly '--help'/);
    expect(() => parseBenchCliRoute(['-h'])).toThrow(/exactly '--help'/);
    expect(() => parseBenchCliRoute(['--help', 'run'])).toThrow(/--suite must precede/);
    expect(() => parseBenchCliRoute(['--suite', 'swebench-pro', 'run', '--help', '--run-id', 'trial1'])).toThrow(
      /only '--help'/,
    );
  });

  it('rejects unsupported commands with the selected suite command set', () => {
    expect(() => parseBenchCliRoute(['--suite', 'swebench-pro', 'publish'])).toThrow(
      /not supported for swebench-pro; expected fetch, prep, run, eval, report, status, clean/,
    );
    expect(() => parseBenchCliRoute(['--suite', 'featurebench', 'clean'])).toThrow(
      /not supported for featurebench; expected prep, run, report/,
    );
  });

  it('parses command options before dispatch and dispatches exactly once', async () => {
    const calls: string[] = [];
    const registry = {
      get(suite: string) {
        expect(suite).toBe('featurebench');
        return {
          commands: {
            run: {
              parse(argv: readonly string[]) {
                calls.push(`parse:${argv.join('|')}`);
                return { runId: argv[1] };
              },
              async run(options: { runId: string }) {
                calls.push(`run:${options.runId}`);
              },
            },
          },
        };
      },
    } as unknown as SuiteRegistry;
    const context = {
      stdout: { write: () => true },
      stderr: { write: () => true },
      paths: { benchRoot: '/bench', cacheRoot: '/bench/.cache', resultsRoot: '/bench/results' },
      clock: { now: () => new Date(0), monotonicMs: () => 0 },
    } as unknown as CommandContext;

    await runBenchCli(['--suite', 'featurebench', 'run', '--run-id', 'trial1'], registry, context);
    expect(calls).toEqual(['parse:--run-id|trial1', 'run:trial1']);
  });

  it('never dispatches after command-option validation fails', async () => {
    let dispatched = false;
    const registry = {
      get: () => ({
        commands: {
          report: {
            parse: () => { throw new Error('--run-id is required'); },
            run: async () => { dispatched = true; },
          },
        },
      }),
    } as unknown as SuiteRegistry;
    await expect(runBenchCli(['--suite', 'featurebench', 'report'], registry)).rejects.toThrow(
      '--run-id is required',
    );
    expect(dispatched).toBe(false);
  });

  it('runs a selected suite cleanup hook when command dispatch rejects', async () => {
    const calls: string[] = [];
    const adapter = {
      cleanup: async () => { calls.push('cleanup'); },
      commands: {
        run: {
          parse: () => ({}),
          run: async () => {
            calls.push('run');
            throw new Error('command failed');
          },
        },
      },
    };
    const registry = { get: () => adapter } as unknown as SuiteRegistry;
    await expect(runBenchCli([
      '--suite', 'featurebench', 'run', '--run-id', 'trial1',
    ], registry)).rejects.toThrow('command failed');
    expect(calls).toEqual(['run', 'cleanup']);
  });

  it('reports both a command failure and a failed suite cleanup retry', async () => {
    const adapter = {
      cleanup: async () => { throw new Error('cleanup failed'); },
      commands: {
        run: {
          parse: () => ({}),
          run: async () => { throw new Error('command failed'); },
        },
      },
    };
    const registry = { get: () => adapter } as unknown as SuiteRegistry;
    await expect(runBenchCli([
      '--suite', 'featurebench', 'run', '--run-id', 'trial1',
    ], registry)).rejects.toThrow('command failed; suite runtime cleanup failed: cleanup failed');
  });

  it('advertises only the common suite-scoped result layout', () => {
    expect(BENCH_USAGE).toContain('bench/results/<suite>/<runId>/manifest.json');
    expect(BENCH_USAGE).not.toMatch(/external|run\.json/);
  });
});

describe('benchmark executable structure', () => {
  it('leaves cli.ts as the only TypeScript executable and package entrypoint', () => {
    const executables = sourceFiles(join(REPO_ROOT, 'bench/src')).filter((path) =>
      readFileSync(path, 'utf8').includes('process.argv'));
    expect(executables).toEqual([join(REPO_ROOT, 'bench/src/cli.ts')]);
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.bench).toBe('tsx bench/src/cli.ts');
    expect(Object.keys(packageJson.scripts).filter((name) => name.startsWith('bench')).sort()).toEqual([
      'bench',
      'bench:check',
    ]);
  });

  it('keeps SIGINT and SIGTERM ownership at the executable boundary', () => {
    const signalOwners = sourceFiles(join(REPO_ROOT, 'bench/src')).filter((path) => {
      const source = readFileSync(path, 'utf8');
      return source.includes("process.on('SIGINT'") || source.includes("process.on('SIGTERM'");
    });
    expect(signalOwners).toEqual([join(REPO_ROOT, 'bench/src/cli.ts')]);
  });
});

describe('benchmark signal cleanup bounds', () => {
  it('quiesces active Docker clients before and after two suite cleanup sweeps', async () => {
    const events: string[] = [];
    let releaseCommand!: () => void;
    const command = new Promise<void>((resolvePromise) => { releaseCommand = resolvePromise; });
    const adapter = {
      cleanup: async () => { events.push('suite'); },
      commands: {
        run: {
          parse: () => ({}),
          run: async () => {
            setTimeout(() => process.emit('SIGTERM'), 0);
            await command;
          },
        },
      },
    };
    await runBenchExecutable(
      ['--suite', 'featurebench', 'run'],
      { get: () => adapter } as unknown as SuiteRegistry,
      {
        stdout: { write: () => true },
        stderr: { write: () => true },
        paths: { benchRoot: '/bench', cacheRoot: '/bench/.cache', resultsRoot: '/bench/results' },
        clock: { now: () => new Date(0), monotonicMs: () => 0 },
      } as unknown as CommandContext,
      {
        cleanupActiveProcesses: async () => { events.push('active'); },
        signalCleanupTimeoutMs: 1_000,
        resendSignal: () => { events.push('resend'); releaseCommand(); },
      },
    );
    expect(events).toEqual(['active', 'suite', 'active', 'suite', 'resend']);
  });

  it('adopts a dispatch-owned suite cleanup before it settles behind active cleanup', async () => {
    const events: string[] = [];
    let releaseFirstSuite!: () => void;
    const firstSuite = new Promise<void>((resolvePromise) => { releaseFirstSuite = resolvePromise; });
    let firstSuiteStarted!: () => void;
    const suiteStarted = new Promise<void>((resolvePromise) => { firstSuiteStarted = resolvePromise; });
    let releaseFirstActiveCleanup!: () => void;
    const firstActiveCleanup = new Promise<void>((resolvePromise) => {
      releaseFirstActiveCleanup = resolvePromise;
    });
    let firstActiveCleanupStarted!: () => void;
    const activeCleanupStarted = new Promise<void>((resolvePromise) => {
      firstActiveCleanupStarted = resolvePromise;
    });
    let suiteCleanupCount = 0;
    let activeCleanupCount = 0;
    const adapter = {
      cleanup: async () => {
        suiteCleanupCount += 1;
        const pass = suiteCleanupCount;
        events.push(`suite:${pass}:start`);
        if (pass === 1) {
          firstSuiteStarted();
          process.emit('SIGTERM');
          await firstSuite;
        }
        events.push(`suite:${pass}:done`);
      },
      commands: {
        run: {
          parse: () => ({}),
          run: async () => {
            events.push('run');
            throw new Error('command failed');
          },
        },
      },
    };
    const running = runBenchExecutable(
      ['--suite', 'featurebench', 'run'],
      { get: () => adapter } as unknown as SuiteRegistry,
      {
        stdout: { write: () => true },
        stderr: { write: () => true },
        paths: { benchRoot: '/bench', cacheRoot: '/bench/.cache', resultsRoot: '/bench/results' },
        clock: { now: () => new Date(0), monotonicMs: () => 0 },
      } as unknown as CommandContext,
      {
        cleanupActiveProcesses: async () => {
          activeCleanupCount += 1;
          const pass = activeCleanupCount;
          events.push(`active:${pass}:start`);
          if (pass === 1) {
            firstActiveCleanupStarted();
            await firstActiveCleanup;
          }
          events.push(`active:${pass}:done`);
        },
        signalCleanupTimeoutMs: 1_000,
        resendSignal: (signal) => { events.push(`resend:${signal}`); },
      },
    );

    await Promise.all([suiteStarted, activeCleanupStarted]);
    releaseFirstSuite();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    releaseFirstActiveCleanup();
    await running;

    expect(suiteCleanupCount).toBe(2);
    expect(activeCleanupCount).toBe(2);
    expect(events).toEqual([
      'run',
      'suite:1:start',
      'active:1:start',
      'suite:1:done',
      'active:1:done',
      'active:2:start',
      'active:2:done',
      'suite:2:start',
      'suite:2:done',
      'resend:SIGTERM',
    ]);
  });

  it('re-delivers the first signal after the cleanup deadline when a suite hook never settles', async () => {
    const resent: NodeJS.Signals[] = [];
    let releaseCommand!: () => void;
    const command = new Promise<void>((resolvePromise) => { releaseCommand = resolvePromise; });
    const adapter = {
      cleanup: async () => await new Promise(() => {}),
      commands: {
        run: {
          parse: () => ({}),
          run: async () => {
            setTimeout(() => process.emit('SIGTERM'), 0);
            await command;
          },
        },
      },
    };
    await runBenchExecutable(
      ['--suite', 'featurebench', 'run'],
      { get: () => adapter } as unknown as SuiteRegistry,
      {
        stdout: { write: () => true },
        stderr: { write: () => true },
        paths: { benchRoot: '/bench', cacheRoot: '/bench/.cache', resultsRoot: '/bench/results' },
        clock: { now: () => new Date(0), monotonicMs: () => 0 },
      } as unknown as CommandContext,
      {
        cleanupActiveProcesses: async () => {},
        signalCleanupTimeoutMs: 20,
        resendSignal: (signal) => {
          resent.push(signal);
          releaseCommand();
        },
      },
    );
    expect(resent).toEqual(['SIGTERM']);
  });

  it('makes a repeated signal immediately force re-delivery during cleanup', async () => {
    const resent: NodeJS.Signals[] = [];
    let releaseCommand!: () => void;
    const command = new Promise<void>((resolvePromise) => { releaseCommand = resolvePromise; });
    const adapter = {
      cleanup: async () => await new Promise(() => {}),
      commands: {
        run: {
          parse: () => ({}),
          run: async () => {
            setTimeout(() => {
              process.emit('SIGTERM');
              setTimeout(() => process.emit('SIGINT'), 0);
            }, 0);
            await command;
          },
        },
      },
    };
    await runBenchExecutable(
      ['--suite', 'featurebench', 'run'],
      { get: () => adapter } as unknown as SuiteRegistry,
      {
        stdout: { write: () => true },
        stderr: { write: () => true },
        paths: { benchRoot: '/bench', cacheRoot: '/bench/.cache', resultsRoot: '/bench/results' },
        clock: { now: () => new Date(0), monotonicMs: () => 0 },
      } as unknown as CommandContext,
      {
        cleanupActiveProcesses: async () => {},
        signalCleanupTimeoutMs: 60_000,
        resendSignal: (signal) => {
          resent.push(signal);
          releaseCommand();
        },
      },
    );
    expect(resent).toEqual(['SIGINT']);
  });
});

describe.skipIf(SUBPROCESS_BLOCKED)('benchmark executable boundary', () => {
  it('is import-inert', async () => {
    const cliUrl = pathToFileURL(join(REPO_ROOT, 'bench/src/cli.ts')).href;
    const script = `
      const originalOut = process.stdout.write.bind(process.stdout);
      const originalErr = process.stderr.write.bind(process.stderr);
      let stdout = '';
      let stderr = '';
      process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
      process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
      process.exitCode = 23;
      await import(${JSON.stringify(cliUrl)});
      const observed = { stdout, stderr, exitCode: process.exitCode };
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      process.exitCode = 0;
      originalOut(JSON.stringify(observed));
    `;
    const imported = await invokeNode(['--import', 'tsx', '--input-type=module', '--eval', script]);
    if (imported.error) throw imported.error;
    expect(imported.status).toBe(0);
    expect(imported.stderr).toBe('');
    expect(JSON.parse(imported.stdout)).toEqual({ stdout: '', stderr: '', exitCode: 23 });
  });

  it('renders only the exact root, selected-suite, and command help forms', async () => {
    const root = await invokeCli(['--help']);
    if (root.error) throw root.error;
    expect(root.status).toBe(0);
    expect(root.stderr).toBe('');
    expect(root.stdout).toContain(
      'npm run bench -- --suite <swebench-pro|swe-marathon|featurebench|workflow-authoring>',
    );

    for (const argv of [
      ['--suite', 'swebench-pro', '--help'],
      ['--suite=swebench-pro', 'run', '--help'],
      ['--suite', 'swebench-pro', 'report', '--help'],
      ['--suite', 'workflow-authoring', 'generate', '--help'],
    ]) {
      const selected = await invokeCli(argv);
      if (selected.error) throw selected.error;
      expect(selected.status, argv.join(' ')).toBe(0);
      expect(selected.stderr, argv.join(' ')).toBe('');
      expect(selected.stdout, argv.join(' ')).toContain('Usage: npm run bench -- --suite');
    }
  });

  it.each([
    [[], /--suite is required/],
    [['-h'], /root help is exactly '--help'/],
    [['help'], /root help is exactly '--help'/],
    [['--help', 'run'], /--suite must precede the command/],
    [['run', '--suite', 'swebench-pro'], /--suite must precede the command/],
    [['--suite', 'swebench-pro', 'run', '--suite', 'swebench-pro'], /only once/],
    [['--suite', 'swebench-pro', 'run', '--', '--suite=swebench-pro'], /only once/],
    [['--suite', 'swebench-pro', 'publish'], /not supported for swebench-pro/],
    [['--suite', 'swebench-pro', 'report'], /--run-id is required/],
    [['--suite', 'swebench-pro', 'run', 'help'], /unexpected positional argument 'help'/],
  ] as const)('emits one actionable final bench line for invalid argv %j', async (argv, message) => {
    const result = await invokeCli(argv);
    if (result.error) throw result.error;
    expect(result.status).toBe(1);
    const lines = benchLines(result.stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(message);
    expect(result.stderr.trim().split(/\r?\n/u).at(-1)).toBe(lines[0]);
  });
});
