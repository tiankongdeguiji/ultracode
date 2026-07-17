import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunId, RUN_ID_RE, agentDirName, ultracodeRoot } from '../../src/store/layout.js';
import { readManifest, writeManifest, isTerminal, type RunManifest } from '../../src/store/manifest.js';
import { EventWriter, readEventsFrom } from '../../src/store/events.js';
import { createRunDir, getRun, listRuns, liveStatus, reapOrphans, isPidAlive, recentRuns, DEFAULT_LIST_COUNT } from '../../src/store/runstore.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'uc-store-'));
}

function baseManifest(runId: string): RunManifest {
  const now = new Date().toISOString();
  return {
    runId,
    name: 'test',
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

describe('layout', () => {
  it('newRunId matches the reference regex', () => {
    for (let i = 0; i < 20; i++) expect(newRunId()).toMatch(RUN_ID_RE);
  });

  it('agentDirName slugs labels safely', () => {
    expect(agentDirName(3, 'review:src/Auth.TS!!')).toBe('0003-review-src-auth-ts');
    expect(agentDirName(0, '###')).toBe('0000-agent');
  });

  it('ultracodeRoot precedence: override > $ULTRACODE_HOME > cwd/.ultracode', () => {
    const prev = process.env.ULTRACODE_HOME;
    try {
      delete process.env.ULTRACODE_HOME;
      expect(ultracodeRoot('/proj')).toBe('/proj/.ultracode');
      process.env.ULTRACODE_HOME = '/env-home';
      expect(ultracodeRoot('/proj')).toBe('/env-home');
      expect(ultracodeRoot('/proj', '/explicit')).toBe('/explicit');
    } finally {
      if (prev === undefined) delete process.env.ULTRACODE_HOME;
      else process.env.ULTRACODE_HOME = prev;
    }
  });
});

describe('manifest', () => {
  it('atomic write + read roundtrip', () => {
    const dir = tmpRoot();
    const m = baseManifest('wf_aaaaaaaaaaaa');
    writeManifest(dir, m);
    expect(readManifest(dir)).toEqual(m);
    expect(existsSync(join(dir, '.manifest.' + process.pid + '.tmp'))).toBe(false);
  });

  it('isTerminal', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('stopped')).toBe(true);
    expect(isTerminal('orphaned')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('created')).toBe(false);
  });
});

describe('events', () => {
  it('append + offset reads consume only complete lines', () => {
    const dir = tmpRoot();
    const file = join(dir, 'events.jsonl');
    const w = new EventWriter(file);
    w.write({ type: 'run_started', name: 'x' });
    w.write({ type: 'workflow_log', message: 'hello' });

    const page1 = readEventsFrom(file, 0);
    expect(page1.events.map((e) => e.type)).toEqual(['run_started', 'workflow_log']);
    expect(page1.events[0]!.ts).toBeTypeOf('number');

    const page2 = readEventsFrom(file, page1.nextOffset);
    expect(page2.events).toEqual([]);
    expect(page2.nextOffset).toBe(page1.nextOffset);

    w.write({ type: 'run_completed' });
    const page3 = readEventsFrom(file, page2.nextOffset);
    expect(page3.events.map((e) => e.type)).toEqual(['run_completed']);
    expect(page3.hasMore).toBe(false);
    w.close();
  });

  it('maxBytes pages a large backlog: complete lines only, hasMore until drained', () => {
    const dir = tmpRoot();
    const file = join(dir, 'events.jsonl');
    const w = new EventWriter(file);
    for (let i = 0; i < 50; i++) w.write({ type: 'agent_usage', seq: i, totalTokens: i });
    w.close();

    const seen: number[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const page = readEventsFrom(file, offset, 256); // far smaller than the file
      offset = page.nextOffset;
      pages++;
      for (const e of page.events) seen.push(e.seq as number);
      if (!page.hasMore) break;
    }
    expect(pages).toBeGreaterThan(1); // it actually paged
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i)); // nothing lost or torn
  });

  it('a line moderately larger than maxBytes is recovered by window growth (up to 4×)', () => {
    const dir = tmpRoot();
    const file = join(dir, 'events.jsonl');
    const w = new EventWriter(file);
    w.write({ type: 'workflow_log', message: 'x'.repeat(400) }); // > 256-byte page, < 4× cap
    w.write({ type: 'run_completed' });
    w.close();

    const page1 = readEventsFrom(file, 0, 256);
    expect(page1.events.map((e) => e.type)).toEqual(['workflow_log', 'run_completed']);
    expect(page1.hasMore).toBe(false);
  });

  it('non-object and type-less envelopes are dropped like malformed JSON (a null line must not crash consumers)', () => {
    const dir = tmpRoot();
    const file = join(dir, 'events.jsonl');
    writeFileSync(
      file,
      'null\n42\n"str"\n[]\n{}\n{"type":5}\n{"ts":1,"type":"workflow_log","message":"ok"}\n',
    );
    const page = readEventsFrom(file, 0);
    expect(page.events).toEqual([{ ts: 1, type: 'workflow_log', message: 'ok' }]);
  });

  it('a pathological unterminated line past the growth cap is skipped in bounded steps, and the tail self-heals', () => {
    const dir = tmpRoot();
    const file = join(dir, 'events.jsonl');
    const w = new EventWriter(file);
    // One line ≫ 4×256: growth stops at the cap and the reader advances past
    // it instead of re-allocating the whole remainder on every tick (a
    // worker-writable file must not be able to force that).
    w.write({ type: 'workflow_log', message: 'x'.repeat(4000) });
    w.write({ type: 'run_completed' });
    w.close();

    const page1 = readEventsFrom(file, 0, 256);
    expect(page1.events).toEqual([]); // the oversized event is dropped, like any garbage line
    expect(page1.nextOffset).toBe(1024); // …but the offset ADVANCES (bounded step, no stall)
    expect(page1.hasMore).toBe(true);

    // Keep paging: every call makes progress and the stream recovers.
    const seen: string[] = [];
    let offset = page1.nextOffset;
    for (let i = 0; i < 40; i++) {
      const p = readEventsFrom(file, offset, 256);
      expect(p.nextOffset).toBeGreaterThanOrEqual(offset);
      seen.push(...p.events.map((e) => e.type));
      if (!p.hasMore && p.nextOffset === offset) break;
      offset = p.nextOffset;
    }
    expect(seen).toContain('run_completed'); // the event after the monster line survives
  });
});

