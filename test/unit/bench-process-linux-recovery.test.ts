/** Deterministic Linux lifecycle recovery with authenticated process seams. */
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupActiveBenchProcesses,
  runBenchProcess,
} from '../../bench/src/shared/process.js';
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
  signalTrackedWorkerProcesses,
  signalWorkerProcessTokensUntilGone,
  snapshotLinuxProcessIdentities,
  type ProcessInspectionOptions,
  type TrackedWorkerProcess,
  workerScopeValue,
} from '../../src/exec/procinfo.js';
import { spawnAgentProcess } from '../../src/exec/spawn.js';
import { stopRun } from '../../src/exec/stop.js';
import { workerRecordDir, workerRecordPath } from '../../src/exec/worker-record.js';
import { newRunId } from '../../src/store/layout.js';
import { isResumableStatus, readManifest, writeManifest } from '../../src/store/manifest.js';
import { createRunDir, getRun } from '../../src/store/runstore.js';

const HASH = 'a'.repeat(64);
const INVOCATION = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'b'.repeat(32);
const PROCESS_PID = process.pid === 101 ? 102 : 101;
const PROCESS: TrackedWorkerProcess = {
  pid: PROCESS_PID,
  pgrp: PROCESS_PID,
  starttime: 'linux-process-start',
  token: TOKEN,
};
const roots: string[] = [];
const leases: BenchLockHandle[] = [];

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function lifecycleStore(withPendingProcess = true): Promise<{
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
  if (withPendingProcess) {
    const lifecycle = store.lifecycleHooks(INVOCATION);
    lifecycle.onLifecycleToken(TOKEN);
    lifecycle.onLifecycleStarted(TOKEN, PROCESS.pid, PROCESS.starttime);
  }
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

function noSuchProcess(): Error {
  return Object.assign(new Error('absent'), { code: 'ESRCH' });
}

function procMountInfo(options = 'rw', root = '/'): string {
  return `31 24 0:27 ${root} /proc rw,nosuid,nodev,noexec,relatime - proc proc ${options}\n`;
}

describe('Linux worker-token publication', () => {
  it('snapshots process identities before publishing the lifecycle token', async () => {
    const order: string[] = [];
    let published = false;
    let clock = 0;
    const spawned = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      env: {},
      onWorkerToken: () => {
        order.push('publish');
        published = true;
      },
      processInspection: {
        platform: 'linux',
        listLinuxProcessIds: () => {
          order.push(published ? 'scan' : 'snapshot');
          return [];
        },
        signalProcess: (_pid, signal) => {
          if (signal === 0) throw noSuchProcess();
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    });

    expect(order.slice(0, 2)).toEqual(['snapshot', 'publish']);
    await once(spawned.child, 'close');
    await expect(spawned.cleanupEscaped(50)).resolves.toBe(0);
  });

  it('signals a latched escaped identity after its marker disappears', async () => {
    let clock = 0;
    let discoveries = 0;
    let escapedLive = true;
    let workerToken = '';
    const signals: Array<[number, NodeJS.Signals]> = [];
    const spawned = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      env: {},
      onWorkerToken: (token) => { workerToken = token; },
      processInspection: {
        platform: 'linux',
        listLinuxProcessIds: () => [],
        discoverWorkerProcesses: () => ({
          processes: discoveries++ === 0
            ? [{ ...PROCESS, token: workerToken }]
            : [],
          complete: true,
        }),
        readIdentitySnapshot: (pids) => ({
          identities: new Map(
            escapedLive && pids.includes(PROCESS.pid)
              ? [[PROCESS.pid, { pgrp: PROCESS.pgrp, starttime: PROCESS.starttime }]]
              : [],
          ),
          complete: true,
        }),
        signalProcess: (pid, signal) => {
          if (signal === 0) throw noSuchProcess();
          signals.push([pid, signal]);
          escapedLive = false;
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    });

    await once(spawned.child, 'close');
    await expect(spawned.cleanupEscaped(50)).resolves.toBe(0);
    expect(signals).toEqual([[-PROCESS.pid, 'SIGTERM']]);
  });

  it('does not duplicate SIGTERM for a token match in the worker group', async () => {
    let exposeTokenMatch = true;
    let groupLive = true;
    let groupPid = 0;
    let tokenMatchLive = true;
    let clock = 0;
    const duplicateSignals: Array<[number, NodeJS.Signals]> = [];
    const spawned = spawnAgentProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1e9)'],
      {
        cwd: process.cwd(),
        env: {},
        processInspection: {
          platform: 'linux',
          listLinuxProcessIds: () => [],
          discoverWorkerProcesses: (tokens) => ({
            processes: exposeTokenMatch
              ? [{ pid: groupPid, pgrp: groupPid, starttime: 'worker-start', token: tokens[0]! }]
              : [],
            complete: true,
          }),
          readIdentitySnapshot: (pids) => ({
            identities: new Map(tokenMatchLive && pids.includes(groupPid)
              ? [[groupPid, { pgrp: groupPid, starttime: 'worker-start' }]]
              : []),
            complete: true,
          }),
          signalProcess: (pid, signal) => {
            if (signal === 0) {
              if (!groupLive) throw noSuchProcess();
              return;
            }
            duplicateSignals.push([pid, signal]);
          },
          observationNow: () => clock,
          observationWait: async (delayMs) => { clock += delayMs; },
        },
      },
    );
    groupPid = spawned.child.pid!;

    spawned.killTree('SIGTERM');
    exposeTokenMatch = false;
    await once(spawned.child, 'close');
    groupLive = false;
    tokenMatchLive = false;
    await expect(spawned.cleanupEscaped(50)).resolves.toBe(0);
    expect(duplicateSignals).toEqual([]);
  });

  it('retains a pre-signal identity from killTree across a PGID change and marker removal', async () => {
    let clock = 0;
    let groupLive = true;
    let groupPid = 0;
    let workerEscaped = false;
    let workerLive = true;
    let exposeTokenMatch = true;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const spawned = spawnAgentProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1e9)'],
      {
        cwd: process.cwd(),
        env: {},
        processInspection: {
          platform: 'linux',
          listLinuxProcessIds: () => [],
          discoverWorkerProcesses: (tokens) => ({
            processes: exposeTokenMatch
              ? [{
                  pid: PROCESS.pid,
                  pgrp: groupPid,
                  starttime: PROCESS.starttime,
                  token: tokens[0]!,
                }]
              : [],
            complete: true,
          }),
          readIdentitySnapshot: (pids) => ({
            identities: new Map(
              workerLive && pids.includes(PROCESS.pid)
                ? [[PROCESS.pid, {
                    pgrp: workerEscaped ? PROCESS.pid : groupPid,
                    starttime: PROCESS.starttime,
                  }]]
                : [],
            ),
            complete: true,
          }),
          signalProcess: (pid, signal) => {
            if (signal === 0) {
              if (!groupLive) throw noSuchProcess();
              return;
            }
            signals.push([pid, signal]);
            workerLive = false;
          },
          observationNow: () => clock,
          observationWait: async (delayMs) => { clock += delayMs; },
        },
      },
    );
    groupPid = spawned.child.pid!;
    const closed = once(spawned.child, 'close');

    spawned.killTree('SIGTERM');
    exposeTokenMatch = false;
    groupLive = false;
    workerEscaped = true;
    await expect(spawned.cleanupEscaped(50)).resolves.toBe(0);
    await closed;
    expect(signals).toEqual([[-PROCESS.pid, 'SIGTERM']]);
  });

  it('retains an authenticated identity across a failed cleanup retry', async () => {
    let clock = 0;
    let exposeTokenMatch = true;
    let workerLive = true;
    let allowSignal = false;
    const signals: NodeJS.Signals[] = [];
    const spawned = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      env: {},
      processInspection: {
        platform: 'linux',
        listLinuxProcessIds: () => [],
        discoverWorkerProcesses: (tokens) => ({
          processes: exposeTokenMatch
            ? [{ ...PROCESS, token: tokens[0]! }]
            : [],
          complete: true,
        }),
        readIdentitySnapshot: (pids) => ({
          identities: new Map(
            workerLive && pids.includes(PROCESS.pid)
              ? [[PROCESS.pid, { pgrp: PROCESS.pgrp, starttime: PROCESS.starttime }]]
              : [],
          ),
          complete: true,
        }),
        signalProcess: (_pid, signal) => {
          if (signal === 0) throw noSuchProcess();
          signals.push(signal);
          if (!allowSignal) throw new Error('survivor');
          workerLive = false;
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    });

    await once(spawned.child, 'close');
    await expect(spawned.cleanupEscaped(0)).resolves.toBeGreaterThan(0);
    exposeTokenMatch = false;
    allowSignal = true;
    await expect(spawned.cleanupEscaped(50)).resolves.toBe(0);
    expect(signals).toEqual(['SIGKILL', 'SIGKILL', 'SIGTERM']);
  });

  it('retires a latched identity after it becomes a zombie', async () => {
    let clock = 0;
    let identityReads = 0;
    let observations = 0;
    const spawned = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      env: {},
      processInspection: {
        platform: 'linux',
        listLinuxProcessIds: () => [],
        discoverWorkerProcesses: (tokens) => ({
          processes: observations++ === 0 ? [{ ...PROCESS, token: tokens[0]! }] : [],
          complete: true,
        }),
        readIdentitySnapshot: (pids) => ({
          identities: new Map(pids.includes(PROCESS.pid)
            ? [[PROCESS.pid, {
                state: identityReads++ === 0 ? 'S' : 'Z',
                pgrp: PROCESS.pgrp,
                starttime: PROCESS.starttime,
              }]]
            : []),
          complete: true,
        }),
        signalProcess: (_pid, signal) => {
          if (signal === 0) throw noSuchProcess();
          throw new Error('a zombie must not be signaled');
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    });

    await once(spawned.child, 'close');
    await expect(spawned.cleanupEscaped(50)).resolves.toBe(0);
  });
});

