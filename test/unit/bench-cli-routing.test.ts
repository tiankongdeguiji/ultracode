/** Offline compatibility coverage for the public benchmark dispatcher surface. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runBenchCli } from '../../bench/src/bench-cli.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BENCH_CLI = join(REPO_ROOT, 'bench/src/bench-cli.ts');
const SUBPROCESS_ENV = {
  NO_COLOR: '1',
  PATH: process.env.PATH ?? '',
};

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
  it('preserves every legacy Pro run flag byte-for-byte when the selector is omitted', async () => {
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
    await harness.run(argv);
    expect(harness.calls).toEqual([{ name: 'pro', argv }]);
  });

  it.each([
    ['eval', '--run-id', 'legacy-1', '--gold'],
    ['eval', '--run-id', 'legacy-1', '--null'],
  ])('preserves Pro eval argv: %j', async (...argv) => {
    const harness = routingHarness();
    await harness.run(argv);
    expect(harness.calls).toEqual([{ name: 'pro', argv }]);
  });

  it.each([
    [
      ['--suite', 'swebench-pro', 'status', '--run-id', 'same'],
      ['status', '--run-id', 'same'],
    ],
    [
      ['report', '--run-id', 'same', '--suite=swebench-pro'],
      ['report', '--run-id', 'same'],
    ],
  ] as const)('strips either explicit Pro selector syntax: %j', async (argv, expected) => {
    const harness = routingHarness();
    await harness.run([...argv]);
    expect(harness.calls).toEqual([{ name: 'pro', argv: [...expected] }]);
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

  it.each([
    [['run', '--suite'], /suite.*requires a value/i],
    [['run', '--suite='], /suite.*requires a value/i],
    [['run', '--suite', '--help'], /suite.*requires a value/i],
    [['--help', '--suite', 'unknown'], /suite.*unknown/i],
    [['run', '--suite', 'swebench-pro', '--suite', 'swebench-pro'], /suite.*only once|duplicate/i],
    [['run', '--suite=featurebench', '--suite', 'swe-marathon'], /suite.*only once|duplicate/i],
  ] as const)('rejects invalid selectors before help or dispatch: %j', async (argv, error) => {
    const harness = routingHarness();
    await expect(harness.run([...argv])).rejects.toThrow(error);
    expect(harness.calls).toEqual([]);
  });

  it('stops recognizing selectors after a literal option terminator', async () => {
    const pro = routingHarness();
    await pro.run(['run', '--', '--suite', 'featurebench']);
    expect(pro.calls).toEqual([{
      name: 'pro',
      argv: ['run', '--', '--suite', 'featurebench'],
    }]);

    const external = routingHarness();
    await external.run([
      'run', '--suite', 'featurebench', '--', '--suite=swebench-pro', '--flag=value',
    ]);
    expect(external.calls).toEqual([{
      name: 'external',
      argv: ['run', '--suite', 'featurebench', '--', '--suite=swebench-pro', '--flag=value'],
    }]);
  });

  it.each(['fetch', 'prep', 'run', 'eval', 'report', 'status', 'clean'])(
    'routes the Pro %s command',
    async (command) => {
      const harness = routingHarness();
      await harness.run([command]);
      expect(harness.calls).toEqual([{ name: 'pro', argv: [command] }]);
    },
  );

  it.each(['swe-marathon', 'featurebench'] as const)(
    'routes only prep, run, and report for %s',
    async (suite) => {
      for (const command of ['prep', 'run', 'report']) {
        const harness = routingHarness();
        await harness.run([command, '--suite', suite]);
        expect(harness.calls).toEqual([{
          name: 'external',
          argv: [command, '--suite', suite],
        }]);
      }
      for (const command of ['fetch', 'eval', 'status', 'clean']) {
        const harness = routingHarness();
        await expect(harness.run([command, '--suite', suite])).rejects.toThrow(/command/i);
        expect(harness.calls).toEqual([]);
      }
    },
  );

  it('does not infer a suite from run ids or paths', async () => {
    const argv = ['report', '--run-id', 'results/external/featurebench/same'];
    const harness = routingHarness();
    await harness.run(argv);
    expect(harness.calls).toEqual([{ name: 'pro', argv }]);
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
      ['run', '--help', '--suite', 'featurebench'],
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
      ? ['report', '--run-id', 'same']
      : ['report', '--suite', 'featurebench', '--run-id', 'same'];
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
      expect(stdout.mock.calls.flat().join('')).toContain('swebench-pro');
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
    expect(result.stdout).toContain('swebench-pro');
    expect(result.stdout).toContain('default');
    expect(result.stdout).toContain('swe-marathon');
    expect(result.stdout).toContain('featurebench');
    expect(result.stdout).toContain('bench/results/<runId>/run.json');
    expect(result.stdout).toContain('bench/results/external/<suite>/<runId>/external-run.json');
    expect(result.stdout).toContain('npm run bench -- prep --suite swe-marathon');
    expect(result.stdout).toContain('npm run bench -- report --suite featurebench');
  });

  it.each([
    ['--suite', 'swebench-pro', '--help'],
    ['--suite=swe-marathon', '--help'],
    ['prep', '--help', '--suite', 'featurebench'],
  ])('delegates selected and command help: %j', (...argv) => {
    const result = invokeBenchCli(argv);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage:');
  });

  it('prints root usage and one concise error when no command is provided', () => {
    const result = invokeBenchCli([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Usage:');
    expect(stderrLines(result)).toEqual([expect.stringMatching(/^bench: .*command/i)]);
  });

  it.each([
    [['--help', '--suite', 'unknown'], /suite.*unknown/i],
    [['run', '--run-id'], /option.*run-id.*argument/i],
    [['report', '--suite', 'featurebench'], /run-id is required/i],
  ] as const)('reports selector and parser failures exactly once: %j', (argv, message) => {
    const result = invokeBenchCli([...argv]);
    expect(result.status).toBe(1);
    expect(stderrLines(result)).toHaveLength(1);
    expect(stderrLines(result)[0]).toMatch(/^bench: /);
    expect(stderrLines(result)[0]).toMatch(message);
  });
});
