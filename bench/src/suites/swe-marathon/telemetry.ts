/** Exact SWE-Marathon telemetry indexing beneath validated direct-child Harbor trials. */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { MetricsArtifactIndex, WorkflowArtifact } from '../../shared/metrics.js';
import type { SweMarathonManifest } from '../../shared/manifest.js';
import { readRegularFileWithinRoot } from '../../shared/paths.js';
import type { BenchRunState } from '../../shared/run-state.js';
import { indexHarborEvidence, locateExactHarborTrial } from './verifier.js';

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

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sessionId(path: string): string | null {
  return /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1] ?? null;
}

function workflowIndex(
  runDirectory: string,
  agentDirectory: string,
  taskId: string,
  arm: 'a' | 'b',
): { workflows: WorkflowArtifact[]; sessionBackends: Map<string, string> } {
  const runs = join(agentDirectory, 'ultracode', 'runs');
  let entries: Dirent[] = [];
  try { entries = readdirSync(runs, { withFileTypes: true }); } catch { return { workflows: [], sessionBackends: new Map() }; }
  const workflows: WorkflowArtifact[] = [];
  const sessionBackends = new Map<string, string>();
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const root = join(runs, entry.name);
    const config = json(runDirectory, portable(runDirectory, join(root, 'config.json')));
    const manifest = json(runDirectory, portable(runDirectory, join(root, 'manifest.json')));
    const output = json(runDirectory, portable(runDirectory, join(root, 'output.json')));
    const backend = typeof config?.backend === 'string' ? config.backend : null;
    for (const resultPath of files(join(root, 'agents'), (name) => name === 'result.json')) {
      const result = json(runDirectory, portable(runDirectory, resultPath));
      const id = result?.sessionId;
      const observedBackend = result?.backend;
      if (typeof id === 'string' && typeof observedBackend === 'string') sessionBackends.set(id, observedBackend);
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
  return { workflows, sessionBackends };
}

function invocationId(
  state: BenchRunState | null,
  taskId: string,
  arm: 'a' | 'b',
  nativePath: string,
): string | null {
  return [...(state?.attempts ?? [])].reverse().find((attempt) =>
    attempt.taskId === taskId && attempt.arm === arm && attempt.phase === 'session'
    && attempt.nativePath === nativePath)?.invocationId ?? null;
}

function executionJobRoots(runDirectory: string, nativeRoot: string, key: string): string[] {
  const output: string[] = [];
  const attempts = join(runDirectory, 'native', 'attempts');
  let entries: Dirent[] = [];
  try { entries = readdirSync(attempts, { withFileTypes: true }); } catch { /* no redo archives */ }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const children = readdirSync(join(attempts, entry.name), { withFileTypes: true });
    if (children.some((child) => child.isDirectory() && child.name === key)) {
      output.push(`native/attempts/${entry.name}/${key}`);
    }
  }
  if (existsSync(join(runDirectory, ...nativeRoot.split('/')))) output.push(nativeRoot);
  return output.sort();
}

/** Enumerate only manifest jobs and validated direct-child trials; run-root lookalikes are ignored. */
export function indexSweMarathonMetrics(
  manifest: SweMarathonManifest,
  runDirectory: string,
  state: BenchRunState | null = null,
): MetricsArtifactIndex {
  const rollouts: MetricsArtifactIndex['rollouts'][number][] = [];
  const workflows: WorkflowArtifact[] = [];
  const timings: MetricsArtifactIndex['timings'][number][] = [];
  for (const execution of manifest.artifacts.executions) {
    for (const jobRoot of executionJobRoots(runDirectory, execution.nativeRoot, execution.key)) {
      let trial: ReturnType<typeof locateExactHarborTrial>;
      try { trial = locateExactHarborTrial(runDirectory, jobRoot); } catch { continue; }
      const evidence = indexHarborEvidence(runDirectory, {
        taskId: execution.taskId,
        arm: execution.arm,
        model: manifest.experiment.model,
        requestedEffort: manifest.experiment.requestedEffort,
        jobRelativeRoot: jobRoot,
      }, randomUUID());
      if (evidence.trialName !== trial.name) continue;
      const agentDirectory = join(runDirectory, ...trial.root.split('/'), 'agent');
      const lifecyclePath = portable(runDirectory, join(agentDirectory, 'arm_b_lifecycle.json'));
      const lifecycle = existsSync(join(runDirectory, ...lifecyclePath.split('/')))
        ? json(runDirectory, lifecyclePath)
        : null;
      const hostSessionId = typeof lifecycle?.host_session_id === 'string' ? lifecycle.host_session_id : null;
      const workflow = workflowIndex(runDirectory, agentDirectory, execution.taskId, execution.arm);
      workflows.push(...workflow.workflows);
      const sessionPaths = ['sessions', 'worker-sessions'].flatMap((directory) =>
        files(join(agentDirectory, directory), (name) => /^rollout-.*\.jsonl$/.test(name)));
      for (const path of sessionPaths) {
        const id = sessionId(path);
        const host = execution.arm === 'a' || id === hostSessionId;
        const backend = host ? 'codex' : id === null ? null : workflow.sessionBackends.get(id) ?? null;
        rollouts.push({
          scope: { taskId: execution.taskId, arm: execution.arm },
          path: portable(runDirectory, path),
          roleHint: host ? 'host' : 'worker',
          backend,
          billingClass: backend === 'mock' ? 'mock' : backend === null ? 'unknown' : 'billable',
        });
      }
      const observedInvocation = invocationId(state, execution.taskId, execution.arm, jobRoot);
      if (observedInvocation !== null
        && typeof lifecycle?.wait_started_at === 'string'
        && typeof lifecycle.wait_ended_at === 'string'
        && typeof lifecycle.wait_elapsed_ms === 'number'
        && Number.isFinite(lifecycle.wait_elapsed_ms)
        && lifecycle.wait_elapsed_ms >= 0) {
        timings.push({
          sourceKey: `${jobRoot}/${trial.name}/arm-b-detached-wait`,
          invocationId: observedInvocation,
          scope: { taskId: execution.taskId, arm: execution.arm },
          phase: 'detached-wait',
          startedAt: lifecycle.wait_started_at,
          endedAt: lifecycle.wait_ended_at,
          elapsedMs: lifecycle.wait_elapsed_ms,
        });
      }
    }
  }
  return { rollouts, workflows, timings, annotations: [], failures: [] };
}