describe('Linux tracked worker signaling', () => {
  const leader = { pid: 301, pgrp: 301, starttime: 'leader-start', token: TOKEN };
  const child = { pid: 302, pgrp: 301, starttime: 'child-start', token: 'c'.repeat(32) };
  const identitySnapshot = () => ({
    identities: new Map([
      [leader.pid, { pgrp: leader.pgrp, starttime: leader.starttime }],
      [child.pid, { pgrp: child.pgrp, starttime: child.starttime }],
    ]),
    complete: true,
  });

  it('coalesces an authenticated group while retaining children for later retries', () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    const result = signalTrackedWorkerProcesses([leader, child], 'SIGTERM', {
      platform: 'linux',
      readIdentitySnapshot: identitySnapshot,
      signalProcess: (pid, signal) => { signals.push([pid, signal as NodeJS.Signals]); },
    });

    expect(signals).toEqual([[-leader.pid, 'SIGTERM']]);
    expect(result.processes).toBe(1);
    expect(result.tokens).toEqual(new Set([leader.token]));
  });

  it('falls back to rechecked individual PIDs when the group signal fails', () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    const result = signalTrackedWorkerProcesses([leader, child], 'SIGTERM', {
      platform: 'linux',
      readIdentitySnapshot: identitySnapshot,
      signalProcess: (pid, signal) => {
        signals.push([pid, signal as NodeJS.Signals]);
        if (pid < 0) throw noSuchProcess();
      },
    });

    expect(signals).toEqual([
      [-leader.pid, 'SIGTERM'],
      [leader.pid, 'SIGTERM'],
      [child.pid, 'SIGTERM'],
    ]);
    expect(result.processes).toBe(2);
  });

  it('rechecks each group leader immediately before signaling it', () => {
    const reused = {
      pid: 303,
      pgrp: 303,
      starttime: 'second-start',
      token: 'd'.repeat(32),
    };
    let secondReused = false;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const identities = new Map([
      [leader.pid, { pgrp: leader.pgrp, starttime: leader.starttime }],
      [reused.pid, { pgrp: reused.pgrp, starttime: reused.starttime }],
    ]);
    const result = signalTrackedWorkerProcesses([leader, reused], 'SIGTERM', {
      platform: 'linux',
      readIdentitySnapshot: (pids) => ({
        identities: new Map(pids.flatMap((pid) => {
          const identity = identities.get(pid);
          if (identity === undefined) return [];
          if (pid === reused.pid && secondReused) {
            return [[pid, { ...identity, starttime: 'replacement-start' }]];
          }
          return [[pid, identity]];
        })),
        complete: true,
      }),
      signalProcess: (pid, signal) => {
        signals.push([pid, signal as NodeJS.Signals]);
        if (pid === -leader.pid) secondReused = true;
      },
    });

    expect(signals).toEqual([[-leader.pid, 'SIGTERM']]);
    expect(result.processes).toBe(1);
    expect(result.tokens).toEqual(new Set([leader.token]));
  });
});

