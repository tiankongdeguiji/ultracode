/**
 * Reproducible FeatureBench runner for the Codex A/B experiment. The adapter
 * keeps host credentials and paths out of FeatureBench's persisted TOML while
 * pinning both upstream code and dataset content. Its planning and validation
 * functions are pure; preparation, run preflight, execution, and targeted
 * cleanup own the adapter's explicit disk, process, and container effects.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allowlistedEnvironment,
  runOwnedProcess,
  sha256File,
  validateFeatureBenchTaskId,
  validatePortableComponent,
} from './external-common.js';
import { requireFeatureBenchHost } from './featurebench-host.js';
import { ARM_B_PREFIX } from './prompt.js';

export const FEATUREBENCH_REPOSITORY = 'https://github.com/LiberCoders/FeatureBench.git';
export const FEATUREBENCH_SOURCE_REVISION = '445dcbaec0b2e136061b0acb54e753c0a9f1888e';
export const FEATUREBENCH_DATASET = 'LiberCoders/FeatureBench';
export const FEATUREBENCH_DATASET_REVISION = 'e99d6efdfe511ea832c1b5735c536129561ec96a';
export const FEATUREBENCH_SPLIT = 'fast';
export const FEATUREBENCH_PYTHON = '3.13.5';
export const FEATUREBENCH_PATCH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../external/featurebench/codex-chatgpt.patch',
);

export type FeatureBenchArm = 'a' | 'b';

export interface FeatureBenchRunOptions {
  /** Patched checkout produced by prepareFeatureBench(). */
  sourceDir: string;
  /** Private parent directory for FeatureBench's timestamped run directory. */
  outputDir: string;
  /** Host-pinned standalone Codex executable. Passed only in the child environment. */
  codexBin: string;
  /** OpenAI-compatible broker holding the credential outside the task container. */
  credentialBrokerUrl: string;
  /** Internal network containing only the broker before task containers attach. */
  restrictedNetwork: string;
  /** Arm B toolchain assembled by bench/src/toolchain.ts. */
  toolchainDir?: string;
  arm: FeatureBenchArm;
  taskIds: readonly string[];
  model: string;
  effort: string;
  concurrency?: number;
  evalConcurrency?: number;
  timeoutSecs?: number;
  cpus?: number;
  memoryGb?: number;
  /** These knobs exist only so unsupported expansion fails explicitly. */
  split?: string;
  attempts?: number;
  retries?: number;
  runtime?: 'cpu' | 'gpu';
  auth?: 'chatgpt' | 'api-key';
  /** Run upstream `fb eval` after inference. Defaults to true. */
  evaluate?: boolean;
  /** Stable owner label used only for targeted container lifecycle handling. */
  runOwner: string;
  /** Resolved task image references; populated by preflight immediately before launch. */
  imageDigests?: Readonly<Record<string, string>>;
}

export interface FeatureBenchPrepOptions {
  sourceDir: string;
  repository?: string;
  patchPath?: string;
  installDependencies?: boolean;
  executor?: FeatureBenchExecutor;
}

export interface FeatureBenchCommand {
  command: string;
  argv: string[];
  cwd: string;
}

export interface FeatureBenchRunPlan {
  arm: FeatureBenchArm;
  config: string;
  infer: FeatureBenchCommand;
}

export interface FeatureBenchRunResult {
  runDir: string;
  predictionsPath: string;
  /** Exact official per-task verifier reports, never recursively discovered. */
  verifierReports: Record<string, string>;
  infer: FeatureBenchCommand;
  evaluation: FeatureBenchCommand | null;
}

export interface FeatureBenchPreflight {
  /** Exact task images passed to the patched native runner. */
  imageDigests: Record<string, string>;
  /** SHA-256 attestation of stable, non-secret broker runtime metadata. */
  brokerRuntimeSha256: string;
  /** Hash of the pinned task-to-image map materialized during preparation. */
  datasetMapSha256: string;
}

export interface FeatureBenchExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Stream long-running native runner output while retaining only bounded tails. */
  stream?: boolean;
}

export interface FeatureBenchExecResult {
  stdout: string;
  stderr: string;
}

/** Injectable process seam used by offline unit tests. */
export type FeatureBenchExecutor = (
  command: string,
  argv: readonly string[],
  options?: FeatureBenchExecOptions,
) => Promise<FeatureBenchExecResult>;

