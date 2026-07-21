/**
 * Fixed-address recovery record layout. Stop logic can enumerate every path
 * the engine may create without trusting worker-controlled directory entries.
 */
import { join } from 'node:path';
import { MAX_DARWIN_CANDIDATE_PROCESSES, type TrackedProcess } from './procinfo.js';

export const MAX_WORKER_SEQUENCES = 1_000;
export const MAX_WORKER_ATTEMPT = 8;
export const MAX_WORKER_CANDIDATE_RECORD_BYTES = 512 * 1_024;
export const MAX_WORKER_CANDIDATE_PROCESSES = MAX_DARWIN_CANDIDATE_PROCESSES;
export const DARWIN_START_IDENTITY_RE =
  /^darwin:[A-Z][a-z]{2}_[A-Z][a-z]{2}_\d{1,2}_\d{2}:\d{2}:\d{2}_\d{4}$/u;
const WORKER_TOKEN_RE = /^[a-f0-9]{32}$/u;

export const WORKER_RECORD_FILE_NAMES: readonly string[] = Array.from(
  { length: MAX_WORKER_ATTEMPT },
  (_, index) => index + 1,
).flatMap((attempt) => [`pgid.attempt${attempt}`, `pgid.attempt${attempt}-fresh`]);

/** Directory reserved for one agent sequence's recovery records. */
export function workerRecordDir(runDir: string, seq: number): string {
  return join(runDir, 'worker-records', String(seq).padStart(4, '0'));
}

/** Recovery record for one physical backend spawn. */
export function workerRecordPath(runDir: string, seq: number, attempt: number, suffix = ''): string {
  return join(workerRecordDir(runDir, seq), `pgid.attempt${attempt}${suffix}`);
}

/** Fixed sidecar for the bounded identities observed by host-side Darwin cleanup. */
export function workerCandidateRecordPath(processRecordPath: string): string {
  return `${processRecordPath}.candidates`;
}

export interface WorkerCandidateInventory {
  /** Host observation state; persisted recovery must not trust this worker-writable bit as authority. */
  complete: boolean;
  processes: TrackedProcess[];
}

interface SerializedWorkerCandidateInventory extends WorkerCandidateInventory {
  token: string;
  version: 1;
}

function validCandidate(candidate: unknown): candidate is TrackedProcess {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const value = candidate as Partial<TrackedProcess>;
  return Number.isSafeInteger(value.pid)
    && value.pid! > 1
    && value.pid! <= 2_147_483_647
    && Number.isSafeInteger(value.pgrp)
    && value.pgrp! >= 0
    && value.pgrp! <= 2_147_483_647
    && typeof value.starttime === 'string'
    && DARWIN_START_IDENTITY_RE.test(value.starttime)
    && Object.keys(value).sort().join(',') === 'pgrp,pid,starttime';
}

/** Encode a bounded host observation; only settled live cleanup may set complete. */
export function serializeWorkerCandidateInventory(
  token: string,
  candidates: readonly TrackedProcess[],
  complete: boolean,
): string {
  if (!WORKER_TOKEN_RE.test(token)) throw new Error('invalid worker token for candidate inventory');
  if (candidates.some((candidate) => !validCandidate(candidate))) {
    throw new Error('invalid Darwin candidate identity');
  }
  const processes = [...new Map(candidates.map((candidate) => [
    `${candidate.pid}:${candidate.starttime}:${candidate.pgrp}`,
    candidate,
  ])).values()]
    .sort((left, right) => left.pid - right.pid || left.pgrp - right.pgrp
      || (left.starttime < right.starttime ? -1 : left.starttime > right.starttime ? 1 : 0))
    .slice(0, MAX_WORKER_CANDIDATE_PROCESSES);
  const record: SerializedWorkerCandidateInventory = {
    version: 1,
    token,
    complete: complete && processes.length === candidates.length,
    processes,
  };
  const raw = JSON.stringify(record);
  if (Buffer.byteLength(raw) > MAX_WORKER_CANDIDATE_RECORD_BYTES) {
    throw new Error('Darwin candidate inventory exceeds its byte bound');
  }
  return raw;
}

/** Parse one untrusted sidecar without accepting oversized, partial, or ambiguous data. */
export function parseWorkerCandidateInventory(
  raw: string,
  expectedToken: string,
): WorkerCandidateInventory | undefined {
  if (
    !WORKER_TOKEN_RE.test(expectedToken)
    || Buffer.byteLength(raw) <= 0
    || Buffer.byteLength(raw) > MAX_WORKER_CANDIDATE_RECORD_BYTES
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Partial<SerializedWorkerCandidateInventory>;
  if (
    Object.keys(record).sort().join(',') !== 'complete,processes,token,version'
    || record.version !== 1
    || record.token !== expectedToken
    || typeof record.complete !== 'boolean'
    || !Array.isArray(record.processes)
    || record.processes.length > MAX_WORKER_CANDIDATE_PROCESSES
    || record.processes.some((candidate) => !validCandidate(candidate))
  ) {
    return undefined;
  }
  const processes = record.processes as TrackedProcess[];
  const keys = new Set(processes.map((candidate) =>
    `${candidate.pid}:${candidate.starttime}:${candidate.pgrp}`));
  if (keys.size !== processes.length) return undefined;
  return { complete: record.complete, processes };
}
