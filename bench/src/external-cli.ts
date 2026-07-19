/**
 * Shared CLI and report schema for benchmark suites that retain their native
 * runners and verifiers. Importing this module is inert: suite adapters and
 * their optional Python tooling are loaded only by the selected command.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_ROOT, loadConfig, resultsDir, toolchainDir } from './config.js';
import {
  artifactKey,
  allowlistedEnvironment,
  joinWithinRoot,
  resolveRegularFileWithinRoot,
  sha256File,
  sha256Tree,
  validateFeatureBenchTaskId,
  validateRunId,
} from './external-common.js';
import {
  collectExternalMetrics,
  readJsonLines,
} from './external-metrics.js';
import { ARM_B_PREFIX } from './prompt.js';
import type {
  ExternalMetrics,
  ExternalSessionMetrics,
  ExternalSessionRole,
  ExternalUsage,
} from './external-metrics.js';

export const EXTERNAL_MANIFEST_SCHEMA_VERSION = 1;
export const EXTERNAL_REPORT_SCHEMA_VERSION = 1;

export type ExternalSuite = 'swe-marathon' | 'featurebench';
export type ExternalArm = 'a' | 'b';
export type VerificationStatus = 'verified' | 'unverified';

export interface ExternalTaskArtifact {
  taskId: string;
  key: string;
  /** Portable path relative to the external run directory. */
  nativeRoot: string;
}

export interface ExternalRunManifest {
  schemaVersion: 1;
  kind: 'ultracode-external-run';
  runId: string;
  suite: ExternalSuite;
  createdAt: string;
  requested: {
    model: string;
    effort: string;
    arm: ExternalArm;
    taskIds: string[];
  };
  suitePins: Record<string, string>;
  /** Effective executable, adapter, and task-container inputs. */
  provenance: Record<string, string>;
  artifacts: {
    root: 'native';
    tasks: ExternalTaskArtifact[];
  };
}

export interface ExternalTaskScore {
  taskId: string;
  verification: VerificationStatus;
  /** Null means the native verifier did not produce an attributable score. */
  score: number | null;
  /** Null is unverified, distinct from a verified unresolved result. */
  resolved: boolean | null;
  /** Portable path relative to the external run directory. */
  source: string | null;
}

export interface ExternalSuiteScore {
  verification: VerificationStatus;
  metric: 'mean_reward' | 'resolved_rate';
  score: number | null;
  verifiedTasks: number;
  requestedTasks: number;
  tasks: ExternalTaskScore[];
}

export interface ExternalReportSession extends Omit<ExternalSessionMetrics, 'file'> {
  /** Portable path relative to the external run directory. */
  file: string;
}

export interface ExternalReport {
  schemaVersion: 1;
  kind: 'ultracode-external-report';
  generatedAt: string;
  run: {
    runId: string;
    suite: ExternalSuite;
    arm: ExternalArm;
    model: string;
    taskIds: string[];
    suitePins: Record<string, string>;
  };
  reasoningEffort: {
    requested: string;
    effective: {
      verification: VerificationStatus;
      values: Record<string, number>;
      unknownSessions: number;
      matchesRequested: boolean | null;
    };
  };
  sessions: {
    total: number;
    host: number;
    worker: number;
    unknown: number;
    items: ExternalReportSession[];
  };
  tokens: ExternalUsage;
  context: {
    peak: number;
    windows: number[];
    compactionEvents: number;
    inferredPromptResets: number;
  };
  suiteScore: ExternalSuiteScore;
}

export type ExternalCliArgs =
  | { command: 'help' }
  | { command: 'prep'; suite: ExternalSuite }
  | {
    command: 'run';
    suite: ExternalSuite;
    runId: string;
    model: string;
    effort: string;
    arm: ExternalArm;
    taskIds: string[];
  }
  | { command: 'report'; suite: ExternalSuite; runId: string };

interface ExternalRunInputs {
  suite: ExternalSuite;
  runId: string;
  model: string;
  effort: string;
  arm: ExternalArm;
  taskIds: string[];
}

const EFFORT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SINGLE_VALUE_FLAGS = new Set(['suite', 'run-id', 'model', 'effort', 'arm']);
const COMMAND_FLAGS: Record<'prep' | 'run' | 'report', Set<string>> = {
  prep: new Set(['suite']),
  run: new Set(['suite', 'run-id', 'model', 'effort', 'arm', 'task-id', 'task-ids']),
  report: new Set(['suite', 'run-id']),
};

const out = (message: string): void => void process.stdout.write(`${message}\n`);
const EXTERNAL_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));

/** Fail closed on unknown suite names before importing an adapter. */
export function validateExternalSuite(value: string): ExternalSuite {
  if (value !== 'swe-marathon' && value !== 'featurebench') {
    throw new Error(`--suite must be 'swe-marathon' or 'featurebench', got '${value}'`);
  }
  return value;
}

function validateArm(value: string): ExternalArm {
  if (value !== 'a' && value !== 'b') throw new Error(`--arm must be 'a' or 'b', got '${value}'`);
  return value;
}

function validateModel(value: string): string {
  if (!value || value.trim() !== value || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new Error('--model must be an explicit non-empty single-line value');
  }
  return value;
}

function validateEffort(value: string): string {
  if (!EFFORT_RE.test(value)) {
    throw new Error('--effort must be an explicit portable reasoning-effort name');
  }
  return value;
}

export { validateFeatureBenchTaskId } from './external-common.js';

function parseFlags(args: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--') || token === '--') {
      throw new Error(`unexpected positional argument '${token}'`);
    }
    const equals = token.indexOf('=');
    const name = token.slice(2, equals < 0 ? undefined : equals);
    if (!name) throw new Error(`invalid option '${token}'`);
    const value = equals < 0 ? args[index + 1] : token.slice(equals + 1);
    if (value === undefined || (equals < 0 && value.startsWith('--'))) {
      throw new Error(`--${name} requires a value`);
    }
    if (equals < 0) index += 1;
    const values = flags.get(name) ?? [];
    values.push(value);
    flags.set(name, values);
  }
  return flags;
}

