/**
 * Prompt-only workflow authoring. Model processes run in empty read-only
 * workspaces, and protocol observers terminate any attempted tool invocation.
 */
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CommandContext } from '../../shared/contracts.js';
import {
  createPrivateRunDirectory,
  ensurePrivateDirectoryWithin,
  ensureRealDirectoryWithin,
  manifestFile,
  readPrivateJson,
  reportJsonFile,
  reportMarkdownFile,
  requirePrivateDirectoryWithin,
  resetArtifactDirectory,
  runDir,
  validateRunId,
  writePrivateFileAtomic,
  writePrivateJsonAtomic,
} from '../../shared/paths.js';
import {
  BenchProcessError,
  cleanupActiveBenchProcesses,
  runBenchProcess,
} from '../../shared/process.js';
import { canonicalJson, sha256File } from '../../shared/provenance.js';
import { analyzeWorkflowSource } from './analyzer.js';
import { loadAuthoringTasks, type AuthoringCohort } from './inputs.js';
import {
  composeAuthoringPrompt,
  loadCodexDoctrineSnapshot,
  type CodexDoctrineSnapshot,
} from './prompt.js';
import {
  authoringManifestSchema,
  generatedWorkflowArtifactSchema,
  type AuthoringHost,
  type AuthoringManifest,
  type AuthoringTask,
  type GeneratedWorkflowArtifact,
  type HostStaticAggregate,
  type MetricDistribution,
  type PairedComparison,
  type WorkflowAuthoringReport,
} from './types.js';

const SUITE = 'workflow-authoring' as const;
const TRANSCRIPT_FILE = 'transcript.jsonl';
const WORKFLOW_FILE = 'workflow.js';
const ARTIFACT_FILE = 'artifact.json';
const MAX_TRANSCRIPT_BYTES = 64 * 1_024 * 1_024;

interface GenerateOptions {
  runId: string;
  host: AuthoringHost | 'both';
  model: string;
  requestedEffort: string;
  resume: boolean;
  taskIds?: readonly string[];
}

interface ReportOptions {
  runId: string;
}

interface BinaryIdentity {
  host: AuthoringHost;
  path: string;
  version: string;
  binarySha256: string;
}

interface LoadedInputs {
  cohort: AuthoringCohort;
  tasks: AuthoringTask[];
}

export interface WorkflowAuthoringDependencies {
  loadInputs?: (context: CommandContext, taskIds: readonly string[] | undefined) => LoadedInputs;
  loadDoctrine?: (context: CommandContext) => CodexDoctrineSnapshot;
  inspectBinaries?: (
    hosts: readonly AuthoringHost[],
    context: CommandContext,
  ) => Promise<BinaryIdentity[]>;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function selectedHosts(selection: GenerateOptions['host']): AuthoringHost[] {
  return selection === 'both' ? ['codex', 'claude'] : [selection];
}

function resolveExecutable(name: string, environment: NodeJS.ProcessEnv = process.env): string {
  const search = environment.PATH ?? '';
  for (const directory of search.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      const info = statSync(candidate);
      accessSync(candidate, constants.X_OK);
      if (info.isFile() || info.isSymbolicLink()) return realpathSync(candidate);
    } catch {
      // Continue through PATH.
    }
  }
  throw new Error(`${name} is not available on PATH`);
}

async function inspectBinary(host: AuthoringHost, context: CommandContext): Promise<BinaryIdentity> {
  const path = resolveExecutable(host);
  const result = await runBenchProcess(path, ['--version'], {
    cwd: context.paths.benchRoot,
    tailBytes: 4_096,
  });
  const version = result.stdout.trim();
  if (!version || version.includes('\0')) throw new Error(`${host} returned an invalid version`);
  return { host, path, version: version.slice(0, 512), binarySha256: sha256File(path) };
}

async function inspectBinaries(
  hosts: readonly AuthoringHost[],
  context: CommandContext,
): Promise<BinaryIdentity[]> {
  const identities: BinaryIdentity[] = [];
  for (const host of hosts) identities.push(await inspectBinary(host, context));
  return identities;
}

function manifestProjection(manifest: AuthoringManifest): unknown {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'createdAt'));
}

