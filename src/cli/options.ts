import { isPositiveInt } from '../engine/semaphore.js';

/**
 * Shared positive-integer option guard: absent → ok with no value; invalid →
 * writes the canonical `ultracode: <flag> must be a positive integer` error to
 * stderr and reports failure. Callers pass their own flag name, so one rule and
 * one message shape serve every numeric CLI option and can't drift apart.
 */
function readPositiveIntOpt(raw: string | undefined, flag: string): { ok: true; value?: number } | { ok: false } {
  if (raw === undefined) return { ok: true };
  const n = Number(raw);
  if (!isPositiveInt(n)) {
    process.stderr.write(`ultracode: ${flag} must be a positive integer\n`);
    return { ok: false };
  }
  return { ok: true, value: n };
}

/** `--max-concurrency` guard for `run` / `resume`. */
export function readMaxConcurrencyOpt(raw: string | undefined): { ok: true; value?: number } | { ok: false } {
  return readPositiveIntOpt(raw, '--max-concurrency');
}

/** `--count` guard for `list`. */
export function readCountOpt(raw: string | undefined): { ok: true; value?: number } | { ok: false } {
  return readPositiveIntOpt(raw, '--count');
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
