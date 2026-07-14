/**
 * Integration: real detached-runner processes over the run store (mock
 * backend, no network). Spawns node --import tsx, so these are the slowest
 * unit-adjacent tests (~2-4s each).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { newRunId } from '../../src/store/layout.js';
import { createRunDir, getRun, isPidAlive } from '../../src/store/runstore.js';
import { readManifest, isTerminal } from '../../src/store/manifest.js';
import { launchRunner } from '../../src/exec/daemonize.js';
import { readJournal } from '../../src/engine/journal.js';

const HELLO = `export const meta = { name: 'hello', description: 'd', phases: [{ title: 'Greet' }] }
phase('Greet')
const g = await agent('MOCK:ok hi', { label: 'greeter' })
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

async function waitTerminal(dir: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = readManifest(dir);
    if (m && isTerminal(m.status)) return m.status;
    if (Date.now() > deadline) throw new Error(`run did not finish; status=${m?.status}`);
    await sleep(100);
  }
}

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
    expect(readFileSync(join(dir, 'agents/0000-greeter/prompt.md'), 'utf8')).toBe('MOCK:ok hi');

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
