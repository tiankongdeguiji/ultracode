/** Offline compatibility coverage for the public benchmark dispatcher surface. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  BENCH_USAGE,
  runBenchCli,
} from '../../bench/src/bench-cli.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BENCH_CLI = join(REPO_ROOT, 'bench/src/bench-cli.ts');
const SUBPROCESS_ENV = {
  NO_COLOR: '1',
  PATH: process.env.PATH ?? '',
};
const PRO_COMMANDS = ['fetch', 'prep', 'run', 'eval', 'report', 'status', 'clean'] as const;
const EXTERNAL_COMMANDS = ['prep', 'run', 'report'] as const;
const EXTERNAL_SUITES = ['swe-marathon', 'featurebench'] as const;
const CANONICAL_ROOT_USAGE =
  'npm run bench -- --suite <swebench-pro|swe-marathon|featurebench> <command> [options]';

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function invokeBenchCli(argv: string[]): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', BENCH_CLI, ...argv],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: SUBPROCESS_ENV,
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function stderrLines(result: CliResult): string[] {
  return result.stderr.trim().split('\n').filter(Boolean);
}

function publicCommands(output: string): string[] {
  return output.match(/npm run bench -- [^`'"\n]+/gu) ?? [];
}

function expectOnlySuiteFirstCommands(output: string): void {
  const commands = publicCommands(output);
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) {
    expect(command).toMatch(
      /^npm run bench -- --suite (?:swebench-pro|swe-marathon|featurebench|<[^>]+>)(?:\s|$)/u,
    );
  }
}

type DelegateName = 'pro' | 'external';

interface DelegateCall {
  name: DelegateName;
  argv: string[];
}

function routingHarness(failure?: { name: DelegateName; error: Error }): {
  calls: DelegateCall[];
  run: (argv: string[]) => Promise<void>;
} {
  const calls: DelegateCall[] = [];
  return {
    calls,
    run: (argv) => runBenchCli(argv, {
      runSwebenchProCli: async (delegatedArgv) => {
        calls.push({ name: 'pro', argv: delegatedArgv });
        if (failure?.name === 'pro') throw failure.error;
      },
      runExternalCli: async (delegatedArgv) => {
        calls.push({ name: 'external', argv: delegatedArgv });
        if (failure?.name === 'external') throw failure.error;
      },
    }),
  };
}

describe('unified bench routing', () => {
  it.each(PRO_COMMANDS)('routes suite-first SWE-bench Pro %s commands', async (command) => {
    const harness = routingHarness();
    await harness.run(['--suite', 'swebench-pro', command, '--probe=value']);
    expect(harness.calls).toEqual([{
      name: 'pro',
      argv: [command, '--probe=value'],
    }]);
  });

  it.each(EXTERNAL_SUITES.flatMap((suite) => (
    EXTERNAL_COMMANDS.map((command) => [suite, command] as const)
  )))('routes suite-first %s %s commands', async (suite, command) => {
    const harness = routingHarness();
    await harness.run(['--suite', suite, command, '--probe=value']);
    expect(harness.calls).toEqual([{
      name: 'external',
      argv: [command, '--suite', suite, '--probe=value'],
    }]);
  });

  it('preserves every Pro run flag byte-for-byte after stripping the canonical selector', async () => {
    const argv = [
      'run',
      '--run-id', 'legacy-1',
      '--model', 'gpt-test',
      '--effort', 'xhigh',
      '--arms', 'both',
      '--count', '20',
      '--seed', '7',
      '--ids', 'one,two',
      '--parallel', '4',
      '--timeout-secs', '3600',
      '--auth', 'api-key',
      '--resume',
      '--redo', 'one,two',
      '--unrelated=value',
    ];
    const harness = routingHarness();
    await harness.run(['--suite', 'swebench-pro', ...argv]);
    expect(harness.calls).toEqual([{ name: 'pro', argv }]);
  });

  it.each([
    ['eval', '--run-id', 'legacy-1', '--gold'],
    ['eval', '--run-id', 'legacy-1', '--null'],
  ])('preserves Pro eval argv: %j', async (...argv) => {
    const harness = routingHarness();
    await harness.run(['--suite', 'swebench-pro', ...argv]);
    expect(harness.calls).toEqual([{ name: 'pro', argv }]);
  });

  it.each(PRO_COMMANDS)('accepts a split Pro selector after the %s command', async (command) => {
    const harness = routingHarness();
    await harness.run([command, '--probe=value', '--suite', 'swebench-pro']);
    expect(harness.calls).toEqual([{
      name: 'pro',
      argv: [command, '--probe=value'],
    }]);
  });

  it.each(EXTERNAL_SUITES.flatMap((suite) => (
    EXTERNAL_COMMANDS.map((command) => [suite, command] as const)
  )))('accepts a split %s selector after the %s command', async (suite, command) => {
    const harness = routingHarness();
    await harness.run([command, '--probe=value', '--suite', suite]);
    expect(harness.calls).toEqual([{
      name: 'external',
      argv: [command, '--suite', suite, '--probe=value'],
    }]);
  });

  it.each([
    ['swebench-pro', 'status', 'pro'],
    ['swe-marathon', 'run', 'external'],
    ['featurebench', 'report', 'external'],
  ] as const)('accepts --suite=%s before the command', async (suite, command, name) => {
    const harness = routingHarness();
    await harness.run([`--suite=${suite}`, command, '--probe=value']);
    expect(harness.calls).toEqual([{
      name,
      argv: name === 'pro'
        ? [command, '--probe=value']
        : [command, '--suite', suite, '--probe=value'],
    }]);
  });

  it.each([
    ['swebench-pro', 'report', 'pro'],
    ['swe-marathon', 'prep', 'external'],
    ['featurebench', 'run', 'external'],
  ] as const)('accepts --suite=%s after the command', async (suite, command, name) => {
    const harness = routingHarness();
    await harness.run([command, '--probe=value', `--suite=${suite}`]);
    expect(harness.calls).toEqual([{
      name,
      argv: name === 'pro'
        ? [command, '--probe=value']
        : [command, '--suite', suite, '--probe=value'],
    }]);
  });

  it.each([
    [
      ['--suite=featurebench', 'run', '--run-id', 'feature-1', '--task-id', 'first'],
      ['run', '--suite', 'featurebench', '--run-id', 'feature-1', '--task-id', 'first'],
    ],
    [
      [
        'run', '--task-id', 'first', '--suite', 'swe-marathon', '--task-id', 'second',
        '--task-ids', 'third,fourth', '--unrelated=value',
      ],
      [
        'run', '--suite', 'swe-marathon', '--task-id', 'first', '--task-id', 'second',
        '--task-ids', 'third,fourth', '--unrelated=value',
      ],
    ],
  ] as const)('normalizes external selectors and preserves every other token: %j', async (argv, expected) => {
    const harness = routingHarness();
    await harness.run([...argv]);
    expect(harness.calls).toEqual([{ name: 'external', argv: [...expected] }]);
  });

  it.each(PRO_COMMANDS)(
    'rejects selector-less %s before resolving a delegate',
    async (command) => {
      const harness = routingHarness();
      await expect(harness.run([command, '--probe=value'])).rejects.toThrow(
        /--suite.*required|required.*--suite/i,
      );
      expect(harness.calls).toEqual([]);
    },
  );

  it('does not inspect delegate properties for a selector-less lifecycle command', async () => {
    let delegateResolved = false;
    const delegates = {};
    Object.defineProperties(delegates, {
      runSwebenchProCli: {
        get: () => {
          delegateResolved = true;
          throw new Error('Pro delegate resolved');
        },
      },
      runExternalCli: {
        get: () => {
          delegateResolved = true;
          throw new Error('external delegate resolved');
        },
      },
    });

    await expect(runBenchCli(['run'], delegates)).rejects.toThrow(
      /--suite.*required|required.*--suite/i,
    );
    expect(delegateResolved).toBe(false);
  });

  it.each([
    ['run', '--help'],
    ['--help', 'run'],
    ['-h', 'run'],
    ['help', 'run'],
  ])('rejects non-bare selector-less help before dispatch: %j', async (...argv) => {
    const harness = routingHarness();
    await expect(harness.run(argv)).rejects.toThrow(/--suite.*required|required.*--suite/i);
    expect(harness.calls).toEqual([]);
  });

  it.each([
    [['run', '--suite'], /suite.*requires a value/i],
    [['run', '--suite='], /suite.*requires a value/i],
    [['run', '--suite', '--help'], /suite.*requires a value/i],
    [['--suite'], /suite.*requires a value/i],
    [['--suite='], /suite.*requires a value/i],
    [['--help', '--suite', 'unknown'], /suite.*unknown/i],
    [['--suite=unknown', 'run'], /suite.*unknown/i],
    [['run', '--suite=unknown'], /suite.*unknown/i],
    [['run', '--suite', 'swebench-pro', '--suite', 'swebench-pro'], /suite.*only once|duplicate/i],
    [['run', '--suite=featurebench', '--suite', 'swe-marathon'], /suite.*only once|duplicate/i],
    [['--suite=swebench-pro', 'run', '--suite=featurebench'], /suite.*only once|duplicate/i],
  ] as const)('rejects invalid selectors before help or dispatch: %j', async (argv, error) => {
    const harness = routingHarness();
    await expect(harness.run([...argv])).rejects.toThrow(error);
    expect(harness.calls).toEqual([]);
  });

  it('does not treat a selector after the option terminator as explicit selection', async () => {
    const harness = routingHarness();
    await expect(harness.run(['run', '--', '--suite', 'featurebench'])).rejects.toThrow(
      /--suite.*required|required.*--suite/i,
    );
    expect(harness.calls).toEqual([]);
  });

  it('preserves selector-shaped payload after the option terminator', async () => {
    const pro = routingHarness();
    await pro.run([
      '--suite', 'swebench-pro', 'run', '--', '--suite', 'featurebench', '--flag=value',
    ]);
    expect(pro.calls).toEqual([{
      name: 'pro',
      argv: ['run', '--', '--suite', 'featurebench', '--flag=value'],
    }]);

    const external = routingHarness();
    await external.run([
      '--suite', 'featurebench', 'run', '--', '--suite=swebench-pro', '--flag=value',
    ]);
    expect(external.calls).toEqual([{
      name: 'external',
      argv: ['run', '--suite', 'featurebench', '--', '--suite=swebench-pro', '--flag=value'],
    }]);
  });

  it.each(EXTERNAL_SUITES)(
    'rejects unsupported lifecycle commands for %s before dispatch',
    async (suite) => {
      for (const command of ['fetch', 'eval', 'status', 'clean']) {
        const harness = routingHarness();
        await expect(harness.run(['--suite', suite, command])).rejects.toThrow(/command/i);
        expect(harness.calls).toEqual([]);
      }
    },
  );

  it('does not infer a suite from run ids or paths', async () => {
    const argv = ['report', '--run-id', 'results/external/featurebench/same'];
    const harness = routingHarness();
    await expect(harness.run(argv)).rejects.toThrow(/--suite.*required|required.*--suite/i);
    expect(harness.calls).toEqual([]);
  });

  it.each([
    [
      ['--suite', 'swebench-pro', '--help'],
      { name: 'pro', argv: ['--help'] },
    ],
    [
      ['--suite=swe-marathon', '--help'],
      { name: 'external', argv: ['--help', '--suite', 'swe-marathon'] },
    ],
    [
      ['run', '--help', '--suite=featurebench'],
      { name: 'external', argv: ['run', '--suite', 'featurebench', '--help'] },
    ],
  ] as const)('delegates explicit-suite and command help: %j', async (argv, expected) => {
    const harness = routingHarness();
    await harness.run([...argv]);
    expect(harness.calls).toEqual([{
      name: expected.name,
      argv: [...expected.argv],
    }]);
  });

  it.each(['pro', 'external'] as const)('never retries after a %s delegate failure', async (name) => {
    const expected = new Error(`${name} parser failed`);
    const harness = routingHarness({ name, error: expected });
    const argv = name === 'pro'
      ? ['--suite', 'swebench-pro', 'report', '--run-id', 'same']
      : ['--suite', 'featurebench', 'report', '--run-id', 'same'];
    await expect(harness.run(argv)).rejects.toBe(expected);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.name).toBe(name);
  });

  it('handles bare root help without importing either delegate', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      for (const argv of [['--help'], ['-h'], ['help']]) {
        const harness = routingHarness();
        await harness.run(argv);
        expect(harness.calls).toEqual([]);
      }
      const output = stdout.mock.calls.flat().join('');
      expect(output).toContain(CANONICAL_ROOT_USAGE);
      expect(output).not.toMatch(/\bdefault\b/iu);
      expectOnlySuiteFirstCommands(output);
    } finally {
      stdout.mockRestore();
    }
  });

  it.each([
    [['--suite', 'swebench-pro', '--help'], 'swebench-pro'],
    [['--suite', 'swebench-pro', 'run', '--help'], 'swebench-pro'],
    [['--suite=swe-marathon', '--help'], '<swe-marathon|featurebench>'],
    [['prep', '--help', '--suite=featurebench'], '<swe-marathon|featurebench>'],
  ] as const)('renders selected help with suite-first public commands: %j', async (argv, selector) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runBenchCli([...argv]);
      const output = stdout.mock.calls.flat().join('');
      expect(output).toContain('Usage:');
      expect(output).toContain(`npm run bench -- --suite ${selector}`);
      expectOnlySuiteFirstCommands(output);
    } finally {
      stdout.mockRestore();
    }
  });

  it('requires a command after an explicit selector without resolving a delegate', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const harness = routingHarness();
    try {
      await expect(harness.run(['--suite', 'swebench-pro'])).rejects.toThrow(/command.*required/i);
      expect(harness.calls).toEqual([]);
      expect(stdout.mock.calls.flat().join('')).toContain(CANONICAL_ROOT_USAGE);
    } finally {
      stdout.mockRestore();
    }
  });
});

describe('unified bench executable compatibility', () => {
  it('exposes one package script without a legacy external alias', () => {
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.bench).toBe('tsx bench/src/bench-cli.ts');
    expect(Object.keys(packageJson.scripts).filter((name) => name.startsWith('bench')).sort()).toEqual([
      'bench',
      'bench:check',
    ]);
  });

  it('imports the dispatcher and both subdrivers without output or exit-state changes', () => {
    const moduleUrls = [
      'bench/src/bench-cli.ts',
      'bench/src/cli.ts',
      'bench/src/external-cli.ts',
    ].map((path) => pathToFileURL(join(REPO_ROOT, path)).href);
    const script = `
      const originalOut = process.stdout.write.bind(process.stdout);
      const originalErr = process.stderr.write.bind(process.stderr);
      let stdout = '';
      let stderr = '';
      process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
      process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
      process.exitCode = 23;
      for (const url of ${JSON.stringify(moduleUrls)}) await import(url);
      const observed = { stdout, stderr, exitCode: process.exitCode };
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      process.exitCode = 0;
      originalOut(JSON.stringify(observed));
    `;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: SUBPROCESS_ENV,
      },
    );
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ stdout: '', stderr: '', exitCode: 23 });
  });

  it.each([['--help'], ['-h'], ['help']])('shows unified root help for %s', (flag) => {
    const result = invokeBenchCli([flag]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(CANONICAL_ROOT_USAGE);
    expect(result.stdout).not.toMatch(/\bdefault\b/iu);
    expect(result.stdout).toContain('swebench-pro');
    expect(result.stdout).toContain('swe-marathon');
    expect(result.stdout).toContain('featurebench');
    expect(result.stdout).toContain('bench/results/<runId>/run.json');
    expect(result.stdout).toContain('bench/results/external/<suite>/<runId>/external-run.json');
    expect(result.stdout).toContain('npm run bench -- --suite swe-marathon prep');
    expect(result.stdout).toContain('npm run bench -- --suite featurebench report');
    expectOnlySuiteFirstCommands(result.stdout);
  });

  it.each([
    [['--suite', 'swebench-pro', '--help'], 'swebench-pro'],
    [['--suite', 'swebench-pro', 'run', '--help'], 'swebench-pro'],
    [['--suite=swe-marathon', '--help'], '<swe-marathon|featurebench>'],
    [['--suite', 'featurebench', 'prep', '--help'], '<swe-marathon|featurebench>'],
    [['report', '--help', '--suite=featurebench'], '<swe-marathon|featurebench>'],
  ] as const)('shows suite-first selected and command help: %j', (argv, selector) => {
    const result = invokeBenchCli(argv);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain(`npm run bench -- --suite ${selector}`);
    expectOnlySuiteFirstCommands(result.stdout);
  });

  it('prints root usage and one concise suite error when no arguments are provided', () => {
    const result = invokeBenchCli([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Usage:');
    expect(stderrLines(result)).toEqual([expect.stringMatching(/^bench: .*--suite.*required/i)]);
  });

  it.each([
    [['--help', '--suite', 'unknown'], /suite.*unknown/i],
    [['run', '--run-id'], /--suite.*required|required.*--suite/i],
    [['run', '--suite'], /suite.*requires a value/i],
    [['--suite=unknown', 'run'], /suite.*unknown/i],
    [['--suite', 'swebench-pro', 'run', '--run-id'], /option.*run-id.*argument/i],
    [['--suite', 'featurebench', 'report'], /run-id is required/i],
  ] as const)('reports selector and parser failures exactly once: %j', (argv, message) => {
    const result = invokeBenchCli([...argv]);
    expect(result.status).toBe(1);
    expect(stderrLines(result)).toHaveLength(1);
    expect(stderrLines(result)[0]).toMatch(/^bench: /);
    expect(stderrLines(result)[0]).toMatch(message);
  });

  it('keeps generated benchmark guidance suite-first and suite-specific', () => {
    const expectations: Array<[string, string[]]> = [
      ['bench/src/cli.ts', [
        'npm run bench -- --suite swebench-pro fetch',
        'npm run bench -- --suite swebench-pro eval',
        'npm run bench -- --suite swebench-pro report',
      ]],
      ['bench/src/instances.ts', ['npm run bench -- --suite swebench-pro fetch']],
      ['bench/src/image.ts', ['npm run bench -- --suite swebench-pro prep']],
      ['bench/src/eval.ts', ['npm run bench -- --suite swebench-pro prep']],
      ['bench/src/toolchain.ts', ['npm run bench -- --suite swebench-pro prep']],
      ['bench/src/report.ts', ['npm run bench -- --suite swebench-pro run']],
      ['bench/src/marathon.ts', ['npm run bench -- --suite swe-marathon prep']],
      ['bench/src/featurebench.ts', ['npm run bench -- --suite featurebench prep']],
    ];

    for (const [path, commands] of expectations) {
      const source = readFileSync(join(REPO_ROOT, path), 'utf8');
      for (const command of commands) expect(source).toContain(command);
      expectOnlySuiteFirstCommands(source);
    }
  });

  it('exports root usage with only the canonical public grammar', () => {
    expect(BENCH_USAGE).toContain(CANONICAL_ROOT_USAGE);
    expect(BENCH_USAGE).not.toMatch(/\bdefault\b/iu);
    expectOnlySuiteFirstCommands(BENCH_USAGE);
  });
});
