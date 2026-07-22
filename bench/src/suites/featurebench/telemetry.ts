/** Exact FeatureBench telemetry indexing beneath state-bound timestamped runs. */
import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { FeatureBenchManifest } from '../../shared/manifest.js';
import type { MetricsArtifactIndex, WorkflowArtifact } from '../../shared/metrics.js';
import type { Annotation } from '../../shared/failure.js';
import { forEachJsonLine } from '../../shared/jsonl.js';
import { readRegularFileWithinRoot } from '../../shared/paths.js';
import type { BenchRunState } from '../../shared/run-state.js';

const TIMESTAMP_ROOT_RE = /^native\/\d{4}-\d{2}-\d{2}__\d{2}-\d{2}-\d{2}$/;
const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'stopped', 'orphaned', 'cleanup-failed']);

function portable(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function directoryEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw new Error(`FeatureBench telemetry directory is unreadable: ${directory}`, { cause: error });
  }
}

function regularFileExists(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`FeatureBench telemetry path is not a regular file: ${path}`);
    }
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

function directoryExists(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`FeatureBench telemetry path is not a real directory: ${path}`);
    }
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

function files(root: string, predicate: (name: string) => boolean): string[] {
  const output: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of directoryEntries(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && predicate(entry.name)) output.push(path);
    }
  };
  walk(root);
  return output.sort();
}

function json(runDirectory: string, path: string): Record<string, unknown> | null {
  const absolute = join(runDirectory, ...path.split('/'));
  try {
    lstatSync(absolute);
  } catch (error) {
    if (missing(error)) return null;
    throw new Error(`FeatureBench telemetry file is unreadable: ${path}`, { cause: error });
  }
  try {
    const value = JSON.parse(readRegularFileWithinRoot(runDirectory, path).toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`FeatureBench telemetry JSON must be an object: ${path}`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`FeatureBench telemetry JSON is malformed: ${path}`, { cause: error });
  }
}

function sessionId(path: string): string | null {
  return /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1] ?? null;
}

