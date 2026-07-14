/**
 * The `__runner` process: executes exactly one run inside its run dir.
 * Single writer for everything under the dir: manifest (atomic swaps,
 * 5s heartbeat), events.jsonl, journal.jsonl, agents/**, output.json.
 * SIGTERM aborts the run gracefully; partial output is preserved.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { writeFileNoFollow } from '../exec/safe-write.js';
import { dirname, join } from 'node:path';
import { executeWorkflow } from '../engine/run.js';
import { parseWorkflowScript } from '../engine/meta.js';
import { JournalWriter, KeyChain, PrefixReplayCache, argsHash, readJournal, seedKey } from '../engine/journal.js';
import { EventWriter } from '../store/events.js';
import { readManifest, writeManifest, HEARTBEAT_INTERVAL_MS, type RunManifest } from '../store/manifest.js';
import { readRunArgs, readRunConfig } from '../store/runstore.js';
import { agentDirName } from '../store/layout.js';
import { MockExecutor } from '../backends/mock.js';
import { createExecutorForBackend } from '../engine/agentcall.js';
import { readProcStat } from '../exec/procinfo.js';
import { Semaphore, defaultConcurrency } from '../engine/semaphore.js';
import { WorkflowBudgetError } from '../engine/errors.js';
import { BudgetAccount } from '../budget/account.js';
import { createWorktreeManager, repoRootSync, worktreesRootFor } from '../exec/worktree.js';
import { resolveWorkflowSource } from '../installer/registry.js';
import { VERSION } from '../version.js';
import type { AgentExecutor, AgentSpec } from '../backends/types.js';
import type { SharedRunState } from '../engine/hostapi.js';

/**
 * Routes each agent to its backend's executor (per-call `backend:` override
 * in agent() options; run config supplies the default).
 */
function makeExecutorMux(
  dir: string,
  permission: 'safe' | 'auto' | 'danger',
  budget: BudgetAccount,
  codexMaxConcurrency?: number,
): AgentExecutor {
  const cache = new Map<string, AgentExecutor>();
  const artifactDir = (spec: AgentSpec) => join(dir, 'agents', agentDirName(spec.seq, spec.label));
  // Gate codex separately so per-call backend:'codex' honors the OAuth fan-out
  // cap even in a non-codex-default run (where the run-level semaphore is wider).
  const codexSem =
    codexMaxConcurrency && codexMaxConcurrency >= 1 && codexMaxConcurrency !== Infinity
      ? new Semaphore(codexMaxConcurrency)
      : undefined;
  const resolve = (backend: string): AgentExecutor => {
    let ex = cache.get(backend);
    if (!ex) {
      ex =
        backend === 'mock'
          ? new MockExecutor()
          : (createExecutorForBackend(backend, { artifactDir, permission }) ??
            (() => {
              throw new Error(`backend '${backend}' is not implemented yet`);
            })());
      cache.set(backend, ex);
    }
    return ex;
  };
  return {
    async execute(spec, signal) {
      const ex = resolve(spec.backend);
      if (spec.backend === 'codex' && codexSem) {
        const release = await codexSem.acquire();
        try {
          // Re-check the budget AFTER the codex queue wait. Many codex calls can
          // clear the engine's dispatch gate at spent=0, then serialize here
          // behind cap 1 while earlier calls exhaust the budget — without this
          // they'd all still spawn sequentially past the ceiling.
          if (budget.remaining() <= 0) throw new WorkflowBudgetError();
          return await ex.execute(spec, signal);
        } finally {
          release();
        }
      }
      return ex.execute(spec, signal);
    },
  };
}

