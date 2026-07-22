/**
 * The only persisted benchmark experiment manifest. Pro relay runs use v3;
 * the unchanged Marathon and FeatureBench contracts remain strict v2.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { BenchPathRoots, BenchSuite } from './contracts.js';
import {
  benchProvenanceSchema,
  canonicalJson,
  modelTransportProvenanceSchema,
  sha256CanonicalJson,
  sha256Schema,
} from './provenance.js';
import {
  artifactKey,
  isPortableComponent,
  manifestFile,
  readPrivateJson,
  runDir,
  validateArtifactKey,
  validateRelativeArtifactPath,
  validateRunId,
  validateTaskId,
  writePrivateJsonAtomic,
} from './paths.js';

const taskIdSchema = z.string().transform(validateTaskId);
const runIdSchema = z.string().transform(validateRunId);
const artifactKeySchema = z.string().transform(validateArtifactKey);
const relativeArtifactPathSchema = z.string().transform(validateRelativeArtifactPath);
const armSchema = z.enum(['a', 'b']);
const experimentArmSchema = z.enum(['a', 'b', 'both']);
const isoTimestampSchema = z.string().datetime({ offset: true });

export const metricsPolicySnapshotSchema = z.strictObject({
  parserContractVersion: z.literal(2),
  cachedInputWeight: z.number().finite().min(0).max(1),
  compactionRule: z.literal('max-event-record'),
  resetMinDropTokens: z.number().int().nonnegative(),
  resetRetainedFraction: z.number().finite().min(0).max(1),
  workflowDedupeRule: z.literal('run-id'),
  implementationSha256: sha256Schema,
});

export const pricingSnapshotSchema = z.strictObject({
  currency: z.literal('USD'),
  model: z.string().min(1),
  uncachedInputPerMTokens: z.number().finite().nonnegative(),
  cachedInputPerMTokens: z.number().finite().nonnegative(),
  outputPerMTokens: z.number().finite().nonnegative(),
});

export const experimentSchema = z.strictObject({
  model: z.string().min(1).max(256),
  requestedEffort: z.string().min(1).max(64),
  arm: experimentArmSchema,
  taskIds: z.array(taskIdSchema).min(1),
});

export const limitsSchema = z.strictObject({
  hostTaskTimeoutMs: z.number().int().positive().nullable(),
  hostVerifierTimeoutMs: z.number().int().positive().nullable(),
  taskConcurrency: z.number().int().positive(),
  verifierConcurrency: z.number().int().positive(),
});

export const executionArtifactSchema = z.strictObject({
  taskId: taskIdSchema,
  arm: armSchema,
  key: artifactKeySchema,
  nativeRoot: relativeArtifactPathSchema,
});

export const runArtifactsSchema = z.strictObject({
  nativeRoot: z.literal('native'),
  runState: z.literal('run-state.json'),
  verifierReceipt: z.literal('verifier-receipt.json'),
  reportJson: z.literal('report.json'),
  reportMarkdown: z.literal('report.md'),
  executions: z.array(executionArtifactSchema).min(1),
});

const authSnapshotSchema = z.strictObject({
  mechanism: z.enum(['chatgpt', 'api-key']),
  publicIdentitySha256: sha256Schema,
});

const proPolicySchema = z.strictObject({
  sessionSha256: sha256Schema,
  historySha256: sha256Schema,
  cleanupSha256: sha256Schema,
  evaluatorSha256: sha256Schema,
  adapterSha256: sha256Schema,
});

export const swebenchProSuiteConfigSchema = z.strictObject({
  preparedInputSha256: sha256Schema,
  selection: z.discriminatedUnion('mode', [
    z.strictObject({
      mode: z.literal('explicit'),
      seed: z.null(),
      count: z.number().int().positive(),
      stratifyBy: z.null(),
      requestedTaskIds: z.array(taskIdSchema),
    }),
    z.strictObject({
      mode: z.literal('seeded-stratified'),
      seed: z.number().int().nonnegative(),
      count: z.number().int().positive(),
      stratifyBy: z.enum(['repo_language', 'repo']),
      requestedTaskIds: z.array(taskIdSchema),
    }),
  ]),
  instances: z.array(z.strictObject({
    taskId: taskIdSchema,
    row: z.record(z.string(), z.json()),
    rowSha256: sha256Schema,
  })).min(1),
  armOrder: z.array(z.strictObject({
    taskId: taskIdSchema,
    arms: z.array(armSchema).min(1).max(2),
  })).min(1),
  modelTransport: modelTransportProvenanceSchema,
  policies: proPolicySchema,
  attempts: z.literal(1),
  retries: z.literal(0),
  evaluator: z.strictObject({
    workers: z.number().int().positive(),
    watchdogMs: z.number().int().positive(),
  }),
  docker: z.strictObject({
    cpus: z.number().finite().positive(),
    memoryBytes: z.number().int().positive(),
  }),
});

export const sweMarathonSuiteConfigSchema = z.strictObject({
  preparedInputSha256: sha256Schema,
  auth: authSnapshotSchema,
  workflowWaitMs: z.number().int().nonnegative(),
  bridgeClass: z.string().min(1).max(256),
  oneTaskPerJob: z.literal(true),
  attempts: z.literal(1),
  retries: z.literal(0),
  policies: z.strictObject({
    excludedTasksSha256: sha256Schema,
    tasksSha256: sha256Schema,
    resourcesSha256: sha256Schema,
    bridgeSha256: sha256Schema,
    adapterSha256: sha256Schema,
  }),
});

export const featureBenchSuiteConfigSchema = z.strictObject({
  preparedInputSha256: sha256Schema,
  authMechanism: z.literal('credential-broker'),
  runtime: z.literal('cpu'),
  publicBrokerIdentitySha256: sha256Schema,
  publicBrokerVersionSha256: sha256Schema,
  restrictedNetworkPolicySha256: sha256Schema,
  attempts: z.literal(1),
  retries: z.literal(0),
  inference: z.strictObject({
    concurrency: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  }),
  evaluation: z.strictObject({
    concurrency: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  }),
  resources: z.strictObject({
    cpus: z.number().finite().positive(),
    memoryBytes: z.number().int().positive(),
    pids: z.number().int().positive(),
  }),
  policies: z.strictObject({
    promptSha256: sha256Schema,
    patchSha256: sha256Schema,
    datasetMapSha256: sha256Schema,
    adapterSha256: sha256Schema,
  }),
});

const commonShape = {
  kind: z.literal('ultracode-benchmark-run'),
  runId: runIdSchema,
  createdAt: isoTimestampSchema,
  experiment: experimentSchema,
  limits: limitsSchema,
  metricsPolicy: metricsPolicySnapshotSchema,
  pricing: pricingSnapshotSchema.nullable(),
  provenance: benchProvenanceSchema,
  artifacts: runArtifactsSchema,
};

const swebenchProManifestSchema = z.strictObject({
  ...commonShape,
  schemaVersion: z.literal(3),
  suite: z.literal('swebench-pro'),
  suiteConfig: swebenchProSuiteConfigSchema,
});

const sweMarathonManifestSchema = z.strictObject({
  ...commonShape,
  schemaVersion: z.literal(2),
  suite: z.literal('swe-marathon'),
  suiteConfig: sweMarathonSuiteConfigSchema,
});

const featureBenchManifestSchema = z.strictObject({
  ...commonShape,
  schemaVersion: z.literal(2),
  suite: z.literal('featurebench'),
  suiteConfig: featureBenchSuiteConfigSchema,
});

const rawManifestSchema = z.discriminatedUnion('suite', [
  swebenchProManifestSchema,
  sweMarathonManifestSchema,
  featureBenchManifestSchema,
]);

type RawManifest = z.infer<typeof rawManifestSchema>;

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const SECRET_FIELD_RE = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credentials?|auth[_-]?(?:file|path)|broker[_-]?url|pip[_-]?config[_-]?file)$/i;

function rejectSecretMaterial(value: unknown, context: z.RefinementCtx, path: PropertyKey[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecretMaterial(entry, context, [...path, index]));
    return;
  }
  if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) {
        addIssue(context, path, 'benchmark manifests must not contain secret-bearing URLs');
      }
    } catch {
      addIssue(context, path, 'benchmark manifests must not contain malformed URLs');
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD_RE.test(key)) {
      addIssue(context, [...path, key], 'benchmark manifests must not contain secret or runtime-binding fields');
    }
    rejectSecretMaterial(entry, context, [...path, key]);
  }
}

function expectedExecutionArms(manifest: RawManifest): Array<{ taskId: string; arm: 'a' | 'b' }> {
  if (manifest.suite === 'swebench-pro') {
    return manifest.suiteConfig.armOrder.flatMap(({ taskId, arms }) => arms.map((arm) => ({ taskId, arm })));
  }
  const arm = manifest.experiment.arm;
  if (arm === 'both') return [];
  return manifest.experiment.taskIds.map((taskId) => ({ taskId, arm }));
}

function refineManifest(manifest: RawManifest, context: z.RefinementCtx): void {
  rejectSecretMaterial(manifest, context);
  const taskIds = manifest.experiment.taskIds;
  for (let index = 0; index < taskIds.length; index += 1) {
    const taskId = taskIds[index]!;
    const valid = manifest.suite === 'swe-marathon'
      ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskId)
      : isPortableComponent(taskId) && !taskId.includes('..');
    if (!valid) addIssue(context, ['experiment', 'taskIds', index], `unsafe ${manifest.suite} task identity`);
  }
  if (!unique(taskIds)) addIssue(context, ['experiment', 'taskIds'], 'task IDs must be unique');
  if (manifest.pricing !== null && manifest.pricing.model !== manifest.experiment.model) {
    addIssue(context, ['pricing', 'model'], 'pricing model must equal experiment model');
  }
  if (manifest.metricsPolicy.implementationSha256 !== manifest.provenance.controlPlane.metricsPolicySha256) {
    addIssue(context, ['metricsPolicy', 'implementationSha256'], 'metrics policy hash must equal provenance');
  }
  const provenanceTaskIds = manifest.provenance.tasks.map((task) => task.taskId);
  if (canonicalJson(provenanceTaskIds) !== canonicalJson(taskIds)) {
    addIssue(context, ['provenance', 'tasks'], 'task provenance order must equal experiment task order');
  }

  if (manifest.suite !== 'swebench-pro' && manifest.experiment.arm === 'both') {
    addIssue(context, ['experiment', 'arm'], `${manifest.suite} requires one arm per run`);
  }

  if (manifest.suite === 'swebench-pro') {
    const config = manifest.suiteConfig;
    if (manifest.provenance.modelTransport === undefined
      || canonicalJson(config.modelTransport) !== canonicalJson(manifest.provenance.modelTransport)) {
      addIssue(context, ['provenance', 'modelTransport'], 'Pro model transport provenance must equal its frozen suite policy');
    }
    const modelSha256 = createHash('sha256').update(manifest.experiment.model, 'utf8').digest('hex');
    if (config.modelTransport.modelSha256 !== modelSha256) {
      addIssue(context, ['suiteConfig', 'modelTransport', 'modelSha256'], 'Pro model transport must bind the requested model');
    }
    const instanceIds = config.instances.map((instance) => instance.taskId);
    const orderIds = config.armOrder.map((entry) => entry.taskId);
    if (canonicalJson(instanceIds) !== canonicalJson(taskIds)) {
      addIssue(context, ['suiteConfig', 'instances'], 'frozen instance order must equal experiment task order');
    }
    if (canonicalJson(orderIds) !== canonicalJson(taskIds)) {
      addIssue(context, ['suiteConfig', 'armOrder'], 'arm-order task order must equal experiment task order');
    }
    for (let index = 0; index < config.instances.length; index += 1) {
      const instance = config.instances[index]!;
      if (sha256CanonicalJson(instance.row) !== instance.rowSha256) {
        addIssue(context, ['suiteConfig', 'instances', index, 'rowSha256'], 'frozen row hash does not match row');
      }
      if (instance.row.instance_id !== instance.taskId) {
        addIssue(context, ['suiteConfig', 'instances', index, 'row'], 'frozen row identity must equal task identity');
      }
      const task = manifest.provenance.tasks[index];
      if (task?.sourceSha256 !== instance.rowSha256 || task?.image === null) {
        addIssue(context, ['provenance', 'tasks', index], 'Pro task provenance must bind its row and prepared image');
      }
    }
    for (let index = 0; index < config.armOrder.length; index += 1) {
      const arms = config.armOrder[index]!.arms;
      const expected = manifest.experiment.arm === 'both' ? ['a', 'b'] : [manifest.experiment.arm];
      if (!unique(arms) || arms.length !== expected.length || arms.some((arm) => !expected.includes(arm))) {
        addIssue(context, ['suiteConfig', 'armOrder', index, 'arms'], 'arm order must cover the experiment arm exactly');
      }
    }
    if (config.selection.count !== taskIds.length) {
      addIssue(context, ['suiteConfig', 'selection', 'count'], 'selection count must equal frozen task count');
    }
    if (config.selection.mode === 'explicit'
      && canonicalJson(config.selection.requestedTaskIds) !== canonicalJson(taskIds)) {
      addIssue(context, ['suiteConfig', 'selection', 'requestedTaskIds'], 'explicit selection must equal task order');
    }
    if (config.selection.mode === 'seeded-stratified' && config.selection.requestedTaskIds.length !== 0) {
      addIssue(context, ['suiteConfig', 'selection', 'requestedTaskIds'], 'sampled selection cannot contain requested task IDs');
    }
    if (config.policies.adapterSha256 !== manifest.provenance.controlPlane.adapterPolicySha256) {
      addIssue(context, ['suiteConfig', 'policies', 'adapterSha256'], 'adapter policy hash must equal provenance');
    }
  } else if (manifest.suite === 'swe-marathon') {
    if (manifest.provenance.modelTransport !== undefined) {
      addIssue(context, ['provenance', 'modelTransport'], 'SWE-Marathon does not accept Pro model transport provenance');
    }
    if (manifest.limits.hostVerifierTimeoutMs !== null) {
      addIssue(context, ['limits', 'hostVerifierTimeoutMs'], 'SWE-Marathon uses only native verifier deadlines');
    }
    if (manifest.suiteConfig.policies.adapterSha256 !== manifest.provenance.controlPlane.adapterPolicySha256) {
      addIssue(context, ['suiteConfig', 'policies', 'adapterSha256'], 'adapter policy hash must equal provenance');
    }
  } else {
    if (manifest.provenance.modelTransport !== undefined) {
      addIssue(context, ['provenance', 'modelTransport'], 'FeatureBench does not accept Pro model transport provenance');
    }
    if (manifest.suiteConfig.policies.adapterSha256 !== manifest.provenance.controlPlane.adapterPolicySha256) {
      addIssue(context, ['suiteConfig', 'policies', 'adapterSha256'], 'adapter policy hash must equal provenance');
    }
  }

  const expectedExecutions = expectedExecutionArms(manifest);
  const executions = manifest.artifacts.executions;
  if (executions.length !== expectedExecutions.length) {
    addIssue(context, ['artifacts', 'executions'], 'execution artifacts must cover every task and arm exactly');
  }
  for (let index = 0; index < Math.min(executions.length, expectedExecutions.length); index += 1) {
    const execution = executions[index]!;
    const expected = expectedExecutions[index]!;
    if (execution.taskId !== expected.taskId || execution.arm !== expected.arm) {
      addIssue(context, ['artifacts', 'executions', index], 'execution order must equal frozen task and arm order');
    }
    const expectedKey = artifactKey(execution.taskId);
    if (execution.key !== expectedKey) {
      addIssue(context, ['artifacts', 'executions', index, 'key'], 'artifact key does not match task identity');
    }
    const expectedRoot = manifest.suite === 'swebench-pro'
      ? `native/tasks/${expectedKey}/${execution.arm}`
      : manifest.suite === 'swe-marathon'
        ? `native/tasks/${expectedKey}`
        : 'native';
    if (execution.nativeRoot !== expectedRoot) {
      addIssue(context, ['artifacts', 'executions', index, 'nativeRoot'], 'native root does not match suite layout');
    }
  }
}

export const benchRunManifestSchema = rawManifestSchema.superRefine(refineManifest);

export type BenchRunManifest = z.infer<typeof benchRunManifestSchema>;
export type SwebenchProManifest = Extract<BenchRunManifest, { suite: 'swebench-pro' }>;
export type SweMarathonManifest = Extract<BenchRunManifest, { suite: 'swe-marathon' }>;
export type FeatureBenchManifest = Extract<BenchRunManifest, { suite: 'featurebench' }>;
export type MetricsPolicySnapshot = z.infer<typeof metricsPolicySnapshotSchema>;
export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;
export type RunArtifacts = z.infer<typeof runArtifactsSchema>;

export function parseBenchRunManifest(value: unknown): BenchRunManifest {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (candidate.suite === 'swebench-pro' && candidate.schemaVersion === 2) {
      throw new Error('SWE-bench Pro manifest schema version 2 predates attested relay transport and is unsupported; create a new version 3 run');
    }
  }
  return benchRunManifestSchema.parse(value);
}

export function serializeBenchRunManifest(value: unknown): string {
  return `${JSON.stringify(parseBenchRunManifest(value), null, 2)}\n`;
}

export function sha256BenchRunManifest(value: unknown): string {
  return createHash('sha256').update(serializeBenchRunManifest(value), 'utf8').digest('hex');
}

export function writeBenchRunManifest(roots: BenchPathRoots, value: unknown): BenchRunManifest {
  const manifest = parseBenchRunManifest(value);
  const directory = runDir(roots, manifest.suite, manifest.runId);
  const file = manifestFile(roots, manifest.suite, manifest.runId);
  if (existsSync(file)) throw new Error(`benchmark manifest already exists: ${manifest.suite}/${manifest.runId}`);
  writePrivateJsonAtomic(directory, file, manifest);
  if (directory !== runDir(roots, manifest.suite, manifest.runId)) throw new Error('manifest path identity changed');
  return manifest;
}

/** Load exactly manifest.json for the requested suite/run identity. */
export function loadBenchRunManifest(
  roots: BenchPathRoots,
  suite: BenchSuite,
  runId: string,
): BenchRunManifest {
  const directory = runDir(roots, suite, runId);
  const parsed = parseBenchRunManifest(readPrivateJson(directory, manifestFile(roots, suite, runId)));
  if (parsed.suite !== suite || parsed.runId !== validateRunId(runId)) {
    throw new Error(`manifest identity mismatch for ${suite}/${runId}`);
  }
  return parsed;
}

/** Immutable resume projection; only creation time is not a requested input. */
export function manifestResumeProjection(manifest: BenchRunManifest): unknown {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'createdAt'));
}

/** Fail closed if any common or suite-specific immutable resume input drifted. */
export function assertManifestResumeEquality(existing: unknown, requested: unknown): void {
  const frozen = parseBenchRunManifest(existing);
  const candidate = parseBenchRunManifest(requested);
  if (canonicalJson(manifestResumeProjection(frozen)) !== canonicalJson(manifestResumeProjection(candidate))) {
    throw new Error('resume inputs do not match the frozen benchmark manifest');
  }
}

export const MANIFEST_POLICY_SHA256 = sha256CanonicalJson({
  schemaVersions: { swebenchPro: 3, sweMarathon: 2, featureBench: 2 },
  kind: 'ultracode-benchmark-run',
  strictDiscriminatedUnion: true,
  resumeProjection: 'all-except-created-at',
  credentials: 'forbidden',
  modelTransport: 'suite-bound-attested-relay-provenance',
  artifacts: 'suite-task-arm-exact',
  marathonVerifierTimeout: 'native-only-host-null',
});
