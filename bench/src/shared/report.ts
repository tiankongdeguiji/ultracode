/** Common report envelope, evidence binding, and suite-analysis hook contract. */
import { createHash } from 'node:crypto';
import type { BenchSuite } from './contracts.js';
import {
  annotationSchema,
  failureObservationSchema,
  taskDisposition,
  type Annotation,
  type FailureObservation,
  type TaskDisposition,
} from './failure.js';
import { parseBenchRunManifest, type BenchRunManifest } from './manifest.js';
import type { NormalizedMetrics } from './metrics.js';
import {
  canonicalJson,
  sha256File,
  sha256CanonicalJson,
  type BenchProvenance,
} from './provenance.js';
import {
  reportJsonFile,
  reportMarkdownFile,
  manifestFile,
  readPrivateFile,
  resolveRegularFileWithinRoot,
  runDir,
  validateRelativeArtifactPath,
  writePrivateFileAtomic,
  writePrivateJsonAtomic,
  verifierReceiptFile,
} from './paths.js';
import type { BenchPathRoots, Arm } from './contracts.js';
import { loadBenchRunStateEvidence, type BenchRunState } from './run-state.js';
import { verifierReceiptSchema, type NativeVerifierResult, type VerifierReceipt } from './verifier.js';

export interface RateAnalysis {
  evaluated: number;
  resolved: number;
  rate: number | null;
  wilson95: { lo: number; hi: number };
}

export interface PairedAnalysis {
  paired: number;
  bothResolved: number;
  aOnly: number;
  bOnly: number;
  neither: number;
  mcnemarExactP: number;
}

export interface ThesisStratum {
  paired: number;
  aResolved: number;
  bResolved: number;
  aRate: number | null;
  bRate: number | null;
  delta: number | null;
}

export interface SwebenchProAnalysis {
  suite: 'swebench-pro';
  native: {
    arms: { a: RateAnalysis; b: RateAnalysis };
    paired: PairedAnalysis;
    thesisCut: { inside: ThesisStratum; outside: ThesisStratum; unclassified: number };
  };
  policyAdjusted: {
    arms: { a: RateAnalysis; b: RateAnalysis };
    paired: PairedAnalysis;
  };
}

export interface SweMarathonAnalysis {
  suite: 'swe-marathon';
  native: { meanReward: number | null; verifiedTasks: number; requestedTasks: number };
  policyAdjusted: { meanReward: number | null; includedTasks: number };
}

export interface FeatureBenchAnalysis {
  suite: 'featurebench';
  native: {
    passRate: number | null;
    resolvedRate: number | null;
    completedTasks: number;
    requestedTasks: number;
  };
  consistency: { taskMeanPassRate: number | null; matchesAggregate: boolean | null };
  policyAdjusted: { passRate: number | null; includedTasks: number };
}

export type SuiteAnalysis = SwebenchProAnalysis | SweMarathonAnalysis | FeatureBenchAnalysis;

export interface NativeVerifierArtifact {
  path: string;
  sha256: string;
  nativeRecordKey: string;
}

export interface TaskResult {
  taskId: string;
  arm: Arm;
  nativeVerifier: {
    verification: 'verified' | 'unverified';
    score: number | null;
    resolved: boolean | null;
    artifact: NativeVerifierArtifact | null;
  };
  disposition: TaskDisposition;
  failures: FailureObservation[];
  annotations: Annotation[];
}

export interface ReproducibilityEnvelope {
  manifestPath: 'manifest.json';
  manifestSha256: string;
  verifierReceiptPath: 'verifier-receipt.json';
  verifierReceiptSha256: string;
  runStatePath: 'run-state.json';
  runStateSha256: string;
  runStateLedgerRootSha256: string | null;
  provenance: BenchProvenance;
  suiteConfigSha256: string;
  metricsPolicySha256: string;
  failurePolicySha256: string;
  reportPolicySha256: string;
}

