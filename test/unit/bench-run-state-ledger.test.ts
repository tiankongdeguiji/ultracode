/** Append-only benchmark run-state ledger durability and scaling coverage. */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireBenchLock, type BenchLockHandle } from '../../bench/src/shared/locks.js';
import {
  createBenchPathRoots,
  createPrivateRunDirectory,
  runLeaseFile,
  runStateFile,
  runStateLedgerDir,
  writePrivateJsonAtomic,
} from '../../bench/src/shared/paths.js';
import { canonicalJson } from '../../bench/src/shared/provenance.js';
import {
  MAX_RUN_STATE_LEDGER_RECORD_BYTES,
  type RunStateLedgerOptions,
} from '../../bench/src/shared/run-state-ledger.js';
import {
  BenchRunStateStore,
  createBenchRunState,
  loadBenchRunStateEvidence,
  type AttemptRecord,
} from '../../bench/src/shared/run-state.js';

const HASH = 'a'.repeat(64);
const INVOCATION = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const leases: BenchLockHandle[] = [];

const temporary = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'uc-bench-ledger-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const lease of leases.splice(0)) {
    try {
      lease.release();
    } catch {
      // Corruption tests may intentionally make the containing run unreadable.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function invocation() {
  return {
    invocationId: INVOCATION,
    command: 'run' as const,
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: null,
    activeElapsedMs: null,
    exitCode: null,
    signal: null,
    lifecycleProcesses: [],
    failure: null,
    nativeInvocation: 'native' as never,
  };
}

function attempt(index: number, taskId = `task-${index}`, nativePath = 'native'): AttemptRecord {
  return {
    attemptId: uuid(index),
    invocationId: INVOCATION,
    taskId,
    arm: 'a',
    ordinal: 1,
    phase: 'session',
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: '2026-07-20T12:00:01.000Z',
    elapsedMs: 1_000,
    nativePath: nativePath as never,
    exitCode: 0,
    signal: null,
    status: 'succeeded',
    failures: [],
    annotations: [],
  };
}

async function createStore(runId: string, options: RunStateLedgerOptions = {}) {
  const paths = createBenchPathRoots(temporary());
  createPrivateRunDirectory(paths, 'featurebench', runId);
  const lease = await acquireBenchLock(paths.resultsRoot, runLeaseFile(paths, 'featurebench', runId));
  leases.push(lease);
  const store = new BenchRunStateStore(paths, 'featurebench', runId, HASH, lease, options);
  store.initialize();
  return { paths, lease, store };
}

async function addInvocation(store: BenchRunStateStore): Promise<void> {
  await store.updateCurrent((state) => ({ ...state, invocations: [...state.invocations, invocation()] }));
}

async function addAttempt(store: BenchRunStateStore, record: AttemptRecord): Promise<void> {
  await store.updateCurrent((state) => ({ ...state, attempts: [...state.attempts, record] }));
}

function ledgerBytes(directory: string): number {
  return readdirSync(directory).reduce((total, name) => total + statSync(join(directory, name)).size, 0);
}

