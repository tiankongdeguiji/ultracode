/** Exclusive claim and lifecycle leases with explicit, conservative stale recovery. */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
  readProcessIdentity,
  readProcessIdentitySnapshot,
  type ProcessInspectionOptions,
} from '../../../src/exec/procinfo.js';
import { canonicalJson, sha256Schema } from './provenance.js';
import {
  ensurePrivateDirectoryWithin,
  readPrivateJson,
  requirePrivateDirectoryWithin,
  writePrivateJsonAtomic,
} from './paths.js';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MINIMUM_STALE_MS = 60_000;

export const lockOwnerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('ultracode-benchmark-lock'),
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().positive(),
  processStartIdentity: z.string().min(1).nullable(),
  hostIdentitySha256: sha256Schema,
  createdAt: z.string().datetime({ offset: true }),
});

export type LockOwner = z.infer<typeof lockOwnerSchema>;

export interface AcquireBenchLockOptions {
  /** Explicitly authorize conservative stale recovery. */
  recoverStale?: boolean;
  staleAfterMs?: number;
  now?: () => Date;
  observationDelayMs?: number;
  /** Create a missing lock parent. Existing-run leases set this to false. */
  createParent?: boolean;
  /** Explicit platform/process seam for deterministic stale-recovery tests. */
  processInspection?: ProcessInspectionOptions;
}

function hostIdentitySha256(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  return createHash('sha256')
    .update(`${hostname()}\0${uid}\0${process.platform}\0${process.arch}`, 'utf8')
    .digest('hex');
}

function currentOwner(now: () => Date): LockOwner {
  return {
    schemaVersion: 1,
    kind: 'ultracode-benchmark-lock',
    nonce: randomBytes(32).toString('hex'),
    pid: process.pid,
    processStartIdentity: readProcessIdentity(process.pid)?.starttime ?? null,
    hostIdentitySha256: hostIdentitySha256(),
    createdAt: now().toISOString(),
  };
}

function createLockFile(path: string, owner: LockOwner): boolean {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    const contents = Buffer.from(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    let offset = 0;
    while (offset < contents.length) {
      const written = writeSync(fd, contents, offset, contents.length - offset);
      if (written === 0) throw new Error(`benchmark lock write made no progress: ${path}`);
      offset += written;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // The failed exclusive create may already have been removed.
    }
    throw error;
  }
  closeSync(fd);
  return true;
}

function readOwner(privateRoot: string, path: string): LockOwner {
  try {
    return lockOwnerSchema.parse(readPrivateJson(privateRoot, path, 64 * 1_024));
  } catch (error) {
    throw new Error(`benchmark lock is malformed or unsafe: ${path}`, { cause: error });
  }
}

function trackedOwnerObservation(
  owner: LockOwner,
  inspection: ProcessInspectionOptions,
): 'absent' | 'live' | 'unverifiable' {
  if (owner.processStartIdentity === null) return 'unverifiable';
  const snapshot = readProcessIdentitySnapshot([owner.pid], inspection);
  const observed = snapshot.identities.get(owner.pid);
  if (observed !== undefined) {
    return observed.starttime === owner.processStartIdentity ? 'live' : 'absent';
  }
  if (!snapshot.complete) return 'unverifiable';
  const signalProcess = inspection.signalProcess ?? ((pid: number, signal: NodeJS.Signals | 0) => {
    process.kill(pid, signal);
  });
  try {
    signalProcess(owner.pid, 0);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'absent';
    if (code === 'EPERM') return 'live';
    return 'unverifiable';
  }
}

async function recoverStaleLock(
  privateRoot: string,
  path: string,
  options: AcquireBenchLockOptions,
): Promise<LockOwner> {
  const owner = readOwner(privateRoot, path);
  const now = options.now ?? (() => new Date());
  const staleAfterMs = Math.max(MINIMUM_STALE_MS, options.staleAfterMs ?? MINIMUM_STALE_MS);
  const age = now().getTime() - Date.parse(owner.createdAt);
  if (!Number.isFinite(age) || age < staleAfterMs) throw new Error(`benchmark lock is active: ${path}`);
  if (owner.hostIdentitySha256 !== hostIdentitySha256()) {
    throw new Error(`benchmark lock belongs to another host and cannot be recovered automatically: ${path}`);
  }
  const inspection = options.processInspection ?? {};
  if (trackedOwnerObservation(owner, inspection) !== 'absent') {
    throw new Error(`benchmark lock owner is still running or unverifiable: ${path}`);
  }
  await sleep(Math.max(1, options.observationDelayMs ?? 50));
  if (trackedOwnerObservation(owner, inspection) !== 'absent') {
    throw new Error(`benchmark lock owner identity is not stably absent: ${path}`);
  }
  const current = readOwner(privateRoot, path);
  if (canonicalJson(current) !== canonicalJson(owner)) throw new Error(`benchmark lock changed during recovery: ${path}`);
  unlinkSync(path);
  return owner;
}

