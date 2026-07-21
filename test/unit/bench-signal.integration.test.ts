/** Real-signal coverage for the benchmark executable cleanup boundary. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SUBPROCESS_ENV = { NO_COLOR: '1', PATH: process.env.PATH ?? '' };
const subprocessProbe = spawnSync(process.execPath, ['--version'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  env: SUBPROCESS_ENV,
});
const SUBPROCESS_BLOCKED = (subprocessProbe.error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
const tempDirectories: string[] = [];

interface SignalCase {
  suite: 'featurebench' | 'swe-marathon' | 'swebench-pro';
  signal: 'SIGINT' | 'SIGTERM';
  delayMs?: number;
  repeatSignal?: 'SIGINT' | 'SIGTERM';
  failActiveCleanup?: boolean;
  failSuiteCleanup?: boolean;
}

interface SignalResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  events: string[];
  activePid: number;
  suitePid: number;
  stderr: string;
}

interface DeadlineSignalResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
}

interface DispatchCleanupSignalResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  events: string[];
  stderr: string;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function killDetached(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function fixtureSource(): string {
  const cliUrl = pathToFileURL(join(REPO_ROOT, 'bench/src/cli.ts')).href;
  const processUrl = pathToFileURL(join(REPO_ROOT, 'bench/src/shared/process.ts')).href;
  return `
    import { spawn } from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    import { runBenchExecutable } from ${JSON.stringify(cliUrl)};
    import { cleanupActiveBenchProcesses, runBenchProcess } from ${JSON.stringify(processUrl)};

    const suite = process.env.TEST_SUITE;
    const eventsPath = process.env.TEST_EVENTS_PATH;
    const delayMs = Number(process.env.TEST_DELAY_MS ?? '0');
    const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
    const event = (value) => appendFileSync(eventsPath, value + '\\n');
    const stop = async (child) => {
      if (child.pid === undefined) return;
      const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await Promise.race([exited, pause(1_000)]);
    };
    let suiteResource;
    const adapter = {
      cleanup: async () => {
        event('suite:start');
        await pause(delayMs);
        await stop(suiteResource);
        if (process.env.TEST_FAIL_SUITE === '1') {
          event('suite:failed');
          throw new Error('injected suite cleanup failure');
        }
        event('suite:done');
      },
      commands: {
        run: {
          parse: () => ({}),
          run: async () => {
            suiteResource = spawn(process.execPath, [
              '--input-type=module', '--eval', 'setInterval(() => {}, 60_000)',
            ], { detached: true, stdio: 'ignore' });
            suiteResource.unref();
            await runBenchProcess(process.execPath, [
              '--input-type=module', '--eval', 'setInterval(() => {}, 60_000)',
            ], {
              cwd: process.cwd(),
              terminationGraceMs: 20,
              processInspection: {
                discoverWorkerProcesses: () => ({ processes: [], complete: true }),
              },
              onLifecycleStarted: (_token, activePid) => {
                process.stdout.write(JSON.stringify({
                  ready: true,
                  activePid,
                  suitePid: suiteResource.pid,
                }) + '\\n');
              },
            });
          },
        },
      },
    };
    const registry = { get: (selected) => {
      if (selected !== suite) throw new Error('unexpected suite ' + selected);
      return adapter;
    } };
    const cleanupActiveProcesses = process.env.TEST_FAIL_ACTIVE === '1'
      ? async () => { event('active:failed'); throw new Error('injected active cleanup failure'); }
      : async () => { event('active:start'); await cleanupActiveBenchProcesses(40); event('active:done'); };
    await runBenchExecutable(
      ['--suite', suite, 'run'],
      registry,
      {
        stdout: process.stdout,
        stderr: process.stderr,
        paths: { benchRoot: process.cwd(), cacheRoot: process.cwd(), resultsRoot: process.cwd() },
        clock: { now: () => new Date(), monotonicMs: () => performance.now() },
      },
      { cleanupActiveProcesses },
    );
  `;
}

async function waitForReady(child: ChildProcess): Promise<{
  activePid: number;
  suitePid: number;
  stderr: () => string;
}> {
  let stdout = '';
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
  return await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`benchmark fixture did not become ready: ${stderr}`)), 5_000);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/u).find((candidate) => candidate.startsWith('{'));
      if (line === undefined) return;
      const parsed = JSON.parse(line) as { ready: boolean; activePid: number; suitePid: number };
      clearTimeout(timer);
      resolvePromise({ activePid: parsed.activePid, suitePid: parsed.suitePid, stderr: () => stderr });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`benchmark fixture exited before ready: ${String(code)}/${String(signal)} ${stderr}`));
    });
  });
}

async function runSignalCase(options: SignalCase): Promise<SignalResult> {
  const directory = mkdtempSync(join(tmpdir(), 'uc-bench-signal-'));
  tempDirectories.push(directory);
  const fixture = join(directory, 'fixture.mjs');
  const eventsPath = join(directory, 'events.log');
  writeFileSync(fixture, fixtureSource());
  writeFileSync(eventsPath, '');
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
    cwd: REPO_ROOT,
    env: {
      ...SUBPROCESS_ENV,
      TEST_SUITE: options.suite,
      TEST_EVENTS_PATH: eventsPath,
      TEST_DELAY_MS: String(options.delayMs ?? 0),
      TEST_FAIL_ACTIVE: options.failActiveCleanup ? '1' : '0',
      TEST_FAIL_SUITE: options.failSuiteCleanup ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = await waitForReady(child);
  const startedAt = Date.now();
  child.kill(options.signal);
  if (options.repeatSignal !== undefined) {
    setTimeout(() => child.kill(options.repeatSignal!), 20);
  }
  let result: SignalResult;
  try {
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`benchmark fixture did not exit: ${ready.stderr()}`));
      }, 7_000);
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal });
      });
    });
    await Promise.all([waitUntilGone(ready.activePid), waitUntilGone(ready.suitePid)]);
    result = {
      ...closed,
      elapsedMs: Date.now() - startedAt,
      events: readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean),
      activePid: ready.activePid,
      suitePid: ready.suitePid,
      stderr: ready.stderr(),
    };
  } finally {
    if (processExists(ready.activePid)) killDetached(ready.activePid);
    if (processExists(ready.suitePid)) killDetached(ready.suitePid);
  }
  return result;
}

function runDeadlineSignalCase(signal: 'SIGINT' | 'SIGTERM'): DeadlineSignalResult {
  const cliUrl = pathToFileURL(join(REPO_ROOT, 'bench/src/cli.ts')).href;
  const script = `
    import { runBenchExecutable } from ${JSON.stringify(cliUrl)};

    const keepAlive = setInterval(() => {}, 60_000);
    const pending = new Promise(() => {});
    const command = {
      parse: () => ({}),
      run: async () => {
        setImmediate(() => process.kill(process.pid, ${JSON.stringify(signal)}));
        await pending;
      },
    };
    const registry = { get: () => ({ commands: { run: command } }) };
    void runBenchExecutable(
      ['--suite', 'featurebench', 'run'],
      registry,
      undefined,
      {
        cleanupActiveProcesses: async () => {
          clearInterval(keepAlive);
          await pending;
        },
        signalCleanupTimeoutMs: 150,
      },
    );
  `;
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: SUBPROCESS_ENV,
    timeout: 5_000,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  return {
    code: result.status,
    signal: result.signal,
    elapsedMs: Date.now() - startedAt,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runDispatchCleanupSignalCase(signal: 'SIGINT' | 'SIGTERM'): DispatchCleanupSignalResult {
  const cliUrl = pathToFileURL(join(REPO_ROOT, 'bench/src/cli.ts')).href;
  const script = `
    import { writeSync } from 'node:fs';
    import { runBenchExecutable } from ${JSON.stringify(cliUrl)};

    const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
    const event = (value) => writeSync(1, value + '\\n');
    let activeCleanupCount = 0;
    let suiteCleanupCount = 0;
    const adapter = {
      cleanup: async () => {
        suiteCleanupCount += 1;
        const pass = suiteCleanupCount;
        event('suite:' + pass + ':start');
        if (pass === 1) {
          setImmediate(() => process.kill(process.pid, ${JSON.stringify(signal)}));
          await pause(40);
        }
        event('suite:' + pass + ':done');
      },
      commands: {
        run: {
          parse: () => ({}),
          run: async () => {
            event('run:failed');
            throw new Error('injected command failure');
          },
        },
      },
    };
    const cleanupActiveProcesses = async () => {
      activeCleanupCount += 1;
      const pass = activeCleanupCount;
      event('active:' + pass + ':start');
      if (pass === 1) await pause(150);
      event('active:' + pass + ':done');
    };
    void runBenchExecutable(
      ['--suite', 'featurebench', 'run'],
      { get: () => adapter },
      undefined,
      { cleanupActiveProcesses, signalCleanupTimeoutMs: 1_000 },
    );
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: SUBPROCESS_ENV,
    timeout: 5_000,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  return {
    code: result.status,
    signal: result.signal,
    events: result.stdout.trim().split(/\r?\n/u).filter(Boolean),
    stderr: result.stderr,
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(SUBPROCESS_BLOCKED)('benchmark signal coordinator', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('keeps the fatal cleanup deadline alive before re-sending %s', (signal, status) => {
    const result = runDeadlineSignalCase(signal);
    expect(result.code).toBeNull();
    expect(result.signal).toBe(signal);
    const observedStatus = result.code ?? 128 + osConstants.signals[result.signal!];
    expect(observedStatus).toBe(status);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('adopts dispatch-owned cleanup before re-sending %s', (signal, status) => {
    const result = runDispatchCleanupSignalCase(signal);
    expect(result.code).toBeNull();
    expect(result.signal).toBe(signal);
    const observedStatus = result.code ?? 128 + osConstants.signals[result.signal!];
    expect(observedStatus).toBe(status);
    expect(result.events).toEqual([
      'run:failed',
      'suite:1:start',
      'active:1:start',
      'suite:1:done',
      'active:1:done',
      'active:2:start',
      'active:2:done',
      'suite:2:start',
      'suite:2:done',
    ]);
    expect(result.stderr).toBe('');
  });

  it.each([
    ['featurebench', 'SIGINT', 130],
    ['swe-marathon', 'SIGTERM', 143],
    ['swebench-pro', 'SIGTERM', 143],
  ] as const)('drains %s registered resources twice before re-sending %s', async (suite, signal, status) => {
    const result = await runSignalCase({
      suite,
      signal,
      delayMs: suite === 'featurebench' ? 150 : 0,
    });
    expect(result.code).toBeNull();
    expect(result.signal).toBe(signal);
    const observedStatus = result.code ?? 128 + osConstants.signals[result.signal!];
    expect(observedStatus).toBe(status);
    expect(result.events.filter((event) => event === 'active:start')).toHaveLength(2);
    expect(result.events.filter((event) => event === 'active:done')).toHaveLength(2);
    expect(result.events.filter((event) => event === 'suite:start')).toHaveLength(2);
    expect(result.events.filter((event) => event === 'suite:done')).toHaveLength(2);
    expect(processExists(result.activePid)).toBe(false);
    expect(processExists(result.suitePid)).toBe(false);
    expect(result.stderr).toBe('');
    if (suite === 'featurebench') expect(result.elapsedMs).toBeGreaterThanOrEqual(120);
  });

  it('still settles active processes when selected-suite cleanup rejects', async () => {
    const result = await runSignalCase({
      suite: 'swebench-pro',
      signal: 'SIGTERM',
      failSuiteCleanup: true,
    });
    expect(result.signal).toBe('SIGTERM');
    expect(result.events.filter((event) => event === 'active:start')).toHaveLength(2);
    expect(result.events.filter((event) => event === 'active:done')).toHaveLength(2);
    expect(result.events.filter((event) => event === 'suite:start')).toHaveLength(2);
    expect(result.events.filter((event) => event === 'suite:failed')).toHaveLength(2);
    expect(processExists(result.activePid)).toBe(false);
    expect(processExists(result.suitePid)).toBe(false);
  });

  it('still settles selected-suite resources when active-process cleanup rejects', async () => {
    const result = await runSignalCase({
      suite: 'swe-marathon',
      signal: 'SIGINT',
      failActiveCleanup: true,
    });
    expect(result.signal).toBe('SIGINT');
    expect(result.events).toEqual([
      'active:failed', 'suite:start', 'suite:done',
      'active:failed', 'suite:start', 'suite:done',
    ]);
    expect(processExists(result.suitePid)).toBe(false);
  });

  it('removes both signal listeners after normal command settlement', async () => {
    const cliUrl = pathToFileURL(join(REPO_ROOT, 'bench/src/cli.ts')).href;
    const script = `
      import { runBenchExecutable } from ${JSON.stringify(cliUrl)};
      const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
      const command = { parse: () => ({}), run: async () => {} };
      const registry = { get: () => ({ commands: { run: command } }) };
      await runBenchExecutable(['--suite', 'featurebench', 'run'], registry);
      process.stdout.write(JSON.stringify({
        before,
        after: { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') },
      }));
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: SUBPROCESS_ENV,
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const counts = JSON.parse(result.stdout) as {
      before: { int: number; term: number };
      after: { int: number; term: number };
    };
    expect(counts.after).toEqual(counts.before);
  });
});
