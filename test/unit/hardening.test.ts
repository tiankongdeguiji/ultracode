/**
 * Regression tests for the iter-3 hardening fixes. These cover the
 * safety-critical exec-layer controls (untrusted worker-writable run store):
 * the O_NOFOLLOW writers, the /proc-stat identity read, the pgid kill guard,
 * the NDJSON buffer cap, and resume path-traversal confinement.
 */
import { describe, it, expect } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NdjsonSplitter } from '../../src/backends/ndjson.js';
import { writeFileNoFollow, openAppendFdNoFollow } from '../../src/exec/safe-write.js';
import { readProcStat } from '../../src/exec/procinfo.js';
import { killWorkerGroups } from '../../src/exec/stop.js';
import { PrefixReplayCache, type JournalRecord } from '../../src/engine/journal.js';
import type { AgentSpec } from '../../src/backends/types.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('NdjsonSplitter buffer cap', () => {
  it('drops a newline-less line past the cap instead of buffering unbounded', () => {
    const s = new NdjsonSplitter(1024); // 1 KB cap for the test
    // 3 × 500 chars, no '\n' → 1500 > 1024 → overflow drop on the third push.
    const out = [s.push('x'.repeat(500)), s.push('x'.repeat(500)), s.push('x'.repeat(500))].flat();
    expect(out.some((l) => l.includes('dropped'))).toBe(true);
    // The overflow reset the buffer, so a subsequent well-formed line splits cleanly.
    expect(s.push('{"a":1}\n')).toEqual(['{"a":1}']);
  });

  it('does not drop a large line that still fits under the cap', () => {
    const s = new NdjsonSplitter(1024 * 1024);
    const line = '{"k":"' + 'y'.repeat(1000) + '"}';
    expect(s.push(line + '\n')).toEqual([line]);
  });
});

describe('safe-write O_NOFOLLOW (worker may plant a symlink at the artifact path)', () => {
  it('the truncating writer refuses to follow a symlink leaf', () => {
    const dir = tmp('uc-nofollow-');
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'ORIGINAL');
    symlinkSync(outside, join(dir, 'result.json'));
    writeFileNoFollow(join(dir, 'result.json'), 'NEW');
    expect(readFileSync(outside, 'utf8')).toBe('ORIGINAL'); // link target untouched
    expect(readFileSync(join(dir, 'result.json'), 'utf8')).toBe('NEW'); // now a regular file
  });

  it('the append writer refuses a symlink leaf', () => {
    const dir = tmp('uc-nofollow-');
    const outside = join(dir, 'outside.log');
    writeFileSync(outside, 'ORIGINAL\n');
    symlinkSync(outside, join(dir, 'journal.jsonl'));
    expect(() => openAppendFdNoFollow(join(dir, 'journal.jsonl'))).toThrow(); // ELOOP
    expect(readFileSync(outside, 'utf8')).toBe('ORIGINAL\n');
  });
});

describe('readProcStat', () => {
  it('reads our own pgrp + start-time on linux, undefined otherwise', () => {
    const s = readProcStat(process.pid);
    if (process.platform === 'linux') {
      expect(s).toBeTruthy();
      expect(Number.isInteger(s!.pgrp)).toBe(true);
      expect(s!.starttime.length).toBeGreaterThan(0);
    } else {
      expect(s).toBeUndefined();
    }
  });

  it('returns undefined for an impossible pid', () => {
    expect(readProcStat(2 ** 31)).toBeUndefined();
  });
});

describe('killWorkerGroups (the pgid file is untrusted worker-writable input)', () => {
  const mk = (contents: Record<string, string>) => {
    const runDir = tmp('uc-kill-');
    for (const [name, body] of Object.entries(contents)) {
      mkdirSync(join(runDir, 'agents', name), { recursive: true });
      writeFileSync(join(runDir, 'agents', name, 'pgid'), body);
    }
    return runDir;
  };

  it('refuses pid <= 1 (kill(-1) would broadcast SIGKILL to every process the user owns)', () => {
    expect(killWorkerGroups(mk({ a: '1', b: '0', c: '-1' }))).toBe(0);
  });

  it('refuses our own pid and non-integer junk', () => {
    expect(killWorkerGroups(mk({ a: String(process.pid), b: 'not-a-number', c: '' }))).toBe(0);
  });

  it('kills a matching detached worker group (linux)', async () => {
    if (process.platform !== 'linux') return;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid!;
    try {
      const stat = readProcStat(pid)!;
      expect(killWorkerGroups(mk({ good: `${pid} ${stat.starttime}` }))).toBe(1);
      await sleep(150);
      expect(readProcStat(pid)).toBeUndefined(); // gone
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
  });

  it('skips a start-time mismatch — a recycled/forged pid is not killed (linux)', async () => {
    if (process.platform !== 'linux') return;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid!;
    try {
      // Correct pid, wrong recorded start-time → identity check fails → not killed.
      expect(killWorkerGroups(mk({ stale: `${pid} 999999999` }))).toBe(0);
      expect(readProcStat(pid)).toBeTruthy(); // still alive
    } finally {
      process.kill(-pid, 'SIGKILL');
    }
  });
});

describe('PrefixReplayCache resultRef confinement (resume reads a worker-writable journal)', () => {
  const agentRecord = (resultRef: string): JournalRecord => ({
    t: 'agent',
    seq: 0,
    key: 'u1:testkey',
    status: 'ok',
    label: 'x',
    backend: 'mock',
    totalTokens: 0,
    resultRef,
  });

  it('rejects a resultRef that escapes the prior run dir (path traversal → miss)', () => {
    const priorDir = tmp('uc-prior-');
    const cache = new PrefixReplayCache([agentRecord('../../../../etc/hostname')], priorDir);
    expect(cache.lookup({} as AgentSpec, 'u1:testkey')).toBeUndefined();
    expect(cache.stats.hits).toBe(0);
    expect(cache.stats.misses).toBe(1);
  });

  it('reads a confined resultRef (happy path still works)', () => {
    const priorDir = tmp('uc-prior-');
    mkdirSync(join(priorDir, 'agents', '0-x'), { recursive: true });
    writeFileSync(join(priorDir, 'agents', '0-x', 'result.json'), JSON.stringify({ value: 'hi' }));
    const cache = new PrefixReplayCache([agentRecord('agents/0-x/result.json')], priorDir);
    expect(cache.lookup({} as AgentSpec, 'u1:testkey')).toEqual({ hit: true, value: 'hi' });
  });
});
