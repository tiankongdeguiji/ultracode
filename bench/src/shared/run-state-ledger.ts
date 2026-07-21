/**
 * Append-only benchmark run-state storage. A small atomic head commits one
 * hash-chained prefix while bounded JSONL segments make replay independent of
 * total history size.
 */
import { createHash, type Hash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BenchPathRoots, BenchSuite } from './contracts.js';
import { canonicalJson, sha256Schema } from './provenance.js';
import {
  ensurePrivateDirectoryWithin,
  fsyncDirectory,
  readPrivateFile,
  requirePrivateDirectoryWithin,
  runDir,
  runStateFile,
  runStateLedgerDir,
  writePrivateJsonAtomic,
} from './paths.js';
import type { BenchRunState } from './run-state.js';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const ZERO_HASH = '0'.repeat(64);
const SEGMENT_NAME_RE = /^(\d{16})\.jsonl$/;
const MIGRATION_TEMP_NAME = '.run-state-ledger.migration.tmp';
const MIGRATION_TEMP_RE = /^\.run-state-ledger\.(?:migration|[a-f0-9]{32})\.tmp$/;
const CHANGE_PATH_KEY_RE = /^(?!__proto__$|prototype$|constructor$)[A-Za-z][A-Za-z0-9]*$/;

export const MAX_RUN_STATE_LEDGER_RECORD_BYTES = 1 * 1_024 * 1_024;
export const MAX_RUN_STATE_LEDGER_SEGMENT_BYTES = 8 * 1_024 * 1_024;
const MAX_LEDGER_HEAD_BYTES = 64 * 1_024;

const changePathSchema = z.array(z.union([
  z.string().regex(CHANGE_PATH_KEY_RE),
  z.number().int().nonnegative(),
])).min(1).max(16);

const ledgerChangeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('set'), path: changePathSchema, value: z.unknown() }),
  z.strictObject({ op: z.literal('delete'), path: changePathSchema }),
  z.strictObject({ op: z.literal('append'), path: changePathSchema, value: z.unknown() }),
  z.strictObject({ op: z.literal('truncate'), path: changePathSchema, length: z.number().int().nonnegative() }),
]);

export type RunStateLedgerChange = z.infer<typeof ledgerChangeSchema>;
type LedgerChange = RunStateLedgerChange;

const ledgerPayloadSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('snapshot'), state: z.unknown() }),
  z.strictObject({ type: z.literal('delta'), changes: z.array(ledgerChangeSchema).max(100_000) }),
]);

const ledgerRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('ultracode-benchmark-run-state-ledger-record'),
  segmentIndex: z.number().int().nonnegative().max(10_000),
  segmentRecordIndex: z.number().int().nonnegative().max(100_000),
  recordIndex: z.number().int().nonnegative().max(1_000_000_000),
  revision: z.number().int().nonnegative(),
  revisionIndex: z.number().int().nonnegative(),
  revisionRecords: z.number().int().positive().max(1_000_000),
  previousHash: sha256Schema,
  payload: ledgerPayloadSchema,
  hash: sha256Schema,
});

type LedgerRecord = z.infer<typeof ledgerRecordSchema>;
type LedgerRecordBody = Omit<LedgerRecord, 'hash'>;

export const runStateLedgerHeadSchema = z.strictObject({
  schemaVersion: z.literal(3),
  kind: z.literal('ultracode-benchmark-run-state-ledger-head'),
  suite: z.enum(['swebench-pro', 'swe-marathon', 'featurebench']),
  runId: z.string().min(1),
  manifestSha256: sha256Schema,
  revision: z.number().int().nonnegative(),
  segmentIndex: z.number().int().nonnegative().max(10_000),
  segmentRecordIndex: z.number().int().nonnegative().max(100_000),
  recordIndex: z.number().int().nonnegative().max(1_000_000_000),
  segmentBytes: z.number().int().positive().max(MAX_RUN_STATE_LEDGER_SEGMENT_BYTES),
  ledgerRootSha256: sha256Schema,
});

export type RunStateLedgerHead = z.infer<typeof runStateLedgerHeadSchema>;

export interface RunStateMaterialization {
  state: BenchRunState;
  stateFileSha256: string;
  ledgerRootSha256: string | null;
  head: RunStateLedgerHead | null;
  segmentFingerprints: readonly LedgerSegmentFingerprint[] | null;
  /** Incremental digest state for the committed bytes of the active segment. */
  activeSegmentHasher: Hash | null;
}

export interface LedgerSegmentFingerprint {
  segmentIndex: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mtimeNs: string;
  ctimeNs: string;
  nlink: number;
  contentSha256: string | null;
}

export type RunStateCrashPoint = 'after-ledger-fsync' | 'after-head-fsync' | 'after-migration-rename';

export interface RunStateLedgerOptions {
  /** Lower only in deterministic rotation tests; production remains fixed at 8 MiB. */
  segmentMaximumBytes?: number;
  /** Synchronous fault injection after a durable crash boundary. */
  onCrashPoint?: (point: RunStateCrashPoint) => void;
}

