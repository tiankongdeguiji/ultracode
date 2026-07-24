/**
 * Static authoring artifacts are intentionally separate from scored benchmark
 * manifests: they attest generated source and structural proxies only.
 */
import { z } from 'zod';
import { validateArtifactKey, validateRunId, validateTaskId } from '../../shared/paths.js';

export const AUTHORING_HOSTS = ['codex', 'claude'] as const;
export type AuthoringHost = typeof AUTHORING_HOSTS[number];
export type AuthoringSourceSuite = 'swebench-pro' | 'swe-marathon';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const hostSchema = z.enum(AUTHORING_HOSTS);
const sourceSuiteSchema = z.enum(['swebench-pro', 'swe-marathon']);
const taskIdSchema = z.string().transform(validateTaskId);
const artifactKeySchema = z.string().transform(validateArtifactKey);

export interface AuthoringTask {
  sourceSuite: AuthoringSourceSuite;
  taskId: string;
  qualifiedTaskId: string;
  key: string;
  taskBody: string;
  taskBodySha256: string;
  goldPatchStats: GoldPatchStats | null;
}

export interface GoldPatchStats {
  files: number;
  additions: number;
  deletions: number;
}

export const authoringManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('ultracode-workflow-authoring-run'),
  suite: z.literal('workflow-authoring'),
  runId: z.string().transform(validateRunId),
  createdAt: z.string().datetime({ offset: true }),
  model: z.string().min(1).max(256),
  requestedEffort: z.string().min(1).max(64),
  hosts: z.array(hostSchema).min(1).max(2),
  cohortSha256: sha256Schema,
  codexDoctrineSha256: sha256Schema,
  tasks: z.array(z.strictObject({
    sourceSuite: sourceSuiteSchema,
    taskId: taskIdSchema,
    qualifiedTaskId: z.string().min(1),
    key: artifactKeySchema,
    taskBodySha256: sha256Schema,
    goldPatchStats: z.strictObject({
      files: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }).nullable(),
  })).min(1),
  binaries: z.array(z.strictObject({
    host: hostSchema,
    version: z.string().min(1).max(512),
    binarySha256: sha256Schema,
  })).min(1).max(2),
  artifacts: z.strictObject({
    tasksRoot: z.literal('tasks'),
    reportJson: z.literal('report.json'),
    reportMarkdown: z.literal('report.md'),
  }),
});

export type AuthoringManifest = z.infer<typeof authoringManifestSchema>;

export interface CountBounds {
  min: number;
  /** Null means a dynamic or unbounded upper path. */
  max: number | null;
}

export interface StaticWorkflowMetrics {
  parseValid: boolean;
  sourceBytes: number;
  agentCallSites: number;
  agentCalls: CountBounds;
  dispatchAttempts: CountBounds;
  phaseCalls: number;
  parallelCalls: number;
  pipelineCalls: number;
  conditionalBranches: number;
  boundedLoops: number;
  unboundedLoops: number;
  retryDeclarations: number;
  maximumDeclaredRetries: number;
  schemaAgentCallSites: number;
  programmaticAgentResults: number;
  schemaCoveredProgrammaticResults: number;
  jsonStringifyCalls: number;
  duplicateSerializedBindings: string[];
  worktreeIsolations: number;
  unsafeParallelMutators: number;
  conditionalRepairCalls: number;
  unconditionalRepairCalls: number;
  triageOrAdjudicationCalls: number;
  throwStatements: number;
  failClosedSignals: number;
  constraintTerms: number;
  mutatingPromptConstraintCoverage: number | null;
  lintErrors: number;
  lintWarnings: number;
}

const countBoundsSchema = z.strictObject({
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative().nullable(),
});

