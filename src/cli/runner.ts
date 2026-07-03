/**
 * The `__runner` process: executes exactly one run inside its run dir.
 * Single writer for everything under the dir: manifest (atomic swaps,
 * 5s heartbeat), events.jsonl, journal.jsonl, agents/**, output.json.
 * SIGTERM aborts the run gracefully; partial output is preserved.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeWorkflow } from '../engine/run.js';
import { parseWorkflowScript } from '../engine/meta.js';
import { JournalWriter, KeyChain, argsHash, seedKey } from '../engine/journal.js';
import { EventWriter } from '../store/events.js';
import { readManifest, writeManifest, HEARTBEAT_INTERVAL_MS, type RunManifest } from '../store/manifest.js';
import { readRunArgs, readRunConfig } from '../store/runstore.js';
import { agentDirName } from '../store/layout.js';
import { MockExecutor } from '../backends/mock.js';
import { createExecutorForBackend } from '../engine/agentcall.js';
import { VERSION } from '../version.js';
import type { AgentExecutor, AgentSpec } from '../backends/types.js';

/**
 * Routes each agent to its backend's executor (per-call `backend:` override
 * in agent() options; run config supplies the default).
 */
function makeExecutorMux(dir: string, permission: 'safe' | 'auto' | 'danger'): AgentExecutor {
  const cache = new Map<string, AgentExecutor>();
  const artifactDir = (spec: AgentSpec) => join(dir, 'agents', agentDirName(spec.seq, spec.label));
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
    execute(spec, signal) {
      return resolve(spec.backend).execute(spec, signal);
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

  process.on('SIGTERM', () => {
    events.write({ type: 'stop_requested' });
    abort.abort(new Error('stopped by user'));
  });
  process.on('SIGINT', () => {
    abort.abort(new Error('stopped by user'));
  });

  // Wall-clock cap (default 60 minutes) — a loud stop, never a silent one.
  const wallClockMs = config.wallClockMs ?? 60 * 60_000;
  const wallTimer = setTimeout(() => {
    events.write({ type: 'workflow_log', message: `wall-clock cap ${wallClockMs}ms exceeded — stopping run` });
    abort.abort(new Error(`wall-clock cap ${wallClockMs}ms exceeded`));
  }, wallClockMs);
  wallTimer.unref();

  // Parse up-front to seed the journal chain (executeWorkflow re-parses; cheap).
  const parsed = parseWorkflowScript(source);
  const chain = new KeyChain(seedKey(parsed.scriptHash, args), config.cwd);
  journal.append({
    t: 'started',
    runId: manifest.runId,
    engineVersion: VERSION,
    scriptHash: parsed.scriptHash,
    argsHash: argsHash(args),
    seedKey: seedKey(parsed.scriptHash, args),
  });

  let spentTotal = 0;
  const output = await executeWorkflow(source, {
    executor: makeExecutorMux(dir, config.permission ?? 'auto'),
    args,
    budgetTotal: config.budgetTotal ?? null,
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
        if (ev.ok) {
          const p = manifest.phases.at(-1);
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
      writeFileSync(join(agentDir, 'prompt.md'), record.spec.prompt, 'utf8');
      if (record.spec.schema) {
        writeFileSync(join(agentDir, 'schema.json'), JSON.stringify(record.spec.schema, null, 2), 'utf8');
      }
      const resultRef = join('agents', agentDirName(record.spec.seq, record.spec.label), 'result.json');
      writeFileSync(
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
        'utf8',
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
  writeFileSync(join(dir, 'output.json'), JSON.stringify(output, null, 2), 'utf8');

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
