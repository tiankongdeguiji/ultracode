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
import { chainedTimeout } from '../exec/timers.js';
import { Semaphore, defaultConcurrency, isPositiveInt } from '../engine/semaphore.js';
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
function makeExecutorMux(dir: string, permission: 'safe' | 'auto' | 'danger', attemptTimeoutMs?: number): AgentExecutor {
  const cache = new Map<string, AgentExecutor>();
  const artifactDir = (spec: AgentSpec) => join(dir, 'agents', agentDirName(spec.seq, spec.label));
  const resolve = (backend: string): AgentExecutor => {
    let ex = cache.get(backend);
    if (!ex) {
      ex =
        backend === 'mock'
          ? new MockExecutor({ attemptTimeoutMs })
          : (createExecutorForBackend(backend, { artifactDir, permission, attemptTimeoutMs }) ??
            (() => {
              throw new Error(`backend '${backend}' is not implemented yet`);
            })());
      cache.set(backend, ex);
    }
    return ex;
  };
  return {
    execute(spec, signal, onProgress) {
      return resolve(spec.backend).execute(spec, signal, onProgress);
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
  const HARD_STOP_GRACE_MS = Number(process.env.ULTRACODE_HARD_STOP_GRACE_MS) || 15_000;
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
    // Intentionally NOT unref'd: this is the last-resort guarantee. On abort the
    // sandbox disposes the script's timers, so the loop can otherwise empty and
    // the process exit code-0 with a stuck 'running' manifest before this fires.
    // Keeping it ref'd holds the process alive just long enough to finalize.
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

  // Wall-clock cap — user-opt-in: unset runs unlimited; when set it is a loud
  // stop, never a silent one. chainedTimeout honors oversized caps past the
  // setTimeout range; invalid values (≤0, NaN, fractional — the config file
  // is worker-writable; same predicate as attemptTimeoutMs below) run
  // uncapped, saying so loudly.
  const wallClockMs = config.wallClockMs;
  let wallTimer: { clear(): void } | undefined;
  if (wallClockMs !== undefined) {
    if (isPositiveInt(wallClockMs)) {
      wallTimer = chainedTimeout(wallClockMs, () => {
        events.write({ type: 'workflow_log', message: `wall-clock cap ${wallClockMs}ms exceeded — stopping run` });
        abort.abort(new Error(`wall-clock cap ${wallClockMs}ms exceeded`));
        armHardStop('wall-clock cap');
      });
    } else {
      events.write({ type: 'workflow_log', message: `wall-clock cap ${wallClockMs}ms is invalid — running uncapped` });
    }
  }

  // Parse up-front to seed the journal chain (executeWorkflow re-parses; cheap).
  // The seed folds in permission so a resume under a different permission does
  // not replay results produced under different capabilities.
  const parsed = parseWorkflowScript(source);
  const seed = seedKey(args, config.permission);
  const chain = new KeyChain(seed, config.cwd);
  journal.append({
    t: 'started',
    runId: manifest.runId,
    engineVersion: VERSION,
    scriptHash: parsed.scriptHash,
    argsHash: argsHash(args),
    seedKey: seed,
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
  // Choke-point guard: config.json is worker-writable and version-inherited on
  // resume — a non-positive-integer maxConcurrency (0, 2.5, hand-edited junk)
  // would throw in the Semaphore constructor AFTER the manifest flipped to
  // 'running', orphaning the run. Fall back to the default instead.
  const storedMax = config.maxConcurrency ?? defaultConcurrency();
  const maxConcurrency = isPositiveInt(storedMax) ? storedMax : defaultConcurrency();
  const shared: SharedRunState = {
    semaphore: new Semaphore(maxConcurrency),
    counter: { count: 0 },
    runId: manifest.runId,
  };
  // Worktree isolation only inside a git repo.
  const repoRoot = repoRootSync(config.cwd);
  if (repoRoot) shared.worktrees = createWorktreeManager(repoRoot, worktreesRootFor(dir));

  // Same worker-writable-config caution as maxConcurrency above: junk in
  // attemptTimeoutMs falls back to unlimited (timeouts are opt-in; per-call
  // timeoutMs still applies). Applied loudly so the override is observable
  // in events.jsonl.
  const attemptTimeoutMs =
    config.attemptTimeoutMs !== undefined && isPositiveInt(config.attemptTimeoutMs) ? config.attemptTimeoutMs : undefined;
  if (attemptTimeoutMs !== undefined) {
    events.write({ type: 'workflow_log', message: `attempt timeout ${attemptTimeoutMs}ms (run-level override)` });
  }
  // `permission` crosses the same worker-writable boundary: junk fails CLOSED
  // to 'safe'. (A forged-but-VALID 'danger' is the documented run-store trust
  // follow-up — a validator cannot tell it from a legitimate one.)
  const permission =
    config.permission === undefined
      ? 'auto'
      : (['safe', 'auto', 'danger'] as readonly string[]).includes(config.permission)
        ? config.permission
        : 'safe';

  let spentTotal = 0;
  const output = await executeWorkflow(source, {
    executor: makeExecutorMux(dir, permission, attemptTimeoutMs),
    cacheLookup: replay?.lookup,
    args,
    budgetAccount,
    shared,
    resolveChild: (nameOrPath) => resolveWorkflowSource(nameOrPath, config.cwd),
    maxAgents: config.maxAgents,
    // The guarded local, NOT raw config.maxConcurrency: if a refactor ever
    // stops threading `shared`, the engine's own Semaphore fallback must still
    // receive a sanitized value (raw 2.5/0 would throw post-'running').
    maxConcurrency,
    logCap: config.logCap,
    signal: abort.signal,
    defaultBackend: config.backend,
    cwd: config.cwd,
    keyChain: chain,
    onEvent: (ev) => {
      events.write(ev);
      // Manifest phases mirror the PARENT workflow only: child-tagged phase
      // events would otherwise create/credit same-titled parent entries.
      if (ev.type === 'phase_started' && ev.childId === undefined) {
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
        if (ev.childId === undefined && ev.ok && !ev.skipped && ev.phase) {
          const p = manifest.phases.find((ph) => ph.title === ev.phase);
          if (p) p.agentsDone++;
        }
        flushManifest();
      }
      if (ev.type === 'budget_tick') {
        spentTotal = ev.spent;
        manifest.budget = { ...manifest.budget, spent: ev.spent };
      }
      // Journal boundary records for nested workflow() calls; replay-safe
      // (PrefixReplayCache reads only t:'agent' records).
      if (ev.type === 'child_started') journal.append({ t: 'child-enter', name: ev.name, argsHash: ev.argsHash });
      if (ev.type === 'child_completed') journal.append({ t: 'child-exit', name: ev.name });
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
            model: record.spec.model,
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
        model: record.spec.model,
        cached: record.cached,
        sessionId: record.sessionId,
        totalTokens: record.usage.totalTokens,
        resultRef,
        error: record.error,
      });
    },
  });

  clearInterval(heartbeat);
  wallTimer?.clear();
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