export interface RunStateLedgerIdentity {
  roots: BenchPathRoots;
  suite: BenchSuite;
  runId: string;
  manifestSha256: string;
}

type LedgerIdentity = RunStateLedgerIdentity;

type ParseState = (value: unknown) => BenchRunState;

function sha256Bytes(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function headBytes(head: RunStateLedgerHead): Buffer {
  return Buffer.from(`${JSON.stringify(head, null, 2)}\n`, 'utf8');
}

function recordHash(body: LedgerRecordBody): string {
  return sha256Bytes(canonicalJson(body));
}

function makeRecord(body: LedgerRecordBody): LedgerRecord {
  return ledgerRecordSchema.parse({ ...body, hash: recordHash(body) });
}

function recordBytes(record: LedgerRecord): Buffer {
  const bytes = Buffer.from(JSON.stringify(record), 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_RUN_STATE_LEDGER_RECORD_BYTES) {
    throw new Error(`run-state ledger record exceeds ${MAX_RUN_STATE_LEDGER_RECORD_BYTES} bytes`);
  }
  return bytes;
}

function segmentName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 9_999_999_999_999_999) {
    throw new Error(`invalid run-state ledger segment index ${index}`);
  }
  return `${String(index).padStart(16, '0')}.jsonl`;
}

function segmentPath(identity: LedgerIdentity, index: number, directory = runStateLedgerDir(
  identity.roots,
  identity.suite,
  identity.runId,
)): string {
  return join(directory, segmentName(index));
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertPrivateFile(info: Stats, path: string): void {
  const uid = currentUid();
  if (!info.isFile() || info.nlink !== 1) throw new Error(`run-state ledger segment must be a singly-linked regular file: ${path}`);
  if (uid !== undefined && info.uid !== uid) throw new Error(`run-state ledger segment is not owned by the current user: ${path}`);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`run-state ledger segment must have mode 0600: ${path}`);
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written === 0) throw new Error('run-state ledger write made no progress');
    offset += written;
  }
}

function createSegment(path: string): number {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    assertPrivateFile(fstatSync(fd), path);
    return fd;
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // The failed exclusive create may already have been removed.
    }
    throw error;
  }
}

function assertUnchanged(info: Stats, after: Stats, leaf: Stats, path: string): void {
  if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size
    || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.nlink !== 1
    || leaf.isSymbolicLink() || leaf.dev !== info.dev || leaf.ino !== info.ino) {
    throw new Error(`run-state ledger segment changed while being replayed: ${path}`);
  }
}

function segmentFingerprint(
  segmentIndex: number,
  info: Stats,
  precise: BigIntStats,
  contentSha256: string | null,
): LedgerSegmentFingerprint {
  return {
    segmentIndex,
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    mtimeNs: precise.mtimeNs.toString(),
    ctimeNs: precise.ctimeNs.toString(),
    nlink: info.nlink,
    contentSha256,
  };
}

function readSegmentFingerprint(
  path: string,
  segmentIndex: number,
  hashContents: boolean,
): LedgerSegmentFingerprint {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = fstatSync(fd);
    assertPrivateFile(info, path);
    const leaf = lstatSync(path);
    if (leaf.isSymbolicLink() || leaf.dev !== info.dev || leaf.ino !== info.ino) {
      throw new Error(`run-state ledger segment identity is unsafe: ${path}`);
    }
    let contentSha256: string | null = null;
    if (hashContents) {
      const hash = createHash('sha256');
      const chunk = Buffer.alloc(64 * 1_024);
      let position = 0;
      while (position < info.size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, info.size - position), position);
        if (count === 0) throw new Error(`run-state ledger segment changed while being fingerprinted: ${path}`);
        hash.update(chunk.subarray(0, count));
        position += count;
      }
      contentSha256 = hash.digest('hex');
    }
    const after = fstatSync(fd);
    assertUnchanged(info, after, lstatSync(path), path);
    return segmentFingerprint(segmentIndex, info, fstatSync(fd, { bigint: true }), contentSha256);
  } finally {
    closeSync(fd);
  }
}

function hashSegmentPrefix(path: string, bytes: number): Hash {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = fstatSync(fd);
    assertPrivateFile(info, path);
    if (bytes <= 0 || bytes > info.size) {
      throw new Error(`run-state ledger committed prefix is outside its segment: ${path}`);
    }
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1_024);
    let position = 0;
    while (position < bytes) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, bytes - position), position);
      if (count === 0) throw new Error(`run-state ledger segment changed while being hashed: ${path}`);
      hash.update(chunk.subarray(0, count));
      position += count;
    }
    assertUnchanged(info, fstatSync(fd), lstatSync(path), path);
    return hash;
  } finally {
    closeSync(fd);
  }
}

function readExact(fd: number, bytes: number, position: number): Buffer {
  const output = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < output.length) {
    const count = readSync(fd, output, offset, output.length - offset, position + offset);
    if (count === 0) throw new Error('run-state ledger segment changed while being replayed');
    offset += count;
  }
  return output;
}