function requestedManifest(
  options: GenerateOptions,
  hosts: readonly AuthoringHost[],
  inputs: LoadedInputs,
  doctrine: CodexDoctrineSnapshot,
  binaries: readonly BinaryIdentity[],
  createdAt: Date,
): AuthoringManifest {
  return authoringManifestSchema.parse({
    schemaVersion: 1,
    kind: 'ultracode-workflow-authoring-run',
    suite: SUITE,
    runId: validateRunId(options.runId),
    createdAt: createdAt.toISOString(),
    model: options.model,
    requestedEffort: options.requestedEffort,
    hosts,
    cohortSha256: inputs.cohort.sha256,
    codexDoctrineSha256: doctrine.sha256,
    tasks: inputs.tasks.map((task) => ({
      sourceSuite: task.sourceSuite,
      taskId: task.taskId,
      qualifiedTaskId: task.qualifiedTaskId,
      key: task.key,
      taskBodySha256: task.taskBodySha256,
      goldPatchStats: task.goldPatchStats,
    })),
    binaries: binaries.map(({ host, version, binarySha256 }) => ({ host, version, binarySha256 })),
    artifacts: {
      tasksRoot: 'tasks',
      reportJson: 'report.json',
      reportMarkdown: 'report.md',
    },
  });
}

function loadManifest(context: CommandContext, runId: string): AuthoringManifest {
  const directory = runDir(context.paths, SUITE, runId);
  const manifest = authoringManifestSchema.parse(
    readPrivateJson(directory, manifestFile(context.paths, SUITE, runId)),
  );
  if (manifest.runId !== validateRunId(runId)) throw new Error('workflow-authoring manifest identity mismatch');
  return manifest;
}

function openRun(
  context: CommandContext,
  requested: AuthoringManifest,
  resume: boolean,
): { directory: string; manifest: AuthoringManifest } {
  ensureRealDirectoryWithin(context.paths.benchRoot, context.paths.resultsRoot);
  const directory = runDir(context.paths, SUITE, requested.runId);
  if (!resume) {
    if (existsSync(directory)) throw new Error(`workflow-authoring run already exists: ${requested.runId}`);
    createPrivateRunDirectory(context.paths, SUITE, requested.runId);
    writePrivateJsonAtomic(directory, manifestFile(context.paths, SUITE, requested.runId), requested);
    return { directory, manifest: requested };
  }
  requirePrivateDirectoryWithin(context.paths.resultsRoot, directory);
  const existing = loadManifest(context, requested.runId);
  if (canonicalJson(manifestProjection(existing)) !== canonicalJson(manifestProjection(requested))) {
    throw new Error('resume inputs do not match the frozen workflow-authoring manifest');
  }
  return { directory, manifest: existing };
}

function hostArguments(
  host: AuthoringHost,
  model: string,
  requestedEffort: string,
  workspace: string,
): string[] {
  if (host === 'codex') {
    return [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--color', 'never',
      '--model', model,
      '--config', `model_reasoning_effort="${requestedEffort}"`,
      '--cd', workspace,
      '-',
    ];
  }
  return [
    '--print',
    '--model', model,
    '--effort', requestedEffort,
    '--tools', 'Workflow',
    '--permission-mode', 'plan',
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--input-format', 'text',
    '--strict-mcp-config',
    '--mcp-config', '{}',
    '--setting-sources', 'user',
  ];
}

function containsToolUse(host: AuthoringHost, event: unknown): boolean {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return false;
  const record = event as Record<string, unknown>;
  if (host === 'claude') {
    if (['tool_use', 'tool_result', 'server_tool_use'].includes(String(record.type))) return true;
    const message = record.message;
    if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content;
      return Array.isArray(content) && content.some((entry) =>
        entry !== null && typeof entry === 'object'
        && ['tool_use', 'tool_result', 'server_tool_use'].includes(
          String((entry as Record<string, unknown>).type),
        ));
    }
    return false;
  }
  const item = record.item;
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
  const itemType = String((item as Record<string, unknown>).type ?? '');
  return [
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'web_search',
    'computer',
    'tool_call',
  ].includes(itemType) || itemType.endsWith('_tool_call');
}