describe('Linux benchmark lifecycle recovery', () => {
  it('retires an authenticated token-only process identity to a safe terminal state', async () => {
    const { store, directory } = await lifecycleStore(false);
    store.lifecycleHooks(INVOCATION).onLifecycleToken(TOKEN);
    let live = true;
    let clock = 0;
    const signals: Array<[number, NodeJS.Signals]> = [];
    await expect(store.recoverPendingLifecycleProcesses(directory, 50, {
      platform: 'linux',
      discoverWorkerProcesses: () => ({
        processes: live ? [PROCESS] : [],
        complete: true,
      }),
      readIdentitySnapshot: (pids) => live
        ? identitySnapshot(pids)
        : { identities: new Map(), complete: true },
      signalProcess: (pid, signal) => {
        if (signal === 0) {
          if (!live) throw noSuchProcess();
          return;
        }
        signals.push([pid, signal]);
        live = false;
      },
      recoveryNow: () => clock,
      recoveryWait: async (delayMs) => { clock += delayMs; },
    })).resolves.toBe(1);
    expect(signals).toEqual([[-PROCESS.pid, 'SIGTERM']]);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('complete');
  });

  it('keeps a never-observed token-only process record fail-closed', async () => {
    const { store, directory } = await lifecycleStore(false);
    store.lifecycleHooks(INVOCATION).onLifecycleToken(TOKEN);
    let clock = 0;
    await expect(store.recoverPendingLifecycleProcesses(directory, 25, {
      platform: 'linux',
      discoverWorkerProcesses: () => ({ processes: [], complete: true }),
      readIdentitySnapshot: () => ({ identities: new Map(), complete: true }),
      signalProcess: (_pid, signal) => {
        if (signal !== 0) throw new Error('an unauthenticated identity must not be signaled');
      },
      recoveryNow: () => clock,
      recoveryWait: async (delayMs) => { clock += delayMs; },
    })).rejects.toThrow(/could not be recovered safely/u);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('failed');
  });

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
      [-PROCESS.pid, 'SIGTERM'],
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
    expect(signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL', 'SIGKILL']);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('failed');

    survives = false;
    await expect(store.recoverPendingLifecycleProcesses(directory, 25, inspection)).resolves.toBe(1);
    expect(retryObservations).toBe(4);
    expect(signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL', 'SIGKILL']);
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
    expect(signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL', 'SIGKILL']);
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

  it('signals a token-bearing descendant that appears after the first recovery snapshot', async () => {
    const { store, directory } = await lifecycleStore();
    const lateProcess = {
      ...PROCESS,
      pid: PROCESS.pid + 1,
      pgrp: PROCESS.pgrp + 1,
      starttime: 'late-linux-process-start',
    };
    let clock = 0;
    let observations = 0;
    let descendantLive = true;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const absent = Object.assign(new Error('absent'), { code: 'ESRCH' });
    await expect(store.recoverPendingLifecycleProcesses(directory, 50, {
      platform: 'linux',
      discoverWorkerProcesses: () => {
        observations++;
        if (observations === 1 || !descendantLive) return { processes: [], complete: true };
        return { processes: [lateProcess], complete: true };
      },
      readIdentitySnapshot: (pids) => ({
        identities: new Map(descendantLive && pids.includes(lateProcess.pid)
          ? [[lateProcess.pid, { pgrp: lateProcess.pgrp, starttime: lateProcess.starttime }]]
          : []),
        complete: true,
      }),
      signalProcess: (pid, signal) => {
        if (signal === 0) throw absent;
        signals.push([pid, signal]);
        if (pid === -lateProcess.pid) descendantLive = false;
      },
      recoveryNow: () => clock,
      recoveryWait: async (delayMs) => { clock += delayMs; },
    })).resolves.toBe(1);
    expect(signals).toEqual([[-lateProcess.pid, 'SIGTERM']]);
  });
});

describe('Linux token discovery completeness', () => {
  it('classifies only ESRCH as absent and retains EPERM as live', () => {
    const error = (code: string) => Object.assign(new Error(code), { code });
    expect(signal0Status(-PROCESS.pgrp, { signalProcess: () => { throw error('ESRCH'); } })).toBe('absent');
    expect(signal0Status(-PROCESS.pgrp, { signalProcess: () => { throw error('EPERM'); } })).toBe('alive');
    expect(signal0Status(-PROCESS.pgrp, { signalProcess: () => { throw error('EINVAL'); } })).toBe('unknown');
  });

  it('accepts a stable same-EUID unreadable environment in the non-root sweep', () => {
    const discovery = discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, {
      platform: 'linux',
      readLinuxEffectiveUid: () => 2_000,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessOwner: () => 2_000,
      readLinuxProcessIdentity: () => ({ pgrp: PROCESS.pgrp, starttime: PROCESS.starttime }),
      readLinuxProcessEnvironment: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      signalProcess: () => {},
    });
    expect(discovery).toEqual({ processes: [], complete: true });
  });

  it('accepts a procfs read race only after ESRCH proves the candidate exited', () => {
    const discovery = discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, {
      platform: 'linux',
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessOwner: () => process.getuid!(),
      readLinuxProcessIdentity: () => undefined,
      signalProcess: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    });
    expect(discovery).toEqual({ processes: [], complete: true });
  });

  it('skips unreadable different-EUID processes without blocking settlement', async () => {
    const effectiveUid = 2_000;
    let environmentReads = 0;
    const inspection = (uid: number): ProcessInspectionOptions => ({
      platform: 'linux',
      readLinuxEffectiveUid: () => effectiveUid,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => ({ pgrp: PROCESS.pgrp, starttime: PROCESS.starttime }),
      readLinuxProcessOwner: () => uid,
      readLinuxProcessEnvironment: () => {
        environmentReads++;
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
      signalProcess: () => {},
    });
    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, inspection(effectiveUid + 1)))
      .toEqual({ processes: [], complete: true });
    expect(environmentReads).toBe(0);
    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, inspection(effectiveUid)))
      .toEqual({ processes: [], complete: true });
    expect(environmentReads).toBe(1);

    let clock = 0;
    await expect(signalWorkerProcessTokensUntilGone(
      [TOKEN], 'SIGKILL', '/worker-scope', 10,
      {
        ...inspection(effectiveUid + 1),
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    )).resolves.toMatchObject({ settled: true, processes: 0 });
  });

  it('accepts hidepid enumeration for the same-EUID non-root scope', () => {
    const inspection = (effectiveUid: number): ProcessInspectionOptions => ({
      platform: 'linux',
      readLinuxEffectiveUid: () => effectiveUid,
      readLinuxProcMountInfo: () => procMountInfo('rw,hidepid=2'),
      listLinuxProcessIds: () => [],
    });

    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, inspection(1_000)))
      .toEqual({ processes: [], complete: true });
    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, inspection(0)))
      .toEqual({ processes: [], complete: true });
  });

  it.each(['4', 'ptraceable'])('rejects hidepid=%s as an incomplete process listing', (mode) => {
    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, {
      platform: 'linux',
      readLinuxEffectiveUid: () => 1_000,
      listLinuxProcessIds: () => [],
      readLinuxProcMountInfo: () => procMountInfo(`rw,hidepid=${mode}`),
    })).toEqual({ processes: [], complete: false });
  });

  it('fails closed when non-root procfs visibility cannot be identified', () => {
    const inspect = (
      mountInfo: string,
      effectiveUid: number | undefined,
    ): ProcessInspectionOptions => ({
      platform: 'linux',
      readLinuxEffectiveUid: () => effectiveUid,
      readLinuxProcMountInfo: () => mountInfo,
      listLinuxProcessIds: () => [],
    });

    expect(discoverWorkerProcessesForTokens(
      [TOKEN], '/worker-scope', undefined, inspect(procMountInfo('rw,hidepid=off'), 1_000),
    )).toEqual({ processes: [], complete: true });
    expect(discoverWorkerProcessesForTokens(
      [TOKEN], '/worker-scope', undefined, inspect('malformed mountinfo\n', 1_000),
    )).toEqual({ processes: [], complete: false });
    expect(discoverWorkerProcessesForTokens(
      [TOKEN], '/worker-scope', undefined, inspect(procMountInfo('rw,hidepid=2'), undefined),
    )).toEqual({ processes: [], complete: false });
  });

  it('rejects malformed and subtree proc mounts even for effective root', () => {
    const inspect = (mountInfo: string, effectiveUid: number): ProcessInspectionOptions => ({
      platform: 'linux',
      readLinuxEffectiveUid: () => effectiveUid,
      readLinuxProcMountInfo: () => mountInfo,
      listLinuxProcessIds: () => [],
    });
    const truncated = '31 24 0:27 / /proc rw,nosuid - proc\n';
    const subtree = procMountInfo('rw', `/${PROCESS.pid}`);

    expect(discoverWorkerProcessesForTokens(
      [TOKEN], '/worker-scope', undefined, inspect(truncated, 0),
    )).toEqual({ processes: [], complete: false });
    expect(discoverWorkerProcessesForTokens(
      [TOKEN], '/worker-scope', undefined, inspect(subtree, 0),
    )).toEqual({ processes: [], complete: false });
    expect(discoverWorkerProcessesForTokens(
      [TOKEN], '/worker-scope', undefined, inspect(subtree, 1_000),
    )).toEqual({ processes: [], complete: false });
  });

  it('does not inspect a readable process owned by another EUID', () => {
    const scope = '/worker-scope';
    let effectiveUidReads = 0;
    let environmentReads = 0;
    const discovery = discoverWorkerProcessesForTokens([TOKEN], scope, undefined, {
      platform: 'linux',
      readLinuxEffectiveUid: () => {
        effectiveUidReads++;
        return 2_000;
      },
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => ({ pgrp: PROCESS.pgrp, starttime: PROCESS.starttime }),
      readLinuxProcessOwner: () => 1_000,
      readLinuxProcessEnvironment: () => {
        environmentReads++;
        return [
          `ULTRACODE_WORKER_TOKEN=${TOKEN}`,
          `ULTRACODE_WORKER_SCOPE=${workerScopeValue(scope)}`,
        ].join('\0');
      },
    });
    expect(effectiveUidReads).toBe(1);
    expect(environmentReads).toBe(0);
    expect(discovery).toEqual({ processes: [], complete: true });
  });

  it('retains the host-wide sweep when ultracode runs as root', () => {
    const scope = '/worker-scope';
    const discovery = discoverWorkerProcessesForTokens([TOKEN], scope, undefined, {
      platform: 'linux',
      readLinuxEffectiveUid: () => 0,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => ({ pgrp: PROCESS.pgrp, starttime: PROCESS.starttime }),
      readLinuxProcessOwner: () => 1_000,
      readLinuxProcessEnvironment: () => [
        `ULTRACODE_WORKER_TOKEN=${TOKEN}`,
        `ULTRACODE_WORKER_SCOPE=${workerScopeValue(scope)}`,
      ].join('\0'),
    });
    expect(discovery).toEqual({ processes: [PROCESS], complete: true });
  });

  it('fails closed when non-root owner metadata is unavailable', () => {
    const scope = '/worker-scope';
    let environmentReads = 0;
    const discovery = discoverWorkerProcessesForTokens([TOKEN], scope, undefined, {
      platform: 'linux',
      readLinuxEffectiveUid: () => 1_000,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => ({ pgrp: PROCESS.pgrp, starttime: PROCESS.starttime }),
      readLinuxProcessOwner: () => undefined,
      readLinuxProcessEnvironment: () => {
        environmentReads++;
        return [
          `ULTRACODE_WORKER_TOKEN=${TOKEN}`,
          `ULTRACODE_WORKER_SCOPE=${workerScopeValue(scope)}`,
        ].join('\0');
      },
      signalProcess: () => {},
    });
    expect(environmentReads).toBe(0);
    expect(discovery).toEqual({ processes: [], complete: false });
  });

  it('does not require a pre-spawn baseline for stable same-EUID unreadable processes', () => {
    const baseline = snapshotLinuxProcessIdentities({
      platform: 'linux',
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => ({ pgrp: PROCESS.pgrp, starttime: '100' }),
    });
    const inspection = (starttime: string): ProcessInspectionOptions => ({
      platform: 'linux',
      excludedLinuxProcessIdentities: baseline,
      readLinuxEffectiveUid: () => 2_000,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => ({ pgrp: PROCESS.pgrp, starttime }),
      readLinuxProcessOwner: () => 2_000,
      readLinuxProcessEnvironment: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      signalProcess: () => {},
    });
    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, inspection('100')))
      .toEqual({ processes: [], complete: true });
    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, inspection('101')))
      .toEqual({ processes: [], complete: true });
  });

  it.each([
    {
      relationship: 'exact pre-spawn identity',
      candidate: { state: 'S', pgrp: PROCESS.pid, session: PROCESS.pid, starttime: '100' },
      leaders: new Map<number, { state: string; pgrp: number; session?: number; starttime: string }>(),
      baseline: new Set([`${PROCESS.pid}:100:${PROCESS.pid}`]),
    },
    {
      relationship: 'exact pre-spawn process group',
      candidate: { state: 'S', pgrp: PROCESS.pid + 20, session: PROCESS.pid + 20, starttime: '300' },
      leaders: new Map([[PROCESS.pid + 20, {
        state: 'S', pgrp: PROCESS.pid + 20, session: PROCESS.pid + 20, starttime: '100',
      }]]),
      baseline: new Set([`${PROCESS.pid + 20}:100:${PROCESS.pid + 20}`]),
    },
    {
      relationship: 'exact pre-spawn session',
      candidate: { state: 'S', pgrp: PROCESS.pid, session: PROCESS.pid + 30, starttime: '300' },
      leaders: new Map([[PROCESS.pid + 30, {
        state: 'S', pgrp: PROCESS.pid + 30, session: PROCESS.pid + 30, starttime: '100',
      }]]),
      baseline: new Set([`${PROCESS.pid + 30}:100:${PROCESS.pid + 30}`]),
    },
  ])('keeps a readable marked candidate actionable despite $relationship', ({
    candidate,
    leaders,
    baseline,
  }) => {
    const scope = '/worker-scope';
    let environmentReads = 0;
    const discovery = discoverWorkerProcessesForTokens([TOKEN], scope, undefined, {
      platform: 'linux',
      excludedLinuxProcessIdentities: baseline,
      readLinuxEffectiveUid: () => 1_000,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: (pid) => pid === PROCESS.pid ? candidate : leaders.get(pid),
      readLinuxProcessOwner: () => 1_000,
      readLinuxProcessEnvironment: () => {
        environmentReads++;
        return [
          `ULTRACODE_WORKER_TOKEN=${TOKEN}`,
          `ULTRACODE_WORKER_SCOPE=${workerScopeValue(scope)}`,
        ].join('\0');
      },
    });

    expect(environmentReads).toBe(1);
    expect(discovery).toEqual({
      processes: [{ pid: PROCESS.pid, token: TOKEN, ...candidate }],
      complete: true,
    });
  });

  it('does not authenticate a readable token across PID identity reuse', () => {
    const scope = '/worker-scope';
    let identityReads = 0;
    const discovery = discoverWorkerProcessesForTokens([TOKEN], scope, undefined, {
      platform: 'linux',
      readLinuxEffectiveUid: () => 1_000,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => ({
        pgrp: PROCESS.pgrp,
        starttime: identityReads++ === 0 ? 'before' : 'replacement',
      }),
      readLinuxProcessOwner: () => 1_000,
      readLinuxProcessEnvironment: () => [
        `ULTRACODE_WORKER_TOKEN=${TOKEN}`,
        `ULTRACODE_WORKER_SCOPE=${workerScopeValue(scope)}`,
      ].join('\0'),
      signalProcess: () => {},
    });

    expect(discovery).toEqual({ processes: [], complete: false });
  });

  it('does not let an unreadable zombie invalidate live-process absence', () => {
    const discovery = discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, {
      platform: 'linux',
      readLinuxEffectiveUid: () => 0,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => ({ state: 'Z', pgrp: PROCESS.pgrp, starttime: '300' }),
      readLinuxProcessOwner: () => process.getuid!(),
      readLinuxProcessEnvironment: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      signalProcess: () => {},
    });
    expect(discovery).toEqual({ processes: [], complete: true });
  });

  it('ignores unreadable Linux kernel workers with process group zero', () => {
    let environmentReads = 0;
    const discovery = discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, {
      platform: 'linux',
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => ({ state: 'S', pgrp: 0, starttime: '300' }),
      readLinuxProcessOwner: () => 0,
      readLinuxProcessEnvironment: () => {
        environmentReads++;
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
      signalProcess: () => {},
    });
    expect(discovery).toEqual({ processes: [], complete: true });
    expect(environmentReads).toBe(0);
  });

  it.each([
    ['zombie', { state: 'Z', pgrp: PROCESS.pgrp, starttime: '300' }],
    ['process-group-zero worker', { state: 'S', pgrp: 0, starttime: '300' }],
  ])('does not apply the %s exemption across PID reuse', (_kind, before) => {
    let identityReads = 0;
    let environmentReads = 0;
    const discovery = discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, {
      platform: 'linux',
      readLinuxEffectiveUid: () => 1_000,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => identityReads++ === 0
        ? before
        : { state: 'S', pgrp: PROCESS.pgrp, starttime: 'replacement' },
      readLinuxProcessOwner: () => 1_000,
      readLinuxProcessEnvironment: () => {
        environmentReads++;
        return '';
      },
      signalProcess: () => {},
    });

    expect(discovery).toEqual({ processes: [], complete: false });
    expect(identityReads).toBe(2);
    expect(environmentReads).toBe(0);
  });

  it('excludes new members of an exact pre-spawn process group', () => {
    const leaderPid = PROCESS.pid + 20;
    const leader = { state: 'S', pgrp: leaderPid, starttime: '100' };
    const candidate = { state: 'S', pgrp: leaderPid, starttime: '300' };
    const baseline = new Set([`${leaderPid}:${leader.starttime}:${leader.pgrp}`]);
    let environmentReads = 0;
    const inspection = (leaderStarttime: string): ProcessInspectionOptions => ({
      platform: 'linux',
      excludedLinuxProcessIdentities: baseline,
      readLinuxEffectiveUid: () => 0,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: (pid) => pid === PROCESS.pid
        ? candidate
        : pid === leaderPid
          ? { ...leader, starttime: leaderStarttime }
          : undefined,
      readLinuxProcessOwner: () => 0,
      readLinuxProcessEnvironment: () => {
        environmentReads++;
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
      signalProcess: () => {},
    });
    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, inspection('100')))
      .toEqual({ processes: [], complete: true });
    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, inspection('101')))
      .toEqual({ processes: [], complete: false });
    expect(environmentReads).toBe(2);
  });

  it('excludes new process groups in an exact pre-spawn session', () => {
    const sessionPid = PROCESS.pid + 30;
    const sessionLeader = { state: 'S', pgrp: sessionPid, session: sessionPid, starttime: '100' };
    const candidate = {
      state: 'S',
      pgrp: PROCESS.pid,
      session: sessionPid,
      starttime: '300',
    };
    const baseline = new Set([`${sessionPid}:${sessionLeader.starttime}:${sessionLeader.pgrp}`]);
    const inspection = (sessionStarttime: string): ProcessInspectionOptions => ({
      platform: 'linux',
      excludedLinuxProcessIdentities: baseline,
      readLinuxEffectiveUid: () => 0,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: (pid) => pid === PROCESS.pid
        ? candidate
        : pid === sessionPid
          ? { ...sessionLeader, starttime: sessionStarttime }
          : undefined,
      readLinuxProcessOwner: () => 0,
      readLinuxProcessEnvironment: () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
      signalProcess: () => {},
    });
    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, inspection('100')))
      .toEqual({ processes: [], complete: true });
    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, inspection('101')))
      .toEqual({ processes: [], complete: false });
  });

  it('keeps descendants of pre-spawn markerless daemons completeness-relevant', () => {
    const parentPid = PROCESS.pid + 1;
    const parent = { state: 'S', ppid: 1, pgrp: parentPid, starttime: '100' };
    const child = { state: 'S', ppid: parentPid, pgrp: PROCESS.pgrp, starttime: '300' };
    const parentKey = `${parentPid}:${parent.starttime}:${parent.pgrp}`;
    const inspection: ProcessInspectionOptions = {
      platform: 'linux',
      excludedLinuxProcessIdentities: new Set([parentKey]),
      readLinuxEffectiveUid: () => 0,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: (pid) => pid === PROCESS.pid ? child : pid === parentPid ? parent : undefined,
      readLinuxProcessOwner: () => process.getuid!(),
      readLinuxProcessEnvironment: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      signalProcess: () => {},
    };
    expect(discoverWorkerProcessesForTokens([TOKEN], '/worker-scope', undefined, inspection))
      .toEqual({ processes: [], complete: false });
  });

  it('discovers a token descendant reparented behind a markerless daemon', () => {
    const scope = '/worker-scope';
    const daemonPid = PROCESS.pid + 11;
    const commonPid = PROCESS.pid + 12;
    const identities = new Map([
      [PROCESS.pid, { state: 'S', ppid: daemonPid, pgrp: PROCESS.pgrp, starttime: '400' }],
      [daemonPid, { state: 'S', ppid: commonPid, pgrp: daemonPid, starttime: '300' }],
      [commonPid, { state: 'S', ppid: 1, pgrp: commonPid, starttime: '100' }],
    ]);
    const key = (pid: number) => {
      const identity = identities.get(pid)!;
      return `${pid}:${identity.starttime}:${identity.pgrp}`;
    };
    const inspection: ProcessInspectionOptions = {
      platform: 'linux',
      excludedLinuxProcessIdentities: new Set([key(daemonPid), key(commonPid)]),
      readLinuxEffectiveUid: () => 1_000,
      listLinuxProcessIds: () => [String(PROCESS.pid), String(daemonPid)],
      readLinuxProcessIdentity: (pid) => identities.get(pid),
      readLinuxProcessOwner: () => 1_000,
      readLinuxProcessEnvironment: (pid) => pid === PROCESS.pid
        ? [
            `ULTRACODE_WORKER_TOKEN=${TOKEN}`,
            `ULTRACODE_WORKER_SCOPE=${workerScopeValue(scope)}`,
          ].join('\0')
        : '',
      signalProcess: () => {},
    };
    expect(discoverWorkerProcessesForTokens([TOKEN], scope, undefined, inspection))
      .toEqual({
        processes: [{ ...PROCESS, state: 'S', ppid: daemonPid, starttime: '400' }],
        complete: true,
      });
  });
});

