/** Offline lifecycle-lease, run-state CAS, and verifier-receipt coverage. */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireBenchLock,
  assertRecoveredClaimOwnsRunDirectory,
  BenchLockHandle,
  clearClaimedRunDirectory,
  markClaimedRunDirectory,
} from '../../bench/src/shared/locks.js';
import {
  createBenchPathRoots,
  createPrivateRunDirectory,
  runClaimFile,
  runDir,
  runLeaseFile,
} from '../../bench/src/shared/paths.js';
import { BenchRunStateStore } from '../../bench/src/shared/run-state.js';
import type { ProcessInspectionOptions } from '../../src/exec/procinfo.js';
import {
  createVerifierBinding,
  UNVERIFIED_NATIVE_RESULT,
  VerifierReceiptStore,
} from '../../bench/src/shared/verifier.js';

const HASH = 'a'.repeat(64);
const INVOCATION = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const DARWIN_LOCK_START = 'darwin:Mon_Jul_20_12:00:00_2026';

const temporary = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'uc-bench-control-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function staleDarwinLock(): Promise<{
  privateRoot: string;
  path: string;
  owner: BenchLockHandle['owner'];
}> {
  const paths = createBenchPathRoots(temporary());
  const path = join(paths.cacheRoot, 'stale.lock');
  const held = await acquireBenchLock(paths.cacheRoot, path);
  const owner = {
    ...held.owner,
    pid: 424_242,
    processStartIdentity: DARWIN_LOCK_START,
    createdAt: '2026-07-20T12:00:00.000Z',
  };
  held.release();
  writeFileSync(path, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  return { privateRoot: paths.cacheRoot, path, owner };
}

async function recoverDarwinLock(
  inspection: ProcessInspectionOptions,
): Promise<BenchLockHandle> {
  const stale = await staleDarwinLock();
  return acquireBenchLock(stale.privateRoot, stale.path, {
    recoverStale: true,
    now: () => new Date('2026-07-21T12:00:00.000Z'),
    observationDelayMs: 1,
    processInspection: inspection,
  });
}

function processError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('run lifecycle control state', () => {
  it('holds an exclusive private lease and enforces run-state revisions', async () => {
    const paths = createBenchPathRoots(temporary());
    createPrivateRunDirectory(paths, 'featurebench', 'pilot1');
    const leasePath = runLeaseFile(paths, 'featurebench', 'pilot1');
    const lease = await acquireBenchLock(paths.resultsRoot, leasePath);
    expect(statSync(leasePath).mode & 0o777).toBe(0o600);
    await expect(acquireBenchLock(paths.resultsRoot, leasePath)).rejects.toThrow(/already held/);

    const store = new BenchRunStateStore(paths, 'featurebench', 'pilot1', HASH, lease);
    expect(store.initialize().revision).toBe(0);
    const updated = await store.update(0, (state) => ({
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
    expect(updated.revision).toBe(1);
    const lifecycle = store.lifecycleHooks(INVOCATION);
    const token = 'b'.repeat(32);
    lifecycle.onLifecycleToken(token);
    lifecycle.onLifecycleStarted(token, 1234, '5678');
    expect(store.load().invocations[0]?.lifecycleProcesses).toEqual([{
      token,
      pid: 1234,
      processStartIdentity: '5678',
      recovery: 'pending',
    }]);
    lifecycle.onLifecycleRecovered(token, 'complete');
    expect(store.load().invocations[0]?.lifecycleProcesses[0]?.recovery).toBe('complete');
    const queued = store.updateCurrent((state) => ({ ...state }));
    const concurrentToken = 'e'.repeat(32);
    lifecycle.onLifecycleToken(concurrentToken);
    lifecycle.onLifecycleStarted(concurrentToken, 4321, '8765');
    lifecycle.onLifecycleRecovered(concurrentToken, 'complete');
    await queued;
    expect(store.load().invocations[0]?.lifecycleProcesses.at(-1)).toEqual({
      token: concurrentToken,
      pid: 4321,
      processStartIdentity: '8765',
      recovery: 'complete',
    });
    const retriedToken = 'f'.repeat(32);
    lifecycle.onLifecycleToken(retriedToken);
    lifecycle.onLifecycleStarted(retriedToken, 2_000_000_000, 'unreachable');
    lifecycle.onLifecycleRecovered(retriedToken, 'failed');
    await expect(store.closeInterruptedInvocations()).rejects.toThrow(/unsettled descendants/);
    let recoveryClock = 0;
    await expect(store.recoverPendingLifecycleProcesses(
      runDir(paths, 'featurebench', 'pilot1'),
      1,
      {
        platform: 'linux',
        discoverWorkerProcesses: () => ({ processes: [], complete: true }),
        readIdentitySnapshot: () => ({ identities: new Map(), complete: true }),
        signalProcess: (_pid, signal) => {
          if (signal === 0) throw processError('ESRCH');
        },
        recoveryNow: () => recoveryClock,
        recoveryWait: async (delayMs) => { recoveryClock += delayMs; },
      },
    )).resolves.toBe(1);
    expect(recoveryClock).toBeGreaterThan(0);
    expect(store.load().invocations[0]?.lifecycleProcesses.at(-1)?.recovery).toBe('complete');
    expect(() => lifecycle.onLifecycleStarted('c'.repeat(32), 1235, '5679')).toThrow(/unknown lifecycle token/);
    expect(() => store.lifecycleHooks('22222222-2222-4222-8222-222222222222')
      .onLifecycleToken('d'.repeat(32))).toThrow(/unknown lifecycle invocation/);
    await expect(store.update(0, (state) => state)).rejects.toThrow(/revision mismatch/);
    await expect(store.closeInterruptedInvocations(
      'driver-interrupted',
      new Date('2026-07-20T12:02:00.000Z'),
    )).resolves.toBe(1);
    expect(store.load().invocations[0]).toMatchObject({
      endedAt: '2026-07-20T12:02:00.000Z',
      exitCode: 1,
      signal: 'interrupted',
      failure: 'driver-interrupted',
    });
    await expect(store.closeInterruptedInvocations()).resolves.toBe(0);
    lease.release();
    expect(() => lease.assertHeld()).toThrow(/released/);
  });

  it('does not create a missing run while acquiring an existing-run lease', async () => {
    const paths = createBenchPathRoots(temporary());
    mkdirSync(paths.resultsRoot, { mode: 0o700 });
    await expect(acquireBenchLock(
      paths.resultsRoot,
      runLeaseFile(paths, 'featurebench', 'missing'),
      { createParent: false },
    )).rejects.toThrow();
    expect(() => statSync(runDir(paths, 'featurebench', 'missing'))).toThrow();
  });

  it('requires the exact recovered claim before reclaiming an incomplete run', async () => {
    const paths = createBenchPathRoots(temporary());
    const claim = await acquireBenchLock(
      paths.resultsRoot,
      runClaimFile(paths, 'featurebench', 'pilot1'),
    );
    const directory = createPrivateRunDirectory(paths, 'featurebench', 'pilot1');
    const recovered = new BenchLockHandle(claim.privateRoot, claim.path, claim.owner, claim.owner);
    expect(() => assertRecoveredClaimOwnsRunDirectory(directory, recovered)).not.toThrow();
    const unowned = join(directory, 'unowned');
    writeFileSync(unowned, 'content');
    expect(() => assertRecoveredClaimOwnsRunDirectory(directory, recovered)).toThrow();
    rmSync(unowned);
    markClaimedRunDirectory(directory, claim);
    expect(() => assertRecoveredClaimOwnsRunDirectory(directory, recovered)).not.toThrow();
    const wrongPrior = { ...claim.owner, nonce: 'f'.repeat(64) };
    const mismatched = new BenchLockHandle(claim.privateRoot, claim.path, claim.owner, wrongPrior);
    expect(() => assertRecoveredClaimOwnsRunDirectory(directory, mismatched)).toThrow(/does not belong/);
    clearClaimedRunDirectory(directory, claim);
    claim.release();
  });

  it('binds exact native evidence and permits record-level bindings to one aggregate', async () => {
    const paths = createBenchPathRoots(temporary());
    const directory = createPrivateRunDirectory(paths, 'swebench-pro', 'pilot1');
    mkdirSync(join(directory, 'native', 'eval'), { recursive: true });
    writeFileSync(join(directory, 'native', 'eval', 'eval_results.json'), '{"task-one":true}\n');
    const lease = await acquireBenchLock(paths.resultsRoot, runLeaseFile(paths, 'swebench-pro', 'pilot1'));
    const store = new VerifierReceiptStore(paths, 'swebench-pro', 'pilot1', HASH, lease);
    expect(store.initialize(new Date('2026-07-20T12:00:00.000Z')).revision).toBe(0);
    const first = createVerifierBinding(runDir(paths, 'swebench-pro', 'pilot1'), {
      invocationId: INVOCATION,
      scope: { kind: 'task-arm', taskId: 'task-one', arm: 'a' },
      role: 'native-result',
      path: 'native/eval/eval_results.json',
      nativeRecordKey: 'task-one',
    });
    const second = {
      ...first,
      scope: { kind: 'suite-check' as const, name: 'aggregate' },
      nativeRecordKey: 'aggregate',
    };
    expect(() => createVerifierBinding(runDir(paths, 'swebench-pro', 'pilot1'), {
      invocationId: INVOCATION,
      scope: { kind: 'task-arm', taskId: 'task-one', arm: 'a' },
      role: 'native-result',
      path: 'native/eval/eval_results.json',
      nativeRecordKey: 'task-one',
    }, 'b'.repeat(64))).toThrow(/changed between parsing and binding/);
    expect(() => createVerifierBinding(runDir(paths, 'swebench-pro', 'pilot1'), {
      invocationId: INVOCATION,
      scope: { kind: 'task-arm', taskId: 'task-one', arm: 'a' },
      role: 'native-result',
      path: 'run-state.json',
      nativeRecordKey: 'task-one',
    })).toThrow(/beneath native/);
    const receipt = await store.update(0, () => [first, second], new Date('2026-07-20T12:01:00.000Z'));
    expect(receipt.bindings).toHaveLength(2);
    expect(receipt.bindings[0]?.sha256).toBe(receipt.bindings[1]?.sha256);
    expect(UNVERIFIED_NATIVE_RESULT).toEqual({
      verification: 'unverified', score: null, resolved: null, artifact: null,
    });
    lease.release();
  });
});

describe('Darwin stale benchmark lock recovery', () => {
  it('does not treat an incomplete empty identity snapshot as absence', async () => {
    let probes = 0;
    await expect(recoverDarwinLock({
      platform: 'darwin',
      readIdentitySnapshot: () => ({ identities: new Map(), complete: false }),
      signalProcess: () => { probes++; },
    })).rejects.toThrow(/still running or unverifiable/);
    expect(probes).toBe(0);
  });

  it.each([
    ['a successful signal-0 probe', undefined],
    ['an EPERM signal-0 probe', 'EPERM'],
  ])('treats %s as a live owner', async (_label, errorCode) => {
    await expect(recoverDarwinLock({
      platform: 'darwin',
      readIdentitySnapshot: () => ({ identities: new Map(), complete: true }),
      signalProcess: () => {
        if (errorCode !== undefined) throw processError(errorCode);
      },
    })).rejects.toThrow(/still running or unverifiable/);
  });

  it('rejects mixed absent and live observations', async () => {
    let probes = 0;
    await expect(recoverDarwinLock({
      platform: 'darwin',
      readIdentitySnapshot: () => ({ identities: new Map(), complete: true }),
      signalProcess: () => {
        probes++;
        if (probes === 1) throw processError('ESRCH');
      },
    })).rejects.toThrow(/not stably absent/);
    expect(probes).toBe(2);
  });

  it('recovers only after two complete snapshots and two ESRCH probes', async () => {
    let snapshots = 0;
    let probes = 0;
    const recovered = await recoverDarwinLock({
      platform: 'darwin',
      readIdentitySnapshot: () => {
        snapshots++;
        return { identities: new Map(), complete: true };
      },
      signalProcess: () => {
        probes++;
        throw processError('ESRCH');
      },
    });
    expect(snapshots).toBe(2);
    expect(probes).toBe(2);
    expect(recovered.recoveredOwner).toMatchObject({
      pid: 424_242,
      processStartIdentity: DARWIN_LOCK_START,
    });
    recovered.release();
  });

  it('uses two positive identity mismatches to prove PID reuse', async () => {
    let snapshots = 0;
    let probes = 0;
    const recovered = await recoverDarwinLock({
      platform: 'darwin',
      readIdentitySnapshot: (pids) => {
        snapshots++;
        return {
          identities: new Map([[pids[0]!, {
            pgrp: pids[0]!,
            starttime: 'darwin:Tue_Jul_21_12:00:00_2026',
          }]]),
          complete: false,
        };
      },
      signalProcess: () => { probes++; },
    });
    expect(snapshots).toBe(2);
    expect(probes).toBe(0);
    recovered.release();
  });

  it('retains a changed nonce-bearing lock instead of unlinking it', async () => {
    const stale = await staleDarwinLock();
    let snapshots = 0;
    await expect(acquireBenchLock(stale.privateRoot, stale.path, {
      recoverStale: true,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      observationDelayMs: 1,
      processInspection: {
        platform: 'darwin',
        readIdentitySnapshot: (pids) => {
          snapshots++;
          if (snapshots === 2) {
            const replacementNonce = stale.owner.nonce === 'f'.repeat(64)
              ? 'e'.repeat(64)
              : 'f'.repeat(64);
            writeFileSync(stale.path, `${JSON.stringify({
              ...stale.owner,
              nonce: replacementNonce,
            }, null, 2)}\n`, { mode: 0o600 });
          }
          return {
            identities: new Map([[pids[0]!, {
              pgrp: pids[0]!,
              starttime: 'darwin:Tue_Jul_21_12:00:00_2026',
            }]]),
            complete: true,
          };
        },
      },
    })).rejects.toThrow(/lock changed during recovery/);
    expect(() => statSync(stale.path)).not.toThrow();
  });

  it('serializes concurrent stale recoverers through one exclusive recovery guard', async () => {
    const stale = await staleDarwinLock();
    const recover = () => acquireBenchLock(stale.privateRoot, stale.path, {
      recoverStale: true,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      observationDelayMs: 10,
      processInspection: {
        platform: 'darwin',
        readIdentitySnapshot: (pids) => ({
          identities: new Map([[pids[0]!, {
            pgrp: pids[0]!,
            starttime: 'darwin:Tue_Jul_21_12:00:00_2026',
          }]]),
          complete: true,
        }),
      },
    });
    const settled = await Promise.allSettled([recover(), recover()]);
    const handles = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    expect(handles).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ message: expect.stringMatching(/recovery is already in progress/) });
    handles[0]!.release();
  });

  it('keeps a matching start identity live without probing or unlinking', async () => {
    let probes = 0;
    await expect(recoverDarwinLock({
      platform: 'darwin',
      readIdentitySnapshot: (pids) => ({
        identities: new Map([[pids[0]!, { pgrp: pids[0]!, starttime: DARWIN_LOCK_START }]]),
        complete: true,
      }),
      signalProcess: () => { probes++; },
    })).rejects.toThrow(/still running or unverifiable/);
    expect(probes).toBe(0);
  });
});