const DEFAULTS = Object.freeze({
  concurrency: 4,
  evalConcurrency: 4,
  timeoutSecs: 43_200,
  cpus: 8,
  memoryGb: 24,
});

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function value<T>(input: T | undefined, fallback: T): T {
  return input === undefined ? fallback : input;
}

/**
 * Fail closed on modes the first adapter intentionally does not support. This
 * prevents an apparently comparable run from silently acquiring GPUs, retries,
 * API-key auth, another split, or a different attempt policy.
 */
export function validateFeatureBenchRun(options: FeatureBenchRunOptions): void {
  if (!options.sourceDir.trim()) throw new Error('sourceDir is required');
  if (!options.outputDir.trim()) throw new Error('outputDir is required');
  if (!options.codexBin.trim()) throw new Error('codexBin is required');
  let broker: URL;
  try {
    broker = new URL(options.credentialBrokerUrl);
  } catch {
    throw new Error('credentialBrokerUrl must be an absolute URL');
  }
  if (broker.protocol !== 'https:') throw new Error('credentialBrokerUrl must use HTTPS');
  if (broker.username || broker.password || broker.search || broker.hash) {
    throw new Error('credentialBrokerUrl must not contain userinfo, query credentials, or a fragment');
  }
  validatePortableComponent(options.restrictedNetwork, 'restrictedNetwork');
  if (typeof options.runOwner !== 'string' || !options.runOwner.trim()) {
    throw new Error('runOwner must be an explicit non-empty value');
  }
  validatePortableComponent(options.runOwner, 'runOwner');
  if (options.arm !== 'a' && options.arm !== 'b') throw new Error(`unsupported arm: ${String(options.arm)}`);
  if (options.arm === 'b' && !options.toolchainDir?.trim()) {
    throw new Error('toolchainDir is required for FeatureBench arm b');
  }
  if (options.taskIds.length === 0) throw new Error('at least one task ID is required');
  const seen = new Set<string>();
  for (const taskId of options.taskIds) {
    validateFeatureBenchTaskId(taskId);
    if (seen.has(taskId)) throw new Error(`duplicate FeatureBench task ID: ${taskId}`);
    seen.add(taskId);
  }
  if (value(options.split, FEATUREBENCH_SPLIT) !== FEATUREBENCH_SPLIT) {
    throw new Error(`unsupported FeatureBench split: only '${FEATUREBENCH_SPLIT}' is enabled`);
  }
  if (value(options.attempts, 1) !== 1) throw new Error('FeatureBench attempts must be exactly 1');
  if (value(options.retries, 0) !== 0) throw new Error('FeatureBench retries are unsupported');
  if (value(options.runtime, 'cpu') !== 'cpu') throw new Error('FeatureBench GPU runtime is unsupported');
  if (value(options.auth, 'chatgpt') !== 'chatgpt') throw new Error('FeatureBench API-key auth is unsupported');

  const model = options.model;
  const effort = options.effort;
  if (typeof model !== 'string' || !model.trim() || /[\0\r\n]/u.test(model)) {
    throw new Error('model must be an explicit non-empty single-line value');
  }
  if (typeof effort !== 'string' || !/^[a-z][a-z0-9_-]*$/iu.test(effort)) {
    throw new Error('effort must be an explicit portable reasoning-effort name');
  }
  positiveInteger('concurrency', value(options.concurrency, DEFAULTS.concurrency));
  positiveInteger('evalConcurrency', value(options.evalConcurrency, DEFAULTS.evalConcurrency));
  positiveInteger('timeoutSecs', value(options.timeoutSecs, DEFAULTS.timeoutSecs));
  positiveInteger('cpus', value(options.cpus, DEFAULTS.cpus));
  positiveInteger('memoryGb', value(options.memoryGb, DEFAULTS.memoryGb));
}

function tomlString(input: string): string {
  return `"${input
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\f', '\\f')
    .replaceAll('\r', '\\r')}"`;
}

