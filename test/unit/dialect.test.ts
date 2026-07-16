import { describe, it, expect } from 'vitest';
import { executeWorkflow, type ExecuteOptions } from '../../src/engine/run.js';
import { MockExecutor } from '../../src/backends/mock.js';

const META = `export const meta = { name: 'test', description: 'dialect semantics test' }\n`;

async function run(body: string, opts: Partial<ExecuteOptions> = {}) {
  const executor = (opts.executor as MockExecutor | undefined) ?? new MockExecutor();
  const output = await executeWorkflow(META + body, {
    executor,
    maxConcurrency: 8,
    ...opts,
  });
  return { output, executor };
}

describe('agent()', () => {
  it('returns the final text without schema', async () => {
    const { output } = await run(`return agent('MOCK:ok hello world')`);
    expect(output.error).toBeUndefined();
    expect(output.result).toBe('hello world');
    expect(output.agentCount).toBe(1);
    expect(output.totalTokens).toBeGreaterThan(0);
  });

  it('supports the single-object call form', async () => {
    const { output } = await run(`return agent({ prompt: 'MOCK:ok {"a":1}', label: 'obj-form' })`);
    expect(output.result).toEqual({ a: 1 });
  });

  it('rejects bad arguments with TypeError', async () => {
    const { output } = await run(`return agent(42)`);
    expect(output.error).toMatch(/agent\(\) expects a prompt string/);
  });

  it('skip: true resolves to null', async () => {
    const { output } = await run(`return agent('anything', { skip: true, skipReason: 'not needed' })`);
    expect(output.result).toBeNull();
    expect(output.failures).toEqual([]);
  });

  it('exhausted retries throw, recorded as agent[seq] label failed', async () => {
    const { output } = await run(`return agent('MOCK:fail boom', { label: 'doomed' })`);
    expect(output.error).toBe('agent[0] doomed failed: boom');
    expect(output.failures).toEqual(['agent[0] doomed failed: boom']);
  });

  it('retries recover: fail-then-ok(1) with retries 1 succeeds', async () => {
    const { output, executor } = await run(`return agent('MOCK:fail-then-ok 1 recovered', { retries: 1 })`);
    expect(output.result).toBe('recovered');
    expect(executor.stats.attempts).toBe(2);
  });

  it('retries clamp to 5', async () => {
    const { executor, output } = await run(`return agent('MOCK:fail always', { retries: 99 })`);
    expect(output.error).toContain('failed: always');
    expect(executor.stats.attempts).toBe(6); // 1 + 5 clamped retries
  });

  it('junk timeoutMs is dropped at intake (0 must not insta-kill; strings must not NaN the deadline)', async () => {
    class SpecCapture extends MockExecutor {
      specs: unknown[] = [];
      override execute(spec: never, signal: never, onProgress?: never) {
        this.specs.push(spec);
        return super.execute(spec, signal, onProgress);
      }
    }
    const executor = new SpecCapture();
    const { output } = await run(
      `const a = await agent('MOCK:ok one', { timeoutMs: 0 })
const b = await agent('MOCK:ok two', { timeoutMs: '30m' })
const c = await agent('MOCK:ok three', { timeoutMs: 1500 })
return [a, b, c]`,
      { executor },
    );
    expect(output.result).toEqual(['one', 'two', 'three']);
    expect(executor.specs.map((s) => (s as { timeoutMs?: number }).timeoutMs)).toEqual([undefined, undefined, 1500]);
  });
});