function replaySegmentLines(
  fd: number,
  path: string,
  bytes: number,
  allowUnterminatedFinal: boolean,
  visit: (line: Buffer) => void,
): void {
  const chunk = Buffer.alloc(Math.min(64 * 1_024, Math.max(1, bytes)));
  let position = 0;
  let pending = Buffer.alloc(0);
  let endedWithNewline = false;
  while (position < bytes) {
    const wanted = Math.min(chunk.length, bytes - position);
    const count = readSync(fd, chunk, 0, wanted, position);
    if (count === 0) throw new Error(`run-state ledger segment changed while being replayed: ${path}`);
    position += count;
    const combined = pending.length === 0 ? chunk.subarray(0, count) : Buffer.concat([pending, chunk.subarray(0, count)]);
    let start = 0;
    for (;;) {
      const newline = combined.indexOf(0x0a, start);
      if (newline < 0) break;
      const line = combined.subarray(start, newline);
      if (line.length === 0) throw new Error(`run-state ledger contains an empty record: ${path}`);
      if (line.length > MAX_RUN_STATE_LEDGER_RECORD_BYTES) {
        throw new Error(`run-state ledger record exceeds ${MAX_RUN_STATE_LEDGER_RECORD_BYTES} bytes: ${path}`);
      }
      visit(line);
      start = newline + 1;
    }
    pending = Buffer.from(combined.subarray(start));
    if (pending.length > MAX_RUN_STATE_LEDGER_RECORD_BYTES) {
      throw new Error(`run-state ledger record exceeds ${MAX_RUN_STATE_LEDGER_RECORD_BYTES} bytes: ${path}`);
    }
    endedWithNewline = combined.at(-1) === 0x0a;
  }
  if (pending.length > 0) {
    if (!allowUnterminatedFinal) throw new Error(`run-state ledger segment has a torn interior record: ${path}`);
    visit(pending);
  } else if (!allowUnterminatedFinal && !endedWithNewline) {
    throw new Error(`run-state ledger segment is empty: ${path}`);
  }
}

function replaySegment(
  path: string,
  segmentIndex: number,
  committedBytes: number | null,
  visit: (line: Buffer) => void,
): LedgerSegmentFingerprint {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = fstatSync(fd);
    assertPrivateFile(info, path);
    if (info.size === 0 || info.size > MAX_RUN_STATE_LEDGER_SEGMENT_BYTES + MAX_RUN_STATE_LEDGER_RECORD_BYTES + 1) {
      throw new Error(`run-state ledger segment has invalid size: ${path}`);
    }
    const replayBytes = committedBytes ?? info.size;
    if (replayBytes <= 0 || replayBytes > info.size) {
      throw new Error(`run-state ledger head exceeds its segment: ${path}`);
    }
    replaySegmentLines(fd, path, replayBytes, committedBytes !== null, visit);
    if (committedBytes !== null) {
      const suffixBytes = info.size - replayBytes;
      if (suffixBytes > MAX_RUN_STATE_LEDGER_RECORD_BYTES + 1) {
        throw new Error(`run-state ledger has more than one torn final record: ${path}`);
      }
      if (suffixBytes > 0) {
        const suffix = readExact(fd, suffixBytes, replayBytes);
        if (suffix[0] !== 0x0a || suffix.subarray(1).includes(0x0a)) {
          throw new Error(`run-state ledger has malformed data after its committed head: ${path}`);
        }
      }
    }
    const after = fstatSync(fd);
    const leaf = lstatSync(path);
    assertUnchanged(info, after, leaf, path);
    return segmentFingerprint(
      segmentIndex,
      info,
      fstatSync(fd, { bigint: true }),
      committedBytes === null ? null : sha256Bytes(readExact(fd, replayBytes, 0)),
    );
  } finally {
    closeSync(fd);
  }
}

function inspectOrphanSegment(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = fstatSync(fd);
    assertPrivateFile(info, path);
    if (info.size > MAX_RUN_STATE_LEDGER_RECORD_BYTES) {
      throw new Error(`orphaned run-state ledger segment is not one bounded final record: ${path}`);
    }
    if (info.size > 0) {
      const bytes = readExact(fd, info.size, 0);
      if (bytes.includes(0x0a)) throw new Error(`orphaned run-state ledger segment contains an interior record: ${path}`);
    }
    const after = fstatSync(fd);
    const leaf = lstatSync(path);
    assertUnchanged(info, after, leaf, path);
  } finally {
    closeSync(fd);
  }
}

function parseRecord(line: Buffer, path: string): LedgerRecord {
  let value: unknown;
  try {
    const text = line.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(line)) throw new Error('record is not canonical UTF-8');
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`run-state ledger record is malformed: ${path}`, { cause: error });
  }
  const record = ledgerRecordSchema.parse(value);
  const { hash, ...body } = record;
  if (recordHash(body) !== hash) throw new Error(`run-state ledger record hash mismatch: ${path}`);
  return record;
}