/** Deterministic, secret-free runtime TOML. Host mount sources never enter it. */
export function featureBenchRuntimeConfig(options: FeatureBenchRunOptions): string {
  validateFeatureBenchRun(options);
  const armB = options.arm === 'b';
  const lines = [
    '[env_vars]',
    `FEATUREBENCH_DATASET_REVISION = ${tomlString(FEATUREBENCH_DATASET_REVISION)}`,
    '',
    '[infer_config.codex]',
    `CODEX_REASONING_EFFORT = ${tomlString(options.effort)}`,
    `FB_CONTAINER_CPUS = ${tomlString(String(value(options.cpus, DEFAULTS.cpus)))}`,
    `FB_CONTAINER_MEMORY = ${tomlString(`${value(options.memoryGb, DEFAULTS.memoryGb)}g`)}`,
    'FEATUREBENCH_BROKER_AUTH = "1"',
    `FEATUREBENCH_BROKER_BASE_URL = ${tomlString(options.credentialBrokerUrl)}`,
    `FEATUREBENCH_RESTRICTED_NETWORK = ${tomlString(options.restrictedNetwork)}`,
    'FEATUREBENCH_CPU_ONLY = "1"',
    `FEATUREBENCH_ARM = ${tomlString(options.arm)}`,
    `FEATUREBENCH_WORKFLOW_WAIT_SECONDS = ${tomlString(String(Math.min(value(options.timeoutSecs, DEFAULTS.timeoutSecs), 3_300)))}`,
  ];
  if (options.imageDigests !== undefined) {
    lines.push(`FEATUREBENCH_IMAGE_DIGESTS = ${tomlString(JSON.stringify(options.imageDigests))}`);
  }
  if (armB) lines.push(`FEATUREBENCH_PROMPT_PREFIX = ${tomlString(ARM_B_PREFIX)}`);
  return `${lines.join('\n')}\n`;
}

/** Arm A receives the upstream task verbatim; Arm B differs by one prefix. */
export function composeFeatureBenchPrompt(instruction: string, arm: FeatureBenchArm): string {
  if (arm !== 'a' && arm !== 'b') throw new Error(`unsupported arm: ${String(arm)}`);
  return arm === 'b' ? ARM_B_PREFIX + instruction : instruction;
}

/** Build the exact upstream inference invocation without touching disk. */
export function planFeatureBenchRun(
  options: FeatureBenchRunOptions,
  configPath = '<runtime-config>',
): FeatureBenchRunPlan {
  validateFeatureBenchRun(options);
  const sourceDir = resolve(options.sourceDir);
  const argv = [
    'infer',
    '--config-path', configPath,
    '--agent', 'codex',
    '--model', options.model,
    '--dataset', FEATUREBENCH_DATASET,
    '--split', FEATUREBENCH_SPLIT,
    '--task-id', ...options.taskIds,
    '--n-attempts', '1',
    '--n-concurrent', String(value(options.concurrency, DEFAULTS.concurrency)),
    '--timeout', String(value(options.timeoutSecs, DEFAULTS.timeoutSecs)),
    '--output-dir', resolve(options.outputDir),
  ];
  return {
    arm: options.arm,
    config: featureBenchRuntimeConfig(options),
    infer: { command: join(sourceDir, '.venv/bin/fb'), argv, cwd: sourceDir },
  };
}

/** Build the official upstream `fb eval` invocation for an inference output. */
export function planFeatureBenchEval(
  options: FeatureBenchRunOptions,
  configPath: string,
  predictionsPath: string,
): FeatureBenchCommand {
  validateFeatureBenchRun(options);
  const sourceDir = resolve(options.sourceDir);
  return {
    command: join(sourceDir, '.venv/bin/fb'),
    cwd: sourceDir,
    argv: [
      'eval',
      '--config-path', configPath,
      '--predictions-path', predictionsPath,
      '--dataset', FEATUREBENCH_DATASET,
      '--split', FEATUREBENCH_SPLIT,
      '--n-concurrent', String(value(options.evalConcurrency, DEFAULTS.evalConcurrency)),
      '--task-id', ...options.taskIds,
    ],
  };
}

/** Resume FeatureBench's own run directory so completed attempts are skipped. */
export function planFeatureBenchResume(
  options: FeatureBenchRunOptions,
  configPath: string,
  runDir: string,
): FeatureBenchCommand {
  validateFeatureBenchRun(options);
  const sourceDir = resolve(options.sourceDir);
  return {
    command: join(sourceDir, '.venv/bin/fb'),
    cwd: sourceDir,
    argv: [
      'infer',
      '--resume', runDir,
      '--config-path', configPath,
      '--n-concurrent', String(value(options.concurrency, DEFAULTS.concurrency)),
      '--timeout', String(value(options.timeoutSecs, DEFAULTS.timeoutSecs)),
    ],
  };
}

