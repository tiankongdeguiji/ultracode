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

/**
 * Shared nesting guard for `run` and `resume`: the engine stamps
 * ULTRACODE_INSIDE_RUN on every spawned worker, and a worker starting fresh
 * detached runs is how workflow fork-bombs happen (each run's workers spawn
 * more runs, none sharing the parent's caps/budget). Refuse unless the user
 * explicitly opted in with --allow-nested. Returns true when refusing.
 */
export function refuseInsideWorker(action: string, allowNested: boolean | undefined): boolean {
  if (!process.env.ULTRACODE_INSIDE_RUN || allowNested) return false;
  // Deliberately does NOT name the override flag: this message is read by the
  // refused WORKER, and agents reflexively follow remediation hints in errors —
  // advertising the bypass would reduce the guard to a one-retry speed bump.
  // Human operators find --allow-nested in --help.
  process.stderr.write(
    `ultracode: refusing to ${action} from inside an ultracode worker (ULTRACODE_INSIDE_RUN is set).\n` +
      '  Nested runs escape the parent run\'s concurrency/budget caps and can cascade.\n' +
      '  Do your assigned task directly; orchestrators nest via the in-script workflow() instead.\n',
  );
  return true;
}
