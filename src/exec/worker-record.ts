/**
 * Fixed-address recovery record layout. Stop logic can enumerate every path
 * the engine may create without trusting worker-controlled directory entries.
 */
import { join } from 'node:path';

export const MAX_WORKER_SEQUENCES = 1_000;
export const MAX_WORKER_ATTEMPT = 8;

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
