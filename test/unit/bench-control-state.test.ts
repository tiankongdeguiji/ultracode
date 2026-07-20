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
import {
  createVerifierBinding,
  UNVERIFIED_NATIVE_RESULT,
  VerifierReceiptStore,
} from '../../bench/src/shared/verifier.js';

const HASH = 'a'.repeat(64);
const INVOCATION = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

const temporary = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'uc-bench-control-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
    await expect(store.recoverPendingLifecycleProcesses(runDir(paths, 'featurebench', 'pilot1'), 0)).resolves.toBe(1);
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
