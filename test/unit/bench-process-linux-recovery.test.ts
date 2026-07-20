/** Deterministic Linux lifecycle recovery with authenticated process seams. */
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
import {
  discoverWorkerProcessesForTokens,
  signal0Status,
  type TrackedWorkerProcess,
} from '../../src/exec/procinfo.js';

const HASH = 'a'.repeat(64);
const INVOCATION = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'b'.repeat(32);
const PROCESS: TrackedWorkerProcess = {
  pid: 101,
  pgrp: 101,
  starttime: 'linux-process-start',
  token: TOKEN,
};
const roots: string[] = [];
const leases: BenchLockHandle[] = [];

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function lifecycleStore(): Promise<{
  store: BenchRunStateStore;
  directory: string;
}> {
  const root = mkdtempSync(join(tmpdir(), 'uc-bench-linux-recovery-'));
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
  lifecycle.onLifecycleStarted(TOKEN, PROCESS.pid, PROCESS.starttime);
  return { store, directory: runDir(paths, 'featurebench', 'pilot1') };
}

function identitySnapshot(pids: readonly number[]) {
  return {
    identities: new Map(pids.map((pid) => [pid, {
      pgrp: PROCESS.pgrp,
      starttime: PROCESS.starttime,
    }])),
    complete: true,
  };
}

describe('Linux benchmark lifecycle recovery', () => {
  it('gives delayed SIGKILL settlement a fresh bounded grace phase', async () => {
    const { store, directory } = await lifecycleStore();
    const signals: Array<[number, NodeJS.Signals]> = [];
    let clock = 0;
    let killSent = false;
    let processLive = true;
    const inspection: LifecycleRecoveryOptions = {
      platform: 'linux',
      discoverWorkerProcesses: () => {
        if (!killSent) return { processes: [PROCESS], complete: true };
        processLive = false;
        return { processes: [], complete: true };
      },
      readIdentitySnapshot: (pids) => processLive
        ? identitySnapshot(pids)
        : { identities: new Map(), complete: true },
      signalProcess: (pid, signal) => {
        if (signal === 0) {
          if (!processLive) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
          return;
        }
        signals.push([pid, signal]);
        if (signal === 'SIGKILL') killSent = true;
      },
      recoveryNow: () => clock,
      recoveryWait: async (delayMs) => { clock += delayMs; },
    };

    await expect(store.recoverPendingLifecycleProcesses(directory, 50, inspection)).resolves.toBe(1);
    expect(signals).toEqual([
      [-PROCESS.pid, 'SIGTERM'],
      [-PROCESS.pid, 'SIGKILL'],
    ]);
    expect(clock).toBe(100);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('complete');
  });

  it('persists a KILL survivor as failed and completes it on a later verified retry', async () => {
    const { store, directory } = await lifecycleStore();
    const signals: NodeJS.Signals[] = [];
    let clock = 0;
    let survives = true;
    let retryObservations = 0;
    const inspection: LifecycleRecoveryOptions = {
      platform: 'linux',
      discoverWorkerProcesses: () => {
        if (survives) return { processes: [PROCESS], complete: true };
        retryObservations++;
        return {
          processes: [],
          complete: retryObservations > 1,
        };
      },
      readIdentitySnapshot: (pids) => survives
        ? identitySnapshot(pids)
        : { identities: new Map(), complete: true },
      signalProcess: (_pid, signal) => {
        if (signal === 0) {
          if (!survives) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
          return;
        }
        signals.push(signal);
      },
      recoveryNow: () => clock,
      recoveryWait: async (delayMs) => { clock += delayMs; },
    };

    await expect(store.recoverPendingLifecycleProcesses(directory, 25, inspection))
      .rejects.toThrow(/could not be recovered safely/);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('failed');

    survives = false;
    await expect(store.recoverPendingLifecycleProcesses(directory, 25, inspection)).resolves.toBe(1);
    expect(retryObservations).toBe(4);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('complete');
  });

  it('does not trust an empty token scan while the durable leader remains live', async () => {
    const { store, directory } = await lifecycleStore();
    const signals: NodeJS.Signals[] = [];
    let clock = 0;
    const inspection: LifecycleRecoveryOptions = {
      platform: 'linux',
      discoverWorkerProcesses: () => ({ processes: [], complete: true }),
      readIdentitySnapshot: identitySnapshot,
      signalProcess: (_pid, signal) => {
        if (signal !== 0) signals.push(signal);
      },
      recoveryNow: () => clock,
      recoveryWait: async (delayMs) => { clock += delayMs; },
    };
    await expect(store.recoverPendingLifecycleProcesses(directory, 25, inspection))
      .rejects.toThrow(/could not be recovered safely/);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('failed');
  });

  it('requires a positive poll interval between initially empty observations', async () => {
    const { store, directory } = await lifecycleStore();
    let clock = 0;
    let waits = 0;
    const absent = Object.assign(new Error('absent'), { code: 'ESRCH' });
    await expect(store.recoverPendingLifecycleProcesses(directory, 25, {
      platform: 'linux',
      discoverWorkerProcesses: () => ({ processes: [], complete: true }),
      readIdentitySnapshot: () => ({ identities: new Map(), complete: true }),
      signalProcess: () => { throw absent; },
      recoveryNow: () => clock,
      recoveryWait: async (delayMs) => {
        waits++;
        clock += delayMs;
      },
    })).resolves.toBe(1);
    expect(waits).toBe(1);
    expect(clock).toBeGreaterThan(0);
  });
});

describe('Linux token discovery completeness', () => {
  it('classifies only ESRCH as absent and retains EPERM as live', () => {
    const error = (code: string) => Object.assign(new Error(code), { code });
    expect(signal0Status(-PROCESS.pgrp, { signalProcess: () => { throw error('ESRCH'); } })).toBe('absent');
    expect(signal0Status(-PROCESS.pgrp, { signalProcess: () => { throw error('EPERM'); } })).toBe('alive');
    expect(signal0Status(-PROCESS.pgrp, { signalProcess: () => { throw error('EINVAL'); } })).toBe('unknown');
  });

  it('marks a persistently unreadable live environment incomplete', () => {
    const discovery = discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, {
      platform: 'linux',
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => ({ pgrp: PROCESS.pgrp, starttime: PROCESS.starttime }),
      readLinuxProcessEnvironment: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      signalProcess: () => {},
    });
    expect(discovery).toEqual({ processes: [], complete: false });
  });

  it('accepts a procfs read race only after ESRCH proves the candidate exited', () => {
    const discovery = discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, {
      platform: 'linux',
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => undefined,
      signalProcess: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    });
    expect(discovery).toEqual({ processes: [], complete: true });
  });
});
