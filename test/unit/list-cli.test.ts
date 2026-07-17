import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunId } from '../../src/store/layout.js';
import { createRunDir } from '../../src/store/runstore.js';
import { readManifest, writeManifest, type RunManifest } from '../../src/store/manifest.js';
import { listCommand } from '../../src/cli/lifecycle.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'uc-list-cli-'));
}

function baseManifest(runId: string): RunManifest {
  const now = new Date().toISOString();
  return {
    runId,
    name: 'demo',
    status: 'running',
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    phases: [],
    agentCount: 0,
    budget: { total: null, spent: 0 },
    backendDefault: 'mock',
    engineVersion: '0.1.0',
  };
}

function makeRun(root: string, startedAt: string, status: RunManifest['status'] = 'running'): string {
  const runId = newRunId();
  const dir = createRunDir(root, { runId, name: 'demo', source: 's', args: null, config: { backend: 'mock', cwd: '/p' } });
  writeManifest(dir, { ...baseManifest(runId), startedAt, status });
  return runId;
}

function capture(stream: 'stdout' | 'stderr'): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process[stream], 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

describe('list CLI', () => {
  it('caps to the 10 most recent newest-first with an "and N more" footer', () => {
    const root = tmpRoot();
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(makeRun(root, new Date(base - (12 - i) * 60_000).toISOString()));
    const out = capture('stdout');
    const code = listCommand({ home: root });
    out.restore();
    expect(code).toBe(0);
    const lines = out.chunks.join('').trimEnd().split('\n');
    expect(lines).toHaveLength(11); // 10 run lines + footer
    expect(lines[10]).toBe('… and 2 more (use --count <n> or --all)');
    expect(lines[0]).toContain(ids[11]); // newest first
    expect(lines[9]).toContain(ids[2]); // oldest shown
    const all = out.chunks.join('');
    expect(all).not.toContain(ids[0]); // the two oldest are hidden
    expect(all).not.toContain(ids[1]);
  });

  it('omits the footer when nothing is hidden', () => {
    const root = tmpRoot();
    makeRun(root, new Date().toISOString());
    const out = capture('stdout');
    listCommand({ home: root });
    out.restore();
    expect(out.chunks.join('')).not.toContain('more (use');
  });

  it('--json emits the capped array', () => {
    const root = tmpRoot();
    const base = Date.now();
    for (let i = 0; i < 12; i++) makeRun(root, new Date(base - i * 60_000).toISOString());
    const out = capture('stdout');
    listCommand({ home: root, json: true });
    out.restore();
    expect(JSON.parse(out.chunks.join(''))).toHaveLength(10);
  });

  it('--all --count caps and the footer omits the redundant --all hint', () => {
    const root = tmpRoot();
    const base = Date.now();
    for (let i = 0; i < 12; i++) makeRun(root, new Date(base - i * 60_000).toISOString());
    const out = capture('stdout');
    const code = listCommand({ home: root, all: true, count: '2' });
    out.restore();
    expect(code).toBe(0);
    const lines = out.chunks.join('').trimEnd().split('\n');
    expect(lines).toHaveLength(3); // 2 runs + footer
    expect(lines[2]).toBe('… and 10 more (use --count <n>)'); // no redundant "or --all"
  });

  it('--json honors --all (full set) and --count (capped)', () => {
    const root = tmpRoot();
    const base = Date.now();
    for (let i = 0; i < 12; i++) makeRun(root, new Date(base - i * 60_000).toISOString());
    const all = capture('stdout');
    listCommand({ home: root, json: true, all: true });
    all.restore();
    expect(JSON.parse(all.chunks.join(''))).toHaveLength(12);
    const capped = capture('stdout');
    listCommand({ home: root, json: true, count: '4' });
    capped.restore();
    expect(JSON.parse(capped.chunks.join(''))).toHaveLength(4);
  });

  it('--all surfaces old terminal runs (full store) with no footer; default omits them', () => {
    const root = tmpRoot();
    const base = Date.now();
    const oldDone = makeRun(root, new Date(base - 48 * 3600e3).toISOString(), 'completed'); // filtered by default
    for (let i = 0; i < 5; i++) makeRun(root, new Date(base - i * 60_000).toISOString());
    // default recency filter drops the old terminal run
    const def = capture('stdout');
    listCommand({ home: root });
    def.restore();
    expect(def.chunks.join('')).not.toContain(oldDone);
    // --all removes the filter (surfaces it) and the cap (no footer)
    const out = capture('stdout');
    listCommand({ home: root, all: true });
    out.restore();
    const all = out.chunks.join('');
    expect(all).toContain(oldDone);
    expect(all.trimEnd().split('\n')).toHaveLength(6); // 5 recent + 1 old terminal
    expect(all).not.toContain('more (use');
  });

  it('--count shows exactly N newest-first with a footer for the rest', () => {
    const root = tmpRoot();
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(makeRun(root, new Date(base - (6 - i) * 60_000).toISOString()));
    const out = capture('stdout');
    const code = listCommand({ home: root, count: '3' });
    out.restore();
    expect(code).toBe(0);
    const lines = out.chunks.join('').trimEnd().split('\n');
    expect(lines).toHaveLength(4); // 3 run lines + footer
    expect(lines[0]).toContain(ids[5]); // newest first
    expect(lines[3]).toBe('… and 3 more (use --count <n> or --all)');
  });

  it('rejects a non-numeric --count with the canonical error and exit 1', () => {
    const root = tmpRoot();
    makeRun(root, new Date().toISOString());
    const err = capture('stderr');
    const out = capture('stdout');
    const code = listCommand({ home: root, count: 'abc' });
    out.restore();
    err.restore();
    expect(code).toBe(1);
    expect(err.chunks.join('')).toContain('ultracode: --count must be a positive integer');
  });

  it('rejects an invalid --count before --reap can mutate the store', () => {
    const root = tmpRoot();
    const runId = newRunId();
    const dir = createRunDir(root, { runId, name: 'demo', source: 's', args: null, config: { backend: 'mock', cwd: '/p' } });
    writeManifest(dir, { ...baseManifest(runId), pid: 999999999, status: 'running' }); // dead pid ⇒ orphaned, reapable
    const err = capture('stderr');
    const out = capture('stdout');
    const code = listCommand({ home: root, reap: true, count: '0' });
    out.restore();
    err.restore();
    expect(code).toBe(1);
    expect(err.chunks.join('')).toContain('ultracode: --count must be a positive integer');
    expect(err.chunks.join('')).not.toContain('reaped'); // reap must not have run
    expect(readManifest(dir)!.status).toBe('running'); // manifest untouched
  });
});