function jsonLines(value: string): unknown[] {
  return value.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

function assistantText(host: AuthoringHost, transcript: string): string | null {
  const events = jsonLines(transcript);
  const candidates: string[] = [];
  for (const event of events) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (host === 'codex') {
      const item = record.item;
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const entry = item as Record<string, unknown>;
        if (entry.type === 'agent_message' && typeof entry.text === 'string') candidates.push(entry.text);
      }
      continue;
    }
    if (record.type === 'result' && typeof record.result === 'string') candidates.push(record.result);
    const message = record.message;
    if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        const text = content.flatMap((entry) =>
          entry !== null && typeof entry === 'object'
          && (entry as Record<string, unknown>).type === 'text'
          && typeof (entry as Record<string, unknown>).text === 'string'
            ? [(entry as Record<string, unknown>).text as string]
            : []).join('');
        if (text) candidates.push(text);
      }
    }
  }
  return candidates.at(-1) ?? null;
}

function normalizeWorkflowSource(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const fenced = /^```(?:javascript|js)?\s*\n([\s\S]*?)\n```\s*$/iu.exec(trimmed);
  const source = (fenced?.[1] ?? trimmed).trim();
  return source.length === 0 ? null : `${source}\n`;
}

function artifactDirectory(runDirectory: string, key: string, host: AuthoringHost): string {
  return join(runDirectory, 'tasks', key, host);
}

function artifactPath(runDirectory: string, key: string, host: AuthoringHost): string {
  return join(artifactDirectory(runDirectory, key, host), ARTIFACT_FILE);
}

function loadArtifact(runDirectory: string, key: string, host: AuthoringHost): GeneratedWorkflowArtifact | null {
  const file = artifactPath(runDirectory, key, host);
  if (!existsSync(file)) return null;
  const value = generatedWorkflowArtifactSchema.parse(readPrivateJson(runDirectory, file));
  if (value.key !== key || value.host !== host) {
    throw new Error(`workflow-authoring artifact identity is malformed: ${key}/${host}`);
  }
  return value as GeneratedWorkflowArtifact;
}

async function generateArtifact(
  runDirectory: string,
  manifest: AuthoringManifest,
  task: AuthoringTask,
  host: AuthoringHost,
  binary: BinaryIdentity,
  doctrine: CodexDoctrineSnapshot,
  context: CommandContext,
): Promise<GeneratedWorkflowArtifact> {
  const taskDirectory = ensurePrivateDirectoryWithin(runDirectory, join(runDirectory, 'tasks', task.key));
  const targetDirectory = artifactDirectory(runDirectory, task.key, host);
  if (existsSync(targetDirectory)) resetArtifactDirectory(taskDirectory, targetDirectory);
  else ensurePrivateDirectoryWithin(taskDirectory, targetDirectory);
  const workspace = mkdtempSync(join(tmpdir(), 'uc-authoring-'));
  const prompt = composeAuthoringPrompt(host, task, doctrine);
  let transcript = '';
  let elapsedMs = 0;
  let processDiagnostic: string | null = null;
  let toolUseDetected = false;
  let transcriptLimitExceeded = false;
  let transcriptBytes = 0;
  const transcriptChunks: Buffer[] = [];
  let pending = '';
  const inspectChunk = (chunk: Buffer, terminate: () => void): void => {
    const remaining = MAX_TRANSCRIPT_BYTES - transcriptBytes;
    if (remaining > 0) {
      const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      transcriptChunks.push(Buffer.from(retained));
      transcriptBytes += retained.length;
    }
    if (chunk.length > remaining) {
      transcriptLimitExceeded = true;
      terminate();
    }
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        if (containsToolUse(host, JSON.parse(line) as unknown)) {
          toolUseDetected = true;
          terminate();
        }
      } catch {
        // Malformed protocol output is diagnosed after the process settles.
      }
    }
  };
  try {
    const result = await runBenchProcess(
      binary.path,
      hostArguments(host, manifest.model, manifest.requestedEffort, workspace),
      {
        cwd: workspace,
        stdinData: prompt,
        tailBytes: MAX_TRANSCRIPT_BYTES,
        observeStdout: inspectChunk,
      },
    );
    elapsedMs = result.elapsedMs;
  } catch (error) {
    if (error instanceof BenchProcessError) {
      elapsedMs = error.result.elapsedMs;
    }
    processDiagnostic = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  transcript = Buffer.concat(transcriptChunks, transcriptBytes).toString('utf8');
  if (pending.trim()) {
    try {
      if (containsToolUse(host, JSON.parse(pending) as unknown)) toolUseDetected = true;
    } catch {
      // The transcript parser reports missing output below.
    }
  }

  const workflow = normalizeWorkflowSource(assistantText(host, transcript));
  const analysis = workflow === null
    ? { metrics: null, diagnostics: ['output: no workflow source was returned'] }
    : analyzeWorkflowSource(workflow, task.taskBody);
  const diagnostics = [
    ...(toolUseDetected ? ['protocol: model attempted a forbidden tool invocation'] : []),
    ...(transcriptLimitExceeded ? [`protocol: transcript exceeded ${MAX_TRANSCRIPT_BYTES} bytes`] : []),
    ...(processDiagnostic === null ? [] : [`process: ${processDiagnostic}`]),
    ...analysis.diagnostics,
  ];
  const status = !toolUseDetected
    && !transcriptLimitExceeded
    && processDiagnostic === null
    && workflow !== null
    && analysis.metrics !== null
    && analysis.metrics.lintErrors === 0
      ? 'valid'
      : 'invalid';
  const artifact = generatedWorkflowArtifactSchema.parse({
    schemaVersion: 1,
    kind: 'ultracode-generated-workflow',
    runId: manifest.runId,
    host,
    sourceSuite: task.sourceSuite,
    taskId: task.taskId,
    qualifiedTaskId: task.qualifiedTaskId,
    key: task.key,
    model: manifest.model,
    requestedEffort: manifest.requestedEffort,
    generatedAt: context.clock.now().toISOString(),
    elapsedMs,
    status,
    toolUseDetected,
    promptSha256: sha256(prompt),
    transcriptSha256: sha256(transcript),
    workflowSha256: workflow === null ? null : sha256(workflow),
    diagnostics,
    metrics: analysis.metrics,
  }) as GeneratedWorkflowArtifact;
  writePrivateFileAtomic(runDirectory, join(targetDirectory, TRANSCRIPT_FILE), transcript);
  if (workflow !== null) writePrivateFileAtomic(runDirectory, join(targetDirectory, WORKFLOW_FILE), workflow);
  writePrivateJsonAtomic(runDirectory, join(targetDirectory, ARTIFACT_FILE), artifact);
  return artifact;
}

