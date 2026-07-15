import { describe, it, expect } from 'vitest';
import { KeyChain, seedKey, stableStringify, readJournal, JournalWriter } from '../../src/engine/journal.js';
import { executeWorkflow } from '../../src/engine/run.js';
import { MockExecutor } from '../../src/backends/mock.js';
import type { AgentSpec } from '../../src/backends/types.js';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = '/project';

function spec(overrides: Partial<AgentSpec>): AgentSpec {
  return {
    seq: 0,
    prompt: 'p',
    label: 'l',
    backend: 'mock',
    cwd: ROOT,
    retries: 0,
    ...overrides,
  };
}

describe('stableStringify', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 }, e: undefined })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(stableStringify([1, { z: 1, a: 2 }])).toBe('[1,{"a":2,"z":1}]');
    expect(stableStringify(null)).toBe('null');
  });
});

describe('KeyChain', () => {
  it('is deterministic: same specs → same chain', () => {
    const seed = seedKey({ q: 1 });
    const a = new KeyChain(seed, ROOT);
    const b = new KeyChain(seed, ROOT);
    const specs = [spec({ prompt: 'one' }), spec({ prompt: 'two', model: 'fast' })];
    expect(specs.map((s) => a.next(s))).toEqual(specs.map((s) => b.next(s)));
  });

  it('prefix property: change at n diverges keys from n onward only', () => {
    const seed = seedKey(null);
    const a = new KeyChain(seed, ROOT);
    const b = new KeyChain(seed, ROOT);
    const k1a = a.next(spec({ prompt: 'same' }));
    const k1b = b.next(spec({ prompt: 'same' }));
    expect(k1a).toBe(k1b);
    const k2a = a.next(spec({ prompt: 'original' }));
    const k2b = b.next(spec({ prompt: 'EDITED' }));
    expect(k2a).not.toBe(k2b);
    const k3a = a.next(spec({ prompt: 'tail' }));
    const k3b = b.next(spec({ prompt: 'tail' }));
    expect(k3a).not.toBe(k3b); // chain, not per-call hash
  });

  it('backend, model, effort, schema, agentType all affect the key', () => {
    const seed = seedKey(null);
    const base = spec({ prompt: 'x' });
    const variants: Partial<AgentSpec>[] = [
      {},
      { backend: 'codex' },
      { model: 'big' },
      { effort: 'high' },
      { schema: { type: 'object' } },
      { agentType: 'explorer' },
    ];
    const keys = variants.map((v) => new KeyChain(seed, ROOT).next(spec({ ...base, ...v })));
    expect(new Set(keys).size).toBe(variants.length);
  });

  it('cwd equal to the run root is omitted from the hash', () => {
    const seed = seedKey(null);
    const atRoot = new KeyChain(seed, ROOT).next(spec({ cwd: ROOT }));
    const alsoRoot = new KeyChain(seed, ROOT).next(spec({ cwd: ROOT }));
    const elsewhere = new KeyChain(seed, ROOT).next(spec({ cwd: '/other' }));
    expect(atRoot).toBe(alsoRoot);
    expect(atRoot).not.toBe(elsewhere);
  });

  it('seed depends on args only — script edits must preserve the prefix', () => {
    expect(seedKey({ x: 1 })).not.toBe(seedKey({ x: 2 }));
    expect(seedKey({ x: 1 })).toBe(seedKey({ x: 1 }));
    expect(seedKey(null)).toBe(seedKey(null));
  });
});

describe('journal integration with executeWorkflow', () => {
  const SRC = `export const meta = { name: 'j', description: 'journal test' }
const a = await agent('MOCK:ok one', { label: 'first' })
await agent('anything', { skip: true })
const b = await agent('MOCK:ok two', { label: 'second' })
return [a, b]`;

  async function runOnce() {
    const records: { key?: string; seq: number; status: string }[] = [];
    const chain = new KeyChain(seedKey(null), process.cwd());
    await executeWorkflow(SRC, {
      executor: new MockExecutor(),
      keyChain: chain,
      cwd: process.cwd(),
      onAgentSettled: (r) => records.push({ key: r.cacheKey, seq: r.spec.seq, status: r.status }),
    });
    return records;
  }

  it('same script+args twice → identical key chains, skips advance the chain', async () => {
    const a = await runOnce();
    const b = await runOnce();
    expect(a).toHaveLength(3);
    expect(a.map((r) => r.key)).toEqual(b.map((r) => r.key));
    expect(a[1]!.status).toBe('skip');
    expect(a.every((r) => r.key?.startsWith('u1:'))).toBe(true);
    expect(new Set(a.map((r) => r.key)).size).toBe(3);
  });
});

describe('JournalWriter/readJournal', () => {
  it('appends and reads records, tolerating a torn tail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc-journal-'));
    const file = join(dir, 'journal.jsonl');
    const w = new JournalWriter(file);
    w.append({ t: 'started', runId: 'wf_abc123def456', engineVersion: '0', scriptHash: 'h', argsHash: 'a', seedKey: 's' });
    w.append({ t: 'agent', seq: 0, key: 'u1:x', status: 'ok', label: 'l', backend: 'mock', totalTokens: 5 });
    // simulate a torn write
    appendFileSync(file, '{"t":"agent","seq":1,');
    const records = readJournal(file);
    expect(records).toHaveLength(2);
    expect(records[0]!.t).toBe('started');
    expect(records[1]).toMatchObject({ t: 'agent', seq: 0, key: 'u1:x' });
  });
});
