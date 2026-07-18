/**
 * Integration: real detached-runner processes over the run store (mock
 * backend, no network). Spawns node --import tsx, so these are the slowest
 * unit-adjacent tests (~2-4s each).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { newRunId } from '../../src/store/layout.js';
import { createRunDir, getRun, isPidAlive } from '../../src/store/runstore.js';
import { readManifest, isTerminal } from '../../src/store/manifest.js';
import { launchRunner } from '../../src/exec/daemonize.js';
import { readJournal } from '../../src/engine/journal.js';
import { findWorkerProcesses, readProcStat, WORKER_TOKEN_ENV } from '../../src/exec/procinfo.js';
import { killWorkerGroups, stopRun } from '../../src/exec/stop.js';

const HELLO = `export const meta = { name: 'hello', description: 'd', phases: [{ title: 'Greet' }] }
phase('Greet')
const g = await agent('MOCK:tools 2 MOCK:ok hi', { label: 'greeter' })
log('greeting received')
return { g }
`;

const SLOW = `export const meta = { name: 'slow', description: 'd' }
await agent('MOCK:delay 15000 MOCK:ok done', { label: 'sleeper' })
return 'finished'
`;

// Keeps the event loop alive (a long timer) while awaiting a never-settling
// promise, and never touches the abort signal. The wall-clock abort can't unwind
// it, so the hard-stop backstop is the only thing that ends the run.
const HANG = `export const meta = { name: 'hang', description: 'd' }
setTimeout(() => {}, 600000)
await new Promise(() => {})
return 'unreachable'
`;

const HANG_WITH_AGENT = `export const meta = { name: 'hang-agent', description: 'd' }
agent('spawn an escaped helper', { label: 'escape' }).catch(() => {})
setTimeout(() => {}, 600000)
await new Promise(() => {})
return 'unreachable'
`;

const CRASH_WITH_AGENT = `export const meta = { name: 'crash-agent', description: 'd' }
agent('spawn an escaped helper', { label: 'escape' }).catch(() => {})
setTimeout(() => { throw new Error('timer callback crash') }, 750)
await new Promise(() => {})
return 'unreachable'
`;

async function waitTerminal(dir: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = readManifest(dir);
    if (m && isTerminal(m.status)) return m.status;
    if (Date.now() > deadline) throw new Error(`run did not finish; status=${m?.status}`);
    await sleep(100);
  }
}

async function waitProcessGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!readProcStat(pid)) return true;
    await sleep(50);
  }
  return false;
}

function writeEscapingClaude(binDir: string, pidsFile: string): string {
  const fake = join(binDir, 'fake-claude.cjs');
  const escapedSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 60_000)";
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `const escaped = spawn(process.execPath, ['-e', ${JSON.stringify(escapedSource)}], { detached: true, stdio: 'ignore', env: process.env });`,
      `writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ worker: process.pid, escaped: escaped.pid }));`,
      'escaped.unref();',
      'setInterval(() => {}, 60_000);',
    ].join('\n'),
    { mode: 0o755 },
  );
  return fake;
}

async function waitForRecordedPids(file: string): Promise<{ worker: number; escaped: number }> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(file) && Date.now() < deadline) await sleep(50);
  if (!existsSync(file)) throw new Error('fake backend did not record its process ids');
  return JSON.parse(readFileSync(file, 'utf8'));
}

const TIMEOUT_PROBE = (opts: string) => `export const meta = { name: 'timeout-probe', description: 'd' }
try { await agent('hi', { label: 'a'${opts} }) } catch (e) { return String(e) }
return 'no timeout'
`;

function makeRun(source: string, config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'uc-runner-'));
  const runId = newRunId();
  const dir = createRunDir(root, {
    runId,
    name: 'itest',
    source,
    args: null,
    config: { backend: 'mock', cwd: root, ...config },
  });
  return { root, runId, dir };
}

describe('detached runner', () => {
  it('completes a run: manifest, events, journal, output.json, agent artifacts', async () => {
    const { root, runId, dir } = makeRun(HELLO);
    const { pid } = await launchRunner(dir);
    expect(pid).toBeGreaterThan(0);

    const status = await waitTerminal(dir);
    expect(status).toBe('completed');

    const output = JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8'));
    expect(output.result).toEqual({ g: 'hi' });
    expect(output.logs).toEqual(['greeting received']);
    expect(output.agentCount).toBe(1);

    const journal = readJournal(join(dir, 'journal.jsonl'));
    expect(journal[0]!.t).toBe('started');
    expect(journal[1]).toMatchObject({ t: 'agent', seq: 0, status: 'ok', label: 'greeter' });
    expect((journal[1] as { key: string }).key).toMatch(/^u1:/);

    const resultJson = JSON.parse(readFileSync(join(dir, 'agents/0000-greeter/result.json'), 'utf8'));
    expect(resultJson.value).toBe('hi');
    expect(readFileSync(join(dir, 'agents/0000-greeter/prompt.md'), 'utf8')).toBe('MOCK:tools 2 MOCK:ok hi');

    // Live tool ticks land in events.jsonl with the writer's envelope ts.
    const toolEvents = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"agent_tool"'))
      .map((l) => JSON.parse(l));
    expect(toolEvents).toHaveLength(4); // 2 tools × started+completed
    expect(toolEvents[0]).toMatchObject({ type: 'agent_tool', seq: 0, name: 'tool:mock-1', status: 'started' });
    for (const t of toolEvents) expect(typeof t.ts).toBe('number');

    const run = getRun(root, runId)!;
    expect(run.effectiveStatus).toBe('completed');
    expect(run.manifest.agentCount).toBe(1);
    expect(run.manifest.phases).toEqual([{ title: 'Greet', agentsDone: 1 }]);
  }, 30_000);

  it('journal determinism: same script+args in two runs → identical key chains', async () => {
    const a = makeRun(HELLO, { cwd: '/same-root' });
    const b = makeRun(HELLO, { cwd: '/same-root' });
    await launchRunner(a.dir);
    await launchRunner(b.dir);
    await waitTerminal(a.dir);
    await waitTerminal(b.dir);
    const keysA = readJournal(join(a.dir, 'journal.jsonl'))
      .filter((r) => r.t === 'agent')
      .map((r) => (r as { key: string }).key);
    const keysB = readJournal(join(b.dir, 'journal.jsonl'))
      .filter((r) => r.t === 'agent')
      .map((r) => (r as { key: string }).key);
    expect(keysA).toEqual(keysB);
    expect(keysA).toHaveLength(1);
  }, 40_000);

  it('SIGTERM stops the run gracefully: status stopped, partial output preserved', async () => {
    const { dir } = makeRun(SLOW);
    const { pid } = await launchRunner(dir);

    // wait until the agent is actually in flight
    const deadline = Date.now() + 10_000;
    for (;;) {
      const m = readManifest(dir);
      if (m?.status === 'running' && existsSync(join(dir, 'events.jsonl'))) {
        const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
        if (events.includes('agent_started')) break;
      }
      if (Date.now() > deadline) throw new Error('agent never started');
      await sleep(100);
    }

    // The prompt is on disk while the agent is still running (early write) —
    // the panel's detail view depends on this.
    expect(readFileSync(join(dir, 'agents/0000-sleeper/prompt.md'), 'utf8')).toContain('MOCK:delay 15000');

    process.kill(pid, 'SIGTERM');
    const status = await waitTerminal(dir, 10_000);
    expect(status).toBe('stopped');

    const output = JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8'));
    expect(output.error).toBeDefined();

    await sleep(200);
    expect(isPidAlive(pid)).toBe(false);
  }, 30_000);

  it('hard-stop backstop force-exits a run whose script never unwinds after the wall-clock cap', async () => {
    // The script awaits a never-settling promise: the wall-clock cap fires
    // abort(), but executeWorkflow never returns, so only the hard-stop backstop
    // can end the detached process (otherwise it leaks with no terminal manifest).
    const prev = process.env.ULTRACODE_HARD_STOP_GRACE_MS;
    process.env.ULTRACODE_HARD_STOP_GRACE_MS = '1500';
    try {
      const { dir } = makeRun(HANG, { wallClockMs: 500 });
      const { pid } = await launchRunner(dir);
      const status = await waitTerminal(dir, 12_000);
      expect(status).toBe('stopped');
      await sleep(300);
      expect(isPidAlive(pid)).toBe(false); // the process actually exited
    } finally {
      if (prev === undefined) delete process.env.ULTRACODE_HARD_STOP_GRACE_MS;
      else process.env.ULTRACODE_HARD_STOP_GRACE_MS = prev;
    }
  }, 20_000);

  it('hard-stop reaps an active backend descendant that escaped into a new session', async () => {
    if (process.platform !== 'linux') return;
    const binDir = mkdtempSync(join(tmpdir(), 'uc-hard-stop-bin-'));
    const pidsFile = join(binDir, 'pids.json');
    const fake = writeEscapingClaude(binDir, pidsFile);
    const prevBin = process.env.ULTRACODE_CLAUDE_BIN;
    const prevGrace = process.env.ULTRACODE_HARD_STOP_GRACE_MS;
    process.env.ULTRACODE_CLAUDE_BIN = fake;
    process.env.ULTRACODE_HARD_STOP_GRACE_MS = '1500';
    let runDir: string | undefined;
    let runnerPid = 0;
    let workerPid = 0;
    let escapedPid = 0;
    try {
      ({ dir: runDir } = makeRun(HANG_WITH_AGENT, { backend: 'claude', wallClockMs: 500 }));
      ({ pid: runnerPid } = await launchRunner(runDir));
      ({ worker: workerPid, escaped: escapedPid } = await waitForRecordedPids(pidsFile));

      expect(await waitTerminal(runDir, 12_000)).toBe('stopped');
      expect(await waitProcessGone(runnerPid)).toBe(true);
      expect(await waitProcessGone(workerPid)).toBe(true);
      expect(await waitProcessGone(escapedPid)).toBe(true);
    } finally {
      if (prevBin === undefined) delete process.env.ULTRACODE_CLAUDE_BIN;
      else process.env.ULTRACODE_CLAUDE_BIN = prevBin;
      if (prevGrace === undefined) delete process.env.ULTRACODE_HARD_STOP_GRACE_MS;
      else process.env.ULTRACODE_HARD_STOP_GRACE_MS = prevGrace;
      for (const pid of [runnerPid, workerPid, escapedPid]) {
        if (pid <= 1) continue;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      if (runDir) killWorkerGroups(runDir);
    }
  }, 20_000);

  it('external stop escalation reaps a wedged runner and its escaped descendant', async () => {
    if (process.platform !== 'linux') return;
    const binDir = mkdtempSync(join(tmpdir(), 'uc-external-stop-bin-'));
    const pidsFile = join(binDir, 'pids.json');
    const fake = writeEscapingClaude(binDir, pidsFile);
    const prevBin = process.env.ULTRACODE_CLAUDE_BIN;
    const prevGrace = process.env.ULTRACODE_HARD_STOP_GRACE_MS;
    process.env.ULTRACODE_CLAUDE_BIN = fake;
    process.env.ULTRACODE_HARD_STOP_GRACE_MS = '30000';
    let runDir: string | undefined;
    let runnerPid = 0;
    let workerPid = 0;
    let escapedPid = 0;
    try {
      const run = makeRun(HANG_WITH_AGENT, { backend: 'claude' });
      runDir = run.dir;
      ({ pid: runnerPid } = await launchRunner(run.dir));
      ({ worker: workerPid, escaped: escapedPid } = await waitForRecordedPids(pidsFile));

      const stopped = await stopRun(run.root, run.runId);
      expect(stopped).toMatchObject({ ok: true, status: 'stopped' });
      expect(stopped.message).toContain('force-killed after 7s grace');
      expect(await waitProcessGone(runnerPid)).toBe(true);
      expect(await waitProcessGone(workerPid)).toBe(true);
      expect(await waitProcessGone(escapedPid)).toBe(true);
    } finally {
      if (prevBin === undefined) delete process.env.ULTRACODE_CLAUDE_BIN;
      else process.env.ULTRACODE_CLAUDE_BIN = prevBin;
      if (prevGrace === undefined) delete process.env.ULTRACODE_HARD_STOP_GRACE_MS;
      else process.env.ULTRACODE_HARD_STOP_GRACE_MS = prevGrace;
      for (const pid of [runnerPid, workerPid, escapedPid]) {
        if (pid <= 1) continue;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      if (runDir) killWorkerGroups(runDir);
    }
  }, 20_000);

  it('uncaught timer callback cleanup reaps active backend descendants before the runner crashes', async () => {
    if (process.platform !== 'linux') return;
    const binDir = mkdtempSync(join(tmpdir(), 'uc-fatal-bin-'));
    const pidsFile = join(binDir, 'pids.json');
    const fake = writeEscapingClaude(binDir, pidsFile);
    const prevBin = process.env.ULTRACODE_CLAUDE_BIN;
    process.env.ULTRACODE_CLAUDE_BIN = fake;
    let runDir: string | undefined;
    let runnerPid = 0;
    let workerPid = 0;
    let escapedPid = 0;
    try {
      ({ dir: runDir } = makeRun(CRASH_WITH_AGENT, { backend: 'claude' }));
      ({ pid: runnerPid } = await launchRunner(runDir));
      ({ worker: workerPid, escaped: escapedPid } = await waitForRecordedPids(pidsFile));

      expect(await waitProcessGone(runnerPid)).toBe(true);
      expect(await waitProcessGone(workerPid)).toBe(true);
      expect(await waitProcessGone(escapedPid)).toBe(true);
      expect(readFileSync(join(runDir, 'runner.log'), 'utf8')).toContain('timer callback crash');
    } finally {
      if (prevBin === undefined) delete process.env.ULTRACODE_CLAUDE_BIN;
      else process.env.ULTRACODE_CLAUDE_BIN = prevBin;
      for (const pid of [runnerPid, workerPid, escapedPid]) {
        if (pid <= 1) continue;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      if (runDir) killWorkerGroups(runDir);
    }
  }, 15_000);

  it('tolerates a non-positive or fractional maxConcurrency in an inherited config.json (falls back to default, no orphan)', async () => {
    // Old-version or hand-edited run dirs can carry maxConcurrency: 0 or 2.5 —
    // the runner must not throw in the Semaphore constructor after flipping the
    // manifest to 'running' (that would orphan the run). 2.5 pins the
    // integer-ness half of the guard, 0 the positivity half.
    const zero = makeRun(HELLO, { maxConcurrency: 0 });
    const frac = makeRun(HELLO, { maxConcurrency: 2.5 });
    await launchRunner(zero.dir);
    await launchRunner(frac.dir);
    for (const { dir } of [zero, frac]) {
      const status = await waitTerminal(dir);
      expect(status).toBe('completed');
      const output = JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8'));
      expect(output.result).toEqual({ g: 'hi' });
    }
  }, 40_000);

  it('attemptTimeoutMs is ENFORCED end-to-end on a non-mock executor, and per-call timeoutMs wins', async () => {
    // A fake hanging claude CLI proves the runner→mux→executor plumbing
    // actually kills attempts — not merely that an override log was written.
    const binDir = mkdtempSync(join(tmpdir(), 'uc-fakebin-'));
    const fake = join(binDir, 'fake-claude.sh');
    writeFileSync(fake, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const prev = process.env.ULTRACODE_CLAUDE_BIN;
    process.env.ULTRACODE_CLAUDE_BIN = fake; // inherited by the detached runner
    try {
      const runLevel = makeRun(TIMEOUT_PROBE(''), { backend: 'claude', attemptTimeoutMs: 700 });
      const perCall = makeRun(TIMEOUT_PROBE(', timeoutMs: 500'), { backend: 'claude', attemptTimeoutMs: 30_000 });
      await launchRunner(runLevel.dir);
      await launchRunner(perCall.dir);
      await waitTerminal(runLevel.dir);
      await waitTerminal(perCall.dir);
      const out1 = JSON.parse(readFileSync(join(runLevel.dir, 'output.json'), 'utf8'));
      expect(out1.result).toContain('attempt timed out after 700ms');
      const out2 = JSON.parse(readFileSync(join(perCall.dir, 'output.json'), 'utf8'));
      expect(out2.result).toContain('attempt timed out after 500ms'); // beats the 30s run level
    } finally {
      if (prev === undefined) delete process.env.ULTRACODE_CLAUDE_BIN;
      else process.env.ULTRACODE_CLAUDE_BIN = prev;
    }
  }, 40_000);

  it('junk in worker-writable config fails closed: bogus permission → safe, non-int wallClockMs → loud uncapped', async () => {
    // The fake binary records its argv so the sandbox flag the executor
    // actually passed is observable.
    const binDir = mkdtempSync(join(tmpdir(), 'uc-fakebin-'));
    const fake = join(binDir, 'fake-claude.sh');
    const argvFile = join(binDir, 'argv.txt');
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nsleep 30\n`, { mode: 0o755 });
    const prev = process.env.ULTRACODE_CLAUDE_BIN;
    process.env.ULTRACODE_CLAUDE_BIN = fake;
    try {
      const { dir } = makeRun(TIMEOUT_PROBE(''), {
        backend: 'claude',
        permission: 'bogus', // worker-writable junk must fall CLOSED to 'safe'
        wallClockMs: 2.5, // non-int junk must log loudly and run uncapped
        attemptTimeoutMs: 700,
      });
      await launchRunner(dir);
      await waitTerminal(dir);
      expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).toContain('wall-clock cap 2.5ms is invalid — running uncapped');
      const argv = readFileSync(argvFile, 'utf8').split('\n');
      const modeAt = argv.indexOf('--permission-mode');
      expect(modeAt).toBeGreaterThan(-1);
      expect(argv[modeAt + 1]).toBe('default'); // claude's 'safe' mapping, not auto's acceptEdits
    } finally {
      if (prev === undefined) delete process.env.ULTRACODE_CLAUDE_BIN;
      else process.env.ULTRACODE_CLAUDE_BIN = prev;
    }
  }, 40_000);

  it('starts a detached runner outside an inherited worker-token lifecycle', async () => {
    if (process.platform !== 'linux') return;
    const enclosingToken = 'a'.repeat(32);
    const previous = process.env[WORKER_TOKEN_ENV];
    let runnerPid = 0;
    let runDir: string | undefined;
    process.env[WORKER_TOKEN_ENV] = enclosingToken;
    try {
      ({ dir: runDir } = makeRun(SLOW));
      ({ pid: runnerPid } = await launchRunner(runDir));
      expect(findWorkerProcesses(enclosingToken).some((proc) => proc.pid === runnerPid)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[WORKER_TOKEN_ENV];
      else process.env[WORKER_TOKEN_ENV] = previous;
      if (runnerPid > 1) {
        try {
          process.kill(runnerPid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      if (runDir && runnerPid > 1) await waitTerminal(runDir, 10_000);
    }
  }, 20_000);

  it('run survives launcher death by construction (launcher already exited: we are polling from a different process)', async () => {
    // The launcher (this test) returns from launchRunner immediately after
    // status flips to running; the runner keeps executing detached. This
    // assertion is implicit in every other test — here we just verify the
    // runner is not our child-session leader (detached).
    const { dir } = makeRun(HELLO);
    const { pid } = await launchRunner(dir);
    expect(pid).not.toBe(process.pid);
    await waitTerminal(dir);
  }, 30_000);
});