/** Generate each requested host/task artifact exactly once, or skip it on resume. */
export async function generateCommand(
  options: GenerateOptions,
  context: CommandContext,
  dependencies: WorkflowAuthoringDependencies = {},
): Promise<void> {
  const hosts = selectedHosts(options.host);
  const inputs = (dependencies.loadInputs ?? ((selectedContext, taskIds) =>
    loadAuthoringTasks(selectedContext.paths, taskIds)))(context, options.taskIds);
  const doctrine = (dependencies.loadDoctrine ?? ((selectedContext) =>
    loadCodexDoctrineSnapshot(selectedContext.paths)))(context);
  const binaries = await (dependencies.inspectBinaries ?? inspectBinaries)(hosts, context);
  const requested = requestedManifest(
    options,
    hosts,
    inputs,
    doctrine,
    binaries,
    context.clock.now(),
  );
  const opened = openRun(context, requested, options.resume);
  let generated = 0;
  let skipped = 0;
  let invalid = 0;
  for (const task of inputs.tasks) {
    for (const host of hosts) {
      const existing = loadArtifact(opened.directory, task.key, host);
      if (existing !== null) {
        skipped += 1;
        continue;
      }
      const binary = binaries.find((candidate) => candidate.host === host);
      if (binary === undefined) throw new Error(`missing frozen binary identity for ${host}`);
      const artifact = await generateArtifact(
        opened.directory,
        opened.manifest,
        task,
        host,
        binary,
        doctrine,
        context,
      );
      generated += 1;
      if (artifact.status === 'invalid') invalid += 1;
      context.stdout.write(
        `${artifact.status} ${task.qualifiedTaskId}/${host} agents=${artifact.metrics?.agentCalls.min ?? '?'}-${artifact.metrics?.agentCalls.max ?? '?'}\n`,
      );
    }
  }
  context.stdout.write(`workflow-authoring: generated=${generated} skipped=${skipped} invalid=${invalid}\n`);
}

function delta(left: number | null | undefined, right: number | null | undefined): number | null {
  return left === null || left === undefined || right === null || right === undefined ? null : left - right;
}