function resolvePath(root: unknown, path: readonly (string | number)[]): unknown {
  let current = root;
  for (const component of path) {
    if (typeof component === 'number') {
      if (!Array.isArray(current) || component >= current.length) throw new Error('run-state ledger change has an invalid array path');
      current = current[component];
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current)
        || !Object.prototype.hasOwnProperty.call(current, component)) {
        throw new Error('run-state ledger change has an invalid object path');
      }
      current = (current as Record<string, unknown>)[component];
    }
  }
  return current;
}

function resolveParent(root: unknown, path: readonly (string | number)[]): { parent: unknown; leaf: string | number } {
  if (path.length === 0) throw new Error('run-state ledger change path is empty');
  return { parent: resolvePath(root, path.slice(0, -1)), leaf: path.at(-1)! };
}

function applyChange(root: unknown, change: LedgerChange): void {
  if (change.op === 'append' || change.op === 'truncate') {
    const target = resolvePath(root, change.path);
    if (!Array.isArray(target)) throw new Error('run-state ledger array operation has a non-array target');
    if (change.op === 'append') target.push(structuredClone(change.value));
    else {
      if (change.length > target.length) throw new Error('run-state ledger truncate grows an array');
      target.length = change.length;
    }
    return;
  }
  const { parent, leaf } = resolveParent(root, change.path);
  if (typeof leaf === 'number') {
    if (!Array.isArray(parent) || leaf >= parent.length) throw new Error('run-state ledger change has an invalid array leaf');
    if (change.op === 'delete') throw new Error('run-state ledger cannot delete one array element');
    parent[leaf] = structuredClone(change.value);
    return;
  }
  if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) {
    throw new Error('run-state ledger change has an invalid object leaf');
  }
  const object = parent as Record<string, unknown>;
  if (change.op === 'delete') {
    if (!Object.prototype.hasOwnProperty.call(object, leaf)) throw new Error('run-state ledger deletes a missing field');
    delete object[leaf];
  } else {
    object[leaf] = structuredClone(change.value);
  }
}

function diffValue(before: unknown, after: unknown, path: (string | number)[], output: LedgerChange[]): void {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index += 1) diffValue(before[index], after[index], [...path, index], output);
    if (after.length < before.length) output.push({ op: 'truncate', path, length: after.length });
    for (let index = shared; index < after.length; index += 1) {
      output.push({ op: 'append', path, value: structuredClone(after[index]) });
    }
    return;
  }
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after)) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    for (const key of Object.keys(left)) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) output.push({ op: 'delete', path: [...path, key] });
    }
    for (const key of Object.keys(right)) {
      if (!Object.prototype.hasOwnProperty.call(left, key)) {
        output.push({ op: 'set', path: [...path, key], value: structuredClone(right[key]) });
      } else {
        diffValue(left[key], right[key], [...path, key], output);
      }
    }
    return;
  }
  output.push({ op: 'set', path, value: structuredClone(after) });
}

/** Derive deltas for infrequent bulk compatibility mutations. */
export function diffRunStateChanges(before: BenchRunState, after: BenchRunState): RunStateLedgerChange[] {
  const changes: LedgerChange[] = [];
  diffValue(before.invocations, after.invocations, ['invocations'], changes);
  diffValue(before.attempts, after.attempts, ['attempts'], changes);
  return changes;
}

function assertHeadIdentity(head: RunStateLedgerHead, identity: LedgerIdentity): void {
  if (head.suite !== identity.suite || head.runId !== identity.runId || head.manifestSha256 !== identity.manifestSha256) {
    throw new Error('run-state ledger head does not match its immutable manifest');
  }
}

function listLedgerSegments(identity: LedgerIdentity, head: RunStateLedgerHead): string | null {
  const directory = requirePrivateDirectoryWithin(
    runDir(identity.roots, identity.suite, identity.runId),
    runStateLedgerDir(identity.roots, identity.suite, identity.runId),
  );
  const indexes: number[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = SEGMENT_NAME_RE.exec(entry.name);
    if (match === null) throw new Error(`unexpected run-state ledger entry: ${entry.name}`);
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index)) throw new Error(`invalid run-state ledger segment: ${entry.name}`);
    indexes.push(index);
  }
  indexes.sort((left, right) => left - right);
  const expected = Array.from({ length: head.segmentIndex + 1 }, (_, index) => index);
  const orphan = head.segmentIndex + 1;
  let hasOrphan = false;
  if (indexes.length === expected.length + 1 && indexes.at(-1) === orphan) {
    indexes.pop();
    hasOrphan = true;
  } else if (indexes.length !== expected.length) {
    throw new Error('run-state ledger segments are missing, duplicated, or non-contiguous');
  }
  if (indexes.some((index, position) => index !== expected[position])) {
    throw new Error('run-state ledger segments are missing, duplicated, or non-contiguous');
  }
  const orphanPath = hasOrphan ? segmentPath(identity, orphan) : null;
  if (orphanPath !== null) inspectOrphanSegment(orphanPath);
  return orphanPath;
}

