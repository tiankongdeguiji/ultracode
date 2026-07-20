/** Offline ownership cleanup tests for ambiguous Docker removal outcomes. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OwnershipUnsafeCleanupError } from '../../bench/src/suites/swebench-pro/cleanup.js';
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
  const runtimeCodex = join(runtime, 'codex-home');
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
  const inspect = JSON.stringify([{
    Id: id,
    Config: { Labels: {
      'ultracode.benchmark.schema': '2',
      'ultracode.benchmark.suite': 'swebench-pro',
      'ultracode.benchmark.run': 'pilot1',
      'ultracode.benchmark.task': 'task-a',
      'ultracode.benchmark.arm': 'a',
      'ultracode.benchmark.purpose': 'session',
      'ultracode.benchmark.ownership': '1',
      'ultracode.benchmark.runtime': runtimeNonce,
    } },
    Mounts: [{ Type: 'bind', Source: runtimeCodex, Destination: '/runtime/codex-home' }],
  }]);
  return { runtime, id, inspect };
}

describe('SWE-bench Pro ownership cleanup', () => {
  it('accepts an ambiguous rm failure only after the exact name is proven absent', async () => {
    const { runtime, id, inspect } = sessionFixture();
    const calls: string[][] = [];
    let listed = true;
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push([...argv]);
      if (argv[0] === 'ps') {
        if (listed) return id;
        return '';
      }
      if (argv[0] === 'inspect') return inspect;
      if (argv[0] === 'rm') {
        listed = false;
        throw new Error('daemon connection ended after accepting removal');
      }
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    await expect(stopPersistedSessionContainer(
      'session-name', 'pilot1', 'task-a', 'a', {}, executor,
    )).resolves.toBeUndefined();
    expect(calls.map((argv) => argv[0])).toEqual(['ps', 'inspect', 'rm', 'ps']);
    expect(existsSync(runtime)).toBe(false);
  });

  it('retains the runtime and raises a typed command-fatal error while the name remains', async () => {
    const { runtime, id, inspect } = sessionFixture();
    const executor: SessionDockerExecutor = async (argv) => {
      if (argv[0] === 'ps') return id;
      if (argv[0] === 'inspect') return inspect;
      if (argv[0] === 'rm') throw new Error('removal failed');
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    const rejection = stopPersistedSessionContainer(
      'session-name', 'pilot1', 'task-a', 'a', {}, executor,
    );
    await expect(rejection).rejects.toBeInstanceOf(OwnershipUnsafeCleanupError);
    await expect(rejection).rejects.toMatchObject({ code: 'ownership-unsafe' });
    expect(existsSync(runtime)).toBe(true);
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
