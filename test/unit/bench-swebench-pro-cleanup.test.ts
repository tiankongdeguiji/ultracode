/** Offline ownership cleanup tests for ambiguous Docker removal outcomes. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OwnershipUnsafeCleanupError } from '../../bench/src/suites/swebench-pro/cleanup.js';
import { sessionTaskIdentity } from '../../bench/src/suites/swebench-pro/container-policy.js';
import {
  stopPersistedSessionContainer,
  settleSessionWorkers,
  type SessionDockerExecutor,
} from '../../bench/src/suites/swebench-pro/runner.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sessionFixture() {
  const runtime = mkdtempSync(join(tmpdir(), 'uc-bench-pro-runtime-'));
  temporaryRoots.push(runtime);
  const taskDirectory = mkdtempSync(join(tmpdir(), 'uc-bench-pro-task-'));
  temporaryRoots.push(taskDirectory);
  mkdirSync(join(taskDirectory, 'codex-home', 'sessions'), { recursive: true, mode: 0o700 });
  const runtimeHome = join(runtime, 'home');
  const runtimeCodex = join(runtime, 'codex-home');
  mkdirSync(runtimeHome, { mode: 0o700 });
  mkdirSync(runtimeCodex, { mode: 0o700 });
  const runtimeNonce = 'a'.repeat(64);
  writeFileSync(join(runtime, 'ownership.json'), `${JSON.stringify({
    schemaVersion: 2,
    kind: 'ultracode-swebench-pro-session-runtime',
    runId: 'pilot1',
    taskId: 'task-a',
    arm: 'a',
    runtimeNonce,
  })}\n`, { mode: 0o600 });
  const id = 'b'.repeat(64);
  const image = {
    overlayName: 'ultracode-swebench-pro:test',
    overlayLocalId: `sha256:${'c'.repeat(64)}`,
  } as never;
  const artifactOwner = {
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    gid: typeof process.getgid === 'function' ? process.getgid() : 0,
  };
  const taskIdentity = sessionTaskIdentity(artifactOwner);
  const inspect = JSON.stringify([{
    Id: id,
    Image: image.overlayLocalId,
    Config: { Image: image.overlayName, Labels: {
      'ultracode.benchmark.schema': '2',
      'ultracode.benchmark.suite': 'swebench-pro',
      'ultracode.benchmark.run': 'pilot1',
      'ultracode.benchmark.task': 'task-a',
      'ultracode.benchmark.arm': 'a',
      'ultracode.benchmark.purpose': 'session',
      'ultracode.benchmark.ownership': '1',
      'ultracode.benchmark.runtime': runtimeNonce,
      'ultracode.benchmark.task-uid': String(taskIdentity.uid),
      'ultracode.benchmark.task-gid': String(taskIdentity.gid),
      'ultracode.benchmark.artifact-uid': String(artifactOwner.uid),
      'ultracode.benchmark.artifact-gid': String(artifactOwner.gid),
    } },
    State: { Running: false },
    Mounts: [
      { Type: 'bind', Source: taskDirectory, Destination: '/bench' },
      { Type: 'bind', Source: runtimeHome, Destination: '/runtime/home' },
      { Type: 'bind', Source: runtimeCodex, Destination: '/runtime/codex-home' },
      {
        Type: 'bind',
        Source: join(taskDirectory, 'codex-home', 'sessions'),
        Destination: '/runtime/codex-home/sessions',
      },
    ],
  }]);
  return { runtime, taskDirectory, id, inspect, image, artifactOwner };
}

describe('SWE-bench Pro ownership cleanup', () => {
  it('reclaims artifacts and runtime homes after the owned container vanished', async () => {
    const { runtime, taskDirectory, image, artifactOwner } = sessionFixture();
    const calls: string[][] = [];
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push([...argv]);
      if (argv[0] === 'ps') return '';
      if (argv[0] === 'run') return '';
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    await stopPersistedSessionContainer(
      'session-name',
      'pilot1',
      'task-a',
      'a',
      {},
      executor,
      { taskDirectory, image, artifactOwner, runtimeDirectory: runtime },
    );
    expect(calls.map((argv) => argv[0])).toEqual(['ps', 'run']);
    expect(calls[1]).toContain('FOWNER');
    expect(existsSync(runtime)).toBe(false);
    expect(statSync(taskDirectory).mode & 0o777).toBe(0o700);
  });

  it('accepts an ambiguous rm failure only after the exact name is proven absent', async () => {
    const { runtime, taskDirectory, id, inspect, image, artifactOwner } = sessionFixture();
    const calls: string[][] = [];
    let listed = true;
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push([...argv]);
      if (argv[0] === 'ps') {
        if (listed) return id;
        return '';
      }
      if (argv[0] === 'inspect') return inspect;
      if (argv[0] === 'run') return '';
      if (argv[0] === 'rm') {
        listed = false;
        throw new Error('daemon connection ended after accepting removal');
      }
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    await expect(stopPersistedSessionContainer(
      'session-name', 'pilot1', 'task-a', 'a', {}, executor, { taskDirectory, image, artifactOwner },
    )).resolves.toBeUndefined();
    expect(calls.map((argv) => argv[0])).toEqual(['ps', 'inspect', 'run', 'rm', 'ps']);
    expect(existsSync(runtime)).toBe(false);
  });

  it('retains the runtime and raises a typed command-fatal error while the name remains', async () => {
    const { runtime, taskDirectory, id, inspect, image, artifactOwner } = sessionFixture();
    const executor: SessionDockerExecutor = async (argv) => {
      if (argv[0] === 'ps') return id;
      if (argv[0] === 'inspect') return inspect;
      if (argv[0] === 'run') return '';
      if (argv[0] === 'rm') throw new Error('removal failed');
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    const rejection = stopPersistedSessionContainer(
      'session-name', 'pilot1', 'task-a', 'a', {}, executor, { taskDirectory, image, artifactOwner },
    );
    await expect(rejection).rejects.toBeInstanceOf(OwnershipUnsafeCleanupError);
    await expect(rejection).rejects.toMatchObject({ code: 'ownership-unsafe' });
    expect(existsSync(runtime)).toBe(true);
  });

  it('reclaims trusted writable mounts before removing a running crash survivor', async () => {
    const { runtime, taskDirectory, id, inspect, image, artifactOwner } = sessionFixture();
    const artifact = join(taskDirectory, 'task-output.txt');
    writeFileSync(artifact, 'result');
    chmodSync(taskDirectory, 0o000);
    let running = true;
    const calls: Array<{ argv: string[]; timeoutMs: number | undefined }> = [];
    let listed = true;
    const executor: SessionDockerExecutor = async (argv, _lifecycle, timeoutMs) => {
      calls.push({ argv: [...argv], timeoutMs });
      if (argv[0] === 'ps') return listed ? id : '';
      if (argv[0] === 'inspect') {
        return JSON.stringify([{ ...JSON.parse(inspect)[0], State: { Running: running } }]);
      }
      if (argv[0] === 'stop') {
        running = false;
        return '';
      }
      if (argv[0] === 'run') {
        chmodSync(taskDirectory, 0o700);
        return '';
      }
      if (argv[0] === 'rm') {
        listed = false;
        return '';
      }
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    await stopPersistedSessionContainer(
      'session-name',
      'pilot1',
      'task-a',
      'a',
      {},
      executor,
      { attemptDeadline: performance.now() + 60_000, taskDirectory, image, artifactOwner },
    );
    expect(calls.map(({ argv }) => argv[0])).toEqual(['ps', 'inspect', 'stop', 'inspect', 'run', 'rm', 'ps']);
    expect(calls[4]!.argv).toContain(image.overlayLocalId);
    expect(calls.every(({ timeoutMs }) => typeof timeoutMs === 'number' && timeoutMs > 0)).toBe(true);
    const timeouts = calls.map(({ timeoutMs }) => timeoutMs!);
    expect(timeouts.every((timeoutMs, index) => index === 0 || timeoutMs <= timeouts[index - 1]!)).toBe(true);
    expect(statSync(taskDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(artifact).mode & 0o777).toBe(0o600);
    expect(existsSync(runtime)).toBe(false);
  });

  it('fails ownership-unsafe before Docker when the cleanup deadline is exhausted', async () => {
    let calls = 0;
    const executor: SessionDockerExecutor = async () => {
      calls += 1;
      return '';
    };
    const rejection = stopPersistedSessionContainer(
      'session-name',
      'pilot1',
      'task-a',
      'a',
      {},
      executor,
      { attemptDeadline: performance.now() },
    );
    await expect(rejection).rejects.toMatchObject({ code: 'ownership-unsafe' });
    expect(calls).toBe(0);
  });

  it('retains the container when writable mount ownership is not exactly bounded', async () => {
    const { runtime, taskDirectory, id, inspect, image, artifactOwner } = sessionFixture();
    const parsed = JSON.parse(inspect);
    parsed[0].State = { Running: true };
    parsed[0].Mounts.push({ Type: 'bind', Source: '/untrusted', Destination: '/bench/nested' });
    const calls: string[] = [];
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push(argv[0]!);
      if (argv[0] === 'ps') return id;
      if (argv[0] === 'inspect') return JSON.stringify(parsed);
      throw new Error('ownership reclamation must not run');
    };
    await expect(stopPersistedSessionContainer(
      'session-name', 'pilot1', 'task-a', 'a', {}, executor, { taskDirectory, image, artifactOwner },
    )).rejects.toMatchObject({ code: 'ownership-unsafe' });
    expect(calls).toEqual(['ps', 'inspect']);
    expect(existsSync(runtime)).toBe(true);
  });

  it('rejects a spoofed image or runtime source before stopping or reclaiming as root', async () => {
    const { taskDirectory, id, inspect, image, artifactOwner } = sessionFixture();
    const parsed = JSON.parse(inspect);
    parsed[0].State = { Running: true };
    parsed[0].Mounts.find((mount: { Destination: string }) =>
      mount.Destination === '/runtime/home').Source = '/untrusted';
    const calls: string[] = [];
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push(argv[0]!);
      if (argv[0] === 'ps') return id;
      if (argv[0] === 'inspect') return JSON.stringify(parsed);
      throw new Error('privileged recovery must not run');
    };
    await expect(stopPersistedSessionContainer(
      'session-name',
      'pilot1',
      'task-a',
      'a',
      {},
      executor,
      { taskDirectory, image, artifactOwner },
    )).rejects.toMatchObject({ code: 'ownership-unsafe' });
    expect(calls).toEqual(['ps', 'inspect']);
  });

  it('settles workers, performs one mandatory retry, and still propagates the retained aggregate', async () => {
    const events: string[] = [];
    const fatal = Promise.resolve().then(() => {
      events.push('fatal-worker');
      throw new OwnershipUnsafeCleanupError('initial cleanup ambiguity', [new Error('rm failed')]);
    });
    const settling = Promise.resolve().then(() => {
      events.push('other-worker-settled');
    });
    let caught: unknown;
    try {
      await settleSessionWorkers([fatal, settling], async () => {
        events.push('mandatory-retry');
      });
    } catch (error) {
      caught = error;
    }
    expect(events).toEqual(['fatal-worker', 'other-worker-settled', 'mandatory-retry']);
    expect(caught).toBeInstanceOf(OwnershipUnsafeCleanupError);
    expect(caught).toMatchObject({
      code: 'ownership-unsafe',
      failures: [expect.objectContaining({ message: 'rm failed' })],
    });
  });
});
