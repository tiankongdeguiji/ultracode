import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { executeWorkflow } from '../../src/engine/run.js';
import {
  JournalWriter,
  KeyChain,
  PrefixReplayCache,
  readJournal,
  seedKey,
  type JournalRecord,
} from '../../src/engine/journal.js';
import { MockExecutor } from '../../src/backends/mock.js';
import { newRunId } from '../../src/store/layout.js';
import { createRunDir, readRunConfig } from '../../src/store/runstore.js';
import { readManifest, isTerminal } from '../../src/store/manifest.js';
import { launchRunner } from '../../src/exec/daemonize.js';

const CWD = '/fixed-root';

/**
 * In-process harness simulating what the runner does: journal records +
 * result.json files in a temp "prior run dir".
 */
async function runAndJournal(source: string, args: unknown = null) {
  const dir = mkdtempSync(join(tmpdir(), 'uc-prior-'));
  const journalFile = join(dir, 'journal.jsonl');
  const writer = new JournalWriter(journalFile);
  const chain = new KeyChain(seedKey(args), CWD);
  const executor = new MockExecutor();
  const output = await executeWorkflow(source, {
    executor,
    args,
    cwd: CWD,
    keyChain: chain,
    onAgentSettled: (r) => {
      let resultRef: string | undefined;
      if (r.status === 'ok') {
        resultRef = `agents/${r.spec.seq}/result.json`;
        mkdirSync(join(dir, 'agents', String(r.spec.seq)), { recursive: true });
        writeFileSync(join(dir, resultRef), JSON.stringify({ value: r.value ?? null }), 'utf8');
      }
      writer.append({
        t: 'agent',
        seq: r.spec.seq,
        key: r.cacheKey ?? '',
        status: r.status,
        label: r.spec.label,
        backend: r.spec.backend,
        totalTokens: r.usage.totalTokens,
        resultRef,
        error: r.error,
      });
    },
  });
  return { dir, records: readJournal(journalFile), output, executor };
}

async function replayRun(source: string, priorDir: string, records: JournalRecord[], args: unknown = null) {
  const chain = new KeyChain(seedKey(args), CWD);
  const cache = new PrefixReplayCache(records, priorDir);
  const executor = new MockExecutor();
  const output = await executeWorkflow(source, {
    executor,
    args,
    cwd: CWD,
    keyChain: chain,
    cacheLookup: cache.lookup,
  });
  return { output, executor, cache };
}

const THREE_AGENTS = `export const meta = { name: 'r', description: 'resume test' }
const a = await agent('MOCK:ok alpha', { label: 'a' })
const b = await agent('MOCK:ok beta', { label: 'b' })
const c = await agent('MOCK:ok gamma', { label: 'c' })
return [a, b, c]`;

describe('PrefixReplayCache', () => {
  it('same script + args → 100% cache hit, zero executor calls', async () => {
    const prior = await runAndJournal(THREE_AGENTS);
    expect(prior.output.result).toEqual(['alpha', 'beta', 'gamma']);

    const replay = await replayRun(THREE_AGENTS, prior.dir, prior.records);
    expect(replay.output.result).toEqual(['alpha', 'beta', 'gamma']);
    expect(replay.executor.stats.calls).toBe(0);
    expect(replay.cache.stats.hits).toBe(3);
  });

  it('edited script: unchanged prefix replays, first edit onward runs live', async () => {
    const prior = await runAndJournal(THREE_AGENTS);
    const edited = THREE_AGENTS.replace("MOCK:ok beta', { label: 'b' }", "MOCK:ok BETA2', { label: 'b' }");
    const replay = await replayRun(edited, prior.dir, prior.records);
    expect(replay.output.result).toEqual(['alpha', 'BETA2', 'gamma']);
    expect(replay.cache.stats.hits).toBe(1); // only 'a' replays
    expect(replay.executor.stats.calls).toBe(2); // b and c run live (chain diverged)
  });

  it('changed args change the seed → full re-run', async () => {
    const src = `export const meta = { name: 'r', description: 'd' }
return agent('MOCK:ok ' + args.word, { label: 'w' })`;
    const prior = await runAndJournal(src, { word: 'one' });
    const replay = await replayRun(src, prior.dir, prior.records, { word: 'two' });
    expect(replay.cache.stats.hits).toBe(0);
    expect(replay.executor.stats.calls).toBe(1);
    expect(replay.output.result).toBe('two');
  });

  it('skip records are advanced over: surrounding agents still replay', async () => {
    const src = `export const meta = { name: 'r', description: 'd' }
const a = await agent('MOCK:ok first', { label: 'a' })
await agent('whatever', { skip: true })
const c = await agent('MOCK:ok third', { label: 'c' })
return [a, c]`;
    const prior = await runAndJournal(src);
    const replay = await replayRun(src, prior.dir, prior.records);
    expect(replay.output.result).toEqual(['first', 'third']);
    expect(replay.executor.stats.calls).toBe(0);
    expect(replay.cache.stats.hits).toBe(2);
  });

  it('a prior error record is a miss: failed agent re-runs (and can now succeed)', async () => {
    const src = `export const meta = { name: 'r', description: 'd' }
const a = await agent('MOCK:ok stable', { label: 'a' })
let b = null
try { b = await agent('MOCK:fail-then-ok 1 recovered', { label: 'flaky' }) } catch (e) { b = 'failed' }
return [a, b]`;
    const prior = await runAndJournal(src);
    expect(prior.output.result).toEqual(['stable', 'failed']); // retries:0 → first run fails

    const replay = await replayRun(src, prior.dir, prior.records);
    expect(replay.cache.stats.hits).toBe(1); // 'a' replays
    // 'flaky' re-runs live; MockExecutor fail-then-ok counter is per-instance,
    // so the fresh executor fails once again — deterministic behavior.
    expect(replay.executor.stats.calls).toBe(1);
  });

  it('corrupt/missing result file breaks the prefix safely (live re-run, no crash)', async () => {
    const prior = await runAndJournal(THREE_AGENTS);
    writeFileSync(join(prior.dir, 'agents/0/result.json'), '{corrupt', 'utf8');
    const replay = await replayRun(THREE_AGENTS, prior.dir, prior.records);
    expect(replay.output.result).toEqual(['alpha', 'beta', 'gamma']);
    expect(replay.executor.stats.calls).toBe(3);
    expect(replay.cache.stats.hits).toBe(0);
  });

  it('a parallel batch that completes out of order still fully replays (journal seq-sorted)', async () => {
    const src = `export const meta = { name: 'r', description: 'd' }
const r = await parallel([
  () => agent('MOCK:delay 80 MOCK:ok zero', { label: 'z' }),
  () => agent('MOCK:ok one', { label: 'o' }),
])
return r`;
    const prior = await runAndJournal(src);
    expect(prior.output.result).toEqual(['zero', 'one']);
    // seq 1 completes before seq 0, so the journal is appended out of dispatch order
    expect(prior.records.filter((r) => r.t === 'agent').map((r) => (r as { seq: number }).seq)).toEqual([1, 0]);
    // ...but resume sorts by seq, so the whole prefix still hits.
    const replay = await replayRun(src, prior.dir, prior.records);
    expect(replay.output.result).toEqual(['zero', 'one']);
    expect(replay.cache.stats.hits).toBe(2);
    expect(replay.executor.stats.calls).toBe(0);
  });
});

