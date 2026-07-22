/** Exact FeatureBench telemetry indexing beneath state-bound timestamped runs. */
import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { FeatureBenchManifest } from '../../shared/manifest.js';
import type { MetricsArtifactIndex, WorkflowArtifact } from '../../shared/metrics.js';
import { forEachJsonLine } from '../../shared/jsonl.js';
import { readRegularFileWithinRoot } from '../../shared/paths.js';
import type { BenchRunState } from '../../shared/run-state.js';

const TIMESTAMP_ROOT_RE = /^native\/\d{4}-\d{2}-\d{2}__\d{2}-\d{2}-\d{2}$/;

function portable(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function files(root: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const walk = (directory: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && predicate(entry.name)) output.push(path);
    }
  };
  walk(root);
  return output.sort();
}

function json(runDirectory: string, path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readRegularFileWithinRoot(runDirectory, path).toString('utf8')) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sessionId(path: string): string | null {
  return /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1] ?? null;
}

function hostSessionIds(eventsPath: string): Set<string> {
  const ids = new Set<string>();
  forEachJsonLine(eventsPath, (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const event = value as Record<string, unknown>;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') ids.add(event.thread_id);
  });
  return ids;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function workflowArtifacts(
  runDirectory: string,
  attemptDirectory: string,
  taskId: string,
  arm: 'a' | 'b',
): { workflows: WorkflowArtifact[]; backends: Map<string, string> } {
  const runs = join(attemptDirectory, 'ultracode', 'runs');
  let entries: Dirent[];
  try { entries = readdirSync(runs, { withFileTypes: true }); } catch {
    return { workflows: [], backends: new Map() };
  }
  const workflows: WorkflowArtifact[] = [];
  const backends = new Map<string, string>();
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const root = join(runs, entry.name);
    const config = json(runDirectory, portable(runDirectory, join(root, 'config.json')));
    const manifest = json(runDirectory, portable(runDirectory, join(root, 'manifest.json')));
    const output = json(runDirectory, portable(runDirectory, join(root, 'output.json')));
    const backend = typeof config?.backend === 'string' ? config.backend : null;
    for (const path of files(join(root, 'agents'), (name) => name === 'result.json')) {
      const result = json(runDirectory, portable(runDirectory, path));
      if (typeof result?.sessionId === 'string' && typeof result.backend === 'string') {
        backends.set(result.sessionId, result.backend);
      }
    }
    workflows.push({
      scope: { taskId, arm },
      workflowId: entry.name,
      status: typeof manifest?.status === 'string' ? manifest.status : 'unknown',
      agentCount: number(output?.agentCount),
      failureCount: Array.isArray(output?.failures) ? output.failures.length : 0,
      workspacesKept: Array.isArray(output?.workspaces) ? output.workspaces.length : 0,
      backend,
      billingClass: backend === 'mock' ? 'mock' : backend === null ? 'unknown' : 'billable',
    });
  }
  return { workflows, backends };
}

function latestInferenceRoots(state: BenchRunState): Map<string, string[]> {
  const byTask = new Map<string, string[]>();
  for (const attempt of state.attempts) {
    if (attempt.phase !== 'inference' || attempt.nativePath === null || attempt.status === 'running') continue;
    if (!TIMESTAMP_ROOT_RE.test(attempt.nativePath)) {
      throw new Error(`FeatureBench metrics state contains a non-timestamp native root: ${attempt.nativePath}`);
    }
    const roots = byTask.get(attempt.taskId) ?? [];
    if (!roots.includes(attempt.nativePath)) roots.push(attempt.nativePath);
    byTask.set(attempt.taskId, roots);
  }
  return byTask;
}

/** Index only manifest task attempt directories under state-bound native roots. */
export function indexFeatureBenchMetrics(
  manifest: FeatureBenchManifest,
  runDirectory: string,
  state: BenchRunState,
): MetricsArtifactIndex {
  const rollouts: MetricsArtifactIndex['rollouts'][number][] = [];
  const workflows: WorkflowArtifact[] = [];
  const seenRollouts = new Set<string>();
  const seenWorkflows = new Set<string>();
  const roots = latestInferenceRoots(state);
  for (const execution of manifest.artifacts.executions) {
    for (const nativeRoot of roots.get(execution.taskId) ?? []) {
      const attemptDirectory = join(
        runDirectory,
        ...nativeRoot.split('/'),
        'run_outputs',
        execution.taskId,
        'attempt-1',
      );
      const eventsPath = join(attemptDirectory, 'codex_events.jsonl');
      const hosts = existsSync(eventsPath) ? hostSessionIds(eventsPath) : new Set<string>();
      const workflow = workflowArtifacts(runDirectory, attemptDirectory, execution.taskId, execution.arm);
      for (const entry of workflow.workflows) {
        const key = `${entry.scope.taskId}\0${entry.scope.arm}\0${entry.workflowId}`;
        if (!seenWorkflows.has(key)) workflows.push(entry);
        seenWorkflows.add(key);
      }
      for (const path of files(join(attemptDirectory, 'codex_sessions'), (name) => /^rollout-.*\.jsonl$/.test(name))) {
        const relativePath = portable(runDirectory, path);
        if (seenRollouts.has(relativePath)) continue;
        seenRollouts.add(relativePath);
        const id = sessionId(path);
        const host = execution.arm === 'a' || (id !== null && hosts.has(id));
        const backend = host ? 'codex' : id === null ? null : workflow.backends.get(id) ?? null;
        rollouts.push({
          scope: { taskId: execution.taskId, arm: execution.arm },
          path: relativePath,
          roleHint: host ? 'host' : 'worker',
          backend,
          billingClass: backend === 'mock' ? 'mock' : backend === null ? 'unknown' : 'billable',
        });
      }
    }
  }
  return { rollouts, workflows, timings: [], annotations: [], failures: [] };
}