async function execute(
  command: string,
  argv: readonly string[],
  options: FeatureBenchExecOptions = {},
): Promise<FeatureBenchExecResult> {
  return await runOwnedProcess(command, argv, {
    cwd: options.cwd,
    env: options.env ?? allowlistedEnvironment(process.env),
    stream: options.stream,
  });
}

const DATASET_MEMBERSHIP_SCRIPT = `import json
from datasets import load_dataset
rows = load_dataset(${JSON.stringify(FEATUREBENCH_DATASET)}, split=${JSON.stringify(FEATUREBENCH_SPLIT)}, revision=${JSON.stringify(FEATUREBENCH_DATASET_REVISION)})
tasks = {}
for row in rows:
    settings = row.get("repo_settings", {})
    if isinstance(settings, str):
        settings = json.loads(settings)
    tasks[str(row["instance_id"])] = settings.get("image_name") or settings.get("docker_image")
print(json.dumps({
    "dataset": ${JSON.stringify(FEATUREBENCH_DATASET)},
    "revision": ${JSON.stringify(FEATUREBENCH_DATASET_REVISION)},
    "split": ${JSON.stringify(FEATUREBENCH_SPLIT)},
    "tasks": tasks,
}, sort_keys=True))`;

function datasetMapPath(sourceDir: string): string {
  return join(resolve(sourceDir), '.git/ultracode-external-dataset-map.json');
}

function parseDatasetMap(contents: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('FeatureBench prepared dataset map is invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FeatureBench prepared dataset map is invalid');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.dataset !== FEATUREBENCH_DATASET
    || record.revision !== FEATUREBENCH_DATASET_REVISION
    || record.split !== FEATUREBENCH_SPLIT
    || record.tasks === null
    || typeof record.tasks !== 'object'
    || Array.isArray(record.tasks)
  ) {
    throw new Error('FeatureBench prepared dataset map does not match the pinned dataset');
  }
  return record.tasks as Record<string, unknown>;
}