function comparison(
  manifest: AuthoringManifest,
  runDirectory: string,
  task: AuthoringManifest['tasks'][number],
): PairedComparison {
  const codex = manifest.hosts.includes('codex') ? loadArtifact(runDirectory, task.key, 'codex') : null;
  const claude = manifest.hosts.includes('claude') ? loadArtifact(runDirectory, task.key, 'claude') : null;
  const codexMetrics = codex?.status === 'valid' ? codex.metrics : null;
  const claudeMetrics = claude?.status === 'valid' ? claude.metrics : null;
  const codexMinimum = codexMetrics?.agentCalls.min ?? null;
  const claudeMinimum = claudeMetrics?.agentCalls.min ?? null;
  const codexMaximum = codexMetrics?.agentCalls.max ?? null;
  const claudeMaximum = claudeMetrics?.agentCalls.max ?? null;
  const phaseDelta = delta(codexMetrics?.phaseCalls, claudeMetrics?.phaseCalls);
  return {
    sourceSuite: task.sourceSuite,
    taskId: task.taskId,
    qualifiedTaskId: task.qualifiedTaskId,
    goldPatchStats: task.goldPatchStats,
    codex,
    claude,
    agentMinimumDelta: delta(codexMinimum, claudeMinimum),
    agentMaximumDelta: delta(codexMaximum, claudeMaximum),
    phaseDelta,
  };
}

function bounds(artifact: GeneratedWorkflowArtifact | null): string {
  if (artifact?.status === 'invalid') return 'invalid';
  const value = artifact?.metrics?.agentCalls;
  return value === undefined ? '—' : `${value.min}–${value.max ?? '?'}`;
}

function distribution(values: readonly number[]): MetricDistribution {
  if (values.length === 0) return { mean: null, median: null };
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median,
  };
}

function aggregate(
  artifacts: readonly GeneratedWorkflowArtifact[],
  host: AuthoringHost,
): HostStaticAggregate {
  const selected = artifacts.filter((artifact) => artifact.host === host);
  const metrics = selected.flatMap((artifact) =>
    artifact.status === 'valid' && artifact.metrics !== null ? [artifact.metrics] : []);
  const values = (select: (entry: NonNullable<GeneratedWorkflowArtifact['metrics']>) => number): number[] =>
    metrics.map(select);
  return {
    storedArtifacts: selected.length,
    validArtifacts: metrics.length,
    dynamicAgentUpperBounds: metrics.filter((entry) => entry.agentCalls.max === null).length,
    sourceBytes: distribution(values((entry) => entry.sourceBytes)),
    agentMinimum: distribution(values((entry) => entry.agentCalls.min)),
    agentMaximum: distribution(metrics.flatMap((entry) =>
      entry.agentCalls.max === null ? [] : [entry.agentCalls.max])),
    phaseCalls: distribution(values((entry) => entry.phaseCalls)),
    parallelCalls: distribution(values((entry) => entry.parallelCalls)),
    pipelineCalls: distribution(values((entry) => entry.pipelineCalls)),
    conditionalBranches: distribution(values((entry) => entry.conditionalBranches)),
    boundedLoops: distribution(values((entry) => entry.boundedLoops)),
    unboundedLoops: distribution(values((entry) => entry.unboundedLoops)),
    retryDeclarations: distribution(values((entry) => entry.retryDeclarations)),
    schemaAgentCallSites: distribution(values((entry) => entry.schemaAgentCallSites)),
    jsonStringifyCalls: distribution(values((entry) => entry.jsonStringifyCalls)),
    worktreeIsolations: distribution(values((entry) => entry.worktreeIsolations)),
    unsafeParallelMutators: distribution(values((entry) => entry.unsafeParallelMutators)),
    conditionalRepairCalls: distribution(values((entry) => entry.conditionalRepairCalls)),
    unconditionalRepairCalls: distribution(values((entry) => entry.unconditionalRepairCalls)),
    triageOrAdjudicationCalls: distribution(values((entry) => entry.triageOrAdjudicationCalls)),
    failClosedSignals: distribution(values((entry) => entry.failClosedSignals)),
  };
}

function summaryCell(value: MetricDistribution): string {
  const format = (entry: number | null): string =>
    entry === null ? '—' : Number.isInteger(entry) ? String(entry) : entry.toFixed(1);
  return `${format(value.mean)} / ${format(value.median)}`;
}

