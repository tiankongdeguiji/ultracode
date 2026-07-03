import os from 'node:os';

/** Engine default: min(16, max(2, cores - 2)) — matches the reference implementations. */
export function defaultConcurrency(): number {
  return Math.min(16, Math.max(2, os.cpus().length - 2));
}

/** FIFO counting semaphore. acquire() resolves with a release function. */
export class Semaphore {
  private inUse = 0;
  private readonly queue: Array<() => void> = [];

  constructor(readonly permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
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
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inUse++;
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse--;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}