function replaceDatasetMap(sourceDir: string, contents: string): void {
  parseDatasetMap(contents);
  const destination = datasetMapPath(sourceDir);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${contents.trim()}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function installFeatureBenchDependencies(
  executor: FeatureBenchExecutor,
  sourceDir: string,
): Promise<void> {
  const env = allowlistedEnvironment(process.env);
  env.PYTHONDONTWRITEBYTECODE = '1';
  rmSync(join(sourceDir, '.venv'), { recursive: true, force: true });
  await executor('uv', ['sync', '--frozen', '--python', FEATUREBENCH_PYTHON], { cwd: sourceDir, env });
  await executor(join(sourceDir, '.venv/bin/fb'), ['pull', '--mode', FEATUREBENCH_SPLIT], {
    cwd: sourceDir,
    env,
  });
  const datasetMap = (await executor(
    join(sourceDir, '.venv/bin/python'),
    ['-c', DATASET_MEMBERSHIP_SCRIPT],
    { cwd: sourceDir, env },
  )).stdout;
  replaceDatasetMap(sourceDir, datasetMap);
}

async function patchIsApplied(
  executor: FeatureBenchExecutor,
  sourceDir: string,
  patchPath: string,
): Promise<boolean> {
  try {
    await executor('git', ['-C', sourceDir, 'apply', '--reverse', '--check', patchPath]);
    return true;
  } catch {
    return false;
  }
}

async function requireExactTrackedPatch(
  executor: FeatureBenchExecutor,
  sourceDir: string,
  patchPath: string,
): Promise<void> {
  if (!await patchIsApplied(executor, sourceDir, patchPath)) {
    throw new Error('FeatureBench tracked patch is absent or has drifted');
  }
  const actual = (await executor(
    'git',
    ['-C', sourceDir, 'diff', '--binary', '--full-index'],
  )).stdout.trimEnd();
  const expected = readFileSync(patchPath, 'utf8').trimEnd();
  const normalizeDerivedTargetHashes = (patch: string): string => patch.replace(
    /^(index [0-9a-f]{40}\.\.)[0-9a-f]{40}( \d+)$/gmu,
    '$1<derived-target>$2',
  );
  if (normalizeDerivedTargetHashes(actual) !== normalizeDerivedTargetHashes(expected)) {
    throw new Error('FeatureBench checkout contains changes beyond the exact tracked patch');
  }
  const gitPaths = (stdout: string): string[] => (stdout.includes('\0')
    ? stdout.split('\0')
    : stdout.split(/\r?\n/u)).filter(Boolean);
  const untracked = (await executor(
    'git',
    ['-C', sourceDir, 'ls-files', '--others', '--exclude-standard', '-z'],
  )).stdout;
  const ignored = (await executor(
    'git',
    ['-C', sourceDir, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
  )).stdout;
  const unexpected = [...new Set([...gitPaths(untracked), ...gitPaths(ignored)])]
    .filter((path) => !path.startsWith('.venv/'))
    .sort();
  if (unexpected.length > 0) {
    throw new Error(`FeatureBench checkout contains unexpected files: ${unexpected.join(', ')}`);
  }
}

/**
 * Clone and detach at the source pin, require a clean preimage, then check the
 * tracked patch before applying it. Existing exactly-prepared checkouts are
 * accepted; any other dirty checkout or preimage drift is rejected.
 */
export async function prepareFeatureBench(options: FeatureBenchPrepOptions): Promise<string> {
  requireFeatureBenchHost();
  const executor = options.executor ?? execute;
  const requestedSourceDir = resolve(options.sourceDir);
  const patchPath = resolve(options.patchPath ?? FEATUREBENCH_PATCH);
  const repository = options.repository ?? FEATUREBENCH_REPOSITORY;

  if (!existsSync(patchPath)) throw new Error(`FeatureBench patch not found: ${patchPath}`);
  const daemonPlatform = (await executor(
    'docker',
    ['info', '--format', '{{.OSType}}/{{.Architecture}}'],
    { env: allowlistedEnvironment(process.env) },
  )).stdout.trim();
  if (daemonPlatform !== 'linux/x86_64' && daemonPlatform !== 'linux/amd64') {
    throw new Error(`FeatureBench requires a Linux amd64 Docker daemon, got ${daemonPlatform || '(empty)'}`);
  }
  const cloned = !existsSync(requestedSourceDir);
  let stagingRoot: string | null = null;
  let sourceDir = requestedSourceDir;
  if (cloned) {
    mkdirSync(dirname(requestedSourceDir), { recursive: true });
    stagingRoot = mkdtempSync(join(dirname(requestedSourceDir), '.featurebench-prepare-'));
    sourceDir = join(stagingRoot, 'checkout');
  } else if (!lstatSync(requestedSourceDir).isDirectory() || !existsSync(join(requestedSourceDir, '.git'))) {
    throw new Error(`FeatureBench sourceDir is not a git checkout: ${sourceDir}`);
  }

  try {
    if (cloned) await executor('git', ['clone', '--no-checkout', repository, sourceDir]);
    const before = (await executor('git', ['-C', sourceDir, 'rev-parse', 'HEAD'])).stdout.trim();
    if (before === FEATUREBENCH_SOURCE_REVISION) {
      if (await patchIsApplied(executor, sourceDir, patchPath)) {
        await requireExactTrackedPatch(executor, sourceDir, patchPath);
        if (options.installDependencies !== false) {
          await installFeatureBenchDependencies(executor, sourceDir);
          await requireExactTrackedPatch(executor, sourceDir, patchPath);
        }
        if (stagingRoot !== null) renameSync(sourceDir, requestedSourceDir);
        return requestedSourceDir;
      }
    }

    if (!cloned) {
      const dirty = (await executor(
        'git',
        ['-C', sourceDir, 'status', '--porcelain=v1', '--untracked-files=all'],
      )).stdout.trim();
      if (dirty) throw new Error('FeatureBench checkout must be unmodified before pinning and patching');
    }

    await executor('git', ['-C', sourceDir, 'checkout', '--detach', FEATUREBENCH_SOURCE_REVISION]);
    const pinned = (await executor('git', ['-C', sourceDir, 'rev-parse', 'HEAD'])).stdout.trim();
    if (pinned !== FEATUREBENCH_SOURCE_REVISION) {
      throw new Error(`FeatureBench source pin mismatch: expected ${FEATUREBENCH_SOURCE_REVISION}, got ${pinned || '(empty)'}`);
    }
    const pinnedDirty = (await executor(
      'git',
      ['-C', sourceDir, 'status', '--porcelain=v1', '--untracked-files=all'],
    )).stdout.trim();
    if (pinnedDirty) throw new Error('FeatureBench pinned checkout is not an unmodified patch preimage');

    try {
      await executor('git', ['-C', sourceDir, 'apply', '--check', patchPath]);
    } catch (error) {
      throw new Error(`FeatureBench patch preimage check failed at ${FEATUREBENCH_SOURCE_REVISION}`, { cause: error });
    }
    await executor('git', ['-C', sourceDir, 'apply', patchPath]);
    await requireExactTrackedPatch(executor, sourceDir, patchPath);
    if (options.installDependencies !== false) {
      await installFeatureBenchDependencies(executor, sourceDir);
      await requireExactTrackedPatch(executor, sourceDir, patchPath);
    }
    if (stagingRoot !== null) renameSync(sourceDir, requestedSourceDir);
    return requestedSourceDir;
  } finally {
    if (stagingRoot !== null) rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function privateDirectory(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) {
    const info = lstatSync(resolved);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`FeatureBench outputDir must be a real directory: ${resolved}`);
    }
  } else {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  chmodSync(resolved, 0o700);
  return resolved;
}

function requireFile(path: string, description: string, executable = false): string {
  const resolved = resolve(path);
  const info = statSync(resolved);
  if (!info.isFile()) throw new Error(`${description} must be a regular file: ${resolved}`);
  if (executable && (info.mode & 0o111) === 0) throw new Error(`${description} is not executable: ${resolved}`);
  return resolved;
}

function runDirectories(outputDir: string): Set<string> {
  return new Set(readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));
}

function resumableRunDirectory(outputDir: string): string | null {
  const candidates = readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(outputDir, entry.name))
    .filter((directory) => existsSync(join(directory, 'run_metadata.json')));
  if (candidates.length > 1) {
    throw new Error(`expected at most one resumable FeatureBench run directory, found ${candidates.length}`);
  }
  return candidates[0] ?? null;
}