describe('Linux live process settlement', () => {
  it('retries a child that survives an authenticated group signal', async () => {
    const groupLeader = {
      pid: 301,
      pgrp: 301,
      starttime: 'leader-start',
      token: TOKEN,
    };
    const groupChild = {
      pid: 302,
      pgrp: 301,
      starttime: 'child-start',
      token: 'c'.repeat(32),
    };
    let leaderLive = true;
    let childLive = true;
    let clock = 0;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const result = await signalWorkerProcessTokensUntilGone(
      [groupLeader.token, groupChild.token],
      'SIGTERM',
      '/worker-scope',
      50,
      {
        platform: 'linux',
        discoverWorkerProcesses: () => ({
          processes: [
            ...(leaderLive ? [groupLeader] : []),
            ...(childLive ? [groupChild] : []),
          ],
          complete: true,
        }),
        readIdentitySnapshot: (pids) => ({
          identities: new Map(pids.flatMap((pid) => {
            if (pid === groupLeader.pid && leaderLive) {
              return [[pid, {
                pgrp: groupLeader.pgrp,
                starttime: groupLeader.starttime,
              }]];
            }
            if (pid === groupChild.pid && childLive) {
              return [[pid, {
                pgrp: groupChild.pgrp,
                starttime: groupChild.starttime,
              }]];
            }
            return [];
          })),
          complete: true,
        }),
        signalProcess: (pid, signal) => {
          if (signal === 0) throw noSuchProcess();
          signals.push([pid, signal]);
          if (pid === -groupLeader.pid) leaderLive = false;
          if (pid === groupChild.pid) childLive = false;
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    );

    expect(result.settled).toBe(true);
    expect(result.processes).toBe(2);
    expect(signals).toEqual([
      [-groupLeader.pid, 'SIGTERM'],
      [groupChild.pid, 'SIGTERM'],
    ]);
  });

  it('does not count an incomplete empty observation and signals a later live process', async () => {
    let clock = 0;
    let observations = 0;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const result = await signalWorkerProcessTokensUntilGone(
      [TOKEN],
      'SIGKILL',
      '/worker-scope',
      100,
      {
        platform: 'linux',
        discoverWorkerProcesses: (tokens) => {
          observations++;
          if (observations === 1) return { processes: [], complete: false };
          if (observations === 2) {
            return { processes: [{ ...PROCESS, token: tokens[0]! }], complete: true };
          }
          return { processes: [], complete: true };
        },
        readLinuxProcessIdentity: (pid) => pid === PROCESS.pid
          ? { pgrp: PROCESS.pgrp, starttime: PROCESS.starttime }
          : undefined,
        signalProcess: (pid, signal) => {
          if (signal === 0) throw noSuchProcess();
          signals.push([pid, signal]);
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    );

    expect(result.settled).toBe(true);
    expect(observations).toBe(4);
    expect(signals).toEqual([[-PROCESS.pid, 'SIGKILL']]);
  });

  it('settles only after two complete empty observations', async () => {
    let clock = 0;
    let observations = 0;
    const result = await signalWorkerProcessTokensUntilGone(
      [TOKEN],
      'SIGKILL',
      '/worker-scope',
      5,
      {
        platform: 'linux',
        discoverWorkerProcesses: () => {
          observations++;
          return { processes: [], complete: true };
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    );

    expect(result.settled).toBe(true);
    expect(observations).toBe(2);
    expect(clock).toBe(5);
  });

  it('reports persistent incomplete observations and deadline-limited absence as unsettled', async () => {
    let clock = 0;
    const incomplete = await signalWorkerProcessTokensUntilGone(
      [TOKEN],
      'SIGKILL',
      '/worker-scope',
      10,
      {
        platform: 'linux',
        discoverWorkerProcesses: () => ({ processes: [], complete: false }),
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    );
    expect(incomplete.settled).toBe(false);

    const deadline = await signalWorkerProcessTokensUntilGone(
      [TOKEN],
      'SIGKILL',
      '/worker-scope',
      0,
      {
        platform: 'linux',
        discoverWorkerProcesses: () => ({ processes: [], complete: true }),
        observationNow: () => clock,
        observationWait: async () => { throw new Error('deadline must not wait'); },
      },
    );
    expect(deadline.settled).toBe(false);
  });
});

describe('Linux benchmark process settlement', () => {
  it('does not derive a start floor from a token-bearing replacement of the leader PID', async () => {
    const scope = '/worker-scope';
    const descendantPid = 2_147_483_000;
    const descendant = { pid: descendantPid, pgrp: descendantPid, starttime: '100' };
    let token = '';
    let initialSnapshot = true;
    let descendantAlive = true;
    let clock = 0;
    const signals: Array<[number, NodeJS.Signals]> = [];

    const result = await runBenchProcess(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      workerScope: scope,
      terminationGraceMs: 100,
      onLifecycleToken: (value) => { token = value; },
      processInspection: {
        platform: 'linux',
        listLinuxProcessIds: () => {
          if (initialSnapshot) {
            initialSnapshot = false;
            return [];
          }
          return descendantAlive ? [String(descendantPid)] : [];
        },
        readLinuxProcessIdentity: (pid) => {
          if (pid === descendantPid) return descendantAlive ? descendant : undefined;
          return { pgrp: pid, starttime: '999999999999' };
        },
        readLinuxProcessOwner: () => 1_000,
        readLinuxEffectiveUid: () => 1_000,
        readLinuxProcessEnvironment: () => [
          `ULTRACODE_WORKER_TOKEN=${token}`,
          `ULTRACODE_WORKER_SCOPE=${workerScopeValue(scope)}`,
        ].join('\0'),
        signalProcess: (pid, signal) => {
          if (signal === 0) throw noSuchProcess();
          signals.push([pid, signal]);
          if (pid === -descendantPid) descendantAlive = false;
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(signals).toEqual([[-descendantPid, 'SIGTERM']]);
  });

  it('ignores an incomplete empty pass, signals a later live descendant, and then recovers', async () => {
    let clock = 0;
    let observations = 0;
    const signals: Array<[number, NodeJS.Signals]> = [];
    let recovered = false;
    let processLive = true;
    const result = await runBenchProcess(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      terminationGraceMs: 100,
      processInspection: {
        platform: 'linux',
        discoverWorkerProcesses: (tokens) => {
          observations++;
          if (observations === 1) return { processes: [], complete: false };
          if (observations === 2 || observations === 3) {
            return { processes: [{ ...PROCESS, token: tokens[0]! }], complete: true };
          }
          return { processes: [], complete: true };
        },
        readLinuxProcessIdentity: (pid) => processLive && pid === PROCESS.pid
          ? { pgrp: PROCESS.pgrp, starttime: PROCESS.starttime }
          : undefined,
        signalProcess: (pid, signal) => {
          if (signal === 0) throw noSuchProcess();
          signals.push([pid, signal]);
          processLive = false;
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
      onLifecycleRecovered: (_token, recovery) => { recovered = recovery === 'complete'; },
    });

    expect(result.exitCode).toBe(0);
    expect(observations).toBe(5);
    expect(signals).toEqual([[-PROCESS.pid, 'SIGTERM']]);
    expect(recovered).toBe(true);
  });

  it('keeps lifecycle recovery pending across incomplete cleanup and completes it on retry', async () => {
    const { store, directory } = await lifecycleStore(false);
    const lifecycle = store.lifecycleHooks(INVOCATION);
    let clock = 0;
    let complete = false;
    const inspection: ProcessInspectionOptions = {
      platform: 'linux',
      discoverWorkerProcesses: () => ({ processes: [], complete }),
      readLinuxProcessIdentity: () => undefined,
      signalProcess: () => { throw noSuchProcess(); },
      observationNow: () => clock,
      observationWait: async (delayMs) => { clock += delayMs; },
    };

    try {
      await expect(runBenchProcess(process.execPath, ['-e', ''], {
        cwd: directory,
        workerScope: directory,
        terminationGraceMs: 10,
        processInspection: inspection,
        ...lifecycle,
      })).rejects.toThrow(/descendant cleanup failed/);
      expect(store.load().invocations[0]?.lifecycleProcesses).toEqual([
        expect.objectContaining({ recovery: 'pending' }),
      ]);
      await expect(cleanupActiveBenchProcesses(10)).rejects.toThrow(/verified stable absence/);
      expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('pending');

      complete = true;
      await expect(cleanupActiveBenchProcesses(25)).resolves.toBe(1);
      expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('complete');
      await expect(cleanupActiveBenchProcesses(0)).resolves.toBe(0);
    } finally {
      complete = true;
      await cleanupActiveBenchProcesses(25).catch(() => {});
    }
  });

  it('does not report a one-pass complete observation at the deadline as cleanup', async () => {
    let clock = 0;
    let recovered = false;
    let graceExpired = true;
    const inspection: ProcessInspectionOptions = {
      platform: 'linux',
      discoverWorkerProcesses: () => ({ processes: [], complete: true }),
      readLinuxProcessIdentity: () => undefined,
      signalProcess: () => { throw noSuchProcess(); },
      observationNow: () => clock,
      observationWait: async (delayMs) => {
        if (graceExpired) throw new Error('zero-grace cleanup must not wait');
        clock += delayMs;
      },
    };

    try {
      await expect(runBenchProcess(process.execPath, ['-e', ''], {
        cwd: process.cwd(),
        terminationGraceMs: 0,
        processInspection: inspection,
        onLifecycleRecovered: () => { recovered = true; },
      })).rejects.toThrow(/descendant cleanup failed/);
      expect(recovered).toBe(false);

      graceExpired = false;
      await expect(cleanupActiveBenchProcesses(25)).resolves.toBe(1);
      expect(recovered).toBe(true);
    } finally {
      graceExpired = false;
      await cleanupActiveBenchProcesses(25).catch(() => {});
    }
  });
});

describe('process stop settlement', () => {
  it('does not report success until token recovery reaches verified absence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-stop-settlement-'));
    roots.push(root);
    const runId = newRunId();
    const directory = createRunDir(root, {
      runId,
      name: 'settlement',
      source: 'return null',
      args: null,
      config: { backend: 'mock', cwd: root },
    });
    const run = getRun(root, runId)!;
    writeManifest(directory, {
      ...run.manifest,
      status: 'stopped',
      endedAt: new Date().toISOString(),
    });
    mkdirSync(workerRecordDir(directory, 0), { recursive: true });
    writeFileSync(
      workerRecordPath(directory, 0, 1),
      `${PROCESS.pid} ${PROCESS.starttime} ${TOKEN}`,
    );

    let clock = 0;
    let complete = false;
    const inspection: ProcessInspectionOptions = {
      platform: 'linux',
      discoverWorkerProcesses: () => ({ processes: [], complete }),
      observationNow: () => clock,
      observationWait: async (delayMs) => { clock += delayMs; },
    };
    const incomplete = await stopRun(root, runId, inspection);
    expect(incomplete).toMatchObject({ ok: false, status: 'cleanup-failed' });
    expect(incomplete.message).toMatch(/could not verify stable process absence/);
    expect(readManifest(directory)?.status).toBe('cleanup-failed');

    complete = true;
    const recovered = await stopRun(root, runId, inspection);
    expect(recovered).toMatchObject({ ok: true, status: 'stopped' });
    expect(recovered.message).toContain('worker cleanup scan settled; marked stopped');
    expect(readManifest(directory)?.status).toBe('stopped');
  });

  it('settles a non-root run when only stable same-EUID environments are unreadable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-stop-forged-floor-'));
    roots.push(root);
    const runId = newRunId();
    const directory = createRunDir(root, {
      runId,
      name: 'forged-floor',
      source: 'return null',
      args: null,
      config: { backend: 'mock', cwd: root },
    });
    const run = getRun(root, runId)!;
    writeManifest(directory, {
      ...run.manifest,
      status: 'cleanup-failed',
      endedAt: new Date().toISOString(),
      error: 'worker cleanup incomplete',
    });
    mkdirSync(workerRecordDir(directory, 0), { recursive: true });
    writeFileSync(workerRecordPath(directory, 0, 1), `${PROCESS.pid} 999999999999 ${TOKEN}`);
    let clock = 0;

    const result = await stopRun(root, runId, {
      platform: 'linux',
      readLinuxEffectiveUid: () => 1_000,
      listLinuxProcessIds: () => [String(PROCESS.pid)],
      readLinuxProcessIdentity: () => ({ pgrp: PROCESS.pgrp, starttime: '100' }),
      readLinuxProcessOwner: () => 1_000,
      readLinuxProcessEnvironment: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      signalProcess: () => {},
      observationNow: () => clock,
      observationWait: async (delayMs) => { clock += delayMs; },
    });
    expect(result).toMatchObject({ ok: true, status: 'stopped' });
    expect(result.message).toContain('worker cleanup scan settled; marked stopped');
    expect(readManifest(directory)?.status).toBe('stopped');
    expect(isResumableStatus(readManifest(directory)!.status)).toBe(true);
  });
});