export const staticWorkflowMetricsSchema = z.strictObject({
  parseValid: z.literal(true),
  sourceBytes: z.number().int().nonnegative(),
  agentCallSites: z.number().int().nonnegative(),
  agentCalls: countBoundsSchema,
  dispatchAttempts: countBoundsSchema,
  phaseCalls: z.number().int().nonnegative(),
  parallelCalls: z.number().int().nonnegative(),
  pipelineCalls: z.number().int().nonnegative(),
  conditionalBranches: z.number().int().nonnegative(),
  boundedLoops: z.number().int().nonnegative(),
  unboundedLoops: z.number().int().nonnegative(),
  retryDeclarations: z.number().int().nonnegative(),
  maximumDeclaredRetries: z.number().int().min(0).max(5),
  schemaAgentCallSites: z.number().int().nonnegative(),
  programmaticAgentResults: z.number().int().nonnegative(),
  schemaCoveredProgrammaticResults: z.number().int().nonnegative(),
  jsonStringifyCalls: z.number().int().nonnegative(),
  duplicateSerializedBindings: z.array(z.string().min(1)),
  worktreeIsolations: z.number().int().nonnegative(),
  unsafeParallelMutators: z.number().int().nonnegative(),
  conditionalRepairCalls: z.number().int().nonnegative(),
  unconditionalRepairCalls: z.number().int().nonnegative(),
  triageOrAdjudicationCalls: z.number().int().nonnegative(),
  throwStatements: z.number().int().nonnegative(),
  failClosedSignals: z.number().int().nonnegative(),
  constraintTerms: z.number().int().nonnegative(),
  mutatingPromptConstraintCoverage: z.number().min(0).max(1).nullable(),
  lintErrors: z.number().int().nonnegative(),
  lintWarnings: z.number().int().nonnegative(),
});

export interface GeneratedWorkflowArtifact {
  schemaVersion: 1;
  kind: 'ultracode-generated-workflow';
  runId: string;
  host: AuthoringHost;
  sourceSuite: AuthoringSourceSuite;
  taskId: string;
  qualifiedTaskId: string;
  key: string;
  model: string;
  requestedEffort: string;
  generatedAt: string;
  elapsedMs: number;
  status: 'valid' | 'invalid';
  toolUseDetected: boolean;
  promptSha256: string;
  transcriptSha256: string;
  workflowSha256: string | null;
  diagnostics: string[];
  metrics: StaticWorkflowMetrics | null;
}

export const generatedWorkflowArtifactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('ultracode-generated-workflow'),
  runId: z.string().transform(validateRunId),
  host: hostSchema,
  sourceSuite: sourceSuiteSchema,
  taskId: taskIdSchema,
  qualifiedTaskId: z.string().min(1),
  key: artifactKeySchema,
  model: z.string().min(1).max(256),
  requestedEffort: z.string().min(1).max(64),
  generatedAt: z.string().datetime({ offset: true }),
  elapsedMs: z.number().finite().nonnegative(),
  status: z.enum(['valid', 'invalid']),
  toolUseDetected: z.boolean(),
  promptSha256: sha256Schema,
  transcriptSha256: sha256Schema,
  workflowSha256: sha256Schema.nullable(),
  diagnostics: z.array(z.string()),
  metrics: staticWorkflowMetricsSchema.nullable(),
});

export interface PairedComparison {
  sourceSuite: AuthoringSourceSuite;
  taskId: string;
  qualifiedTaskId: string;
  goldPatchStats: GoldPatchStats | null;
  codex: GeneratedWorkflowArtifact | null;
  claude: GeneratedWorkflowArtifact | null;
  agentMinimumDelta: number | null;
  agentMaximumDelta: number | null;
  phaseDelta: number | null;
  agentScaleMatched: boolean | null;
  phaseCountMatched: boolean | null;
  codexLocalizedScaleMatched: boolean | null;
}

export interface MetricDistribution {
  mean: number | null;
  median: number | null;
}

export interface HostStaticAggregate {
  storedArtifacts: number;
  validArtifacts: number;
  dynamicAgentUpperBounds: number;
  sourceBytes: MetricDistribution;
  agentMinimum: MetricDistribution;
  agentMaximum: MetricDistribution;
  phaseCalls: MetricDistribution;
  parallelCalls: MetricDistribution;
  pipelineCalls: MetricDistribution;
  retryDeclarations: MetricDistribution;
  schemaAgentCallSites: MetricDistribution;
  jsonStringifyCalls: MetricDistribution;
  unsafeParallelMutators: MetricDistribution;
  conditionalRepairCalls: MetricDistribution;
  unconditionalRepairCalls: MetricDistribution;
}

export interface WorkflowAuthoringReport {
  schemaVersion: 1;
  kind: 'ultracode-workflow-authoring-report';
  suite: 'workflow-authoring';
  runId: string;
  generatedAt: string;
  model: string;
  requestedEffort: string;
  summary: {
    requestedArtifacts: number;
    storedArtifacts: number;
    validArtifacts: number;
    invalidArtifacts: number;
    pairedTasks: number;
    agentScaleMatches: number;
    phaseCountMatches: number;
    localizedCodexTasks: number;
    localizedCodexScaleMatches: number;
    toolUseViolations: number;
  };
  aggregates: Record<AuthoringHost, HostStaticAggregate>;
  comparisons: PairedComparison[];
}