function locateRunDirectory(outputDir: string, before: Set<string>): string {
  const candidates = readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !before.has(entry.name))
    .map((entry) => join(outputDir, entry.name))
    .filter((dir) => existsSync(join(dir, 'output.jsonl')));
  if (candidates.length !== 1) {
    throw new Error(`expected one new FeatureBench run directory, found ${candidates.length}`);
  }
  return candidates[0]!;
}

function childEnvironment(options: FeatureBenchRunOptions, runtimeHome: string): NodeJS.ProcessEnv {
  const env = allowlistedEnvironment(process.env);
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.HOME = runtimeHome;
  env.XDG_CONFIG_HOME = join(runtimeHome, '.config');
  env.FEATUREBENCH_CODEX_BIN_HOST_PATH = resolve(options.codexBin);
  env.FEATUREBENCH_CREDENTIAL_BROKER_URL = options.credentialBrokerUrl;
  env.FEATUREBENCH_RESTRICTED_NETWORK = options.restrictedNetwork;
  env.FEATUREBENCH_RUN_OWNER = options.runOwner;
  if (options.arm === 'b') env.FEATUREBENCH_TOOLCHAIN_HOST_PATH = resolve(options.toolchainDir!);
  else delete env.FEATUREBENCH_TOOLCHAIN_HOST_PATH;
  return env;
}

const BROKER_RUNTIME_INSPECT_FORMAT = [
  'image={{json .Image}}',
  'command={{json .Path}}',
  'args={{json .Args}}',
  'binds={{json .HostConfig.Binds}}',
  'configuredMounts={{json .HostConfig.Mounts}}',
  'runtimeMounts={{json .Mounts}}',
  'tmpfs={{json .HostConfig.Tmpfs}}',
  'networks={{range $name, $_ := .NetworkSettings.Networks}}{{json $name}};{{end}}',
  'labels={{json .Config.Labels}}',
].join('\n');

function brokerRuntimeSha256(attestation: string): string {
  return `sha256:${createHash('sha256')
    .update('featurebench-broker-runtime-v1\0')
    .update(attestation.trimEnd())
    .digest('hex')}`;
}