function recoveryGuardPath(path: string): string {
  return `${path}.recovery`;
}

/** A held lock remains actionable only while its exact nonce-bearing file exists. */
export class BenchLockHandle {
  private released = false;

  constructor(
    readonly privateRoot: string,
    readonly path: string,
    readonly owner: LockOwner,
    /** Prior stale owner, present only on an explicitly recovered lock. */
    readonly recoveredOwner: LockOwner | null = null,
  ) {}

  assertHeld(): void {
    if (this.released) throw new Error(`benchmark lock has already been released: ${this.path}`);
    const current = readOwner(this.privateRoot, this.path);
    if (canonicalJson(current) !== canonicalJson(this.owner)) {
      throw new Error(`benchmark lock ownership changed: ${this.path}`);
    }
  }

  release(): void {
    this.assertHeld();
    unlinkSync(this.path);
    this.released = true;
  }
}

/** Acquire one O_EXCL lock; stale removal occurs only with explicit authorization. */
export async function acquireBenchLock(
  privateRoot: string,
  path: string,
  options: AcquireBenchLockOptions = {},
): Promise<BenchLockHandle> {
  if (options.createParent === false) requirePrivateDirectoryWithin(privateRoot, dirname(path));
  else ensurePrivateDirectoryWithin(privateRoot, dirname(path));
  const now = options.now ?? (() => new Date());
  let owner = currentOwner(now);
  if (createLockFile(path, owner)) return new BenchLockHandle(privateRoot, path, owner);
  if (!options.recoverStale) throw new Error(`benchmark lock is already held: ${path}`);
  const guardPath = recoveryGuardPath(path);
  const guardOwner = currentOwner(now);
  if (!createLockFile(guardPath, guardOwner)) {
    throw new Error(`benchmark lock recovery is already in progress or requires manual guard recovery: ${path}`);
  }
  const guard = new BenchLockHandle(privateRoot, guardPath, guardOwner);
  try {
    const recoveredOwner = await recoverStaleLock(privateRoot, path, options);
    owner = currentOwner(now);
    if (!createLockFile(path, owner)) throw new Error(`benchmark lock was reacquired concurrently: ${path}`);
    return new BenchLockHandle(privateRoot, path, owner, recoveredOwner);
  } finally {
    guard.release();
  }
}

const RUN_CLAIM_MARKER = '.creation-claim.json';

const runClaimMarkerSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('ultracode-benchmark-run-claim'),
  owner: lockOwnerSchema,
});

/** Label a newly created run directory with the exact claim that owns it. */
export function markClaimedRunDirectory(directory: string, claim: BenchLockHandle): void {
  claim.assertHeld();
  writePrivateJsonAtomic(directory, join(directory, RUN_CLAIM_MARKER), {
    schemaVersion: 2,
    kind: 'ultracode-benchmark-run-claim',
    owner: claim.owner,
  });
}

/** Prove an incomplete run directory belongs to the stale claim just recovered. */
export function assertRecoveredClaimOwnsRunDirectory(directory: string, claim: BenchLockHandle): void {
  claim.assertHeld();
  if (claim.recoveredOwner === null) {
    throw new Error('incomplete run directory has no recovered claim ownership proof');
  }
  requirePrivateDirectoryWithin(claim.privateRoot, directory);
  if (readdirSync(directory).length === 0) {
    // Exclusive mkdir precedes marker publication, so only this empty state is safely recoverable.
    return;
  }
  const marker = runClaimMarkerSchema.parse(readPrivateJson(
    directory,
    join(directory, RUN_CLAIM_MARKER),
    64 * 1_024,
  ));
  if (canonicalJson(marker.owner) !== canonicalJson(claim.recoveredOwner)) {
    throw new Error('incomplete run directory does not belong to the recovered claim');
  }
}

/** Remove the transient marker only while its exact creating claim remains held. */
export function clearClaimedRunDirectory(directory: string, claim: BenchLockHandle): void {
  claim.assertHeld();
  const path = join(directory, RUN_CLAIM_MARKER);
  const marker = runClaimMarkerSchema.parse(readPrivateJson(directory, path, 64 * 1_024));
  if (canonicalJson(marker.owner) !== canonicalJson(claim.owner)) {
    throw new Error('run creation marker ownership changed');
  }
  unlinkSync(path);
}

/** Read-only existence check that does not parse or recover a lock. */
export function benchLockExists(path: string): boolean {
  return existsSync(path);
}
