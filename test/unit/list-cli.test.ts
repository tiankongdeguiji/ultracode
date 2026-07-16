import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunId } from '../../src/store/layout.js';
import { createRunDir } from '../../src/store/runstore.js';
import { writeManifest, type RunManifest } from '../../src/store/manifest.js';
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

  it('--all shows every run with no footer', () => {
    const root = tmpRoot();
    const base = Date.now();
    for (let i = 0; i < 12; i++) makeRun(root, new Date(base - i * 60_000).toISOString());
    const out = capture('stdout');
    listCommand({ home: root, all: true });
    out.restore();
    const lines = out.chunks.join('').trimEnd().split('\n');
    expect(lines).toHaveLength(12);
    expect(out.chunks.join('')).not.toContain('more (use');
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
});
