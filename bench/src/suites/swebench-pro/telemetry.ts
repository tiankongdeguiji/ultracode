/** Exact Pro-native artifact indexing; shared metrics owns all aggregation. */
import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { annotationSchema, failureObservationSchema, taskArmScope } from '../../shared/failure.js';
import { forEachJsonLine } from '../../shared/jsonl.js';
import type { MetricsArtifactIndex, WorkflowArtifact } from '../../shared/metrics.js';
import type { SwebenchProManifest } from '../../shared/manifest.js';
import { assertArtifactTree, readRegularFileWithinRoot } from '../../shared/paths.js';
import { readTaskStatus } from './state.js';

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function files(root: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const walk = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && predicate(entry.name)) output.push(path);
    }
  };
  walk(root);
  return output.sort();
}

function jsonObject(root: string, relativePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readRegularFileWithinRoot(root, relativePath).toString('utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hostSessionIds(taskDirectory: string): Set<string> {
  const ids = new Set<string>();
  const file = join(taskDirectory, 'logs', 'host.jsonl');
  forEachJsonLine(file, (record) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return;
    const row = record as Record<string, unknown>;
    const id = row.thread_id ?? (row.type === 'thread.started' ? row.thread_id : undefined);
    if (typeof id === 'string') ids.add(id);
  });
  return ids;
}

function rolloutSessionId(path: string): string | null {
  return /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1] ?? null;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function workflows(taskDirectory: string, taskId: string, arm: 'a' | 'b'): WorkflowArtifact[] {
  const runs = join(taskDirectory, 'uc', 'runs');
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(runs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const root = join(runs, entry.name);
      const output = jsonObject(root, 'output.json');
      const manifest = jsonObject(root, 'manifest.json');
      const config = jsonObject(root, 'config.json');
      return {
        scope: { taskId, arm },
        workflowId: entry.name,
        status: typeof manifest?.status === 'string' ? manifest.status : 'unknown',
        agentCount: numeric(output?.agentCount),
        failureCount: Array.isArray(output?.failures) ? output.failures.length : 0,
        workspacesKept: Array.isArray(output?.workspaces) ? output.workspaces.length : 0,
        backend: typeof config?.backend === 'string' ? config.backend : null,
        billingClass: config?.backend === 'mock' ? 'mock' as const : 'unknown' as const,
      };
    });
}

/** Enumerate only manifest-declared task roots; no recursive run-root discovery. */
export function indexSwebenchProMetrics(
  manifest: SwebenchProManifest,
  runDirectory: string,
): MetricsArtifactIndex {
  const rollouts: MetricsArtifactIndex['rollouts'][number][] = [];
  const workflowItems: WorkflowArtifact[] = [];
  const annotations: MetricsArtifactIndex['annotations'][number][] = [];
  const failures: MetricsArtifactIndex['failures'][number][] = [];
  for (const execution of manifest.artifacts.executions) {
    const taskDirectory = join(runDirectory, ...execution.nativeRoot.split('/'));
    if (!existsSync(taskDirectory)) continue;
    try {
      assertArtifactTree(taskDirectory);
    } catch {
      failures.push(failureObservationSchema.parse({
        code: 'artifact-unsafe',
        scope: taskArmScope(execution.taskId, execution.arm),
        phase: 'report',
        terminal: false,
        evidence: 'harness',
      }));
      continue;
    }
    const hosts = hostSessionIds(taskDirectory);
    for (const path of files(join(taskDirectory, 'codex-home', 'sessions'), (name) => /^rollout-.*\.jsonl$/.test(name))) {
      const id = rolloutSessionId(path);
      rollouts.push({
        scope: { taskId: execution.taskId, arm: execution.arm },
        path: portableRelative(runDirectory, path),
        roleHint: execution.arm === 'a' || hosts.has(id ?? '') ? 'host' : 'worker',
        backend: 'codex',
        billingClass: 'billable',
      });
    }
    workflowItems.push(...workflows(taskDirectory, execution.taskId, execution.arm));
    const status = readTaskStatus(taskDirectory);
    const scope = taskArmScope(execution.taskId, execution.arm);
    for (const code of status.annotations) annotations.push(annotationSchema.parse({ code, scope }));
    if (status.failure !== null) {
      failures.push(failureObservationSchema.parse({
        code: status.failure,
        scope,
        phase: 'session',
        terminal: true,
        evidence: status.failure === 'agent-timeout' ? 'native' : 'driver',
      }));
    }
  }
  return { rollouts, workflows: workflowItems, timings: [], annotations, failures };
}
