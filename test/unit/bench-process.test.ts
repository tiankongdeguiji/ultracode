/** Benchmark process environment, diagnostics, and bounded-output behavior. */
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  BenchProcessError,
  allowlistedEnvironment,
  cleanupActiveBenchProcesses,
  runBenchProcess,
  sanitizeDiagnostic,
} from '../../bench/src/shared/process.js';

class GatedSink extends Writable {
  readonly chunks: Buffer[] = [];
  private blockedCallback: ((error?: Error | null) => void) | undefined;
  private open = false;

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    if (this.open) callback();
    else this.blockedCallback = callback;
  }

  get blocked(): boolean {
    return this.blockedCallback !== undefined;
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  release(): void {
    this.open = true;
    const callback = this.blockedCallback;
    this.blockedCallback = undefined;
    callback?.();
  }
}

class EmittingErrorSink extends Writable {
  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.emit('error', new Error('destination exploded'));
    callback();
  }
}

const PIPE_TARGET_EVENTS = ['close', 'drain', 'error', 'finish', 'unpipe'] as const;

function targetListeners(stream: Writable): number[] {
  return PIPE_TARGET_EVENTS.map((event) => stream.listenerCount(event));
}

async function waitForBlocked(...sinks: GatedSink[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!sinks.every((sink) => sink.blocked)) {
    if (Date.now() >= deadline) throw new Error('forwarding sink did not receive a gated write');
    await sleep(5);
  }
}

