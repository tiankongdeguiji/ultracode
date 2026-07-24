import { describe, it, expect } from 'vitest';
import { executeWorkflow } from '../../src/engine/run.js';
import { MockExecutor } from '../../src/backends/mock.js';
import { KeyChain, seedKey } from '../../src/engine/journal.js';
import type { RunEvent } from '../../src/engine/hostapi.js';

const PARENT = `export const meta = { name: 'uc-parent', description: 'nesting test' }
const a = await agent('MOCK:ok parent-a', { label: 'pa' })
const childOut = await workflow('uc-child', { n: 3 })
const b = await agent('MOCK:ok parent-b', { label: 'pb' })
return { a, childOut, b }`;

const CHILD = `export const meta = { name: 'uc-child', description: 'child' }
const items = await parallel(
  Array.from({ length: args.n }, (_, i) => () => agent('MOCK:ok child-' + i, { label: 'c' + i })),
)
return items`;

const resolveChild = (name) => {
  if (name === 'uc-child') return CHILD;
  throw new Error('unknown child ' + name);
};

describe('nested workflow()', () => {
  it("merges a child's caught agent failures into the parent (not silently dropped)", async () => {
    // The child catches an agent failure inside parallel() → no top-level child
    // error, but the failure must still surface in the PARENT's failures[].
    const CHILD_WITH_CAUGHT_FAILURE = `export const meta = { name: 'uc-child', description: 'c' }
const r = await parallel([
  () => agent('MOCK:fail boom-in-child', { label: 'bad' }),
  () => agent('MOCK:ok fine', { label: 'good' }),
])
return r`;
    const PARENT_ONE = `export const meta = { name: 'uc-parent', description: 'd' }
await workflow('uc-child', {})
return 'parent-done'`;
    const out = await executeWorkflow(PARENT_ONE, {
      executor: new MockExecutor(),
      resolveChild: () => CHILD_WITH_CAUGHT_FAILURE,
      maxConcurrency: 4,
    });
    expect(out.error).toBeUndefined(); // parent completed
    expect(out.result).toBe('parent-done');
    expect(out.failures.some((f) => f.includes('boom-in-child') || f.includes('bad'))).toBe(true);
  });

  it('runs a child inline and returns its result', async () => {
    const executor = new MockExecutor();
    const out = await executeWorkflow(PARENT, { executor, resolveChild, maxConcurrency: 4 });
    expect(out.error).toBeUndefined();
    const r = out.result as { a: string; childOut: string[]; b: string };
    expect(r.a).toBe('parent-a');
    expect(r.b).toBe('parent-b');
    expect(r.childOut).toEqual(['child-0', 'child-1', 'child-2']);
  });

  it('propagates model controls into child agents', async () => {
    const events: RunEvent[] = [];
    const out = await executeWorkflow(PARENT, {
      executor: new MockExecutor(),
      resolveChild,
      maxConcurrency: 4,
      defaultBackend: 'qoder',
      defaultModel: 'coder',
      defaultEffort: 'xhigh',
      defaultContextWindow: 200_000,
      onEvent: (event) => events.push(event),
    });
    expect(out.error).toBeUndefined();
    const childStarts = events.filter(
      (event): event is Extract<RunEvent, { type: 'agent_started' }> =>
        event.type === 'agent_started' && event.childId === 0,
    );
    expect(childStarts).toHaveLength(3);
    expect(childStarts).toEqual(childStarts.map(() => expect.objectContaining({
      backend: 'qoder',
      model: 'coder',
      effort: 'xhigh',
      contextWindow: 200_000,
    })));
  });

  it('shares the agent counter and budget with the child (cap counts child agents)', async () => {
    const executor = new MockExecutor();
    // parent: pa + (child: 3) + pb = 5 agents. maxAgents 4 → cap trips inside.
    const out = await executeWorkflow(PARENT, { executor, resolveChild, maxAgents: 4, maxConcurrency: 4 });
    expect(out.error).toMatch(/max agents \(4\)/);
    expect(out.agentCount).toBe(4); // pa (1) + the child's 3 agents merged into the parent; cap trips on pb
    expect(executor.stats.calls).toBe(4); // pa + 3 child (shared counter), then the cap trips on pb
  });

  it('shared budget: child spend counts against the parent ceiling', async () => {
    const executor = new MockExecutor();
    const out = await executeWorkflow(PARENT, { executor, resolveChild, budgetTotal: 1, maxConcurrency: 4 });
    // pa spends >1 token → next dispatch (child's first agent) throws.
    expect(out.error).toBe('Workflow budget exceeded');
  });

  it('one level only: a child that calls workflow() throws', async () => {
    const NESTING_CHILD = `export const meta = { name: 'uc-child', description: 'c' }
return workflow('uc-grandchild', {})`;
    const out = await executeWorkflow(PARENT, {
      executor: new MockExecutor(),
      resolveChild: (name) => (name === 'uc-child' ? NESTING_CHILD : 'x'),
      maxConcurrency: 4,
    });
    expect(out.error).toContain('child workflow');
    expect(out.error).toContain('cannot nest more than one level');
  });

  it('unknown child name surfaces a clear error', async () => {
    const out = await executeWorkflow(`export const meta = { name: 'uc-p', description: 'd' }
return workflow('nope', {})`, {
      executor: new MockExecutor(),
      resolveChild: (name) => {
        throw new Error(`workflow '${name}' not found`);
      },
      maxConcurrency: 4,
    });
    expect(out.error).toContain("workflow 'nope' not found");
  });

  it('keys keep chaining across the nesting boundary (deterministic across two runs)', async () => {
    const keysOf = async () => {
      const keys: string[] = [];
      await executeWorkflow(PARENT, {
        executor: new MockExecutor(),
        resolveChild,
        maxConcurrency: 1,
        cwd: '/fixed',
        keyChain: new KeyChain(seedKey(null), '/fixed'),
        onAgentSettled: (r) => keys.push(r.cacheKey ?? ''),
      });
      return keys;
    };
    const a = await keysOf();
    const b = await keysOf();
    expect(a).toEqual(b);
    expect(a).toHaveLength(5); // pa, c0, c1, c2, pb — all in one chain
    expect(new Set(a).size).toBe(5);
  });

  it('emits explicit child boundaries; child events tagged, exactly one untagged run lifecycle', async () => {
    const events: RunEvent[] = [];
    const out = await executeWorkflow(PARENT, {
      executor: new MockExecutor(),
      resolveChild,
      maxConcurrency: 4,
      onEvent: (e) => events.push(e),
    });
    expect(out.error).toBeUndefined();
    // The child's own run_started/run_completed are dropped — one lifecycle only.
    expect(events.filter((e) => e.type === 'run_started')).toEqual([{ type: 'run_started', name: 'uc-parent' }]);
    expect(events.filter((e) => e.type === 'run_completed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'child_started')).toEqual([
      expect.objectContaining({ childId: 0, name: 'uc-child' }),
    ]);
    expect(events.filter((e) => e.type === 'child_completed')).toEqual([
      expect.objectContaining({ childId: 0, name: 'uc-child', ok: true, agentCount: 3 }),
    ]);
    const completed = events.filter((e): e is Extract<RunEvent, { type: 'agent_completed' }> => e.type === 'agent_completed');
    expect(completed.filter((e) => e.childId === 0 && e.childName === 'uc-child').map((e) => e.label).sort()).toEqual(['c0', 'c1', 'c2']);
    expect(completed.filter((e) => e.childId === undefined).map((e) => e.label)).toEqual(['pa', 'pb']);
  });

  it('workflow() racing agent() in parallel(): attribution rides each event, not the boundary interval', async () => {
    const script = `export const meta = { name: 'uc-parent', description: 'd' }
return parallel([
  () => workflow('uc-child', { n: 2 }),
  () => agent('MOCK:delay 20 MOCK:ok parent-concurrent', { label: 'p-conc' }),
])`;
    const events: RunEvent[] = [];
    const out = await executeWorkflow(script, {
      executor: new MockExecutor(),
      resolveChild,
      maxConcurrency: 4,
      onEvent: (e) => events.push(e),
    });
    expect(out.error).toBeUndefined();
    const completed = events.filter((e): e is Extract<RunEvent, { type: 'agent_completed' }> => e.type === 'agent_completed');
    expect(completed.find((e) => e.label === 'p-conc')?.childId).toBeUndefined();
    expect(completed.filter((e) => e.childId === 0).map((e) => e.label).sort()).toEqual(['c0', 'c1']);
  });

  it("child log() lines appear once in the parent's logs and once on the event stream", async () => {
    const CHILD_LOG = `export const meta = { name: 'uc-child', description: 'c' }
log('hello-from-child')
return 1`;
    const events: RunEvent[] = [];
    const out = await executeWorkflow(
      `export const meta = { name: 'uc-p', description: 'd' }
await workflow('uc-child', {})
return 1`,
      { executor: new MockExecutor(), resolveChild: () => CHILD_LOG, maxConcurrency: 2, onEvent: (e) => events.push(e) },
    );
    expect(out.error).toBeUndefined();
    expect(out.logs.filter((l) => l === 'hello-from-child')).toHaveLength(1);
    const logEvents = events.filter((e) => e.type === 'workflow_log' && e.message === 'hello-from-child');
    expect(logEvents).toEqual([expect.objectContaining({ childId: 0, childName: 'uc-child' })]);
  });

  it('a failing child still closes its boundary with ok:false', async () => {
    const FAIL_CHILD = `export const meta = { name: 'uc-child', description: 'c' }
await agent('MOCK:fail child-boom', { label: 'cb' })`;
    const events: RunEvent[] = [];
    const out = await executeWorkflow(
      `export const meta = { name: 'uc-p', description: 'd' }
await workflow('uc-child', {})`,
      { executor: new MockExecutor(), resolveChild: () => FAIL_CHILD, maxConcurrency: 2, onEvent: (e) => events.push(e) },
    );
    expect(out.error).toContain('child workflow');
    expect(events.filter((e) => e.type === 'child_completed')).toEqual([
      expect.objectContaining({ childId: 0, ok: false }),
    ]);
  });

  it('a child honors the parent maxAgents cap (propagated, not the default 50)', async () => {
    const parent = `export const meta = { name: 'uc-parent', description: 'd' }
await agent('MOCK:ok pa', { label: 'pa' })
await workflow('uc-child', { n: 10 })
await agent('MOCK:ok pb', { label: 'pb' })
return 'done'`;
    const executor = new MockExecutor();
    const out = await executeWorkflow(parent, { executor, resolveChild, maxAgents: 3, maxConcurrency: 4 });
    expect(out.error).toMatch(/max agents \(3\)/);
    // pa + 2 child dispatches hit the shared ceiling of 3; without cap propagation
    // the child would run all 10 against its own default cap of 50.
    expect(executor.stats.calls).toBe(3);
  });
});