export async function runnerMain(dir: string): Promise<number> {
  const source = readFileSync(join(dir, 'script.js'), 'utf8');
  const args = readRunArgs(dir);
  const config = readRunConfig(dir);
  const base = readManifest(dir);
  if (!base) throw new Error(`no manifest in ${dir}`);

  const events = new EventWriter(join(dir, 'events.jsonl'));
  const journal = new JournalWriter(join(dir, 'journal.jsonl'));
  const abort = new AbortController();

  let manifest: RunManifest = {
    ...base,
    status: 'running',
    pid: process.pid,
    pidStart: readProcStat(process.pid)?.starttime,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    engineVersion: VERSION,
  };
  const flushManifest = () => {
    manifest = { ...manifest, heartbeatAt: new Date().toISOString() };
    writeManifest(dir, manifest);
  };
  flushManifest();

  const heartbeat = setInterval(flushManifest, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  // Hard-stop backstop: abort() only stops the run if executeWorkflow can
  // observe the signal and unwind. A guest awaiting a never-settling promise
  // never returns, so the terminal manifest/output are never written and this
  // detached process leaks. Arm a grace timer on any abort that finalizes and
  // force-exits. (A CPU-bound sync loop blocks this timer too — that case still
  // needs an external `ultracode stop` SIGKILL, as documented.)
  const HARD_STOP_GRACE_MS = 15_000;
  let hardStopTimer: ReturnType<typeof setTimeout> | undefined;
  const armHardStop = (reason: string) => {
    if (hardStopTimer) return;
    hardStopTimer = setTimeout(() => {
      events.write({
        type: 'workflow_log',
        message: `hard stop: runner did not unwind ${HARD_STOP_GRACE_MS}ms after ${reason} — force-exiting`,
      });
      try {
        writeManifest(dir, {
          ...manifest,
          status: 'stopped',
          endedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          error: reason,
        });
      } catch {
        /* best effort — the point is to not leave a live orphan */
      }
      events.close();
      process.exit(1);
    }, HARD_STOP_GRACE_MS);
    hardStopTimer.unref();
  };

  process.on('SIGTERM', () => {
    events.write({ type: 'stop_requested' });
    abort.abort(new Error('stopped by user'));
    armHardStop('stop requested');
  });
  process.on('SIGINT', () => {
    abort.abort(new Error('stopped by user'));
    armHardStop('interrupt');
  });

  // Wall-clock cap (default 60 minutes) — a loud stop, never a silent one.
  const wallClockMs = config.wallClockMs ?? 60 * 60_000;
  const wallTimer = setTimeout(() => {
    events.write({ type: 'workflow_log', message: `wall-clock cap ${wallClockMs}ms exceeded — stopping run` });
    abort.abort(new Error(`wall-clock cap ${wallClockMs}ms exceeded`));
    armHardStop('wall-clock cap');
  }, wallClockMs);
  wallTimer.unref();

  // Parse up-front to seed the journal chain (executeWorkflow re-parses; cheap).
  const parsed = parseWorkflowScript(source);
  const chain = new KeyChain(seedKey(args), config.cwd);
  journal.append({
    t: 'started',
    runId: manifest.runId,
    engineVersion: VERSION,
    scriptHash: parsed.scriptHash,
    argsHash: argsHash(args),
    seedKey: seedKey(args),
  });

  // Prefix-replay cache from the prior run's journal (resume path).
  let replay: PrefixReplayCache | undefined;
  if (config.resumeFromRunId) {
    const priorDir = join(dirname(dir), config.resumeFromRunId);
    replay = new PrefixReplayCache(readJournal(join(priorDir, 'journal.jsonl')), priorDir);
    events.write({ type: 'workflow_log', message: `resuming from ${config.resumeFromRunId} (prefix replay)` });
  }

  // Shared execution state so nested workflow() children share caps/budget.
  const budgetAccount = new BudgetAccount(config.budgetTotal ?? null);
  const shared: SharedRunState = {
    semaphore: new Semaphore(config.maxConcurrency ?? defaultConcurrency()),
    counter: { count: 0 },
    runId: manifest.runId,
  };
  // Worktree isolation only inside a git repo.
  const repoRoot = repoRootSync(config.cwd);
  if (repoRoot) shared.worktrees = createWorktreeManager(repoRoot, worktreesRootFor(dir));

  let spentTotal = 0;
  const output = await executeWorkflow(source, {
    executor: makeExecutorMux(dir, config.permission ?? 'auto', budgetAccount, config.codexMaxConcurrency),
    cacheLookup: replay?.lookup,
    args,
    budgetAccount,
    shared,
    resolveChild: (nameOrPath) => resolveWorkflowSource(nameOrPath, config.cwd),
    maxAgents: config.maxAgents,
    maxConcurrency: config.maxConcurrency,
    logCap: config.logCap,
    signal: abort.signal,
    defaultBackend: config.backend,
    cwd: config.cwd,
    keyChain: chain,
    onEvent: (ev) => {
      events.write(ev as never);
      if (ev.type === 'phase_started') {
        if (!manifest.phases.some((p) => p.title === ev.title)) {
          manifest.phases.push({ title: ev.title, agentsDone: 0 });
        }
      }
      if (ev.type === 'agent_completed') {
        manifest.agentCount++;
        // Credit the agent's OWN phase (by title), not whatever phase is last —
        // concurrent agents from an earlier phase and skipped agents would
        // otherwise inflate the final phase. Mirrors hostapi's bumpPhase (skips
        // don't count).
        if (ev.ok && !ev.skipped && ev.phase) {
          const p = manifest.phases.find((ph) => ph.title === ev.phase);
          if (p) p.agentsDone++;
        }
        flushManifest();
      }
      if (ev.type === 'budget_tick') {
        spentTotal = ev.spent;
        manifest.budget = { ...manifest.budget, spent: ev.spent };
      }
    },
    onAgentSettled: (record) => {
      const agentDir = join(dir, 'agents', agentDirName(record.spec.seq, record.spec.label));
      mkdirSync(agentDir, { recursive: true });
      // Symlink-safe: a worker may have planted a symlink at these paths.
      writeFileNoFollow(join(agentDir, 'prompt.md'), record.spec.prompt);
      if (record.spec.schema) {
        writeFileNoFollow(join(agentDir, 'schema.json'), JSON.stringify(record.spec.schema, null, 2));
      }
      const resultRef = join('agents', agentDirName(record.spec.seq, record.spec.label), 'result.json');
      writeFileNoFollow(
        join(dir, resultRef),
        JSON.stringify(
          {
            ok: record.status === 'ok',
            status: record.status,
            value: record.value ?? null,
            error: record.error,
            usage: record.usage,
            sessionId: record.sessionId,
            backend: record.spec.backend,
            cached: record.cached ?? false,
          },
          null,
          2,
        ),
      );
      journal.append({
        t: 'agent',
        seq: record.spec.seq,
        key: record.cacheKey ?? '',
        status: record.status,
        label: record.spec.label,
        phase: record.spec.phase,
        backend: record.spec.backend,
        cached: record.cached,
        sessionId: record.sessionId,
        totalTokens: record.usage.totalTokens,
        resultRef,
        error: record.error,
      });
    },
  });

  clearInterval(heartbeat);
  clearTimeout(wallTimer);
  if (hardStopTimer) clearTimeout(hardStopTimer); // workflow unwound on its own
  if (replay) {
    events.write({
      type: 'workflow_log',
      message: `prefix replay: ${replay.stats.hits} agent(s) from cache, ${replay.stats.hits === 0 ? 'no prefix matched' : `first live call after position ${replay.stats.hits}`}`,
    });
  }
  writeFileNoFollow(join(dir, 'output.json'), JSON.stringify(output, null, 2));

  const stopped = abort.signal.aborted;
  manifest = {
    ...manifest,
    status: stopped ? 'stopped' : output.error ? 'failed' : 'completed',
    endedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    budget: { ...manifest.budget, spent: spentTotal || output.totalTokens },
    error: output.error,
  };
  writeManifest(dir, manifest);
  events.close();
  return manifest.status === 'completed' ? 0 : 1;
}