describe('benchmark process boundary', () => {
  it('forwards only base and explicitly selected environment values', () => {
    expect(allowlistedEnvironment({
      PATH: '/bin',
      DOCKER_HOST: 'unix:///run/docker.sock',
      GITHUB_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      OPENAI_API_KEY: 'selected',
    }, ['OPENAI_API_KEY'])).toEqual({
      PATH: '/bin',
      DOCKER_HOST: 'unix:///run/docker.sock',
      OPENAI_API_KEY: 'selected',
    });
  });

  it('redacts credentials, URL userinfo, and terminal control bytes', () => {
    const sanitized = sanitizeDiagnostic(
      'OPENAI_API_KEY=top-secret CODEX_AUTH_JSON_PATH=/private/codex/auth.json '
        + 'FEATUREBENCH_CREDENTIAL_BROKER_URL=https://broker.internal/v1 '
        + 'https://user:password@example.test/v1\u0001',
    );
    expect(sanitized).not.toMatch(/top-secret|private\/codex|broker\.internal|user:password|\u0001/);
    expect(sanitized).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(sanitized).toContain('https://[REDACTED]@example.test/v1?');
  });

  it('retains only bounded stdout and stderr tails', async () => {
    const lifecycle: string[] = [];
    const result = await runBenchProcess('/bin/sh', [
      '-c',
      "printf '%0100dstdout' 0; printf '%0100dstderr' 0 >&2",
    ], {
      cwd: process.cwd(),
      tailBytes: 8,
      drainMs: 100,
      terminationGraceMs: 0,
      onLifecycleToken: (token) => lifecycle.push(`token:${token}`),
      onLifecycleStarted: (token, pid) => lifecycle.push(`started:${token}:${pid ?? 'none'}`),
      onLifecycleRecovered: (token, recovery) => lifecycle.push(`recovered:${token}:${recovery}`),
    });
    expect(result.stdout).toBe('00stdout');
    expect(result.stderr).toBe('00stderr');
    expect(lifecycle).toHaveLength(3);
    const token = lifecycle[0]?.slice('token:'.length);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(lifecycle[1]).toMatch(new RegExp(`^started:${token}:\\d+$`));
    expect(lifecycle[2]).toBe(`recovered:${token}:complete`);
    await expect(cleanupActiveBenchProcesses(0)).resolves.toBe(0);
  });

  it('decodes UTF-8 only after retaining chunk-spanning tail bytes', async () => {
    const result = await runBenchProcess(process.execPath, ['-e', [
      'require("node:fs").writeSync(1, Buffer.from([0xf0, 0x9f]));',
      'setTimeout(() => require("node:fs").writeSync(1, Buffer.from([0x98, 0x80])), 10);',
    ].join('')], {
      cwd: process.cwd(),
      tailBytes: 4,
      drainMs: 1_000,
    });
    expect(result.stdout).toBe('😀');
  });

  it('propagates destination errors without an uncaught event or target teardown', async () => {
    const target = new EmittingErrorSink();
    const listeners = targetListeners(target);
    await expect(runBenchProcess('/bin/sh', ['-c', "printf 'output'"], {
      cwd: process.cwd(),
      stream: true,
      stdout: target,
      drainMs: 1_000,
    })).rejects.toThrow(/output forwarding failed.*destination exploded/);
    expect(target.writableEnded).toBe(false);
    expect(target.destroyed).toBe(false);
    expect(targetListeners(target)).toEqual(listeners);
    await expect(cleanupActiveBenchProcesses(0)).resolves.toBe(0);
  });

  it('forwards exact bytes through low-water-mark gates while retaining exact tails', async () => {
    const stdout = new GatedSink();
    const stderr = new GatedSink();
    const stdoutListeners = targetListeners(stdout);
    const stderrListeners = targetListeners(stderr);
    const running = runBenchProcess('/bin/sh', ['-c', [
      "printf 'stdout-0123456789'",
      "printf 'stderr-abcdefghij' >&2",
    ].join(';')], {
      cwd: process.cwd(),
      stream: true,
      stdout,
      stderr,
      tailBytes: 8,
      drainMs: 1_000,
    });
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    await waitForBlocked(stdout, stderr);
    expect(settled).toBe(false);
    stdout.release();
    stderr.release();
    const result = await running;
    expect(stdout.text).toBe('stdout-0123456789');
    expect(stderr.text).toBe('stderr-abcdefghij');
    expect(result.stdout).toBe('23456789');
    expect(result.stderr).toBe('cdefghij');
    expect(stdout.writableEnded).toBe(false);
    expect(stderr.writableEnded).toBe(false);
    expect(stdout.destroyed).toBe(false);
    expect(stderr.destroyed).toBe(false);
    expect(targetListeners(stdout)).toEqual(stdoutListeners);
    expect(targetListeners(stderr)).toEqual(stderrListeners);
    await expect(cleanupActiveBenchProcesses(0)).resolves.toBe(0);
  });

  it('independently detaches stdout and stderr from one shared caller-owned target', async () => {
    const target = new GatedSink();
    const listeners = targetListeners(target);
    const running = runBenchProcess('/bin/sh', ['-c', [
      "printf 'OOOO'",
      "printf 'eeee' >&2",
    ].join(';')], {
      cwd: process.cwd(),
      stream: true,
      stdout: target,
      stderr: target,
      tailBytes: 64,
      drainMs: 1_000,
    });
    await waitForBlocked(target);
    target.release();
    const result = await running;
    expect([...target.text].sort().join('')).toBe('OOOOeeee');
    expect(result.stdout).toBe('OOOO');
    expect(result.stderr).toBe('eeee');
    expect(target.writableEnded).toBe(false);
    expect(target.destroyed).toBe(false);
    expect(targetListeners(target)).toEqual(listeners);
    await expect(cleanupActiveBenchProcesses(0)).resolves.toBe(0);
  });

  it('detaches a gated target and retires the child after timeout', async () => {
    const target = new GatedSink();
    const listeners = targetListeners(target);
    const source = "trap '' TERM; while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done";
    const running = runBenchProcess('/bin/sh', ['-c', source], {
      cwd: process.cwd(),
      stream: true,
      stdout: target,
      stderr: target,
      tailBytes: 13,
      timeoutMs: 1_000,
      terminationGraceMs: 25,
      drainMs: 10,
    });
    const failed = running.then(() => undefined, (error: unknown) => error);
    let failure: unknown;
    try {
      await waitForBlocked(target);
      failure = await failed;
    } finally {
      target.release();
      await failed;
    }
    expect(failure).toBeInstanceOf(BenchProcessError);
    expect((failure as Error).message).toMatch(/timed out/);
    expect((failure as BenchProcessError).result.stdout).toBe('x'.repeat(13));
    expect((failure as BenchProcessError).result.stderr).toBe('');
    expect(target.writableEnded).toBe(false);
    expect(target.destroyed).toBe(false);
    expect(targetListeners(target)).toEqual(listeners);
    await expect(cleanupActiveBenchProcesses(0)).resolves.toBe(0);
  });

  it('escalates a timed-out process that ignores SIGTERM', async () => {
    const startedAt = performance.now();
    await expect(runBenchProcess('/bin/sh', [
      '-c',
      "trap '' TERM; while :; do :; done",
    ], {
      cwd: process.cwd(),
      timeoutMs: 25,
      terminationGraceMs: 25,
      drainMs: 25,
    })).rejects.toThrow(/timed out/);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    await expect(cleanupActiveBenchProcesses(0)).resolves.toBe(0);
  });

  it('rejects invalid process supervision intervals', async () => {
    await expect(runBenchProcess('/bin/true', [], {
      cwd: process.cwd(),
      drainMs: -1,
    })).rejects.toThrow(/drainMs/);
    await expect(runBenchProcess('/bin/true', [], {
      cwd: process.cwd(),
      terminationGraceMs: -1,
    })).rejects.toThrow(/terminationGraceMs/);
  });
});