function rewriteLastRecord(
  paths: ReturnType<typeof createBenchPathRoots>,
  runId: string,
  change: (record: Record<string, unknown>, head: Record<string, unknown>) => void,
): void {
  const directory = runStateLedgerDir(paths, 'featurebench', runId);
  const segment = join(directory, readdirSync(directory).sort().at(-1)!);
  const records = readFileSync(segment, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const headPath = runStateFile(paths, 'featurebench', runId);
  const head = JSON.parse(readFileSync(headPath, 'utf8')) as Record<string, unknown>;
  const record = records.at(-1)!;
  change(record, head);
  const body = { ...record };
  delete body.hash;
  record.hash = createHash('sha256').update(canonicalJson(body)).digest('hex');
  head.ledgerRootSha256 = record.hash;
  const contents = `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  writeFileSync(segment, contents, { mode: 0o600 });
  writePrivateJsonAtomic(join(paths.resultsRoot, 'featurebench', runId), headPath, head);
}

describe('run-state append-only ledger', () => {
  it('replays concurrent worker updates exactly and durably publishes lifecycle identity', async () => {
    const { paths, lease, store } = await createStore('concurrent');
    await addInvocation(store);
    const lifecycle = store.lifecycleHooks(INVOCATION);
    const token = 'b'.repeat(32);
    lifecycle.onLifecycleToken(token);
    lifecycle.onLifecycleStarted(token, 4_321, 'process-start-identity');
    const reservations = new BenchRunStateStore(paths, 'featurebench', 'concurrent', HASH, lease).load();
    expect(reservations.invocations[0]?.lifecycleProcesses).toEqual([{
      token,
      pid: 4_321,
      processStartIdentity: 'process-start-identity',
      recovery: 'pending',
    }]);

    await Promise.all(Array.from({ length: 64 }, (_, index) => addAttempt(store, attempt(index + 1))));
    const expected = store.load();
    const replayed = new BenchRunStateStore(paths, 'featurebench', 'concurrent', HASH, lease).load();
    expect(replayed).toEqual(expected);
    expect(replayed.attempts).toHaveLength(64);
    expect(replayed.revision).toBe(67);
  });

  it('keeps serialized growth linear when history doubles', async () => {
    const measure = async (runId: string, count: number): Promise<number> => {
      const { paths, store } = await createStore(runId);
      await addInvocation(store);
      for (let index = 0; index < count; index += 1) await addAttempt(store, attempt(index + 1));
      return ledgerBytes(runStateLedgerDir(paths, 'featurebench', runId));
    };
    const n = await measure('linear-n', 100);
    const twoN = await measure('linear-2n', 200);
    expect(twoN / n).toBeLessThanOrEqual(2.2);
  });

  it('recovers both sides of rotation commit crashes without changing sealed segments', async () => {
    let armed = false;
    let crashPoint: 'after-ledger-fsync' | 'after-head-fsync' = 'after-ledger-fsync';
    const options: RunStateLedgerOptions = {
      segmentMaximumBytes: 4 * 1_024,
      onCrashPoint(point) {
        if (armed && point === crashPoint) {
          armed = false;
          throw new Error(`simulated ${point}`);
        }
      },
    };
    const { paths, lease, store } = await createStore('rotation-crash', options);
    await addInvocation(store);
    const segmentZero = join(runStateLedgerDir(paths, 'featurebench', 'rotation-crash'), '0000000000000000.jsonl');
    armed = true;
    await expect(addAttempt(store, attempt(1, 'x'.repeat(3_500)))).rejects.toThrow(/simulated after-ledger/);
    const sealedBytes = readFileSync(segmentZero);
    const afterUncommitted = new BenchRunStateStore(
      paths, 'featurebench', 'rotation-crash', HASH, lease, { segmentMaximumBytes: 4 * 1_024 },
    );
    expect(afterUncommitted.load().attempts).toHaveLength(0);
    await addAttempt(afterUncommitted, attempt(1, 'x'.repeat(3_500)));
    expect(readFileSync(segmentZero)).toEqual(sealedBytes);

    crashPoint = 'after-head-fsync';
    armed = true;
    const afterHeadStore = new BenchRunStateStore(paths, 'featurebench', 'rotation-crash', HASH, lease, options);
    await expect(addAttempt(afterHeadStore, attempt(2, 'y'.repeat(3_500)))).rejects.toThrow(/simulated after-head/);
    const replayed = new BenchRunStateStore(
      paths, 'featurebench', 'rotation-crash', HASH, lease, { segmentMaximumBytes: 4 * 1_024 },
    ).load();
    expect(replayed.attempts.map((entry) => entry.taskId)).toEqual(['x'.repeat(3_500), 'y'.repeat(3_500)]);
    expect(readdirSync(runStateLedgerDir(paths, 'featurebench', 'rotation-crash'))).toHaveLength(3);
  });

  it('removes an empty next-segment orphan before the next append', async () => {
    const { paths, lease, store } = await createStore('empty-rotation-orphan');
    await addInvocation(store);
    const orphan = join(
      runStateLedgerDir(paths, 'featurebench', 'empty-rotation-orphan'),
      '0000000000000001.jsonl',
    );
    writeFileSync(orphan, '', { mode: 0o600 });
    expect(store.load().revision).toBe(1);
    await addAttempt(store, attempt(1));
    expect(readdirSync(runStateLedgerDir(paths, 'featurebench', 'empty-rotation-orphan')))
      .toEqual(['0000000000000000.jsonl']);
    expect(new BenchRunStateStore(
      paths, 'featurebench', 'empty-rotation-orphan', HASH, lease,
    ).load().attempts).toHaveLength(1);
  });

  it('tolerates one torn final record and truncates it before the next commit', async () => {
    const { paths, lease, store } = await createStore('torn-final');
    await addInvocation(store);
    const directory = runStateLedgerDir(paths, 'featurebench', 'torn-final');
    const segment = join(directory, '0000000000000000.jsonl');
    appendFileSync(segment, '{"schemaVersion":1');
    const restarted = new BenchRunStateStore(paths, 'featurebench', 'torn-final', HASH, lease);
    expect(restarted.load().revision).toBe(1);
    await addAttempt(restarted, attempt(1));
    expect(new BenchRunStateStore(paths, 'featurebench', 'torn-final', HASH, lease).load().attempts).toHaveLength(1);
  });

  it('rejects malformed interior records, revision gaps, and duplicate indexes', async () => {
    const malformed = await createStore('malformed');
    await addInvocation(malformed.store);
    await addAttempt(malformed.store, attempt(1));
    const malformedSegment = join(runStateLedgerDir(malformed.paths, 'featurebench', 'malformed'), '0000000000000000.jsonl');
    const lines = readFileSync(malformedSegment, 'utf8').split('\n');
    lines[1] = 'x'.repeat(lines[1]!.length);
    writeFileSync(malformedSegment, lines.join('\n'), { mode: 0o600 });
    expect(() => new BenchRunStateStore(
      malformed.paths, 'featurebench', 'malformed', HASH, malformed.lease,
    ).load()).toThrow(/malformed/);

    const gap = await createStore('revision-gap');
    await addInvocation(gap.store);
    rewriteLastRecord(gap.paths, 'revision-gap', (record, head) => {
      record.revision = 2;
      head.revision = 2;
    });
    expect(() => new BenchRunStateStore(gap.paths, 'featurebench', 'revision-gap', HASH, gap.lease).load())
      .toThrow(/revisions are not contiguous/);

    const duplicate = await createStore('duplicate-index');
    await addInvocation(duplicate.store);
    rewriteLastRecord(duplicate.paths, 'duplicate-index', (record) => {
      record.recordIndex = 0;
    });
    expect(() => new BenchRunStateStore(
      duplicate.paths, 'featurebench', 'duplicate-index', HASH, duplicate.lease,
    ).load()).toThrow(/record indexes are not contiguous/);
  });

  it('rejects hash drift, symlinks, oversized records, and non-private modes', async () => {
    const hash = await createStore('hash-drift');
    await addInvocation(hash.store);
    const hashSegment = join(runStateLedgerDir(hash.paths, 'featurebench', 'hash-drift'), '0000000000000000.jsonl');
    const hashRecords = readFileSync(hashSegment, 'utf8').trimEnd().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    hashRecords.at(-1)!.hash = 'f'.repeat(64);
    writeFileSync(hashSegment, `${hashRecords.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 });
    expect(() => new BenchRunStateStore(hash.paths, 'featurebench', 'hash-drift', HASH, hash.lease).load())
      .toThrow(/hash mismatch/);

    const linked = await createStore('symlink');
    const linkedSegment = join(runStateLedgerDir(linked.paths, 'featurebench', 'symlink'), '0000000000000000.jsonl');
    renameSync(linkedSegment, `${linkedSegment}.target`);
    symlinkSync(`${linkedSegment}.target`, linkedSegment);
    expect(lstatSync(linkedSegment).isSymbolicLink()).toBe(true);
    expect(() => new BenchRunStateStore(linked.paths, 'featurebench', 'symlink', HASH, linked.lease).load()).toThrow();

    const oversized = await createStore('oversized');
    const oversizedSegment = join(runStateLedgerDir(oversized.paths, 'featurebench', 'oversized'), '0000000000000000.jsonl');
    await addInvocation(oversized.store);
    const hugePath = Array.from({ length: 9_000 }, () => 'z'.repeat(120)).join('/');
    await expect(addAttempt(oversized.store, attempt(1, 'too-large', hugePath))).rejects.toThrow(/record exceeds/);
    expect(new BenchRunStateStore(
      oversized.paths, 'featurebench', 'oversized', HASH, oversized.lease,
    ).load().attempts).toHaveLength(0);
    appendFileSync(oversizedSegment, Buffer.alloc(MAX_RUN_STATE_LEDGER_RECORD_BYTES + 1, 0x20));
    expect(() => new BenchRunStateStore(
      oversized.paths, 'featurebench', 'oversized', HASH, oversized.lease,
    ).load()).toThrow(/more than one torn final record/);

    const permissions = await createStore('permissions');
    const permissionsSegment = join(runStateLedgerDir(permissions.paths, 'featurebench', 'permissions'), '0000000000000000.jsonl');
    chmodSync(permissionsSegment, 0o644);
    expect(() => new BenchRunStateStore(
      permissions.paths, 'featurebench', 'permissions', HASH, permissions.lease,
    ).load()).toThrow(/mode 0600/);
  });

  it('revalidates committed segment ancestry before a warm-store append', async () => {
    const { paths, lease, store } = await createStore('warm-corruption');
    await addInvocation(store);
    const segment = join(runStateLedgerDir(paths, 'featurebench', 'warm-corruption'), '0000000000000000.jsonl');
    const bytes = readFileSync(segment, 'utf8');
    expect(bytes).toContain('"command":"run"');
    writeFileSync(segment, bytes.replace('"command":"run"', '"command":"rux"'), { mode: 0o600 });
    utimesSync(segment, new Date(0), new Date(0));
    await expect(addAttempt(store, attempt(1))).rejects.toThrow(/hash mismatch/);
    expect(() => new BenchRunStateStore(
      paths, 'featurebench', 'warm-corruption', HASH, lease,
    ).load()).toThrow(/hash mismatch/);
  });

  it('loads legacy v2 read-only and migrates it only when explicitly requested', async () => {
    const paths = createBenchPathRoots(temporary());
    const directory = createPrivateRunDirectory(paths, 'featurebench', 'legacy');
    const lease = await acquireBenchLock(paths.resultsRoot, runLeaseFile(paths, 'featurebench', 'legacy'));
    leases.push(lease);
    const legacy = {
      ...createBenchRunState('featurebench', 'legacy', HASH),
      revision: 7,
      invocations: [invocation()],
      attempts: [attempt(1)],
    };
    writePrivateJsonAtomic(directory, runStateFile(paths, 'featurebench', 'legacy'), legacy);
    const store = new BenchRunStateStore(paths, 'featurebench', 'legacy', HASH, lease);
    expect(store.load()).toEqual(legacy);
    await expect(store.updateCurrent((state) => state)).rejects.toThrow(/read-only/);
    expect(store.migrateLegacy()).toEqual(legacy);
    const evidence = loadBenchRunStateEvidence(paths, 'featurebench', 'legacy', HASH);
    const head = JSON.parse(readFileSync(runStateFile(paths, 'featurebench', 'legacy'), 'utf8')) as {
      ledgerRootSha256: string;
    };
    expect(evidence.ledgerRootSha256).toBe(head.ledgerRootSha256);
    await store.updateCurrent((state) => state);
    expect(new BenchRunStateStore(paths, 'featurebench', 'legacy', HASH, lease).load().revision).toBe(8);

    const crashPaths = createBenchPathRoots(temporary());
    const crashDirectory = createPrivateRunDirectory(crashPaths, 'featurebench', 'migration-crash');
    const crashLease = await acquireBenchLock(
      crashPaths.resultsRoot,
      runLeaseFile(crashPaths, 'featurebench', 'migration-crash'),
    );
    leases.push(crashLease);
    const crashLegacy = createBenchRunState('featurebench', 'migration-crash', HASH);
    writePrivateJsonAtomic(
      crashDirectory,
      runStateFile(crashPaths, 'featurebench', 'migration-crash'),
      crashLegacy,
    );
    const crashing = new BenchRunStateStore(crashPaths, 'featurebench', 'migration-crash', HASH, crashLease, {
      onCrashPoint(point) {
        if (point === 'after-migration-rename') throw new Error('simulated migration crash');
      },
    });
    expect(() => crashing.migrateLegacy()).toThrow(/simulated migration crash/);
    expect(loadBenchRunStateEvidence(crashPaths, 'featurebench', 'migration-crash', HASH).ledgerRootSha256).toBeNull();
    const retry = new BenchRunStateStore(crashPaths, 'featurebench', 'migration-crash', HASH, crashLease);
    expect(retry.migrateLegacy()).toEqual(crashLegacy);
  });

  it('bounds stale migration storage and exposes an idempotent production upgrade', async () => {
    const paths = createBenchPathRoots(temporary());
    const directory = createPrivateRunDirectory(paths, 'featurebench', 'legacy-auto');
    const lease = await acquireBenchLock(paths.resultsRoot, runLeaseFile(paths, 'featurebench', 'legacy-auto'));
    leases.push(lease);
    const legacy = createBenchRunState('featurebench', 'legacy-auto', HASH);
    writePrivateJsonAtomic(directory, runStateFile(paths, 'featurebench', 'legacy-auto'), legacy);
    for (const name of [
      '.run-state-ledger.migration.tmp',
      `.run-state-ledger.${'b'.repeat(32)}.tmp`,
    ]) {
      const stale = join(directory, name);
      mkdirSync(stale, { mode: 0o700 });
      writeFileSync(join(stale, 'stale'), 'stale', { mode: 0o600 });
    }
    const store = new BenchRunStateStore(paths, 'featurebench', 'legacy-auto', HASH, lease);
    expect(store.migrateLegacyIfNeeded()).toBe(true);
    expect(store.migrateLegacyIfNeeded()).toBe(false);
    expect(store.load()).toEqual(legacy);
    expect(readdirSync(directory).filter((name) => name.includes('.run-state-ledger.'))).toEqual([]);
  });

  it('streams histories larger than the former 64 MiB monolith limit', { timeout: 120_000 }, async () => {
    const { paths, lease, store } = await createStore('large-history');
    await addInvocation(store);
    const component = 'p'.repeat(120);
    const pathA = Array.from({ length: 4_300 }, () => component).join('/');
    const pathB = `${pathA.slice(0, -1)}q`;
    await addAttempt(store, attempt(1, 'large-task', pathA));
    for (let index = 0; index < 130; index += 1) {
      const nativePath = index % 2 === 0 ? pathB : pathA;
      await store.updateCurrent((state) => ({
        ...state,
        attempts: state.attempts.map((entry) => ({ ...entry, nativePath: nativePath as never })),
      }));
    }
    const directory = runStateLedgerDir(paths, 'featurebench', 'large-history');
    expect(ledgerBytes(directory)).toBeGreaterThan(64 * 1_024 * 1_024);
    const replayed = new BenchRunStateStore(paths, 'featurebench', 'large-history', HASH, lease).load();
    expect(replayed.revision).toBe(132);
    expect(replayed.attempts[0]?.nativePath).toBe(pathA);
  });
});