describe('runstore', () => {
  it('createRunDir writes the full layout', () => {
    const root = tmpRoot();
    const runId = newRunId();
    const dir = createRunDir(root, {
      runId,
      name: 'demo',
      source: 'export const meta = {}',
      args: { a: 1 },
      config: { backend: 'mock', cwd: '/proj' },
    });
    expect(readFileSync(join(dir, 'script.js'), 'utf8')).toContain('meta');
    expect(JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'))).toEqual({ a: 1 });
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).backend).toBe('mock');
    expect(readManifest(dir)!.status).toBe('created');
    expect(existsSync(join(dir, 'agents'))).toBe(true);
  });

  it('liveStatus: dead/recycled pid → orphaned; a stale-but-alive runner stays running', () => {
    const m = baseManifest('wf_bbbbbbbbbbbb');
    expect(liveStatus(m)).toBe('running'); // our own live pid, fresh heartbeat

    const deadPid = { ...m, pid: 999999999 };
    expect(liveStatus(deadPid)).toBe('orphaned');

    // Stale heartbeat but the runner PID is still alive → NOT terminal, so
    // `stop` still signals it (the wedged-runner case that needs the SIGKILL
    // backstop). Marking it orphaned here would make stop return early.
    const stale = { ...m, heartbeatAt: new Date(Date.now() - 60_000).toISOString() };
    expect(liveStatus(stale)).toBe('running');

    // A live PID whose recorded start-time no longer matches is a recycled PID,
    // not our runner → orphaned (Linux only; no /proc elsewhere → can't verify).
    const recycled = { ...m, pidStart: 'not-our-starttime' };
    expect(liveStatus(recycled)).toBe(process.platform === 'linux' ? 'orphaned' : 'running');

    expect(liveStatus({ ...m, status: 'completed' })).toBe('completed');
  });

  it('getRun/listRuns/reapOrphans lifecycle', () => {
    const root = tmpRoot();
    const runId = newRunId();
    const dir = createRunDir(root, {
      runId,
      name: 'demo',
      source: 's',
      args: null,
      config: { backend: 'mock', cwd: '/p' },
    });
    writeManifest(dir, { ...baseManifest(runId), pid: 999999999 });

    const run = getRun(root, runId)!;
    expect(run.effectiveStatus).toBe('orphaned');
    expect(listRuns(root)).toHaveLength(1);

    const reaped = reapOrphans(root);
    expect(reaped).toEqual([runId]);
    expect(readManifest(dir)!.status).toBe('orphaned');
    expect(readManifest(dir)!.error).toContain('runner died');
    expect(reapOrphans(root)).toEqual([]); // idempotent
  });

  it('isPidAlive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(999999999)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
  });
});