function singleton(flags: Map<string, string[]>, name: string): string {
  const values = flags.get(name) ?? [];
  if (values.length === 0 || values[0] === '') throw new Error(`--${name} is required`);
  if (values.length > 1) throw new Error(`--${name} may be provided only once`);
  return values[0]!;
}

function rejectUnknownFlags(command: 'prep' | 'run' | 'report', flags: Map<string, string[]>): void {
  const supported = COMMAND_FLAGS[command];
  for (const [name, values] of flags) {
    if (!supported.has(name)) throw new Error(`unknown option --${name} for ${command}`);
    if (SINGLE_VALUE_FLAGS.has(name) && values.length > 1) {
      throw new Error(`--${name} may be provided only once`);
    }
  }
}

/** Parse the dependency-free external CLI grammar without starting a process. */
export function parseExternalCliArgs(argv: string[]): ExternalCliArgs {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    return { command: 'help' };
  }
  const command = argv[0];
  if (command !== 'prep' && command !== 'run' && command !== 'report') {
    throw new Error(`unknown command '${command ?? ''}': expected prep, run, or report`);
  }
  if (argv.includes('--help') || argv.includes('-h')) return { command: 'help' };
  const flags = parseFlags(argv.slice(1));
  rejectUnknownFlags(command, flags);
  const suite = validateExternalSuite(singleton(flags, 'suite'));
  if (command === 'prep') return { command, suite };

  const runId = validateRunId(singleton(flags, 'run-id'));
  if (command === 'report') return { command, suite, runId };

  const taskIds = [
    ...(flags.get('task-id') ?? []),
    ...(flags.get('task-ids') ?? []).flatMap((value) => value.split(',')),
  ];
  if (taskIds.length === 0) throw new Error('--task-id is required and may be repeated');
  if (taskIds.some((taskId) => taskId.length === 0)) throw new Error('task IDs must be non-empty');
  if (new Set(taskIds).size !== taskIds.length) throw new Error('task IDs must not be duplicated');
  if (suite === 'featurebench') {
    for (const taskId of taskIds) validateFeatureBenchTaskId(taskId);
  } else {
    for (const taskId of taskIds) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(taskId)) {
        throw new Error(`unsafe SWE-Marathon task name '${taskId}'`);
      }
    }
  }
  return {
    command,
    suite,
    runId,
    model: validateModel(singleton(flags, 'model')),
    effort: validateEffort(singleton(flags, 'effort')),
    arm: validateArm(singleton(flags, 'arm')),
    taskIds,
  };
}

function externalSuiteDir(suite: ExternalSuite, root = resultsDir()): string {
  return joinWithinRoot(root, 'external', validateExternalSuite(suite));
}

function externalRunDir(runId: string, suite: ExternalSuite, root = resultsDir()): string {
  return joinWithinRoot(externalSuiteDir(suite, root), validateRunId(runId));
}