describe('parallel()', () => {
  it('is a barrier preserving order, throw → null + failure record', async () => {
    const { output } = await run(`
const r = await parallel([
  () => agent('MOCK:delay 30 MOCK:ok first'),
  () => agent('MOCK:fail exploded', { label: 'bad' }),
  () => agent('MOCK:ok third'),
])
return r`);
    expect(output.result).toEqual(['first', null, 'third']);
    expect(output.failures).toContain('agent[1] bad failed: exploded');
    expect(output.failures.some((f) => /^parallel\[1\] failed: agent\[1\] bad failed: exploded$/.test(f))).toBe(true);
    expect(output.error).toBeUndefined();
  });

  it('TypeErrors on non-array and non-function elements', async () => {
    const a = await run(`return parallel('nope')`);
    expect(a.output.error).toBe('parallel() expects an array of functions');
    const b = await run(`return parallel([1, 2])`);
    expect(b.output.error).toBe('parallel() expects an array of functions');
  });

  it('caps items at 4096', async () => {
    const { output } = await run(`return parallel(Array.from({length: 4097}, () => () => 1))`);
    expect(output.error).toBe('parallel() accepts at most 4096 items, got 4097');
  });

  it('non-agent thunks work', async () => {
    const { output } = await run(`return parallel([() => 1, async () => 2, () => Promise.resolve(3)])`);
    expect(output.result).toEqual([1, 2, 3]);
  });
});

describe('pipeline()', () => {
  it('passes (prevResult, originalItem, index) through stages', async () => {
    const { output } = await run(`
return pipeline([10, 20],
  (prev, item, i) => prev + 1,
  (prev, item, i) => ({ prev, item, i }),
)`);
    expect(output.result).toEqual([
      { prev: 11, item: 10, i: 0 },
      { prev: 21, item: 20, i: 1 },
    ]);
  });

  it('has no inter-stage barrier: a fast item finishes both stages before a slow item finishes stage 1', async () => {
    const { output } = await run(`
const order = []
await pipeline(['slow', 'fast'],
  async (prev, item) => {
    await agent(item === 'slow' ? 'MOCK:delay 120 MOCK:ok s1' : 'MOCK:ok f1')
    order.push(item + ':s1')
    return item
  },
  async (prev, item) => {
    order.push(item + ':s2')
    return item
  },
)
return order`);
    const order = output.result as string[];
    expect(order.indexOf('fast:s2')).toBeLessThan(order.indexOf('slow:s1'));
  });

  it('a throwing stage records pipeline[i] failed and drops the item, skipping later stages', async () => {
    const { output } = await run(`
let stage2Ran = []
const r = await pipeline([1, 2],
  (prev, item, i) => { if (item === 1) throw new Error('stage boom'); return item },
  (prev, item, i) => { stage2Ran.push(item); return prev * 10 },
)
return { r, stage2Ran }`);
    expect(output.result).toEqual({ r: [null, 20], stage2Ran: [2] });
    expect(output.failures).toEqual(['pipeline[0] failed: stage boom']);
  });

  it('a stage returning null drops silently (skip idiom), no failure record', async () => {
    const { output } = await run(`
const r = await pipeline([1, 2],
  (prev, item) => (item === 1 ? null : item),
  (prev) => prev * 10,
)
return r`);
    expect(output.result).toEqual([null, 20]);
    expect(output.failures).toEqual([]);
  });

  it('validates items array, item cap, and stage functions', async () => {
    expect((await run(`return pipeline('x', () => 1)`)).output.error).toBe('pipeline() expects an array of items');
    expect((await run(`return pipeline([1])`)).output.error).toBe('pipeline() stages must be functions');
    expect((await run(`return pipeline(Array(4097).fill(1), () => 1)`)).output.error).toBe(
      'pipeline() accepts at most 4096 items, got 4097',
    );
  });
});

describe('caps and budget gate', () => {
  it('soft agent cap throws the spec error string', async () => {
    const { output } = await run(
      `for (let i = 0; i < 5; i++) await agent('MOCK:ok x')
return 'unreachable'`,
      { maxAgents: 3 },
    );
    expect(output.error).toBe('Workflow reached max agents (3)');
    expect(output.agentCount).toBe(3);
    expect(output.failures).toEqual([]);
  });

  it('budget dispatch gate: in-flight agents finish, next dispatch throws', async () => {
    const { output } = await run(
      `await agent('MOCK:ok one')
return agent('MOCK:ok two')`,
      { budgetTotal: 1 }, // first agent exceeds it; second dispatch must throw
    );
    expect(output.error).toBe('Workflow budget exceeded');
    expect(output.agentCount).toBe(1);
  });

  it('budget global is readable from the script', async () => {
    const { output } = await run(`return { total: budget.total, remaining: budget.remaining() }`, {
      budgetTotal: 1000,
    });
    expect(output.result).toEqual({ total: 1000, remaining: 1000 });
  });

  it('unlimited budget reports remaining Infinity via spent/remaining semantics', async () => {
    const { output } = await run(`return budget.total`);
    expect(output.result).toBeNull(); // JSON round-trip of null total
  });
});

