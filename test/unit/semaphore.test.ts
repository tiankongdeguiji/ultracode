import { describe, it, expect } from 'vitest';
import { Semaphore, defaultConcurrency } from '../../src/engine/semaphore.js';

describe('Semaphore', () => {
  it('rejects non-positive / non-integer permits', () => {
    expect(() => new Semaphore(0)).toThrow(/positive integer/);
    expect(() => new Semaphore(-1)).toThrow(/positive integer/);
    expect(() => new Semaphore(1.5)).toThrow(/positive integer/);
  });

  it('caps concurrency at `permits` and tracks active/waiting', async () => {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    expect(s.active).toBe(2);
    let thirdEntered = false;
    const p3 = s.acquire().then((r) => {
      thirdEntered = true;
      return r;
    });
    await Promise.resolve();
    expect(thirdEntered).toBe(false); // blocked
    expect(s.waiting).toBe(1);
    r1();
    const r3 = await p3;
    expect(thirdEntered).toBe(true);
    expect(s.active).toBe(2); // r2 + r3, never 3
    r2();
    r3();
    expect(s.active).toBe(0);
  });

  it('grants waiters in FIFO order', async () => {
    const s = new Semaphore(1);
    const held = await s.acquire();
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      s.acquire().then((rel) => {
        order.push(n);
        return rel;
      }),
    );
    held(); // wakes them one at a time as each releases
    const rel1 = await waiters[0]!;
    rel1();
    const rel2 = await waiters[1]!;
    rel2();
    const rel3 = await waiters[2]!;
    rel3();
    expect(order).toEqual([1, 2, 3]);
  });

  it('release is idempotent — double-release does not free an extra permit', async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    r1();
    r1(); // no-op
    expect(s.active).toBe(0);
    const r2 = await s.acquire();
    expect(s.active).toBe(1);
    r2();
  });

  it('never over-subscribes when a fresh acquire interleaves a hand-off (permits=1)', async () => {
    const s = new Semaphore(1);
    const a = await s.acquire();
    const bp = s.acquire(); // B queues
    a(); // hands the permit toward B; count stays reserved
    // A brand-new acquire lands in the gap before B's continuation runs — it
    // must NOT steal the permit B was handed.
    const cp = s.acquire();
    const b = await bp;
    expect(s.active).toBe(1); // B holds it; C is still waiting
    let cEntered = false;
    void cp.then(() => {
      cEntered = true;
    });
    await Promise.resolve();
    expect(cEntered).toBe(false);
    b();
    const c = await cp;
    expect(s.active).toBe(1);
    c();
    expect(s.active).toBe(0);
  });

  it('defaultConcurrency is within [2, 16]', () => {
    const d = defaultConcurrency();
    expect(d).toBeGreaterThanOrEqual(2);
    expect(d).toBeLessThanOrEqual(16);
  });
});