/** Remove only containers bearing this run owner's exact lifecycle label. */
export async function cleanupFeatureBenchContainers(
  runOwner: string,
  executor: FeatureBenchExecutor = execute,
): Promise<void> {
  if (typeof runOwner !== 'string' || !runOwner.trim()) {
    throw new Error('FeatureBench run owner must be an explicit non-empty value');
  }
  validatePortableComponent(runOwner, 'FeatureBench run owner');
  const listed = await executor(
    'docker',
    ['ps', '--all', '--quiet', '--filter', `label=ultracode.external-run=${runOwner}`],
    { env: allowlistedEnvironment(process.env) },
  );
  const containerIds = listed.stdout.split(/\s+/u).filter(Boolean);
  if (containerIds.some((containerId) => !/^[0-9a-f]{12,64}$/u.test(containerId))) {
    throw new Error('Docker returned an invalid owned container id');
  }
  if (containerIds.length > 0) {
    await executor('docker', ['rm', '--force', ...containerIds], {
      env: allowlistedEnvironment(process.env),
      stream: true,
    });
  }
}

/** Suite checks that must pass before a run directory is claimed. */
export async function preflightFeatureBench(
  options: FeatureBenchRunOptions,
  executor: FeatureBenchExecutor = execute,
): Promise<FeatureBenchPreflight> {
  validateFeatureBenchRun(options);
  requireFeatureBenchHost();
  requireFile(options.codexBin, 'codexBin', true);
  const sourceDir = resolve(options.sourceDir);
  const head = (await executor('git', ['-C', sourceDir, 'rev-parse', 'HEAD'])).stdout.trim();
  if (head !== FEATUREBENCH_SOURCE_REVISION) {
    throw new Error(`FeatureBench source pin mismatch: expected ${FEATUREBENCH_SOURCE_REVISION}, got ${head || '(empty)'}`);
  }
  await requireExactTrackedPatch(executor, sourceDir, FEATUREBENCH_PATCH);
  const daemonPlatform = (await executor(
    'docker',
    ['info', '--format', '{{.OSType}}/{{.Architecture}}'],
    { env: allowlistedEnvironment(process.env) },
  )).stdout.trim();
  if (daemonPlatform !== 'linux/x86_64' && daemonPlatform !== 'linux/amd64') {
    throw new Error(`FeatureBench requires a Linux amd64 Docker daemon, got ${daemonPlatform || '(empty)'}`);
  }
  await cleanupFeatureBenchContainers(options.runOwner, executor);
  const brokerHost = new URL(options.credentialBrokerUrl).hostname;
  validatePortableComponent(brokerHost, 'credential broker hostname');
  const networkAttestation = (await executor(
    'docker',
    [
      'network', 'inspect', '--format',
      '{{.Internal}}|{{ index .Labels "ultracode.egress-policy" }}|{{len .Containers}}|{{range .Containers}}{{.Name}}{{end}}',
      options.restrictedNetwork,
    ],
    { env: allowlistedEnvironment(process.env) },
  )).stdout.trim();
  if (networkAttestation !== `true|openai-via-credential-broker|1|${brokerHost}`) {
    throw new Error(
      `restricted Docker network ${options.restrictedNetwork} must be internal and have only the named credential broker attached`,
    );
  }
  const brokerAttestation = (await executor(
    'docker',
    [
      'inspect', '--format',
      '{{ index .Config.Labels "ultracode.credential-broker" }}|{{.State.Running}}|{{.Image}}',
      brokerHost,
    ],
    { env: allowlistedEnvironment(process.env) },
  )).stdout.trim();
  const brokerMatch = /^true\|true\|(sha256:[0-9a-f]{64})$/u.exec(brokerAttestation);
  if (brokerMatch === null) {
    throw new Error(`credential broker ${brokerHost} must be a running, labeled, immutable container`);
  }
  const brokerRuntimeAttestation = (await executor(
    'docker',
    ['inspect', '--format', BROKER_RUNTIME_INSPECT_FORMAT, brokerHost],
    { env: allowlistedEnvironment(process.env) },
  )).stdout;
  if (!brokerRuntimeAttestation.trim()) {
    throw new Error(`credential broker ${brokerHost} returned an empty runtime attestation`);
  }
  const preparedDatasetMap = datasetMapPath(sourceDir);
  const taskImages = parseDatasetMap(readFileSync(preparedDatasetMap, 'utf8'));
  const unknown = options.taskIds.filter((taskId) => !(taskId in taskImages));
  if (unknown.length > 0) throw new Error(`FeatureBench task IDs are absent from the pinned dataset: ${unknown.join(', ')}`);
  const imageDigests: Record<string, string> = {};
  for (const taskId of options.taskIds) {
    const image = taskImages[taskId];
    if (typeof image !== 'string' || image.length === 0) {
      throw new Error(`FeatureBench task ${taskId} has no attributable container image`);
    }
    const digest = (await executor(
      'docker',
      ['image', 'inspect', '--format', '{{ index .RepoDigests 0 }}', image],
      { env: allowlistedEnvironment(process.env) },
    )).stdout.trim();
    if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(digest)) {
      throw new Error(
        `FeatureBench image ${image} is not locally resolved to one immutable digest; rerun \`npm run bench -- --suite featurebench prep\``,
      );
    }
    imageDigests[taskId] = digest;
  }
  return {
    imageDigests,
    brokerRuntimeSha256: brokerRuntimeSha256(brokerRuntimeAttestation),
    datasetMapSha256: sha256File(preparedDatasetMap),
  };
}