describe('concurrency', () => {
  it('respects maxConcurrency', async () => {
    const { executor } = await run(
      `await parallel(Array.from({length: 6}, (_, i) => () => agent('MOCK:delay 50 MOCK:ok ' + i)))`,
      { maxConcurrency: 2 },
    );
    expect(executor.stats.maxConcurrent).toBeLessThanOrEqual(2);
    expect(executor.stats.calls).toBe(6);
  });

  it('runs up to the cap concurrently', async () => {
    const { executor } = await run(
      `await parallel(Array.from({length: 6}, (_, i) => () => agent('MOCK:delay 60 MOCK:ok ' + i)))`,
      { maxConcurrency: 4 },
    );
    expect(executor.stats.maxConcurrent).toBeGreaterThanOrEqual(3);
  });
});

describe('phase(), log(), console', () => {
  it('log() and console map into logs with warn/error prefixes', async () => {
    const { output } = await run(`
log('plain')
console.log('via console', { a: 1 })
console.warn('careful')
console.error('bad')
return null`);
    expect(output.logs).toEqual(['plain', 'via console {"a":1}', '[warn] careful', '[error] bad']);
  });

  it('log cap drops beyond the limit and counts', async () => {
    const { output } = await run(`for (let i = 0; i < 10; i++) log('m' + i); return null`, { logCap: 4 });
    expect(output.logs).toHaveLength(4);
    expect(output.droppedLogs).toBe(6);
  });

  it('phase() validates its title', async () => {
    const { output } = await run(`phase(42)`);
    expect(output.error).toBe('phase() expects a non-empty title string');
  });
});

describe('run output shape', () => {
  it('produces the full output contract', async () => {
    const { output } = await run(`
phase('Work')
const r = await agent('MOCK:ok done', { label: 'worker' })
log('finished')
return { r }`);
    expect(output).toMatchObject({
      result: { r: 'done' },
      logs: ['finished'],
      failures: [],
      agentCount: 1,
      droppedLogs: 0,
    });
    expect(output.totalTokens).toBeGreaterThan(0);
    expect(output.totalToolCalls).toBe(1);
    expect(typeof output.durationMs).toBe('number');
    expect(output.error).toBeUndefined();
  });

  it('script throw sets error and preserves partials', async () => {
    const { output } = await run(`
await agent('MOCK:ok first')
log('got first')
throw new Error('script exploded')`);
    expect(output.error).toBe('script exploded');
    expect(output.agentCount).toBe(1);
    expect(output.logs).toEqual(['got first']);
  });

  it('abort stops dispatch with Workflow stopped', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { output } = await run(`return agent('MOCK:ok x')`, { signal: ctl.signal });
    expect(output.error).toBe('Workflow stopped');
  });

  it('workflow() without a child registry throws the documented error', async () => {
    const { output } = await run(`return workflow('child-name')`);
    expect(output.error).toContain('workflow() is not available');
  });

  it('args are exposed verbatim (JSON round-tripped)', async () => {
    const { output } = await run(`return args.items.map(x => x * 2)`, { args: { items: [1, 2, 3] } });
    expect(output.result).toEqual([2, 4, 6]);
  });

  it('meta.inputSchema validates args with the documented error message', async () => {
    const src = `export const meta = { name: 'strict-args', description: 'd', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } } }
return args.q`;
    await expect(
      executeWorkflow(src, { executor: new MockExecutor(), args: { wrong: true } }),
    ).rejects.toThrow(/Workflow args do not match strict-args meta.inputSchema/);
  });
});