function replayLedger(
  identity: LedgerIdentity,
  head: RunStateLedgerHead,
  parseState: ParseState,
): { state: BenchRunState; orphanPath: string | null; segmentFingerprints: LedgerSegmentFingerprint[] } {
  assertHeadIdentity(head, identity);
  const orphanPath = listLedgerSegments(identity, head);
  let previousHash = ZERO_HASH;
  let expectedRecordIndex = 0;
  let state: BenchRunState | null = null;
  let groupRevision = -1;
  let groupRecords = 0;
  let groupIndex = 0;
  let expectedSegmentRecord = 0;
  const segmentFingerprints: LedgerSegmentFingerprint[] = [];
  const finishRevision = (): void => {
    if (state === null || groupIndex !== groupRecords) throw new Error('run-state ledger revision is incomplete');
    state = parseState({ ...state, revision: groupRevision });
  };
  for (let segmentIndex = 0; segmentIndex <= head.segmentIndex; segmentIndex += 1) {
    expectedSegmentRecord = 0;
    const path = segmentPath(identity, segmentIndex);
    segmentFingerprints.push(replaySegment(
      path,
      segmentIndex,
      segmentIndex === head.segmentIndex ? head.segmentBytes : null,
      (line) => {
        const record = parseRecord(line, path);
        if (record.segmentIndex !== segmentIndex || record.segmentRecordIndex !== expectedSegmentRecord) {
          throw new Error('run-state ledger segment indexes are not contiguous');
        }
        if (record.recordIndex !== expectedRecordIndex) throw new Error('run-state ledger record indexes are not contiguous');
        if (record.previousHash !== previousHash) throw new Error('run-state ledger hash chain is discontinuous');
        if (groupIndex === groupRecords) {
          if (state !== null) finishRevision();
          const expectedRevision = state === null ? record.revision : state.revision + 1;
          if (record.revision !== expectedRevision || record.revisionIndex !== 0) {
            throw new Error('run-state ledger revisions are not contiguous');
          }
          groupRevision = record.revision;
          groupRecords = record.revisionRecords;
          groupIndex = 0;
        }
        if (record.revision !== groupRevision || record.revisionRecords !== groupRecords
          || record.revisionIndex !== groupIndex) {
          throw new Error('run-state ledger revision indexes are not contiguous');
        }
        if (record.recordIndex === 0) {
          if (record.payload.type !== 'snapshot' || record.revisionIndex !== 0) {
            throw new Error('run-state ledger must begin with a snapshot');
          }
          state = record.payload.state as BenchRunState;
        } else {
          if (state === null || record.payload.type !== 'delta') throw new Error('run-state ledger contains an unexpected snapshot');
          for (const change of record.payload.changes) applyChange(state, change);
        }
        previousHash = record.hash;
        expectedRecordIndex += 1;
        expectedSegmentRecord += 1;
        groupIndex += 1;
      },
    ));
  }
  finishRevision();
  const replayedState = state as BenchRunState | null;
  if (replayedState === null || expectedRecordIndex - 1 !== head.recordIndex
    || expectedSegmentRecord - 1 !== head.segmentRecordIndex
    || replayedState.revision !== head.revision || previousHash !== head.ledgerRootSha256) {
    throw new Error('run-state ledger head does not bind the replayed history');
  }
  return { state: replayedState, orphanPath, segmentFingerprints };
}

function parseStateFile(
  identity: LedgerIdentity,
  parseState: ParseState,
): RunStateMaterialization {
  const directory = runDir(identity.roots, identity.suite, identity.runId);
  const path = runStateFile(identity.roots, identity.suite, identity.runId);
  const bytes = readPrivateFile(directory, path);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('run-state head is malformed', { cause: error });
  }
  const parsedHead = runStateLedgerHeadSchema.safeParse(value);
  if (parsedHead.success) {
    if (bytes.length > MAX_LEDGER_HEAD_BYTES) throw new Error('run-state ledger head is oversized');
    const replayed = replayLedger(identity, parsedHead.data, parseState);
    return {
      state: replayed.state,
      stateFileSha256: sha256Bytes(bytes),
      ledgerRootSha256: parsedHead.data.ledgerRootSha256,
      head: parsedHead.data,
      segmentFingerprints: replayed.segmentFingerprints,
      activeSegmentHasher: hashSegmentPrefix(
        segmentPath(identity, parsedHead.data.segmentIndex),
        parsedHead.data.segmentBytes,
      ),
    };
  }
  const state = parseState(value);
  return {
    state,
    stateFileSha256: sha256Bytes(bytes),
    ledgerRootSha256: null,
    head: null,
    segmentFingerprints: null,
    activeSegmentHasher: null,
  };
}

/** Stream and materialize either a v3 ledger or a legacy v2 monolith. */
export function loadRunStateMaterialization(
  identity: LedgerIdentity,
  parseState: ParseState,
): RunStateMaterialization {
  return parseStateFile(identity, parseState);
}