function requireRealDirectory(path: string, description: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${description} must be a real directory: ${path}`);
  }
}

function ensurePrivateParent(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  requireRealDirectory(path, 'external results root');
  chmodSync(path, 0o700);
}

function ensureExternalSuiteDir(suite: ExternalSuite, root: string): string {
  const resolvedRoot = resolve(root);
  ensurePrivateParent(resolvedRoot);
  const external = joinWithinRoot(resolvedRoot, 'external');
  if (!existsSync(external)) mkdirSync(external, { mode: 0o700 });
  requireRealDirectory(external, 'external results namespace');
  chmodSync(external, 0o700);
  const suiteDirectory = joinWithinRoot(external, suite);
  if (!existsSync(suiteDirectory)) mkdirSync(suiteDirectory, { mode: 0o700 });
  requireRealDirectory(suiteDirectory, 'external suite results root');
  chmodSync(suiteDirectory, 0o700);
  return suiteDirectory;
}

function requireExternalSuiteDir(suite: ExternalSuite, root: string): string {
  const resolvedRoot = resolve(root);
  requireRealDirectory(resolvedRoot, 'results root');
  const external = joinWithinRoot(resolvedRoot, 'external');
  requireRealDirectory(external, 'external results namespace');
  const suiteDirectory = joinWithinRoot(external, suite);
  requireRealDirectory(suiteDirectory, 'external suite results root');
  return suiteDirectory;
}

function taskArtifacts(suite: ExternalSuite, taskIds: readonly string[]): ExternalTaskArtifact[] {
  return taskIds.map((taskId) => {
    const key = artifactKey(taskId);
    return {
      taskId,
      key,
      nativeRoot: suite === 'swe-marathon' ? `native/${key}` : 'native',
    };
  });
}

function createExternalManifest(
  inputs: ExternalRunInputs,
  suitePins: Record<string, string>,
  provenance: Record<string, string>,
  root = resultsDir(),
): { manifest: ExternalRunManifest; directory: string } {
  const suiteDirectory = ensureExternalSuiteDir(inputs.suite, root);
  const directory = externalRunDir(inputs.runId, inputs.suite, root);
  if (existsSync(directory)) {
    const existing = loadExternalManifest(inputs.runId, inputs.suite, root);
    const exact = JSON.stringify(existing.manifest.requested) === JSON.stringify({
      model: inputs.model,
      effort: inputs.effort,
      arm: inputs.arm,
      taskIds: inputs.taskIds,
    })
      && JSON.stringify(existing.manifest.suitePins) === JSON.stringify(suitePins)
      && JSON.stringify(existing.manifest.provenance) === JSON.stringify(provenance);
    if (!exact) throw new Error(`run ${inputs.runId} exists with a different immutable manifest`);
    return existing;
  }
  const manifest: ExternalRunManifest = {
    schemaVersion: EXTERNAL_MANIFEST_SCHEMA_VERSION,
    kind: 'ultracode-external-run',
    runId: inputs.runId,
    suite: inputs.suite,
    createdAt: new Date().toISOString(),
    requested: {
      model: inputs.model,
      effort: inputs.effort,
      arm: inputs.arm,
      taskIds: [...inputs.taskIds],
    },
    suitePins: { ...suitePins },
    provenance: { ...provenance },
    artifacts: {
      root: 'native',
      tasks: taskArtifacts(inputs.suite, inputs.taskIds),
    },
  };
  const staging = mkdtempSync(join(suiteDirectory, '.external-run-'));
  chmodSync(staging, 0o700);
  try {
    const file = joinWithinRoot(staging, 'external-run.json');
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    chmodSync(file, 0o600);
    renameSync(staging, directory);
    return { manifest, directory };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** Load and validate the manifest before any of its values influence paths. */
export function loadExternalManifest(
  runId: string,
  suite: ExternalSuite,
  root = resultsDir(),
): { manifest: ExternalRunManifest; directory: string } {
  requireExternalSuiteDir(suite, root);
  const directory = externalRunDir(runId, suite, root);
  requireRealDirectory(directory, 'external run directory');
  const file = joinWithinRoot(directory, 'external-run.json');
  const fileInfo = lstatSync(file);
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new Error(`external run manifest must be a regular file: ${file}`);
  }
  const parsed = readJson(file);
  if (!isRecord(parsed)) throw new Error('external-run.json must contain an object');
  if (parsed.schemaVersion !== 1 || parsed.kind !== 'ultracode-external-run') {
    throw new Error('unsupported external-run.json schema');
  }
  if (parsed.runId !== runId) throw new Error('external-run.json run id does not match its directory');
  if (parsed.suite !== suite) throw new Error(`run ${runId} belongs to suite ${String(parsed.suite)}, not ${suite}`);
  if (!isRecord(parsed.requested)) {
    throw new Error('external-run.json requested inputs are invalid');
  }
  const requested = parsed.requested;
  const rawTaskIds = requested.taskIds;
  if (!Array.isArray(rawTaskIds) || !rawTaskIds.every((taskId): taskId is string => typeof taskId === 'string')) {
    throw new Error('external-run.json task IDs are invalid');
  }
  const taskIds: string[] = rawTaskIds;
  const inputs: ExternalRunInputs = {
    suite,
    runId,
    model: validateModel(typeof requested.model === 'string' ? requested.model : ''),
    effort: validateEffort(typeof requested.effort === 'string' ? requested.effort : ''),
    arm: validateArm(typeof requested.arm === 'string' ? requested.arm : ''),
    taskIds,
  };
  if (taskIds.length === 0 || new Set(taskIds).size !== taskIds.length) {
    throw new Error('external-run.json task IDs are empty or duplicated');
  }
  if (!isRecord(parsed.suitePins)) throw new Error('external-run.json suite pins are invalid');
  const suitePins: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.suitePins)) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('external-run.json suite pins are invalid');
    suitePins[name] = value;
  }
  if (!isRecord(parsed.provenance)) throw new Error('external-run.json provenance is invalid');
  const provenance: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.provenance)) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('external-run.json provenance is invalid');
    provenance[name] = value;
  }
  if (!isRecord(parsed.artifacts) || parsed.artifacts.root !== 'native') {
    throw new Error('external-run.json artifact root is invalid');
  }
  const expectedTasks = taskArtifacts(suite, taskIds);
  if (JSON.stringify(parsed.artifacts.tasks) !== JSON.stringify(expectedTasks)) {
    throw new Error('external-run.json task artifacts are invalid');
  }
  return {
    directory,
    manifest: {
      schemaVersion: 1,
      kind: 'ultracode-external-run',
      runId,
      suite,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      requested: {
        model: inputs.model,
        effort: inputs.effort,
        arm: inputs.arm,
        taskIds: inputs.taskIds,
      },
      suitePins,
      provenance,
      artifacts: { root: 'native', tasks: expectedTasks },
    },
  };
}

async function suitePins(suite: ExternalSuite): Promise<Record<string, string>> {
  if (suite === 'swe-marathon') {
    const adapter = await import('./marathon.js');
    return {
      repository: adapter.SWE_MARATHON_REPO,
      sourceRevision: adapter.SWE_MARATHON_PIN,
      python: adapter.SWE_MARATHON_PYTHON,
      harbor: adapter.SWE_MARATHON_HARBOR,
    };
  }
  const adapter = await import('./featurebench.js');
  return {
    repository: adapter.FEATUREBENCH_REPOSITORY,
    sourceRevision: adapter.FEATUREBENCH_SOURCE_REVISION,
    dataset: adapter.FEATUREBENCH_DATASET,
    datasetRevision: adapter.FEATUREBENCH_DATASET_REVISION,
    split: adapter.FEATUREBENCH_SPLIT,
    python: adapter.FEATUREBENCH_PYTHON,
  };
}

async function validateTaskIds(suite: ExternalSuite, taskIds: readonly string[]): Promise<void> {
  if (suite === 'swe-marathon') {
    const { validateMarathonTaskName } = await import('./marathon.js');
    for (const taskId of taskIds) validateMarathonTaskName(taskId);
    return;
  }
  for (const taskId of taskIds) validateFeatureBenchTaskId(taskId);
}

async function prepareExternalSuite(suite: ExternalSuite): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`external container adapters require a Linux x64 host, got ${process.platform}-${process.arch}`);
  }
  if (suite === 'swe-marathon') {
    const { prepareMarathon } = await import('./marathon.js');
    await prepareMarathon();
    return;
  }
  const [{ prepareFeatureBench }, { prepareToolchain }] = await Promise.all([
    import('./featurebench.js'),
    import('./toolchain.js'),
  ]);
  await prepareToolchain(loadConfig());
  await prepareFeatureBench({ sourceDir: join(BENCH_ROOT, '.cache/featurebench') });
}

function toolchainProvenance(): Record<string, string> {
  const root = toolchainDir();
  const manifestPath = join(root, 'manifest.json');
  const manifest = readJson(manifestPath);
  if (!isRecord(manifest)) throw new Error(`invalid toolchain manifest: ${manifestPath}`);
  const codex = join(root, 'codex');
  const codexSha256 = sha256File(codex);
  if (manifest.codexSha256 !== codexSha256) throw new Error('prepared Codex binary has drifted from its toolchain manifest');
  for (const name of ['codexVersion', 'ultracodeVersion', 'nodeVersion']) {
    if (typeof manifest[name] !== 'string' || manifest[name].length === 0) {
      throw new Error(`toolchain manifest is missing ${name}`);
    }
  }
  return {
    hostPlatform: `${process.platform}-${process.arch}`,
    hostNodeVersion: process.version,
    hostNodeSha256: sha256File(process.execPath),
    codexVersion: String(manifest.codexVersion),
    codexSha256,
    ultracodeVersion: String(manifest.ultracodeVersion),
    ultracodeSourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolve(BENCH_ROOT, '..'),
      encoding: 'utf8',
    }).trim(),
    ultracodeSha256: sha256Tree(join(root, 'ultracode')),
    containerNodeVersion: String(manifest.nodeVersion),
    containerNodeSha256: sha256File(join(root, 'node/bin/node')),
    nodeSelectorSha256: sha256File(join(root, 'node-sel')),
    toolchainSha256: sha256Tree(root),
    externalCliSha256: sha256File(join(EXTERNAL_SOURCE_DIR, 'external-cli.ts')),
    externalCommonSha256: sha256File(join(EXTERNAL_SOURCE_DIR, 'external-common.ts')),
    externalMetricsSha256: sha256File(join(EXTERNAL_SOURCE_DIR, 'external-metrics.ts')),
  };
}

/** Hash every tracked TypeScript module that defines FeatureBench adapter policy. */
export function featureBenchSourceProvenance(): Record<string, string> {
  return {
    featureBenchAdapterSha256: sha256File(join(EXTERNAL_SOURCE_DIR, 'featurebench.ts')),
    featureBenchHostPolicySha256: sha256File(join(EXTERNAL_SOURCE_DIR, 'featurebench-host.ts')),
  };
}

interface ExternalPreflight {
  pins: Record<string, string>;
  provenance: Record<string, string>;
}

export type MarathonAuthMechanism = 'codex-auth-json' | 'openai-api-key';

export interface MarathonRuntimeEnvironment {
  authMechanism: MarathonAuthMechanism;
  /** Null for Arm A, which has no workflow wait setting. */
  workflowWaitSeconds: number | null;
  /** Minimal environment passed through Marathon's explicit child-env seam. */
  childEnvironment: NodeJS.ProcessEnv;
}

/**
 * Select one secret-bearing Marathon environment without serializing it. Auth
 * file paths are resolved through the filesystem once, before Harbor sees them.
 */
export function marathonRuntimeEnvironment(
  source: NodeJS.ProcessEnv,
  arm: ExternalArm,
): MarathonRuntimeEnvironment {
  const hasAuthPath = source.CODEX_AUTH_JSON_PATH !== undefined;
  const hasApiKey = source.OPENAI_API_KEY !== undefined;
  if (hasAuthPath === hasApiKey) {
    throw new Error('SWE-Marathon requires exactly one auth mechanism: CODEX_AUTH_JSON_PATH or OPENAI_API_KEY');
  }
  const authMechanism: MarathonAuthMechanism = hasAuthPath ? 'codex-auth-json' : 'openai-api-key';
  const authName = hasAuthPath ? 'CODEX_AUTH_JSON_PATH' : 'OPENAI_API_KEY';
  const authValue = source[authName];
  if (authValue === undefined || authValue.length === 0 || authValue.includes('\0')) {
    throw new Error(`${authName} must be a non-empty value`);
  }
  const childEnvironment = allowlistedEnvironment(source, [authName]);
  if (hasAuthPath) {
    const resolvedPath = resolve(authValue);
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync.native(resolvedPath);
    } catch (error) {
      throw new Error(`CODEX_AUTH_JSON_PATH must resolve to a regular file: ${resolvedPath}`, { cause: error });
    }
    const info = lstatSync(canonicalPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`CODEX_AUTH_JSON_PATH must resolve to a regular file: ${canonicalPath}`);
    }
    childEnvironment.CODEX_AUTH_JSON_PATH = canonicalPath;
  }
  let workflowWaitSeconds: number | null = null;
  if (arm === 'b') {
    workflowWaitSeconds = Number(source.SWE_MARATHON_WORKFLOW_WAIT_SECONDS ?? 3_300);
    if (!Number.isSafeInteger(workflowWaitSeconds) || workflowWaitSeconds < 1) {
      throw new Error('SWE_MARATHON_WORKFLOW_WAIT_SECONDS must be a positive integer');
    }
  }
  return { authMechanism, workflowWaitSeconds, childEnvironment };
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function preflightExternalRun(inputs: ExternalRunInputs): Promise<ExternalPreflight> {
  await validateTaskIds(inputs.suite, inputs.taskIds);
  const pins = await suitePins(inputs.suite);
  const provenance = toolchainProvenance();
  const nativeRoot = joinWithinRoot(externalRunDir(inputs.runId, inputs.suite), 'native');
  if (inputs.suite === 'featurebench') {
    const { FEATUREBENCH_PATCH, preflightFeatureBench } = await import('./featurebench.js');
    const credentialBrokerUrl = process.env.FEATUREBENCH_CREDENTIAL_BROKER_URL ?? '';
    const restrictedNetwork = process.env.FEATUREBENCH_RESTRICTED_NETWORK ?? '';
    const featureBench = await preflightFeatureBench({
      sourceDir: join(BENCH_ROOT, '.cache/featurebench'),
      outputDir: nativeRoot,
      codexBin: join(toolchainDir(), 'codex'),
      credentialBrokerUrl,
      restrictedNetwork,
      toolchainDir: inputs.arm === 'b' ? toolchainDir() : undefined,
      arm: inputs.arm,
      runOwner: inputs.runId,
      taskIds: inputs.taskIds,
      model: inputs.model,
      effort: inputs.effort,
    });
    provenance.featureBenchPatchSha256 = sha256File(FEATUREBENCH_PATCH);
    Object.assign(provenance, featureBenchSourceProvenance());
    provenance.featureBenchRunnerSha256 = sha256File(join(BENCH_ROOT, '.cache/featurebench/.venv/bin/fb'));
    provenance.featureBenchPythonSha256 = sha256File(join(BENCH_ROOT, '.cache/featurebench/.venv/bin/python'));
    provenance.featureBenchEnvironmentSha256 = sha256Tree(
      join(BENCH_ROOT, '.cache/featurebench/.venv'),
      { excludePythonCacheArtifacts: true },
    );
    provenance.featureBenchDatasetMapSha256 = featureBench.datasetMapSha256;
    provenance.featureBenchPromptAdapterSha256 = sha256File(join(EXTERNAL_SOURCE_DIR, 'prompt.ts'));
    provenance.featureBenchArmBPrefixSha256 = sha256Text(ARM_B_PREFIX);
    provenance.featureBenchPromptMode = inputs.arm === 'b' ? 'arm-b-prefix' : 'verbatim';
    provenance.credentialBrokerUrl = credentialBrokerUrl;
    provenance.credentialBrokerRuntimeSha256 = featureBench.brokerRuntimeSha256;
    provenance.restrictedNetwork = restrictedNetwork;
    for (const taskId of inputs.taskIds) {
      provenance[`taskImage.${artifactKey(taskId)}`] = featureBench.imageDigests[taskId]!;
    }
  } else {
    const { preflightMarathon } = await import('./marathon.js');
    const runtime = marathonRuntimeEnvironment(process.env, inputs.arm);
    provenance.marathonAuthMechanism = runtime.authMechanism;
    provenance.marathonWorkflowWaitSeconds = runtime.workflowWaitSeconds === null
      ? 'not-applicable'
      : String(runtime.workflowWaitSeconds);
    provenance.marathonEnvironmentSha256 = sha256Tree(
      join(BENCH_ROOT, '.cache/swe-marathon/.venv'),
      { excludePythonCacheArtifacts: true },
    );
    provenance.marathonAdapterSha256 = sha256File(join(EXTERNAL_SOURCE_DIR, 'marathon.ts'));
    for (const taskId of inputs.taskIds) {
      const task = await preflightMarathon({
        taskName: taskId,
        arm: inputs.arm,
        model: inputs.model,
        effort: inputs.effort,
        resultsDir: nativeRoot,
        jobName: artifactKey(taskId),
        workflowWaitSeconds: runtime.workflowWaitSeconds ?? undefined,
      }, runtime.childEnvironment);
      const key = artifactKey(taskId);
      provenance[`taskConfig.${key}`] = task.taskConfigSha256;
      provenance[`taskImage.${key}`] = task.taskImage;
      if (task.bridgeSha256 !== null) provenance.marathonBridgeSha256 = task.bridgeSha256;
      if (task.skillSha256 !== null) provenance.marathonSkillSha256 = task.skillSha256;
      provenance.pythonVersion = task.pythonVersion;
      provenance.pythonSha256 = task.pythonSha256;
      provenance.harborVersion = task.harborVersion;
      provenance.harborSha256 = task.harborSha256;
    }
  }
  return { pins, provenance };
}

async function assertExternalProvenance(
  inputs: ExternalRunInputs,
  expected: Record<string, string>,
): Promise<void> {
  const actual = (await preflightExternalRun(inputs)).provenance;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('external benchmark inputs drifted after manifest creation; refusing launch');
  }
}

interface NativeReceiptEntry {
  taskId: string;
  key: string;
  verifierResult: string;
  verifierSha256: string;
}

interface NativeReceipt {
  schemaVersion: 1;
  kind: 'ultracode-external-native-receipt';
  suite: ExternalSuite;
  tasks: NativeReceiptEntry[];
}

function receiptPath(directory: string): string {
  return joinWithinRoot(directory, 'native-receipt.json');
}

function exactVerifierResult(
  manifest: ExternalRunManifest,
  directory: string,
  task: ExternalTaskArtifact,
  verifierResult: string,
): string {
  const absolute = resolveRegularFileWithinRoot(
    directory,
    verifierResult,
    'native receipt verifier result',
  );
  if (relativeArtifact(directory, absolute) !== verifierResult) {
    throw new Error('native receipt verifier path must be canonical');
  }
  const relativeToNative = relative(joinWithinRoot(directory, task.nativeRoot), absolute).split(sep);
  const exactShape = manifest.suite === 'swe-marathon'
    ? relativeToNative.length === 2 && relativeToNative[1] === 'result.json'
    : relativeToNative.length === 5
      && relativeToNative[1] === 'eval_outputs'
      && relativeToNative[2] === task.taskId
      && relativeToNative[3] === 'attempt-1'
      && relativeToNative[4] === 'report.json';
  if (!exactShape) throw new Error(`native receipt verifier path is not an exact ${manifest.suite} result path`);
  return absolute;
}

function loadNativeReceipt(manifest: ExternalRunManifest, directory: string): NativeReceipt {
  const path = receiptPath(directory);
  if (!existsSync(path)) {
    return { schemaVersion: 1, kind: 'ultracode-external-native-receipt', suite: manifest.suite, tasks: [] };
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`native receipt must be a regular file: ${path}`);
  const parsed = readJson(path);
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.kind !== 'ultracode-external-native-receipt'
    || parsed.suite !== manifest.suite
    || !Array.isArray(parsed.tasks)) {
    throw new Error('native receipt schema is invalid');
  }
  const expected = new Map(manifest.artifacts.tasks.map((task) => [task.taskId, task]));
  const tasks: NativeReceiptEntry[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.tasks) {
    if (!isRecord(raw)
      || typeof raw.taskId !== 'string'
      || typeof raw.key !== 'string'
      || typeof raw.verifierResult !== 'string'
      || typeof raw.verifierSha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(raw.verifierSha256)) {
      throw new Error('native receipt task entry is invalid');
    }
    const task = expected.get(raw.taskId);
    if (task === undefined || raw.key !== task.key || seen.has(raw.taskId)) {
      throw new Error('native receipt has an unexpected or duplicate task');
    }
    const absolute = exactVerifierResult(manifest, directory, task, raw.verifierResult);
    if (sha256File(absolute) !== raw.verifierSha256) {
      throw new Error(`native receipt verifier content hash mismatch for task ${raw.taskId}`);
    }
    seen.add(raw.taskId);
    tasks.push({
      taskId: raw.taskId,
      key: raw.key,
      verifierResult: raw.verifierResult,
      verifierSha256: raw.verifierSha256,
    });
  }
  return { schemaVersion: 1, kind: 'ultracode-external-native-receipt', suite: manifest.suite, tasks };
}

function replaceNativeReceipt(directory: string, receipt: NativeReceipt): void {
  replacePrivateFile(receiptPath(directory), `${JSON.stringify(receipt, null, 2)}\n`);
}

function updateNativeReceipt(
  manifest: ExternalRunManifest,
  directory: string,
  taskId: string,
  verifierResult: string,
): void {
  const task = manifest.artifacts.tasks.find((candidate) => candidate.taskId === taskId);
  if (task === undefined) throw new Error(`runner returned an unexpected task result: ${taskId}`);
  const receipt = loadNativeReceipt(manifest, directory);
  const portable = relativeArtifact(directory, verifierResult);
  const absolute = exactVerifierResult(manifest, directory, task, portable);
  const score = manifest.suite === 'swe-marathon'
    ? marathonTaskScore(task, absolute, directory)
    : featureBenchTaskScore(task, absolute, directory);
  if (score.verification !== 'verified' || score.score === null) {
    throw new Error(`task ${taskId} did not produce a valid suite-native verifier score`);
  }
  const verifierSha256 = sha256File(absolute);
  const existing = receipt.tasks.find((entry) => entry.taskId === taskId);
  if (existing !== undefined
    && (existing.verifierResult !== portable || existing.verifierSha256 !== verifierSha256)) {
    throw new Error(`task ${taskId} produced conflicting native verifier results`);
  }
  if (existing === undefined) {
    receipt.tasks.push({ taskId, key: task.key, verifierResult: portable, verifierSha256 });
  }
  receipt.tasks.sort((left, right) => left.taskId.localeCompare(right.taskId));
  replaceNativeReceipt(directory, receipt);
}

function currentlyVerifiedReceiptTasks(
  manifest: ExternalRunManifest,
  directory: string,
  receipt: NativeReceipt,
): NativeReceiptEntry[] {
  const tasks = new Map(manifest.artifacts.tasks.map((task) => [task.taskId, task]));
  return receipt.tasks.filter((entry) => {
    const task = tasks.get(entry.taskId)!;
    const file = joinWithinRoot(directory, entry.verifierResult);
    const score = manifest.suite === 'swe-marathon'
      ? marathonTaskScore(task, file, directory)
      : featureBenchTaskScore(task, file, directory);
    return score.verification === 'verified' && score.score !== null;
  });
}

async function executeExternalRun(inputs: ExternalRunInputs): Promise<string> {
  const preflight = await preflightExternalRun(inputs);
  const { manifest, directory } = createExternalManifest(inputs, preflight.pins, preflight.provenance);
  const nativeRoot = joinWithinRoot(directory, manifest.artifacts.root);
  const receipt = loadNativeReceipt(manifest, directory);
  const verifiedReceiptTasks = currentlyVerifiedReceiptTasks(manifest, directory, receipt);
  if (verifiedReceiptTasks.length !== receipt.tasks.length) {
    replaceNativeReceipt(directory, { ...receipt, tasks: verifiedReceiptTasks });
  }
  const completedTasks = new Set(verifiedReceiptTasks.map((task) => task.taskId));

  if (inputs.suite === 'swe-marathon') {
    const { runMarathon } = await import('./marathon.js');
    const runtime = marathonRuntimeEnvironment(process.env, inputs.arm);
    for (const task of manifest.artifacts.tasks) {
      if (completedTasks.has(task.taskId)) continue;
      const result = await runMarathon({
        taskName: task.taskId,
        arm: inputs.arm,
        model: inputs.model,
        effort: inputs.effort,
        resultsDir: nativeRoot,
        jobName: task.key,
        workflowWaitSeconds: runtime.workflowWaitSeconds ?? undefined,
      }, runtime.childEnvironment, async () => assertExternalProvenance(inputs, manifest.provenance));
      updateNativeReceipt(manifest, directory, task.taskId, result.verifierResultPath);
    }
  } else {
    if (completedTasks.size === manifest.artifacts.tasks.length) return directory;
    const { runFeatureBench } = await import('./featurebench.js');
    const pendingTaskIds = inputs.taskIds.filter((taskId) => !completedTasks.has(taskId));
    const result = await runFeatureBench({
      sourceDir: join(BENCH_ROOT, '.cache/featurebench'),
      outputDir: nativeRoot,
      codexBin: join(toolchainDir(), 'codex'),
      credentialBrokerUrl: process.env.FEATUREBENCH_CREDENTIAL_BROKER_URL ?? '',
      restrictedNetwork: process.env.FEATUREBENCH_RESTRICTED_NETWORK ?? '',
      toolchainDir: inputs.arm === 'b' ? toolchainDir() : undefined,
      arm: inputs.arm,
      taskIds: pendingTaskIds,
      model: inputs.model,
      effort: inputs.effort,
      evaluate: true,
      runOwner: inputs.runId,
    }, undefined, async () => assertExternalProvenance(inputs, manifest.provenance));
    for (const [taskId, report] of Object.entries(result.verifierReports)) {
      updateNativeReceipt(manifest, directory, taskId, report);
    }
  }
  return directory;
}

function walkFiles(root: string, wanted: (name: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && wanted(entry.name)) files.push(path);
    }
  };
  walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function discoverHostSessionIds(nativeRoot: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const file of walkFiles(nativeRoot, (name) => name === 'arm_b_metrics.json')) {
    try {
      const metrics = readJson(file);
      if (isRecord(metrics) && typeof metrics.host_session_id === 'string') ids.add(metrics.host_session_id);
    } catch {
      // An incomplete adapter artifact cannot establish a host id.
    }
  }
  for (const file of walkFiles(nativeRoot, (name) => name === 'codex_events.jsonl')) {
    for await (const record of readJsonLines(file)) {
      if (!isRecord(record) || record.type !== 'thread.started') continue;
      if (typeof record.thread_id === 'string') ids.add(record.thread_id);
    }
  }
  return ids;
}

function relativeArtifact(runDirectory: string, path: string): string {
  const value = relative(runDirectory, path);
  if (value === '..' || value.startsWith(`..${sep}`) || value.startsWith('/')) {
    throw new Error(`artifact path escapes external run: ${path}`);
  }
  return value.split(sep).join('/');
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function marathonTaskScore(task: ExternalTaskArtifact, file: string, runDirectory: string): ExternalTaskScore {
  try {
    const result = readJson(file);
    const trialName = basename(dirname(file));
    if (!isRecord(result)
      || result.task_name !== task.taskId
      || result.trial_name !== trialName
      || !isRecord(result.verifier_result)
      || !isRecord(result.verifier_result.rewards)) {
      throw new Error('invalid Harbor trial result schema');
    }
    const reward = numeric(result.verifier_result.rewards.reward);
    if (reward === null || reward < 0 || reward > 1) {
      throw new Error('Harbor trial result has no bounded numeric reward');
    }
    const configPath = resolveRegularFileWithinRoot(
      runDirectory,
      relativeArtifact(runDirectory, join(dirname(file), 'config.json')),
      'Harbor trial config',
    );
    const config = readJson(configPath);
    if (!isRecord(config)
      || config.trial_name !== trialName
      || !isRecord(config.task)
      || config.task.path !== `tasks/${task.taskId}`) {
      throw new Error('Harbor trial config identity mismatch');
    }
    return {
      taskId: task.taskId,
      verification: 'verified',
      score: reward,
      resolved: reward >= 1,
      source: relativeArtifact(runDirectory, file),
    };
  } catch {
    return { taskId: task.taskId, verification: 'unverified', score: null, resolved: null, source: null };
  }
}

function featureBenchTaskScore(task: ExternalTaskArtifact, file: string, runDirectory: string): ExternalTaskScore {
  try {
    const result = readJson(file);
    if (!isRecord(result) || Object.keys(result).length !== 1 || !Object.hasOwn(result, task.taskId)) {
      throw new Error('FeatureBench report identity mismatch');
    }
    const taskReport = result[task.taskId];
    if (!isRecord(taskReport)
      || taskReport.n_attempt !== 1
      || typeof taskReport.resolved !== 'boolean'
      || taskReport.featurebench_eval_completed !== true) {
      throw new Error('FeatureBench report completion or resolution marker is missing');
    }
    const passRate = numeric(taskReport.pass_rate);
    if (passRate === null || passRate < 0 || passRate > 1) {
      throw new Error('FeatureBench report has no bounded pass_rate');
    }
    return {
      taskId: task.taskId,
      verification: 'verified',
      score: taskReport.resolved ? 1 : 0,
      resolved: taskReport.resolved,
      source: relativeArtifact(runDirectory, file),
    };
  } catch {
    return { taskId: task.taskId, verification: 'unverified', score: null, resolved: null, source: null };
  }
}

function collectSuiteScore(manifest: ExternalRunManifest, runDirectory: string): ExternalSuiteScore {
  const receipt = loadNativeReceipt(manifest, runDirectory);
  const receipts = new Map(receipt.tasks.map((task) => [task.taskId, task]));
  const tasks = manifest.artifacts.tasks.map((task) => {
    const entry = receipts.get(task.taskId);
    if (entry === undefined) {
      return { taskId: task.taskId, verification: 'unverified' as const, score: null, resolved: null, source: null };
    }
    const file = joinWithinRoot(runDirectory, entry.verifierResult);
    return manifest.suite === 'swe-marathon'
      ? marathonTaskScore(task, file, runDirectory)
      : featureBenchTaskScore(task, file, runDirectory);
  });
  const verified = tasks.filter((task) => task.verification === 'verified' && task.score !== null);
  const complete = verified.length === tasks.length;
  return {
    verification: complete ? 'verified' : 'unverified',
    metric: manifest.suite === 'swe-marathon' ? 'mean_reward' : 'resolved_rate',
    score: complete && verified.length > 0
      ? verified.reduce((sum, task) => sum + task.score!, 0) / verified.length
      : null,
    verifiedTasks: verified.length,
    requestedTasks: tasks.length,
    tasks,
  };
}

function effectiveEffort(sessions: readonly ExternalSessionMetrics[], requested: string): ExternalReport['reasoningEffort'] {
  const values: Record<string, number> = {};
  let unknownSessions = 0;
  for (const session of sessions) {
    if (session.effort === null) unknownSessions += 1;
    else values[session.effort] = (values[session.effort] ?? 0) + 1;
  }
  const effectiveValues = Object.keys(values);
  const verified = sessions.length > 0 && unknownSessions === 0;
  return {
    requested,
    effective: {
      verification: verified ? 'verified' : 'unverified',
      values,
      unknownSessions,
      matchesRequested: verified ? effectiveValues.every((value) => value === requested) : null,
    },
  };
}

function countRole(sessions: readonly ExternalSessionMetrics[], role: ExternalSessionRole): number {
  return sessions.filter((session) => session.role === role).length;
}

function buildExternalReport(
  manifest: ExternalRunManifest,
  metrics: ExternalMetrics,
  score: ExternalSuiteScore,
  runDirectory: string,
): ExternalReport {
  const windows = [...new Set(metrics.sessions
    .map((session) => session.contextWindow)
    .filter((window): window is number => window !== null))].sort((left, right) => left - right);
  return {
    schemaVersion: EXTERNAL_REPORT_SCHEMA_VERSION,
    kind: 'ultracode-external-report',
    generatedAt: new Date().toISOString(),
    run: {
      runId: manifest.runId,
      suite: manifest.suite,
      arm: manifest.requested.arm,
      model: manifest.requested.model,
      taskIds: [...manifest.requested.taskIds],
      suitePins: { ...manifest.suitePins },
    },
    reasoningEffort: effectiveEffort(metrics.sessions, manifest.requested.effort),
    sessions: {
      total: metrics.sessions.length,
      host: countRole(metrics.sessions, 'host'),
      worker: countRole(metrics.sessions, 'worker'),
      unknown: metrics.sessions.filter((session) => session.role === null).length,
      items: metrics.sessions.map((session) => ({
        ...session,
        file: relativeArtifact(runDirectory, session.file),
      })),
    },
    tokens: metrics.totalUsage,
    context: {
      peak: metrics.contextPeak,
      windows,
      compactionEvents: metrics.compactionEvents,
      inferredPromptResets: metrics.inferredPromptResets,
    },
    suiteScore: score,
  };
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

/** Render a compact, auditable companion to report.json. */
export function renderExternalReportMarkdown(report: ExternalReport): string {
  const effort = report.reasoningEffort.effective;
  const effective = effort.verification === 'verified'
    ? Object.entries(effort.values).map(([name, count]) => `${name}×${count}`).join(', ')
    : `unverified (${effort.unknownSessions} unknown session${effort.unknownSessions === 1 ? '' : 's'})`;
  const score = report.suiteScore.verification === 'verified'
    ? `${report.suiteScore.metric} ${report.suiteScore.score}`
    : `unverified (${report.suiteScore.verifiedTasks}/${report.suiteScore.requestedTasks} task scores present)`;
  const lines = [
    `# External benchmark report: ${report.run.runId}`,
    '',
    `- suite: ${report.run.suite}`,
    `- arm: ${report.run.arm}`,
    `- model: ${report.run.model}`,
    `- reasoning effort: requested ${report.reasoningEffort.requested}; effective ${effective}`,
    `- sessions: ${report.sessions.total} total (${report.sessions.host} host, ${report.sessions.worker} worker, ${report.sessions.unknown} unknown)`,
    `- suite-native score: ${score}`,
    '',
    '## Usage and context',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Non-cached input tokens | ${formatInteger(report.tokens.input)} |`,
    `| Cached input tokens | ${formatInteger(report.tokens.cachedInput)} |`,
    `| Output tokens | ${formatInteger(report.tokens.output)} |`,
    `| Reasoning output tokens | ${formatInteger(report.tokens.reasoning)} |`,
    `| Discounted total tokens | ${formatInteger(report.tokens.total)} |`,
    `| Context peak | ${formatInteger(report.context.peak)} |`,
    `| Context window(s) | ${report.context.windows.length ? report.context.windows.map(formatInteger).join(', ') : 'unknown'} |`,
    `| Explicit compactions | ${formatInteger(report.context.compactionEvents)} |`,
    `| Inferred prompt resets | ${formatInteger(report.context.inferredPromptResets)} |`,
    '',
    '## Native verifier results',
    '',
    '| Task | Verification | Score | Resolved | Source |',
    '| --- | --- | ---: | --- | --- |',
    ...report.suiteScore.tasks.map((task) =>
      `| ${task.taskId} | ${task.verification} | ${task.score ?? '—'} | ${task.resolved === null ? '—' : task.resolved ? 'yes' : 'no'} | ${task.source ?? '—'} |`),
    '',
    '## Sessions',
    '',
    '| Session | Role | Effective effort | Tokens | Context peak | Compactions |',
    '| --- | --- | --- | ---: | ---: | ---: |',
    ...report.sessions.items.map((session) =>
      `| ${session.sessionId} | ${session.role ?? 'unknown'} | ${session.effort ?? 'unverified'} | ${formatInteger(session.usage.total)} | ${formatInteger(session.contextPeak)} | ${formatInteger(session.compactions)} |`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function replacePrivateFile(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Aggregate rollout telemetry and native verifier artifacts for one immutable run. */
export async function generateExternalReport(
  runId: string,
  suite: ExternalSuite,
  root = resultsDir(),
): Promise<{ report: ExternalReport; jsonPath: string; markdownPath: string }> {
  const { manifest, directory } = loadExternalManifest(runId, suite, root);
  const nativeRoot = joinWithinRoot(directory, manifest.artifacts.root);
  const hostSessionIds = await discoverHostSessionIds(nativeRoot);
  const metrics = await collectExternalMetrics(nativeRoot, hostSessionIds.size > 0
    ? { hostSessionIds }
    : manifest.requested.arm === 'a' ? { defaultRole: 'host' } : {});
  const score = collectSuiteScore(manifest, directory);
  const report = buildExternalReport(manifest, metrics, score, directory);
  const jsonPath = joinWithinRoot(directory, 'report.json');
  const markdownPath = joinWithinRoot(directory, 'report.md');
  replacePrivateFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  replacePrivateFile(markdownPath, renderExternalReportMarkdown(report));
  return { report, jsonPath, markdownPath };
}

export const EXTERNAL_USAGE = `Usage:
  npm run bench -- --suite <swe-marathon|featurebench> prep
  npm run bench -- --suite <swe-marathon|featurebench> run --run-id <id> --model <model> --effort <effort> --arm <a|b> --task-id <id> [--task-id <id> ...]
  npm run bench -- --suite <swe-marathon|featurebench> report --run-id <id>`;

/** Execute one parsed CLI command. */
export async function runExternalCli(argv: string[]): Promise<void> {
  const args = parseExternalCliArgs(argv);
  if (args.command === 'help') {
    out(EXTERNAL_USAGE);
    return;
  }
  if (args.command === 'prep') {
    await prepareExternalSuite(args.suite);
    out(`${args.suite} pinned preparation ready`);
    return;
  }
  if (args.command === 'run') {
    const directory = await executeExternalRun(args);
    out(`external run complete: ${directory}`);
    return;
  }
  const { jsonPath, markdownPath } = await generateExternalReport(args.runId, args.suite);
  out(`wrote ${jsonPath}`);
  out(`wrote ${markdownPath}`);
}
