/** Platform-seamed explicit-leader Darwin benchmark recovery. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireBenchLock, type BenchLockHandle } from '../../bench/src/shared/locks.js';
import {
  createBenchPathRoots,
  createPrivateRunDirectory,
  runDir,
  runLeaseFile,
} from '../../bench/src/shared/paths.js';
import {
  BenchRunStateStore,
  type LifecycleRecoveryOptions,
} from '../../bench/src/shared/run-state.js';

const HASH = 'a'.repeat(64);
const TOKEN = 'b'.repeat(32);
const INVOCATION = '11111111-1111-4111-8111-111111111111';
const DIRECT_START = 'darwin:Mon_Jul_20_11:59:59_2026';
const roots: string[] = [];
const leases: BenchLockHandle[] = [];

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function lifecycleStore(): Promise<{ store: BenchRunStateStore; directory: string }> {
  const root = mkdtempSync(join(tmpdir(), 'uc-bench-darwin-recovery-'));
  roots.push(root);
  const paths = createBenchPathRoots(root);
  createPrivateRunDirectory(paths, 'featurebench', 'pilot1');
  const lease = await acquireBenchLock(
    paths.resultsRoot,
    runLeaseFile(paths, 'featurebench', 'pilot1'),
  );
  leases.push(lease);
  const store = new BenchRunStateStore(paths, 'featurebench', 'pilot1', HASH, lease);
  store.initialize();
  await store.update(0, (state) => ({
    ...state,
    invocations: [{
      invocationId: INVOCATION,
      command: 'run',
      startedAt: '2026-07-20T12:00:00.000Z',
      endedAt: null,
      activeElapsedMs: null,
      exitCode: null,
      signal: null,
      lifecycleProcesses: [],
      failure: null,
      nativeInvocation: 'native',
    }],
  }));
  const lifecycle = store.lifecycleHooks(INVOCATION);
  lifecycle.onLifecycleToken(TOKEN);
  lifecycle.onLifecycleStarted(TOKEN, 101, DIRECT_START);
  return { store, directory: runDir(paths, 'featurebench', 'pilot1') };
}

function gone(): Error {
  return Object.assign(new Error('gone'), { code: 'ESRCH' });
}

describe('Darwin benchmark lifecycle recovery', () => {
  it('authenticates, signals, and settles only the persisted leader', async () => {
    const { store, directory } = await lifecycleStore();
    let live = true;
    let clock = 0;
    const candidateSets: Array<readonly number[] | undefined> = [];
    const signals: Array<[number, NodeJS.Signals]> = [];
    const inspection: LifecycleRecoveryOptions = {
      platform: 'darwin',
      discoverWorkerProcesses: (tokens, _scope, candidates) => {
        candidateSets.push(candidates);
        return {
          complete: true,
          processes: live ? [{
            pid: 101,
            pgrp: 101,
            starttime: DIRECT_START,
            token: tokens[0]!,
          }] : [],
        };
      },
      signalProcess: (target, signal) => {
        if (signal === 0) {
          if (!live) throw gone();
          return;
        }
        signals.push([target, signal]);
        live = false;
      },
      recoveryNow: () => clock,
      recoveryWait: async (delayMs) => { clock += delayMs; },
    };

    await expect(store.recoverPendingLifecycleProcesses(directory, 50, inspection)).resolves.toBe(1);

    expect(signals).toEqual([[-101, 'SIGTERM']]);
    expect(candidateSets.length).toBeGreaterThan(0);
    expect(candidateSets.every((candidates) => candidates?.length === 1 && candidates[0] === 101)).toBe(true);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('complete');
  });

  it('escalates from bounded SIGTERM to SIGKILL', async () => {
    const { store, directory } = await lifecycleStore();
    let live = true;
    let clock = 0;
    const signals: NodeJS.Signals[] = [];
    await expect(store.recoverPendingLifecycleProcesses(directory, 50, {
      platform: 'darwin',
      discoverWorkerProcesses: (tokens, _scope, candidates) => {
        expect(candidates).toEqual([101]);
        return {
          complete: true,
          processes: live ? [{ pid: 101, pgrp: 101, starttime: DIRECT_START, token: tokens[0]! }] : [],
        };
      },
      signalProcess: (_target, signal) => {
        if (signal === 0) {
          if (!live) throw gone();
          return;
        }
        signals.push(signal);
        if (signal === 'SIGKILL') live = false;
      },
      recoveryNow: () => clock,
      recoveryWait: async (delayMs) => { clock += delayMs; },
    })).resolves.toBe(1);
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
  });

  it('fails closed on unknown or reused group state without signaling', async () => {
    const { store, directory } = await lifecycleStore();
    let clock = 0;
    let signals = 0;
    await expect(store.recoverPendingLifecycleProcesses(directory, 25, {
      platform: 'darwin',
      discoverWorkerProcesses: (_tokens, _scope, candidates) => {
        expect(candidates).toEqual([101]);
        return { complete: true, processes: [] };
      },
      signalProcess: (_target, signal) => {
        if (signal === 0) throw Object.assign(new Error('unknown'), { code: 'EIO' });
        signals += 1;
      },
      recoveryNow: () => clock,
      recoveryWait: async (delayMs) => { clock += delayMs; },
    })).rejects.toThrow(/could not be recovered safely/u);
    expect(signals).toBe(0);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('failed');
  });
});