/**
 * Run inference and, by default, the official upstream evaluator. The runtime
 * TOML lives in a private temporary directory and is removed on every exit.
 */
export async function runFeatureBench(
  options: FeatureBenchRunOptions,
  executor: FeatureBenchExecutor = execute,
  beforeLaunch?: () => Promise<void>,
): Promise<FeatureBenchRunResult> {
  const { imageDigests } = await preflightFeatureBench(options, executor);
  const outputDir = privateDirectory(options.outputDir);
  if (options.arm === 'b') {
    const toolchain = resolve(options.toolchainDir!);
    if (!lstatSync(toolchain).isDirectory()) throw new Error(`toolchainDir must be a directory: ${toolchain}`);
    requireFile(join(toolchain, 'node-sel'), 'arm-b node selector', true);
    requireFile(join(toolchain, 'ultracode/dist/cli/main.js'), 'arm-b ultracode entrypoint');
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'uc-featurebench-'));
  chmodSync(tempDir, 0o700);
  const configPath = join(tempDir, 'config.toml');
  const plannedOptions = { ...options, outputDir, imageDigests };
  try {
    const plan = planFeatureBenchRun(plannedOptions, configPath);
    writeFileSync(configPath, plan.config, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const configMode = statSync(configPath).mode & 0o777;
    if (configMode !== 0o600) {
      throw new Error(`FeatureBench runtime config mode is ${configMode.toString(8)}, expected 600`);
    }

    const existingRun = resumableRunDirectory(outputDir);
    const inference = existingRun === null
      ? plan.infer
      : planFeatureBenchResume(plannedOptions, configPath, existingRun);
    const before = runDirectories(outputDir);
    await beforeLaunch?.();
    await executor(inference.command, inference.argv, {
      cwd: inference.cwd,
      env: childEnvironment(plannedOptions, tempDir),
      stream: true,
    });
    const runDir = existingRun ?? locateRunDirectory(outputDir, before);
    chmodSync(runDir, 0o700);
    const predictionsPath = join(runDir, 'output.jsonl');
    let evaluation: FeatureBenchCommand | null = null;
    if (options.evaluate !== false) {
      evaluation = planFeatureBenchEval(plannedOptions, configPath, predictionsPath);
      await beforeLaunch?.();
      await executor(evaluation.command, evaluation.argv, {
        cwd: evaluation.cwd,
        env: childEnvironment(plannedOptions, tempDir),
        stream: true,
      });
    }
    const verifierReports: Record<string, string> = {};
    if (evaluation !== null) {
      for (const taskId of options.taskIds) {
        const report = join(runDir, 'eval_outputs', taskId, 'attempt-1', 'report.json');
        const info = lstatSync(report);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error(`FeatureBench verifier report is not a regular file: ${report}`);
        }
        verifierReports[taskId] = report;
      }
    }
    return { runDir, predictionsPath, verifierReports, infer: inference, evaluation };
  } finally {
    try {
      await cleanupFeatureBenchContainers(options.runOwner, executor);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
