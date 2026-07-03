/**
 * Run store: create/list/inspect run directories, liveness detection, and
 * orphan reaping. CLI and MCP server are stateless readers over this store;
 * only the runner process writes inside its own run dir.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../version.js';
import { runDir, runsDir, RUN_ID_RE } from './layout.js';
import {
  HEARTBEAT_STALE_MS,
  isTerminal,
  readManifest,
  writeManifest,
  type RunManifest,
  type RunStatus,
} from './manifest.js';

export interface RunConfig {
  backend: string;
  cwd: string;
  maxAgents?: number;
  maxConcurrency?: number;
  budgetTotal?: number | null;
  logCap?: number;
  permission?: 'safe' | 'auto' | 'danger';
  resumeFromRunId?: string;
}

export interface CreateRunInput {
  runId: string;
  name: string;
  source: string;
  args: unknown;
  config: RunConfig;
  resumedFrom?: string;
}

export function createRunDir(root: string, input: CreateRunInput): string {
  const dir = runDir(root, input.runId);
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'script.js'), input.source, 'utf8');
  writeFileSync(join(dir, 'args.json'), JSON.stringify(input.args ?? null, null, 2), 'utf8');
  writeFileSync(join(dir, 'config.json'), JSON.stringify(input.config, null, 2), 'utf8');
  const now = new Date().toISOString();
  writeManifest(dir, {
    runId: input.runId,
    name: input.name,
    status: 'created',
    pid: 0,
    startedAt: now,
    heartbeatAt: now,
    phases: [],
    agentCount: 0,
    budget: { total: input.config.budgetTotal ?? null, spent: 0 },
    backendDefault: input.config.backend,
    resumedFrom: input.resumedFrom,
    engineVersion: VERSION,
  });
  return dir;
}

export function readRunConfig(dir: string): RunConfig {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as RunConfig;
}

export function readRunArgs(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'));
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Effective status: detects runners that died without finalizing. */
export function liveStatus(manifest: RunManifest): RunStatus {
  if (isTerminal(manifest.status)) return manifest.status;
  if (manifest.status === 'created') return manifest.status;
  const stale = Date.now() - Date.parse(manifest.heartbeatAt) > HEARTBEAT_STALE_MS;
  if (!isPidAlive(manifest.pid) || stale) return 'orphaned';
  return manifest.status;
}

export interface RunSummary {
  runId: string;
  dir: string;
  manifest: RunManifest;
  effectiveStatus: RunStatus;
}

export function getRun(root: string, runId: string): RunSummary | null {
  if (!RUN_ID_RE.test(runId)) return null;
  const dir = runDir(root, runId);
  const manifest = readManifest(dir);
  if (!manifest) return null;
  return { runId, dir, manifest, effectiveStatus: liveStatus(manifest) };
}

export function listRuns(root: string): RunSummary[] {
  const base = runsDir(root);
  if (!existsSync(base)) return [];
  const out: RunSummary[] = [];
  for (const entry of readdirSync(base)) {
    if (!RUN_ID_RE.test(entry)) continue;
    const summary = getRun(root, entry);
    if (summary) out.push(summary);
  }
  return out.sort((a, b) => Date.parse(a.manifest.startedAt) - Date.parse(b.manifest.startedAt));
}

/** Finalize orphaned runs (runner died without writing a terminal manifest). */
export function reapOrphans(root: string): string[] {
  const reaped: string[] = [];
  for (const run of listRuns(root)) {
    if (run.effectiveStatus === 'orphaned' && run.manifest.status !== 'orphaned') {
      writeManifest(run.dir, {
        ...run.manifest,
        status: 'orphaned',
        endedAt: new Date().toISOString(),
        error: run.manifest.error ?? 'runner died without finalizing',
      });
      reaped.push(run.runId);
    }
  }
  return reaped;
}