/** Hash the current commit file without replaying an unchanged ledger. */
export function runStateCommitFileSha256(identity: LedgerIdentity, ledger: boolean): string {
  const directory = runDir(identity.roots, identity.suite, identity.runId);
  const bytes = readPrivateFile(
    directory,
    runStateFile(identity.roots, identity.suite, identity.runId),
    ledger ? MAX_LEDGER_HEAD_BYTES : undefined,
  );
  return sha256Bytes(bytes);
}

/** Detect changed committed segment metadata before trusting a warm materialization. */
export function runStateLedgerSegmentsUnchanged(
  identity: LedgerIdentity,
  materialized: RunStateMaterialization,
): boolean {
  if (materialized.head === null || materialized.segmentFingerprints === null) return true;
  listLedgerSegments(identity, materialized.head);
  const current = Array.from({ length: materialized.head.segmentIndex + 1 }, (_, segmentIndex) =>
    readSegmentFingerprint(
      segmentPath(identity, segmentIndex),
      segmentIndex,
      false,
    ));
  const metadata = (fingerprints: readonly LedgerSegmentFingerprint[]) => fingerprints.map(
    ({ contentSha256: _, ...fingerprint }) => fingerprint,
  );
  return canonicalJson(metadata(current)) === canonicalJson(metadata(materialized.segmentFingerprints));
}

function currentSegmentFingerprints(
  identity: LedgerIdentity,
  head: RunStateLedgerHead,
  activeSegmentHasher: Hash,
): LedgerSegmentFingerprint[] {
  listLedgerSegments(identity, head);
  const fingerprints = Array.from({ length: head.segmentIndex + 1 }, (_, segmentIndex) =>
    readSegmentFingerprint(segmentPath(identity, segmentIndex), segmentIndex, false));
  fingerprints[head.segmentIndex] = {
    ...fingerprints[head.segmentIndex]!,
    contentSha256: activeSegmentHasher.copy().digest('hex'),
  };
  return fingerprints;
}

interface RecordLocation {
  segmentIndex: number;
  segmentRecordIndex: number;
  recordIndex: number;
  previousHash: string;
  segmentBytes: number;
}