export interface BenchReport {
  schemaVersion: 2;
  kind: 'ultracode-benchmark-report';
  suite: BenchSuite;
  runId: string;
  generatedAt: string;
  experiment: BenchRunManifest['experiment'];
  metrics: NormalizedMetrics;
  taskResults: TaskResult[];
  failures: FailureObservation[];
  annotations: Annotation[];
  reproducibility: ReproducibilityEnvelope;
  analysis: SuiteAnalysis;
}

export interface TaskReportInput {
  taskId: string;
  arm: Arm;
  nativeVerifier: NativeVerifierResult;
  failures: readonly FailureObservation[];
  annotations: readonly Annotation[];
  attemptRunning: boolean;
}

export interface SuiteAnalysisContext<S extends BenchSuite = BenchSuite> {
  suite: S;
  manifest: Extract<BenchRunManifest, { suite: S }>;
  metrics: NormalizedMetrics;
  taskResults: readonly TaskResult[];
  /** Receipt-bound suite-native aggregate, when the native verifier has one. */
  nativeAnalysisInput: unknown;
}

export interface SuiteAnalysisHook<S extends BenchSuite = BenchSuite> {
  suite: S;
  analyze(context: SuiteAnalysisContext<S>): Extract<SuiteAnalysis, { suite: S }>;
}

export interface ReportPolicyHashes {
  metricsPolicySha256: string;
  failurePolicySha256: string;
  reportPolicySha256: string;
  adapterPolicySha256: string;
}

export interface NativeAnalysisArtifactInput {
  /** Receipt-bound relative path whose exact bytes are parsed for analysis. */
  path: string;
  bytes: Uint8Array;
}

export interface BuildBenchReportOptions<S extends BenchSuite> {
  manifest: Extract<BenchRunManifest, { suite: S }>;
  manifestSha256: string;
  runState: BenchRunState;
  runStateSha256: string;
  runStateLedgerRootSha256: string | null;
  verifierReceipt: VerifierReceipt;
  verifierReceiptSha256: string;
  metrics: NormalizedMetrics;
  taskResults: readonly TaskReportInput[];
  failures?: readonly FailureObservation[];
  annotations?: readonly Annotation[];
  generatedAt?: Date;
  currentPolicyHashes: ReportPolicyHashes;
  analysisHook: SuiteAnalysisHook<S>;
  nativeAnalysisArtifact?: NativeAnalysisArtifactInput;
}

export interface StoredReportEvidence<S extends BenchSuite = BenchSuite> {
  manifest: Extract<BenchRunManifest, { suite: S }>;
  manifestSha256: string;
  runState: BenchRunState;
  runStateSha256: string;
  runStateLedgerRootSha256: string | null;
  verifierReceipt: VerifierReceipt;
  verifierReceiptSha256: string;
}

