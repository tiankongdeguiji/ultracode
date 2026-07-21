/** Platform-seamed Darwin lifecycle recovery without live process or network use. */
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
import { BenchRunStateStore } from '../../bench/src/shared/run-state.js';
import { workerScopeValue, type ProcessInspectionOptions } from '../../src/exec/procinfo.js';

const HASH = 'a'.repeat(64);
const INVOCATION = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'b'.repeat(32);
const DIRECT_START = 'darwin:Mon_Jul_20_11:59:59_2026';
const CANDIDATE_START = 'darwin:Mon_Jul_20_12:00:00_2026';
const SECOND_CANDIDATE_START = 'darwin:Mon_Jul_20_12:00:01_2026';
const STARTED = 'Mon Jul 20 12:00:00 2026';
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

function noSuchProcess(): Error {
  return Object.assign(new Error('no such process'), { code: 'ESRCH' });
}

describe('Darwin benchmark lifecycle recovery', () => {
  it('replays and reaps a persisted setsid descendant identity', async () => {
    const { store, directory } = await lifecycleStore();
    store.lifecycleHooks(INVOCATION).onLifecycleCandidates(TOKEN, [{
      pid: 202,
      pgrp: 202,
      starttime: CANDIDATE_START,
    }], true);
    const scope = workerScopeValue(directory);
    let escapedLive = true;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const inspection: ProcessInspectionOptions = {
      platform: 'darwin',
      executePs: (argv) => {
        if (argv.includes('command=')) {
          if (!escapedLive) return '';
          const command = `202 202 ${STARTED} /usr/bin/node escaped.js`;
          return argv.includes('-E')
            ? `${command} ULTRACODE_WORKER_TOKEN=${TOKEN} ULTRACODE_WORKER_SCOPE=${scope}`
            : command;
        }
        const requested = argv[argv.indexOf('-p') + 1]?.split(',').map(Number) ?? [];
        return requested.includes(202) && escapedLive ? `202 202 ${STARTED}` : '';
      },
      signalProcess: (pid, signal) => {
        if (signal === 0) throw noSuchProcess();
        signals.push([pid, signal]);
        if (pid === -202) escapedLive = false;
      },
    };

    await expect(store.recoverPendingLifecycleProcesses(directory, 1_000, inspection)).resolves.toBe(1);
    expect(signals).toContainEqual([-202, 'SIGTERM']);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]).toMatchObject({
      recovery: 'complete',
      darwinCandidateInventory: {
        complete: true,
        processes: expect.arrayContaining([expect.objectContaining({ pid: 202, pgrp: 202 })]),
      },
    });
  });

  it('fails closed when the durable candidate inventory is absent', async () => {
    const { store, directory } = await lifecycleStore();
    const signals: number[] = [];
    await expect(store.recoverPendingLifecycleProcesses(directory, 0, {
      platform: 'darwin',
      executePs: () => '',
      signalProcess: (pid, signal) => {
        if (signal !== 0) signals.push(pid);
        throw noSuchProcess();
      },
    })).rejects.toThrow(/could not be recovered safely/);
    expect(signals).toEqual([]);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('failed');
  });

  it('does not turn ps failures into verified process absence', async () => {
    const { store, directory } = await lifecycleStore();
    store.lifecycleHooks(INVOCATION).onLifecycleCandidates(TOKEN, [{
      pid: 202,
      pgrp: 202,
      starttime: CANDIDATE_START,
    }], true);
    const signals: number[] = [];
    await expect(store.recoverPendingLifecycleProcesses(directory, 0, {
      platform: 'darwin',
      executePs: () => { throw new Error('ps failed'); },
      signalProcess: (pid, signal) => {
        if (signal === 0) throw noSuchProcess();
        signals.push(pid);
      },
    })).rejects.toThrow(/could not be recovered safely/);
    expect(signals).toEqual([]);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('failed');
  });

  it('treats a reused candidate PID as absent without signaling the replacement', async () => {
    const { store, directory } = await lifecycleStore();
    store.lifecycleHooks(INVOCATION).onLifecycleCandidates(TOKEN, [{
      pid: 202,
      pgrp: 202,
      starttime: CANDIDATE_START,
    }], true);
    const signals: number[] = [];
    await expect(store.recoverPendingLifecycleProcesses(directory, 1_000, {
      platform: 'darwin',
      executePs: (argv) => argv.includes('command=')
        ? ''
        : `202 202 Tue Jul 21 12:00:00 2026`,
      signalProcess: (pid, signal) => {
        if (signal === 0) throw noSuchProcess();
        signals.push(pid);
      },
    })).resolves.toBe(1);
    expect(signals).toEqual([]);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('complete');
  });

  it('re-authenticates each persisted candidate at its individual signal boundary', async () => {
    const { store, directory } = await lifecycleStore();
    const candidates = [
      { pid: 202, pgrp: 202, starttime: CANDIDATE_START },
      { pid: 303, pgrp: 303, starttime: SECOND_CANDIDATE_START },
    ];
    store.lifecycleHooks(INVOCATION).onLifecycleCandidates(TOKEN, candidates, true);
    const marked = new Set(candidates.map((candidate) => candidate.pid));
    const byPid = new Map(candidates.map((candidate) => [candidate.pid, candidate]));
    const signals: number[] = [];

    await expect(store.recoverPendingLifecycleProcesses(directory, 0, {
      platform: 'darwin',
      discoverWorkerProcesses: (tokens, _scope, candidatePids) => ({
        complete: true,
        processes: (candidatePids ?? candidates.map((candidate) => candidate.pid))
          .filter((pid) => marked.has(pid))
          .map((pid) => ({ ...byPid.get(pid)!, token: tokens[0]! })),
      }),
      // The second PID is replaced inside the same public lstart second after
      // the first signal; only its missing lifecycle markers distinguish it.
      readIdentitySnapshot: () => ({
        complete: true,
        identities: new Map([[303, byPid.get(303)!]]),
      }),
      signalProcess: (pid, signal) => {
        if (signal === 0) throw noSuchProcess();
        signals.push(pid);
        marked.clear();
      },
    })).rejects.toThrow(/could not be recovered safely/u);

    expect(signals).toEqual([-202]);
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('failed');
  });

  it('allows a settlement interval after SIGKILL before declaring recovery failed', async () => {
    const { store, directory } = await lifecycleStore();
    store.lifecycleHooks(INVOCATION).onLifecycleCandidates(TOKEN, [{
      pid: 202,
      pgrp: 202,
      starttime: CANDIDATE_START,
    }], true);
    const scope = workerScopeValue(directory);
    let live = true;
    const signals: NodeJS.Signals[] = [];
    const inspection: ProcessInspectionOptions = {
      platform: 'darwin',
      executePs: (argv) => {
        if (!live) return '';
        if (argv.includes('command=')) {
          const command = `202 202 ${STARTED} /usr/bin/node escaped.js`;
          return argv.includes('-E')
            ? `${command} ULTRACODE_WORKER_TOKEN=${TOKEN} ULTRACODE_WORKER_SCOPE=${scope}`
            : command;
        }
        return `202 202 ${STARTED}`;
      },
      signalProcess: (pid, signal) => {
        if (signal === 0) {
          if (!live) throw noSuchProcess();
          return;
        }
        if (pid === -202) {
          signals.push(signal);
          if (signal === 'SIGKILL') setTimeout(() => { live = false; }, 10);
        }
      },
    };
    await expect(store.recoverPendingLifecycleProcesses(directory, 50, inspection)).resolves.toBe(1);
    expect(signals).toContain('SIGKILL');
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('complete');
  });
});