function writeRecordToNewSegment(path: string, bytes: Buffer): void {
  const fd = createSegment(path);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function appendDelimiter(path: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
  try {
    assertPrivateFile(fstatSync(fd), path);
    writeAll(fd, Buffer.from('\n'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publishHead(identity: LedgerIdentity, head: RunStateLedgerHead): string {
  const directory = runDir(identity.roots, identity.suite, identity.runId);
  writePrivateJsonAtomic(directory, runStateFile(identity.roots, identity.suite, identity.runId), head);
  return sha256Bytes(headBytes(head));
}

function buildSnapshotRecords(state: BenchRunState): Array<LedgerRecord['payload']> {
  if (state.invocations.length === 0 && state.attempts.length === 0) return [{ type: 'snapshot', state }];
  const base = { ...state, invocations: [], attempts: [] };
  return [
    { type: 'snapshot', state: base },
    ...state.invocations.map((invocation) => ({
      type: 'delta' as const,
      changes: [{ op: 'append' as const, path: ['invocations'], value: invocation }],
    })),
    ...state.attempts.map((attempt) => ({
      type: 'delta' as const,
      changes: [{ op: 'append' as const, path: ['attempts'], value: attempt }],
    })),
  ];
}

function segmentMaximum(options: RunStateLedgerOptions): number {
  const maximum = options.segmentMaximumBytes ?? MAX_RUN_STATE_LEDGER_SEGMENT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 4 * 1_024 || maximum > MAX_RUN_STATE_LEDGER_SEGMENT_BYTES) {
    throw new Error('run-state ledger segment maximum is outside the supported range');
  }
  return maximum;
}

function createLedger(
  identity: LedgerIdentity,
  state: BenchRunState,
  directory: string,
  segmentMaximumBytes: number,
): RunStateLedgerHead {
  const payloads = buildSnapshotRecords(state);
  let location: RecordLocation = {
    segmentIndex: 0,
    segmentRecordIndex: 0,
    recordIndex: 0,
    previousHash: ZERO_HASH,
    segmentBytes: 0,
  };
  let fd: number | null = null;
  let lastRecord: LedgerRecord | null = null;
  try {
    for (let revisionIndex = 0; revisionIndex < payloads.length; revisionIndex += 1) {
      const body = (): LedgerRecordBody => ({
        schemaVersion: 1,
        kind: 'ultracode-benchmark-run-state-ledger-record',
        segmentIndex: location.segmentIndex,
        segmentRecordIndex: location.segmentRecordIndex,
        recordIndex: location.recordIndex,
        revision: state.revision,
        revisionIndex,
        revisionRecords: payloads.length,
        previousHash: location.previousHash,
        payload: payloads[revisionIndex]!,
      });
      let record = makeRecord(body());
      let bytes = recordBytes(record);
      const projected = location.segmentBytes + (location.segmentBytes === 0 ? 0 : 1) + bytes.length;
      if (location.segmentBytes > 0 && projected > segmentMaximumBytes) {
        if (fd === null) throw new Error('run-state ledger segment descriptor is missing');
        writeAll(fd, Buffer.from('\n'));
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        location = {
          ...location,
          segmentIndex: location.segmentIndex + 1,
          segmentRecordIndex: 0,
          segmentBytes: 0,
        };
        record = makeRecord(body());
        bytes = recordBytes(record);
      }
      if (fd === null) fd = createSegment(join(directory, segmentName(location.segmentIndex)));
      if (location.segmentBytes > 0) writeAll(fd, Buffer.from('\n'));
      writeAll(fd, bytes);
      location.segmentBytes += (location.segmentBytes === 0 ? 0 : 1) + bytes.length;
      location.previousHash = record.hash;
      lastRecord = record;
      location.recordIndex += 1;
      location.segmentRecordIndex += 1;
    }
    if (fd === null || lastRecord === null) throw new Error('run-state ledger snapshot is empty');
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  fsyncDirectory(directory);
  return runStateLedgerHeadSchema.parse({
    schemaVersion: 3,
    kind: 'ultracode-benchmark-run-state-ledger-head',
    suite: identity.suite,
    runId: identity.runId,
    manifestSha256: identity.manifestSha256,
    revision: state.revision,
    segmentIndex: lastRecord.segmentIndex,
    segmentRecordIndex: lastRecord.segmentRecordIndex,
    recordIndex: lastRecord.recordIndex,
    segmentBytes: location.segmentBytes,
    ledgerRootSha256: lastRecord.hash,
  });
}

function sameMigrationLedger(parent: string, left: string, right: string): boolean {
  requirePrivateDirectoryWithin(parent, left);
  requirePrivateDirectoryWithin(parent, right);
  const leftNames = readdirSync(left).sort();
  const rightNames = readdirSync(right).sort();
  if (canonicalJson(leftNames) !== canonicalJson(rightNames)) return false;
  return leftNames.every((name) => {
    if (!SEGMENT_NAME_RE.test(name)) return false;
    const maximum = MAX_RUN_STATE_LEDGER_SEGMENT_BYTES + MAX_RUN_STATE_LEDGER_RECORD_BYTES + 1;
    const leftBytes = readPrivateFile(left, join(left, name), maximum);
    const rightBytes = readPrivateFile(right, join(right, name), maximum);
    return leftBytes.equals(rightBytes);
  });
}

/** Create an empty v3 ledger and atomically publish its first committed head. */
export function initializeRunStateLedger(
  identity: LedgerIdentity,
  state: BenchRunState,
  options: RunStateLedgerOptions = {},
): RunStateMaterialization {
  const ledgerDirectory = runStateLedgerDir(identity.roots, identity.suite, identity.runId);
  if (existsSync(ledgerDirectory)) throw new Error('run-state ledger already exists');
  ensurePrivateDirectoryWithin(runDir(identity.roots, identity.suite, identity.runId), ledgerDirectory);
  const head = createLedger(identity, state, ledgerDirectory, segmentMaximum(options));
  const stateFileSha256 = publishHead(identity, head);
  appendDelimiter(segmentPath(identity, head.segmentIndex));
  const activeSegmentHasher = hashSegmentPrefix(
    segmentPath(identity, head.segmentIndex),
    head.segmentBytes,
  );
  return {
    state,
    stateFileSha256,
    ledgerRootSha256: head.ledgerRootSha256,
    head,
    segmentFingerprints: currentSegmentFingerprints(identity, head, activeSegmentHasher),
    activeSegmentHasher,
  };
}

/** Replace an explicitly selected legacy v2 monolith with an equivalent v3 ledger. */
export function migrateLegacyRunStateLedger(
  identity: LedgerIdentity,
  state: BenchRunState,
  options: RunStateLedgerOptions = {},
): RunStateMaterialization {
  const finalDirectory = runStateLedgerDir(identity.roots, identity.suite, identity.runId);
  const parent = runDir(identity.roots, identity.suite, identity.runId);
  const temporary = join(parent, MIGRATION_TEMP_NAME);
  let removedStale = false;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!MIGRATION_TEMP_RE.test(entry.name)) continue;
    const stale = join(parent, entry.name);
    requirePrivateDirectoryWithin(parent, stale);
    rmSync(stale, { recursive: true });
    removedStale = true;
  }
  if (removedStale) {
    fsyncDirectory(parent);
  }
  mkdirSync(temporary, { mode: 0o700 });
  let temporaryExists = true;
  try {
    const head = createLedger(identity, state, temporary, segmentMaximum(options));
    if (existsSync(finalDirectory)) {
      if (!sameMigrationLedger(parent, temporary, finalDirectory)) {
        throw new Error('legacy run-state migration target does not match the v2 state');
      }
      rmSync(temporary, { recursive: true });
      temporaryExists = false;
    } else {
      renameSync(temporary, finalDirectory);
      temporaryExists = false;
      fsyncDirectory(parent);
      options.onCrashPoint?.('after-migration-rename');
    }
    const stateFileSha256 = publishHead(identity, head);
    appendDelimiter(segmentPath(identity, head.segmentIndex));
    const activeSegmentHasher = hashSegmentPrefix(
      segmentPath(identity, head.segmentIndex),
      head.segmentBytes,
    );
    return {
      state,
      stateFileSha256,
      ledgerRootSha256: head.ledgerRootSha256,
      head,
      segmentFingerprints: currentSegmentFingerprints(identity, head, activeSegmentHasher),
      activeSegmentHasher,
    };
  } catch (error) {
    if (temporaryExists && existsSync(temporary)) rmSync(temporary, { recursive: true });
    throw error;
  }
}

function prepareActiveSegment(identity: LedgerIdentity, head: RunStateLedgerHead, orphanPath: string | null): void {
  if (orphanPath !== null) {
    inspectOrphanSegment(orphanPath);
    unlinkSync(orphanPath);
    fsyncDirectory(runStateLedgerDir(identity.roots, identity.suite, identity.runId));
  }
  const path = segmentPath(identity, head.segmentIndex);
  const fd = openSync(path, constants.O_WRONLY | NOFOLLOW);
  try {
    const info = fstatSync(fd);
    assertPrivateFile(info, path);
    if (info.size < head.segmentBytes || info.size - head.segmentBytes > MAX_RUN_STATE_LEDGER_RECORD_BYTES + 1) {
      throw new Error('run-state ledger active suffix is unsafe');
    }
    ftruncateSync(fd, head.segmentBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Append and commit exactly one public state revision. */
export function appendRunStateRevision(
  identity: LedgerIdentity,
  materialized: RunStateMaterialization,
  nextRevision: number,
  inputChanges: readonly RunStateLedgerChange[],
  options: RunStateLedgerOptions = {},
): RunStateMaterialization {
  const head = materialized.head;
  if (head === null) throw new Error('legacy v2 run state is read-only; migrate it explicitly before updating');
  if (materialized.activeSegmentHasher === null) throw new Error('run-state ledger active digest is unavailable');
  if (nextRevision !== materialized.state.revision + 1) throw new Error('run-state ledger append must advance one revision');
  const changes = z.array(ledgerChangeSchema).max(100_000).parse(inputChanges);
  const maximum = segmentMaximum(options);
  let segmentIndex = head.segmentIndex;
  let segmentRecordIndex = head.segmentRecordIndex + 1;
  const build = (): LedgerRecord => makeRecord({
    schemaVersion: 1,
    kind: 'ultracode-benchmark-run-state-ledger-record',
    segmentIndex,
    segmentRecordIndex,
    recordIndex: head.recordIndex + 1,
    revision: nextRevision,
    revisionIndex: 0,
    revisionRecords: 1,
    previousHash: head.ledgerRootSha256,
    payload: { type: 'delta', changes },
  });
  let record = build();
  let bytes = recordBytes(record);
  let segmentBytes = head.segmentBytes + 1 + bytes.length;
  const rotate = segmentBytes > maximum;
  if (rotate) {
    segmentIndex += 1;
    segmentRecordIndex = 0;
    record = build();
    bytes = recordBytes(record);
    segmentBytes = bytes.length;
  }
  const activeSegmentHasher = rotate
    ? createHash('sha256').update(bytes)
    : materialized.activeSegmentHasher.copy().update('\n').update(bytes);
  const orphanPath = listLedgerSegments(identity, head);
  prepareActiveSegment(identity, head, orphanPath);
  let path = segmentPath(identity, segmentIndex);
  if (rotate) {
    appendDelimiter(segmentPath(identity, head.segmentIndex));
    path = segmentPath(identity, segmentIndex);
    writeRecordToNewSegment(path, bytes);
    fsyncDirectory(runStateLedgerDir(identity.roots, identity.suite, identity.runId));
  } else {
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
    try {
      assertPrivateFile(fstatSync(fd), path);
      writeAll(fd, Buffer.concat([Buffer.from('\n'), bytes]));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  options.onCrashPoint?.('after-ledger-fsync');
  const nextHead = runStateLedgerHeadSchema.parse({
    ...head,
    revision: nextRevision,
    segmentIndex,
    segmentRecordIndex,
    recordIndex: record.recordIndex,
    segmentBytes,
    ledgerRootSha256: record.hash,
  });
  const stateFileSha256 = publishHead(identity, nextHead);
  options.onCrashPoint?.('after-head-fsync');
  appendDelimiter(path);
  for (const change of changes) applyChange(materialized.state, change);
  materialized.state.revision = nextRevision;
  return {
    state: materialized.state,
    stateFileSha256,
    ledgerRootSha256: nextHead.ledgerRootSha256,
    head: nextHead,
    segmentFingerprints: currentSegmentFingerprints(identity, nextHead, activeSegmentHasher),
    activeSegmentHasher,
  };
}