describe('runner-level resume (detached processes)', () => {
  it('full cycle: run → resume → cached journal records in the new run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-resume-'));
    const source = `export const meta = { name: 'rr', description: 'd' }
const x = await agent('MOCK:ok cached-value', { label: 'one' })
return x`;

    const firstId = newRunId();
    const firstDir = createRunDir(root, {
      runId: firstId,
      name: 'rr',
      source,
      args: null,
      config: { backend: 'mock', cwd: '/same' },
    });
    await launchRunner(firstDir);
    await waitTerminal(firstDir);
    expect(readManifest(firstDir)!.status).toBe('completed');

    const secondId = newRunId();
    const config = readRunConfig(firstDir);
    config.resumeFromRunId = firstId;
    const secondDir = createRunDir(root, {
      runId: secondId,
      name: 'rr',
      source,
      args: null,
      config,
      resumedFrom: firstId,
    });
    await launchRunner(secondDir);
    await waitTerminal(secondDir);

    const manifest = readManifest(secondDir)!;
    expect(manifest.status).toBe('completed');
    expect(manifest.resumedFrom).toBe(firstId);

    const output = JSON.parse(readFileSync(join(secondDir, 'output.json'), 'utf8'));
    expect(output.result).toBe('cached-value');

    const journal = readJournal(join(secondDir, 'journal.jsonl'));
    const agentRec = journal.find((r) => r.t === 'agent') as Extract<JournalRecord, { t: 'agent' }>;
    expect(agentRec.cached).toBe(true);
    expect(agentRec.totalTokens).toBe(0);

    // The resumed run is self-contained: its own result.json exists.
    const resultJson = JSON.parse(readFileSync(join(secondDir, 'agents/0000-one/result.json'), 'utf8'));
    expect(resultJson).toMatchObject({ value: 'cached-value', cached: true });
  }, 40_000);

  it('resume --max-concurrency: explicit override wins; no flag inherits the value frozen at creation', async () => {
    const { resumeCommand } = await import('../../src/cli/resume.js');
    const root = mkdtempSync(join(tmpdir(), 'uc-resume-mc-'));
    const source = `export const meta = { name: 'mc', description: 'd' }
return await agent('MOCK:ok v', { label: 'one' })`;
    const firstId = newRunId();
    const firstDir = createRunDir(root, {
      runId: firstId,
      name: 'mc',
      source,
      args: null,
      config: { backend: 'mock', cwd: '/same', maxConcurrency: 3 },
    });
    await launchRunner(firstDir);
    await waitTerminal(firstDir);

    const outs: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      outs.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // (1) explicit override lands in the resumed run's config.json
      outs.length = 0;
      expect(await resumeCommand(firstId, { home: root, detach: true, maxConcurrency: '5' })).toBe(0);
      const overrideDir = join(root, 'runs', outs.join('').trim().split('\n')[0]!);
      expect(readRunConfig(overrideDir).maxConcurrency).toBe(5);
      await waitTerminal(overrideDir);

      // (2) no flag → the value frozen at creation is inherited untouched
      outs.length = 0;
      expect(await resumeCommand(firstId, { home: root, detach: true })).toBe(0);
      const inheritDir = join(root, 'runs', outs.join('').trim().split('\n')[0]!);
      expect(readRunConfig(inheritDir).maxConcurrency).toBe(3);
      await waitTerminal(inheritDir);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  }, 40_000);
});

async function waitTerminal(dir: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = readManifest(dir);
    if (m && isTerminal(m.status)) return;
    if (Date.now() > deadline) throw new Error(`not terminal: ${m?.status}`);
    await sleep(100);
  }
}