/** Load only fixed private run artifacts and bind their exact stored bytes. */
export function loadStoredReportEvidence<S extends BenchSuite>(
  roots: BenchPathRoots,
  suite: S,
  runId: string,
): StoredReportEvidence<S> {
  const directory = runDir(roots, suite, runId);
  const manifestPath = manifestFile(roots, suite, runId);
  const receiptPath = verifierReceiptFile(roots, suite, runId);
  const parseStored = <T>(path: string, parse: (value: unknown) => T): { value: T; sha256: string } => {
    const bytes = readPrivateFile(directory, path);
    const value = parse(JSON.parse(bytes.toString('utf8')) as unknown);
    return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const storedManifest = parseStored(manifestPath, parseBenchRunManifest);
  const manifest = storedManifest.value as Extract<BenchRunManifest, { suite: S }>;
  const manifestSha256 = storedManifest.sha256;
  const storedState = loadBenchRunStateEvidence(roots, suite, runId, manifestSha256);
  const runState = storedState.state;
  const storedReceipt = parseStored(receiptPath, (value) => verifierReceiptSchema.parse(value));
  const verifierReceipt = storedReceipt.value;
  if (manifest.suite !== suite || manifest.runId !== runId) {
    throw new Error('stored manifest identity does not match the requested report');
  }
  if (runState.suite !== suite || runState.runId !== manifest.runId || runState.manifestSha256 !== manifestSha256) {
    throw new Error('stored run state is not bound to the exact manifest bytes');
  }
  if (verifierReceipt.suite !== suite || verifierReceipt.runId !== manifest.runId
    || verifierReceipt.manifestSha256 !== manifestSha256) {
    throw new Error('stored verifier receipt is not bound to the exact manifest bytes');
  }
  const invocationIds = new Set(runState.invocations.map((invocation) => invocation.invocationId));
  for (const binding of verifierReceipt.bindings) {
    if (!invocationIds.has(binding.invocationId)) {
      throw new Error(`verifier binding references unknown invocation ${binding.invocationId}`);
    }
    const artifact = resolveRegularFileWithinRoot(directory, binding.path, 'receipt-bound native artifact');
    if (sha256File(artifact) !== binding.sha256) {
      throw new Error(`receipt-bound native artifact drifted: ${binding.path}`);
    }
  }
  return {
    manifest,
    manifestSha256,
    runState,
    runStateSha256: storedState.stateFileSha256,
    runStateLedgerRootSha256: storedState.ledgerRootSha256,
    verifierReceipt,
    verifierReceiptSha256: storedReceipt.sha256,
  };
}

function assertPolicyHashes(manifest: BenchRunManifest, current: ReportPolicyHashes): void {
  const frozen = manifest.provenance.controlPlane;
  for (const key of [
    'metricsPolicySha256',
    'failurePolicySha256',
    'reportPolicySha256',
    'adapterPolicySha256',
  ] as const) {
    if (current[key] !== frozen[key]) throw new Error(`${key} drifted after manifest creation`);
  }
}

function sameTaskArm(left: { taskId: string; arm: Arm }, right: { taskId: string; arm: Arm }): boolean {
  return left.taskId === right.taskId && left.arm === right.arm;
}

function bindNativeResult(
  input: TaskReportInput,
  receipt: VerifierReceipt,
): TaskResult['nativeVerifier'] {
  const native = input.nativeVerifier;
  if (native.verification === 'unverified') {
    if (native.score !== null || native.resolved !== null || native.artifact !== null) {
      throw new Error(`unverified native result must be null for ${input.taskId}/${input.arm}`);
    }
    return { verification: 'unverified', score: null, resolved: null, artifact: null };
  }
  if (!Number.isFinite(native.score) || native.score! < 0 || native.score! > 1
    || native.resolved === null || native.artifact === null
    || native.artifact.nativeRecordKey === null) {
    throw new Error(`verified native result is incomplete for ${input.taskId}/${input.arm}`);
  }
  const path = validateRelativeArtifactPath(native.artifact.path);
  const matching = receipt.bindings.some((binding) =>
    binding.scope.kind === 'task-arm'
    && binding.scope.taskId === input.taskId
    && binding.scope.arm === input.arm
    && ['native-result', 'task-report', 'aggregate-report'].includes(binding.role)
    && binding.path === path
    && binding.sha256 === native.artifact!.sha256
    && binding.nativeRecordKey === native.artifact!.nativeRecordKey);
  if (!matching) throw new Error(`native result is not bound by the verifier receipt for ${input.taskId}/${input.arm}`);
  return {
    verification: 'verified',
    score: native.score,
    resolved: native.resolved,
    artifact: {
      path,
      sha256: native.artifact.sha256,
      nativeRecordKey: native.artifact.nativeRecordKey,
    },
  };
}

function uniqueByCanonical<T>(values: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const value of values) unique.set(canonicalJson(value), value);
  return [...unique.values()];
}

