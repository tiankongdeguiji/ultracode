import { isPositiveInt } from '../engine/semaphore.js';

/** Strict positive integer, else null (reject — don't guess). */
function parseMaxConcurrency(raw: string): number | null {
  const n = Number(raw);
  return isPositiveInt(n) ? n : null;
}

/**
 * Shared --max-concurrency guard for CLI commands: absent → ok with no value;
 * invalid → writes the canonical error to stderr and reports failure, so the
 * rule and its message can't drift between `run` and `resume`.
 */
export function readMaxConcurrencyOpt(raw: string | undefined): { ok: true; value?: number } | { ok: false } {
  if (raw === undefined) return { ok: true };
  const n = parseMaxConcurrency(raw);
  if (n === null) {
    process.stderr.write('ultracode: --max-concurrency must be a positive integer\n');
    return { ok: false };
  }
  return { ok: true, value: n };
}