describe('recentRuns', () => {
  const DAY = 24 * 3600e3;

  function makeRun(root: string, startedAt: string, status: RunManifest['status'] = 'running'): string {
    const runId = newRunId();
    const dir = createRunDir(root, { runId, name: 'demo', source: 's', args: null, config: { backend: 'mock', cwd: '/p' } });
    writeManifest(dir, { ...baseManifest(runId), startedAt, status });
    return runId;
  }

  it('default caps to the 10 most recent (oldest-first) and reports the rest as hidden', () => {
    const root = tmpRoot();
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) ids.push(makeRun(root, new Date(base - (13 - i) * 60_000).toISOString()));
    const { runs, hidden } = recentRuns(root, {});
    expect(runs).toHaveLength(DEFAULT_LIST_COUNT);
    expect(hidden).toBe(3);
    expect(runs.map((r) => r.runId)).toEqual(ids.slice(-DEFAULT_LIST_COUNT));
  });

  it('at the exact cap boundary (10 runs) shows all with hidden 0', () => {
    const root = tmpRoot();
    const base = Date.now();
    for (let i = 0; i < DEFAULT_LIST_COUNT; i++) makeRun(root, new Date(base - i * 60_000).toISOString());
    const { runs, hidden } = recentRuns(root, {});
    expect(runs).toHaveLength(DEFAULT_LIST_COUNT);
    expect(hidden).toBe(0);
  });

  it('one past the cap boundary (11 runs) shows 10 with hidden 1', () => {
    const root = tmpRoot();
    const base = Date.now();
    for (let i = 0; i < DEFAULT_LIST_COUNT + 1; i++) makeRun(root, new Date(base - i * 60_000).toISOString());
    const { runs, hidden } = recentRuns(root, {});
    expect(runs).toHaveLength(DEFAULT_LIST_COUNT);
    expect(hidden).toBe(1);
  });

  it('an explicit count sets the cap', () => {
    const root = tmpRoot();
    const base = Date.now();
    for (let i = 0; i < 5; i++) makeRun(root, new Date(base - i * 60_000).toISOString());
    const { runs, hidden } = recentRuns(root, { count: 2 });
    expect(runs).toHaveLength(2);
    expect(hidden).toBe(3);
  });

  it('all returns every run including old terminal ones, nothing hidden', () => {
    const root = tmpRoot();
    const old = new Date(Date.now() - 2 * DAY).toISOString();
    makeRun(root, old, 'completed');
    makeRun(root, old, 'failed');
    makeRun(root, new Date().toISOString());
    const { runs, hidden } = recentRuns(root, { all: true });
    expect(runs).toHaveLength(3);
    expect(hidden).toBe(0);
  });

  it('default filter drops old terminal runs but keeps an old still-running one', () => {
    const root = tmpRoot();
    const old = new Date(Date.now() - 2 * DAY).toISOString();
    const oldDone = makeRun(root, old, 'completed');
    const oldRunning = makeRun(root, old, 'running');
    const recent = makeRun(root, new Date().toISOString(), 'completed');
    const shown = recentRuns(root, {}).runs.map((r) => r.runId);
    expect(shown).toContain(oldRunning);
    expect(shown).toContain(recent);
    expect(shown).not.toContain(oldDone);
  });

  it('hidden counts only cap-dropped runs, never filter-dropped ones', () => {
    const root = tmpRoot();
    const oldTs = new Date(Date.now() - 2 * DAY).toISOString();
    for (let i = 0; i < 3; i++) makeRun(root, oldTs, 'completed'); // old terminal → filtered out
    const base = Date.now();
    for (let i = 0; i < 12; i++) makeRun(root, new Date(base - i * 60_000).toISOString()); // recent, active
    const { runs, hidden } = recentRuns(root, {});
    expect(runs).toHaveLength(DEFAULT_LIST_COUNT);
    // 12 recent − 10 shown; the 3 old terminal runs are filtered, NOT counted in hidden
    // (computing hidden from the unfiltered length of 15 would wrongly give 5).
    expect(hidden).toBe(2);
  });

  it('a non-positive count is treated as unset (no slice(-0) returning everything)', () => {
    const root = tmpRoot();
    const base = Date.now();
    for (let i = 0; i < 12; i++) makeRun(root, new Date(base - i * 60_000).toISOString());
    expect(recentRuns(root, { count: 0 }).runs).toHaveLength(DEFAULT_LIST_COUNT);
    expect(recentRuns(root, { count: 0, all: true }).runs).toHaveLength(12);
  });

  it('all with an explicit count caps within the unfiltered set', () => {
    const root = tmpRoot();
    makeRun(root, new Date(Date.now() - 2 * DAY).toISOString(), 'completed');
    makeRun(root, new Date(Date.now() - 47 * 3600e3).toISOString(), 'completed');
    const newest = makeRun(root, new Date().toISOString(), 'completed');
    const { runs, hidden } = recentRuns(root, { all: true, count: 1 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe(newest);
    expect(hidden).toBe(2);
  });
});