function bindNativeAnalysisInput(
  input: NativeAnalysisArtifactInput | undefined,
  receipt: VerifierReceipt,
): unknown {
  if (input === undefined) return null;
  const path = validateRelativeArtifactPath(input.path);
  const bytes = Buffer.from(input.bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const matching = receipt.bindings.some((binding) =>
    binding.role === 'aggregate-report'
    && binding.path === path
    && binding.sha256 === sha256);
  if (!matching) throw new Error('native analysis artifact is not bound by the verifier receipt');
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`native analysis artifact is not valid JSON: ${path}`);
  }
}

/** Build the common envelope solely from frozen state and receipt-bound evidence. */
export function buildBenchReport<S extends BenchSuite>(options: BuildBenchReportOptions<S>): BenchReport {
  const { manifest, runState, verifierReceipt, metrics } = options;
  if (runState.suite !== manifest.suite || runState.runId !== manifest.runId
    || runState.manifestSha256 !== options.manifestSha256) {
    throw new Error('run-state identity does not match report manifest');
  }
  if (verifierReceipt.suite !== manifest.suite || verifierReceipt.runId !== manifest.runId
    || verifierReceipt.manifestSha256 !== options.manifestSha256) {
    throw new Error('verifier receipt identity does not match report manifest');
  }
  if (metrics.requested.model !== manifest.experiment.model
    || metrics.requested.effort !== manifest.experiment.requestedEffort) {
    throw new Error('normalized metrics requested identity does not match report manifest');
  }
  if (options.analysisHook.suite !== manifest.suite) throw new Error('suite analysis hook does not match manifest');
  assertPolicyHashes(manifest, options.currentPolicyHashes);
  const expected = manifest.artifacts.executions;
  if (options.taskResults.length !== expected.length) {
    throw new Error('task report inputs must cover every manifest execution exactly');
  }
  const taskResults: TaskResult[] = options.taskResults.map((input, index) => {
    const execution = expected[index]!;
    if (!sameTaskArm(input, execution)) throw new Error('task report order must match manifest executions');
    const failures = input.failures.map((failure) => failureObservationSchema.parse(failure));
    const annotations = input.annotations.map((entry) => annotationSchema.parse(entry));
    if (failures.some((failure) => failure.scope.kind !== 'task-arm'
      || !sameTaskArm(failure.scope, input))) {
      throw new Error(`task failure scope does not match ${input.taskId}/${input.arm}`);
    }
    if (annotations.some((entry) => entry.scope.kind !== 'task-arm'
      || !sameTaskArm(entry.scope, input))) {
      throw new Error(`task annotation scope does not match ${input.taskId}/${input.arm}`);
    }
    const nativeVerifier = bindNativeResult(input, verifierReceipt);
    return {
      taskId: input.taskId,
      arm: input.arm,
      nativeVerifier,
      disposition: taskDisposition(nativeVerifier, failures, input.attemptRunning),
      failures,
      annotations,
    };
  });
  const failures = uniqueByCanonical([
    ...metrics.failures,
    ...(options.failures ?? []).map((failure) => failureObservationSchema.parse(failure)),
    ...taskResults.flatMap((task) => task.failures),
  ]);
  const annotations = uniqueByCanonical([
    ...metrics.annotations,
    ...(options.annotations ?? []).map((entry) => annotationSchema.parse(entry)),
    ...taskResults.flatMap((task) => task.annotations),
  ]);
  const context = {
    suite: manifest.suite,
    manifest,
    metrics,
    taskResults,
    nativeAnalysisInput: bindNativeAnalysisInput(options.nativeAnalysisArtifact, verifierReceipt),
  } as SuiteAnalysisContext<S>;
  const analysis = options.analysisHook.analyze(context);
  if (analysis.suite !== manifest.suite) throw new Error('suite analysis returned the wrong discriminator');
  return {
    schemaVersion: 2,
    kind: 'ultracode-benchmark-report',
    suite: manifest.suite,
    runId: manifest.runId,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    experiment: manifest.experiment,
    metrics,
    taskResults,
    failures,
    annotations,
    reproducibility: {
      manifestPath: 'manifest.json',
      manifestSha256: options.manifestSha256,
      verifierReceiptPath: 'verifier-receipt.json',
      verifierReceiptSha256: options.verifierReceiptSha256,
      runStatePath: 'run-state.json',
      runStateSha256: options.runStateSha256,
      runStateLedgerRootSha256: options.runStateLedgerRootSha256,
      provenance: manifest.provenance,
      suiteConfigSha256: sha256CanonicalJson(manifest.suiteConfig),
      metricsPolicySha256: manifest.provenance.controlPlane.metricsPolicySha256,
      failurePolicySha256: manifest.provenance.controlPlane.failurePolicySha256,
      reportPolicySha256: manifest.provenance.controlPlane.reportPolicySha256,
    },
    analysis,
  };
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

/** Render the suite-neutral evidence and disposition view. */
export function renderBenchReportMarkdown(report: BenchReport): string {
  const lines = [
    `# Benchmark report: ${report.runId}`,
    '',
    `- suite: ${report.suite}`,
    `- model: ${report.experiment.model}`,
    `- requested effort: ${report.experiment.requestedEffort}`,
    `- effective effort: ${report.metrics.effectiveEffort.verification}`,
    `- raw tokens: ${report.metrics.tokens.total.rawTokenCount}`,
    `- discounted token equivalent: ${report.metrics.tokens.total.discountedTokenEquivalent}`,
    `- run elapsed: ${report.metrics.timing.runElapsedMs} ms`,
    `- detached workflow wait: ${report.metrics.timing.detachedWorkflowWaitMs} ms (included in run elapsed)`,
    '',
    '## Native verifier evidence',
    '',
    '| Task | Arm | Verification | Score | Resolved | Disposition | Artifact | SHA-256 |',
    '| --- | --- | --- | ---: | --- | --- | --- | --- |',
    ...report.taskResults.map((task) => {
      const artifact = task.nativeVerifier.artifact;
      return `| ${markdownCell(task.taskId)} | ${task.arm} | ${task.nativeVerifier.verification} | ${task.nativeVerifier.score ?? '—'} | ${task.nativeVerifier.resolved === null ? '—' : task.nativeVerifier.resolved ? 'yes' : 'no'} | ${task.disposition} | ${artifact?.path ?? '—'} | ${artifact?.sha256 ?? '—'} |`;
    }),
    '',
    '## Reproducibility',
    '',
    `- manifest: \`${report.reproducibility.manifestPath}\` (${report.reproducibility.manifestSha256})`,
    `- run state: \`${report.reproducibility.runStatePath}\` (${report.reproducibility.runStateSha256})`,
    `- run-state ledger root: ${report.reproducibility.runStateLedgerRootSha256 ?? 'legacy v2 monolith'}`,
    `- verifier receipt: \`${report.reproducibility.verifierReceiptPath}\` (${report.reproducibility.verifierReceiptSha256})`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/** Atomically write the two fixed report artifacts beneath one final run. */
export function writeBenchReport(roots: BenchPathRoots, report: BenchReport): { jsonPath: string; markdownPath: string } {
  const directory = runDir(roots, report.suite, report.runId);
  const jsonPath = reportJsonFile(roots, report.suite, report.runId);
  const markdownPath = reportMarkdownFile(roots, report.suite, report.runId);
  writePrivateJsonAtomic(directory, jsonPath, report);
  writePrivateFileAtomic(directory, markdownPath, renderBenchReportMarkdown(report));
  return { jsonPath, markdownPath };
}

export const REPORT_POLICY_SHA256 = sha256CanonicalJson({
  schemaVersion: 2,
  nativeVerifierAuthority: 'receipt-bound-only',
  missingNativeResult: 'unverified-null',
  provenanceSource: 'manifest-plus-sealed-run-state-ledger-root',
  dispositionPolicy: 'shared-failure-policy-v2',
  analysis: 'suite-discriminated-hook',
});
