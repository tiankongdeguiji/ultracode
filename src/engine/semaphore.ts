import os from 'node:os';

/** The one validation rule for every concurrency surface (flag, env, stored config). */
export function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

/** Engine default: min(10, max(2, cores - 2)); ULTRACODE_MAX_CONCURRENCY (a strict
 *  positive integer, same rule as --max-concurrency) overrides. Junk is ignored. */
export function defaultConcurrency(): number {
  const fromEnv = Number(process.env.ULTRACODE_MAX_CONCURRENCY);
  if (isPositiveInt(fromEnv)) return fromEnv;
  return Math.min(10, Math.max(2, os.cpus().length - 2));
}

/** FIFO counting semaphore. acquire() resolves with a release function. */
export class Semaphore {
  private inUse = 0;
  private readonly queue: Array<() => void> = [];

  constructor(readonly permits: number) {
    if (!isPositiveInt(permits)) {
      throw new TypeError(`Semaphore permits must be a positive integer, got ${permits}`);
    }
  }

  get active(): number {
    return this.inUse;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async acquire(): Promise<() => void> {
    if (this.inUse < this.permits) {
      this.inUse++;
      return this.makeRelease();
    }
    // Queue and wait to be HANDED a permit directly (see makeRelease) — we do
    // NOT increment on wake-up, because the releaser kept the count reserved.
    await new Promise<void>((resolve) => this.queue.push(resolve));
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      // Hand the permit straight to the next waiter WITHOUT dropping the count.
      // Decrement-then-reacquire would leave inUse momentarily below permits, so
      // a fresh acquire() interleaving between the release and the woken waiter's
      // continuation could over-subscribe (grab the permit the waiter was handed).
      if (next) next();
      else this.inUse--;
    };
  }
}