function renderReport(report: WorkflowAuthoringReport): string {
  const lines = [
    '# Workflow authoring static comparison',
    '',
    `- Run: \`${report.runId}\``,
    `- Model/effort: \`${report.model}\` / \`${report.requestedEffort}\``,
    `- Stored: ${report.summary.storedArtifacts}/${report.summary.requestedArtifacts}; valid ${report.summary.validArtifacts}; invalid ${report.summary.invalidArtifacts}`,
    `- Tool-use violations: ${report.summary.toolUseViolations}`,
    '',
    '| Host | Valid | Agent min mean/median | Agent max mean/median | Phases | Parallel | Pipeline |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...(['codex', 'claude'] as const).map((host) => {
      const value = report.aggregates[host];
      return `| ${host} | ${value.validArtifacts}/${value.storedArtifacts} | ${summaryCell(value.agentMinimum)} | ${summaryCell(value.agentMaximum)} | ${summaryCell(value.phaseCalls)} | ${summaryCell(value.parallelCalls)} | ${summaryCell(value.pipelineCalls)} |`;
    }),
    '',
    '| Host | Branches | Bounded loops | Retries | Conditional repair | Unconditional repair | Triage/judge | Unsafe parallel mutation |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...(['codex', 'claude'] as const).map((host) => {
      const value = report.aggregates[host];
      return `| ${host} | ${summaryCell(value.conditionalBranches)} | ${summaryCell(value.boundedLoops)} | ${summaryCell(value.retryDeclarations)} | ${summaryCell(value.conditionalRepairCalls)} | ${summaryCell(value.unconditionalRepairCalls)} | ${summaryCell(value.triageOrAdjudicationCalls)} | ${summaryCell(value.unsafeParallelMutators)} |`;
    }),
    '',
    '| Task | Gold patch | Codex agents | Claude agents | Min Δ | Max Δ | Phase Δ |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...report.comparisons.map((entry) => {
      const gold = entry.goldPatchStats === null
        ? '—'
        : `${entry.goldPatchStats.files}f +${entry.goldPatchStats.additions}/-${entry.goldPatchStats.deletions}`;
      return `| ${entry.qualifiedTaskId} | ${gold} | ${bounds(entry.codex)} | ${bounds(entry.claude)} | ${entry.agentMinimumDelta ?? '—'} | ${entry.agentMaximumDelta ?? '—'} | ${entry.phaseDelta ?? '—'} |`;
    }),
    '',
    '> These are descriptive static proxies, not parity targets or quality claims. No workflow was executed and no benchmark score was produced.',
    '',
  ];
  return lines.join('\n');
}

/** Build paired host deltas from immutable generated artifacts. */
export async function reportCommand(options: ReportOptions, context: CommandContext): Promise<void> {
  const manifest = loadManifest(context, options.runId);
  const directory = runDir(context.paths, SUITE, manifest.runId);
  const comparisons = manifest.tasks.map((task) => comparison(manifest, directory, task));
  const artifacts = comparisons.flatMap((entry) => [entry.codex, entry.claude])
    .filter((artifact): artifact is GeneratedWorkflowArtifact => artifact !== null);
  const report: WorkflowAuthoringReport = {
    schemaVersion: 1,
    kind: 'ultracode-workflow-authoring-report',
    suite: SUITE,
    runId: manifest.runId,
    generatedAt: context.clock.now().toISOString(),
    model: manifest.model,
    requestedEffort: manifest.requestedEffort,
    summary: {
      requestedArtifacts: manifest.tasks.length * manifest.hosts.length,
      storedArtifacts: artifacts.length,
      validArtifacts: artifacts.filter((artifact) => artifact.status === 'valid').length,
      invalidArtifacts: artifacts.filter((artifact) => artifact.status === 'invalid').length,
      pairedTasks: comparisons.filter((entry) => entry.codex !== null && entry.claude !== null).length,
      toolUseViolations: artifacts.filter((artifact) => artifact.toolUseDetected).length,
    },
    aggregates: {
      codex: aggregate(artifacts, 'codex'),
      claude: aggregate(artifacts, 'claude'),
    },
    comparisons,
  };
  writePrivateJsonAtomic(directory, reportJsonFile(context.paths, SUITE, manifest.runId), report);
  writePrivateFileAtomic(directory, reportMarkdownFile(context.paths, SUITE, manifest.runId), renderReport(report));
  context.stdout.write(
    `workflow-authoring report: paired=${report.summary.pairedTasks} valid=${report.summary.validArtifacts} invalid=${report.summary.invalidArtifacts}\n`,
  );
}

export async function cleanupWorkflowAuthoringRuntime(): Promise<void> {
  await cleanupActiveBenchProcesses();
}
