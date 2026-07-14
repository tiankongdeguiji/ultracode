import { describe, it, expect } from 'vitest';
import { createSandbox, compileCheck } from '../../src/engine/sandbox.js';
import { BAN_MESSAGES } from '../../src/engine/determinism.js';

function run(body: string, globals: Record<string, unknown> = {}): Promise<unknown> {
  return createSandbox(body, { globals }).run();
}

describe('sandbox hardening', () => {
  it('Date.now() throws the exact ban message', async () => {
    await expect(run(`return Date.now()`)).rejects.toThrow(BAN_MESSAGES.dateNow);
  });

  it('new Date() without arguments throws the exact ban message', async () => {
    await expect(run(`return new Date()`)).rejects.toThrow(BAN_MESSAGES.dateNoArgs);
  });

  it('bare Date() call throws the exact ban message', async () => {
    await expect(run(`return Date()`)).rejects.toThrow(BAN_MESSAGES.dateNoArgs);
  });

  it('new Date(value), Date.parse, Date.UTC remain legal', async () => {
    const r = await run(`return [new Date(0).toISOString(), Date.parse('1970-01-01T00:00:00Z'), Date.UTC(1970, 0)]`);
    expect(r).toEqual(['1970-01-01T00:00:00.000Z', 0, 0]);
  });

  it('Date ban cannot be bypassed via Date.prototype.constructor', async () => {
    // Date.prototype.constructor must be the guarded constructor, not the real
    // Date — otherwise the determinism bans (which prefix-replay resume relies
    // on) are trivially reachable.
    await expect(run(`return Date.prototype.constructor.now()`)).rejects.toThrow(BAN_MESSAGES.dateNow);
    await expect(run(`return new Date(0).constructor()`)).rejects.toThrow(BAN_MESSAGES.dateNoArgs);
  });

  it('Math.random() throws the exact ban message', async () => {
    await expect(run(`return Math.random()`)).rejects.toThrow(BAN_MESSAGES.mathRandom);
  });

  it('removes WebAssembly, ShadowRealm, Atomics, SharedArrayBuffer', async () => {
    const r = await run(
      `return [typeof WebAssembly, typeof ShadowRealm, typeof Atomics, typeof SharedArrayBuffer]`,
    );
    expect(r).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('freezes intrinsic prototypes', async () => {
    const r = await run(
      `return [Object.isFrozen(Array.prototype), Object.isFrozen(Object.prototype), Object.isFrozen(Function.prototype), Object.isFrozen(Math)]`,
    );
    expect(r).toEqual([true, true, true, true]);
  });

  it('prototype pollution attempts have no effect (body is sloppy mode, frozen target)', async () => {
    const r = await run(
      `const before = Array.prototype.push; Array.prototype.push = null; return Array.prototype.push === before`,
    );
    expect(r).toBe(true);
  });

  it('blocks eval and new Function (code generation from strings)', async () => {
    await expect(run(`return eval('1+1')`)).rejects.toThrow(/Code generation from strings disallowed/);
    await expect(run(`return new Function('return 1')()`)).rejects.toThrow(
      /Code generation from strings disallowed/,
    );
  });

  it('has no require, process, or fs access', async () => {
    const r = await run(`return [typeof require, typeof process, typeof module]`);
    expect(r).toEqual(['undefined', 'undefined', 'undefined']);
  });

  it('exposes injected host globals and supports top-level await + return', async () => {
    const r = await run(`const x = await double(21); return x`, {
      double: async (n: number) => n * 2,
    });
    expect(r).toBe(42);
  });

  it('kills synchronous runaway execution via timeout', async () => {
    const sb = createSandbox(`while (true) {}`, { globals: {}, syncTimeoutMs: 200 });
    await expect(sb.run()).rejects.toThrow(/timed out/i);
  });

  it('compileCheck catches syntax errors without executing', () => {
    expect(() => compileCheck(`const = broken`)).toThrow();
    expect(() => compileCheck(`return 1`)).not.toThrow();
  });

  it('injected host globals cannot reach the host Function via .constructor', async () => {
    // .constructor on a raw host function is the host realm Function, which
    // ignores this context's codeGeneration:false → a classic node:vm escape.
    // The bootstrap re-wraps host globals as vm-realm functions, so their
    // .constructor is the vm's frozen Function and invoking it throws.
    const r = await run(
      `try { const f = agent.constructor('return 1'); return 'ESCAPED:' + f(); }
       catch (e) { return 'blocked'; }`,
      { agent: () => 'ok' },
    );
    expect(r).toBe('blocked');
  });

  it('wrapping host globals preserves their behavior (agent/console/budget still callable)', async () => {
    const r = await run(
      `console.log('hi'); const v = await agent('x'); return { v, spent: budget.spent(), total: budget.total }`,
      {
        agent: async (p: string) => `got:${p}`,
        console: { log: () => {} },
        budget: { total: 500, spent: () => 42, remaining: () => 458 },
      },
    );
    expect(r).toEqual({ v: 'got:x', spent: 42, total: 500 });
  });
});