function hostSessionIds(eventsPath: string): { ids: Set<string>; complete: boolean } {
  const ids = new Set<string>();
  const stats = forEachJsonLine(eventsPath, (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const event = value as Record<string, unknown>;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') ids.add(event.thread_id);
  });
  return {
    ids,
    complete: stats.opened && stats.malformedLines === 0 && stats.oversizeLines === 0 && !stats.unterminatedTail,
  };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function workflowArtifacts(
  runDirectory: string,
  attemptDirectory: string,
  taskId: string,
  arm: 'a' | 'b',
): {
  workflows: WorkflowArtifact[];
  backends: Map<string, string>;
  requiredSessionIds: Set<string>;
  complete: boolean;
} {
  const runs = join(attemptDirectory, 'ultracode', 'runs');
  if (!directoryExists(runs)) {
    return { workflows: [], backends: new Map(), requiredSessionIds: new Set(), complete: false };
  }
  const entries = directoryEntries(runs);
  const workflowEntries = entries.filter((candidate) => candidate.isDirectory());
  const workflows: WorkflowArtifact[] = [];
  const backends = new Map<string, string>();
  const requiredSessionIds = new Set<string>();
  let complete = workflowEntries.length > 0;
  for (const entry of workflowEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    const root = join(runs, entry.name);
    const config = json(runDirectory, portable(runDirectory, join(root, 'config.json')));
    const manifest = json(runDirectory, portable(runDirectory, join(root, 'manifest.json')));
    const output = json(runDirectory, portable(runDirectory, join(root, 'output.json')));
    const backend = typeof config?.backend === 'string' ? config.backend : null;
    const status = typeof manifest?.status === 'string' ? manifest.status : 'unknown';
    const manifestAgentCount = count(manifest?.agentCount);
    const outputAgentCount = count(output?.agentCount);
    const resultPaths = files(join(root, 'agents'), (name) => name === 'result.json');
    if (backend === null || !TERMINAL_WORKFLOW_STATUSES.has(status)
      || typeof manifest?.endedAt !== 'string' || !Number.isFinite(Date.parse(manifest.endedAt))
      || manifestAgentCount === null || outputAgentCount === null
      || manifestAgentCount !== outputAgentCount || resultPaths.length !== outputAgentCount) {
      complete = false;
    }
    for (const path of resultPaths) {
      const result = json(runDirectory, portable(runDirectory, path));
      const resultBackend = typeof result?.backend === 'string' ? result.backend : null;
      const resultStatus = result?.status;
      const cached = result?.cached === true;
      const usage = result?.usage !== null && typeof result?.usage === 'object' && !Array.isArray(result.usage)
        ? result.usage as Record<string, unknown>
        : null;
      const totalTokens = usage === null ? null : count(usage.totalTokens);
      const session = typeof result?.sessionId === 'string' && result.sessionId.length > 0 ? result.sessionId : null;
      if (!['ok', 'error', 'skip'].includes(typeof resultStatus === 'string' ? resultStatus : '')
        || resultBackend === null || totalTokens === null
        || (!cached && resultStatus !== 'skip' && totalTokens > 0 && session === null)) {
        complete = false;
      }
      if (session !== null && resultBackend !== null) {
        backends.set(session, resultBackend);
        requiredSessionIds.add(session);
      }
    }
    workflows.push({
      scope: { taskId, arm },
      workflowId: entry.name,
      status,
      agentCount: outputAgentCount ?? 0,
      failureCount: Array.isArray(output?.failures) ? output.failures.length : 0,
      workspacesKept: Array.isArray(output?.workspaces) ? output.workspaces.length : 0,
      backend,
      billingClass: backend === 'mock' ? 'mock' : backend === null ? 'unknown' : 'billable',
    });
  }
  return { workflows, backends, requiredSessionIds, complete };
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
  const annotations: Annotation[] = [];
  const incompletePricingEvidence = new Set<string>();
  const annotationKeys = new Set<string>();
  const markIncomplete = (taskId: string, arm: 'a' | 'b', code: string): void => {
    incompletePricingEvidence.add(`${taskId}\0${arm}`);
    const key = `${taskId}\0${arm}\0${code}`;
    if (annotationKeys.has(key)) return;
    annotationKeys.add(key);
    annotations.push({ code, scope: { kind: 'task-arm', taskId, arm } });
  };
  const inferenceInvocations = new Set<string>();
  for (const attempt of state.attempts.filter((entry) => entry.phase === 'inference')) {
    inferenceInvocations.add(attempt.invocationId);
    if (attempt.status !== 'running' && attempt.nativePath === null) {
      markIncomplete(attempt.taskId, attempt.arm, 'host-telemetry-missing');
    }
  }
  if ((state.invocations ?? []).some((invocation) =>
    invocation.command === 'run' && invocation.endedAt !== null && invocation.failure !== null
    && !inferenceInvocations.has(invocation.invocationId))) {
    for (const execution of manifest.artifacts.executions) {
      markIncomplete(execution.taskId, execution.arm, 'host-telemetry-missing');
    }
  }
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
      const hasEvents = regularFileExists(eventsPath);
      const hostEvidence = hasEvents
        ? hostSessionIds(eventsPath)
        : { ids: new Set<string>(), complete: false };
      const workflow = workflowArtifacts(runDirectory, attemptDirectory, execution.taskId, execution.arm);
      for (const entry of workflow.workflows) {
        const key = `${entry.scope.taskId}\0${entry.scope.arm}\0${entry.workflowId}`;
        if (!seenWorkflows.has(key)) workflows.push(entry);
        seenWorkflows.add(key);
      }
      const sessionPaths = files(join(attemptDirectory, 'codex_sessions'), (name) => /^rollout-.*\.jsonl$/.test(name));
      const rolloutSessionIds = new Set(sessionPaths.map(sessionId).filter((id): id is string => id !== null));
      if (!hostEvidence.complete || sessionPaths.length === 0) {
        markIncomplete(execution.taskId, execution.arm, 'host-telemetry-missing');
      }
      if (execution.arm === 'b' && (!workflow.complete
        || [...workflow.requiredSessionIds].some((id) => !rolloutSessionIds.has(id)))) {
        markIncomplete(execution.taskId, execution.arm, 'workflow-telemetry-missing');
      }
      for (const path of sessionPaths) {
        const relativePath = portable(runDirectory, path);
        if (seenRollouts.has(relativePath)) continue;
        seenRollouts.add(relativePath);
        const id = sessionId(path);
        const host = execution.arm === 'a' || (id !== null && hostEvidence.ids.has(id));
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
  return {
    rollouts,
    workflows,
    timings: [],
    annotations,
    failures: [],
    pricingEvidenceIncomplete: incompletePricingEvidence.size > 0,
  };
}
