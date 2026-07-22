/** Content-addressed preparation of the pinned FeatureBench source and CPU inputs. */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BenchPathRoots } from '../../shared/contracts.js';
import type { ToolchainConfig } from '../../shared/config.js';
import {
  ensureRealDirectoryWithin,
  isPortableComponent,
  readPrivateJson,
  readRegularFileWithinRoot,
  writePrivateFileAtomic,
  writePrivateJsonAtomic,
} from '../../shared/paths.js';
import { allowlistedEnvironment, runBenchProcess, type BenchProcessOptions } from '../../shared/process.js';
import {
  canonicalJson,
  sha256CanonicalJson,
  sha256File,
  sha256Tree,
  type SourceProvenance,
} from '../../shared/provenance.js';
import { loadPreparedToolchain, prepareSharedToolchain, type PreparedToolchain } from '../../shared/toolchain.js';
import {
  FEATUREBENCH_DATASET,
  FEATUREBENCH_DATASET_REVISION,
  FEATUREBENCH_PYTHON_VERSION,
  FEATUREBENCH_REPOSITORY,
  FEATUREBENCH_SOURCE_REVISION,
  FEATUREBENCH_SPLIT,
  featureBenchCacheRoot,
  featureBenchCurrentFile,
  featureBenchPreparedDir,
} from './config.js';
import { requireFeatureBenchHost } from './host.js';

const CONTENT_MANIFEST = 'content-manifest.json';
const PREPARED_IDENTITY = 'prepared-identity.json';
export const FEATUREBENCH_DATASET_MAP = '.git/ultracode-benchmark-dataset-map.json';
export const FEATUREBENCH_DATASET_PARQUET = '.git/ultracode-benchmark-dataset.parquet';

export interface FeatureBenchExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stream?: boolean;
  timeoutMs?: number;
  workerScope?: string;
  onLifecycleToken?: (token: string) => void;
  onLifecycleStarted?: (token: string, pid: number | null, processStartIdentity: string | null) => void;
  onLifecycleRecovered?: (token: string, recovery: 'complete' | 'failed') => void;
}

export interface FeatureBenchExecResult { stdout: string; stderr: string }

export type FeatureBenchExecutor = (
  command: string,
  argv: readonly string[],
  options?: FeatureBenchExecOptions,
) => Promise<FeatureBenchExecResult>;

export interface FeatureBenchTaskInput {
  taskId: string;
  sourceSha256: string;
  imageRequested: string;
  imageResolvedDigest: string;
  imageLocalId: string;
  imagePlatform: string;
}

interface FeatureBenchContentManifest {
  schemaVersion: 4;
  kind: 'ultracode-featurebench-inputs';
  payloadSha256: string;
  source: SourceProvenance;
  pythonVersion: string;
  environmentSha256: string;
  pythonRuntimeSha256: string;
  fbSha256: string;
  patchSha256: string;
  datasetMapSha256: string;
  datasetParquetSha256: string;
  tasks: FeatureBenchTaskInput[];
  toolchainPayloadSha256: string;
}

export interface PreparedFeatureBenchInputs {
  directory: string;
  sourceDirectory: string;
  environmentDirectory: string;
  pythonBinary: string;
  fbBinary: string;
  source: SourceProvenance;
  pythonVersion: string;
  environmentSha256: string;
  pythonRuntimeSha256: string;
  patchSha256: string;
  datasetMapSha256: string;
  datasetParquetSha256: string;
  tasks: FeatureBenchTaskInput[];
  toolchain: PreparedToolchain;
}

export interface FeatureBenchPrepPlan {
  repository: string;
  revision: string;
  dataset: string;
  datasetRevision: string;
  split: string;
  pythonVersion: string;
  patch: string;
}

export function planFeatureBenchPreparation(roots: BenchPathRoots): FeatureBenchPrepPlan {
  return {
    repository: FEATUREBENCH_REPOSITORY,
    revision: FEATUREBENCH_SOURCE_REVISION,
    dataset: FEATUREBENCH_DATASET,
    datasetRevision: FEATUREBENCH_DATASET_REVISION,
    split: FEATUREBENCH_SPLIT,
    pythonVersion: FEATUREBENCH_PYTHON_VERSION,
    patch: join(roots.benchRoot, 'suites', 'featurebench', 'codex-chatgpt.patch'),
  };
}

async function execute(
  command: string,
  argv: readonly string[],
  options: FeatureBenchExecOptions = {},
): Promise<FeatureBenchExecResult> {
  const processOptions: BenchProcessOptions = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? allowlistedEnvironment(process.env),
    tailBytes: 64 * 1_024 * 1_024,
  };
  if (options.stream !== undefined) processOptions.stream = options.stream;
  if (options.timeoutMs !== undefined) processOptions.timeoutMs = options.timeoutMs;
  if (options.workerScope !== undefined) processOptions.workerScope = options.workerScope;
  if (options.onLifecycleToken !== undefined) processOptions.onLifecycleToken = options.onLifecycleToken;
  if (options.onLifecycleStarted !== undefined) processOptions.onLifecycleStarted = options.onLifecycleStarted;
  if (options.onLifecycleRecovered !== undefined) processOptions.onLifecycleRecovered = options.onLifecycleRecovered;
  const result = await runBenchProcess(command, argv, processOptions);
  return { stdout: result.stdout, stderr: result.stderr };
}

async function command(
  executor: FeatureBenchExecutor,
  file: string,
  argv: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return (await executor(file, argv, { cwd, env })).stdout.trim();
}

/** Fail before preparation creates state or contacts Docker when uv is unavailable. */
export async function preflightFeatureBenchUv(
  executor: FeatureBenchExecutor,
  cwd: string,
): Promise<void> {
  try {
    const version = await command(executor, 'uv', ['--version'], cwd);
    if (!/^uv\s+\S+/u.test(version)) throw new Error('malformed uv version output');
  } catch {
    throw new Error('FeatureBench prep requires uv on PATH (`uv --version` failed)');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface FeatureBenchDatasetMap {
  dataset: typeof FEATUREBENCH_DATASET;
  revision: typeof FEATUREBENCH_DATASET_REVISION;
  split: typeof FEATUREBENCH_SPLIT;
  tasks: Record<string, string>;
}

const FEATUREBENCH_DATASET_PIN_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../suites/featurebench/dataset-pin.json',
);

interface FeatureBenchDatasetPin {
  schemaVersion: 1;
  kind: 'ultracode-featurebench-dataset-pin';
  dataset: typeof FEATUREBENCH_DATASET;
  revision: typeof FEATUREBENCH_DATASET_REVISION;
  split: typeof FEATUREBENCH_SPLIT;
  taskCount: number;
  inventorySha256: string;
  sourceParquetSha256: string;
}

function loadFeatureBenchDatasetPin(): FeatureBenchDatasetPin {
  const value = JSON.parse(readFileSync(FEATUREBENCH_DATASET_PIN_PATH, 'utf8')) as Partial<FeatureBenchDatasetPin>;
  if (value.schemaVersion !== 1 || value.kind !== 'ultracode-featurebench-dataset-pin'
    || value.dataset !== FEATUREBENCH_DATASET || value.revision !== FEATUREBENCH_DATASET_REVISION
    || value.split !== FEATUREBENCH_SPLIT || value.taskCount !== 100
    || value.inventorySha256 !== '4eed1b33a6783154287a0dd8281212b4096b93659a35a4f8b0ebde38d99d916f'
    || value.sourceParquetSha256 !== 'e8a704f83d673e1cc78086eefb76bd56461ead8a65ca06fd6972f7363be8a775') {
    throw new Error('FeatureBench dataset pin is malformed or incompatible');
  }
  return value as FeatureBenchDatasetPin;
}

/** Validate the complete pinned task/image inventory generated by datasets. */
export function parseFeatureBenchDatasetMap(value: unknown): FeatureBenchDatasetMap {
  if (!isRecord(value)
    || value.dataset !== FEATUREBENCH_DATASET
    || value.revision !== FEATUREBENCH_DATASET_REVISION
    || value.split !== FEATUREBENCH_SPLIT
    || !isRecord(value.tasks)) {
    throw new Error('FeatureBench prepared dataset map does not match the pinned dataset');
  }
  const tasks: Record<string, string> = {};
  for (const [taskId, image] of Object.entries(value.tasks)) {
    if (!isPortableComponent(taskId) || taskId.includes('..')
      || typeof image !== 'string' || image.length === 0 || /[\0\r\n]/.test(image)) {
      throw new Error('FeatureBench prepared dataset map contains an invalid task or image');
    }
    tasks[taskId] = image;
  }
  const pin = loadFeatureBenchDatasetPin();
  if (Object.keys(tasks).length !== pin.taskCount || sha256CanonicalJson(tasks) !== pin.inventorySha256) {
    throw new Error('FeatureBench prepared dataset map does not match the audited inventory pin');
  }
  return { dataset: FEATUREBENCH_DATASET, revision: FEATUREBENCH_DATASET_REVISION, split: FEATUREBENCH_SPLIT, tasks };
}

export const FEATUREBENCH_DATASET_MEMBERSHIP_SCRIPT = `import json
import os
from datasets import load_dataset
rows = load_dataset("parquet", data_files=os.environ["FEATUREBENCH_DATASET_PARQUET"], split="train")
tasks = {}
for row in rows:
    task_id = row["instance_id"]
    image_name = row["image_name"]
    if not isinstance(task_id, str) or not task_id:
        raise ValueError("FeatureBench dataset contains an invalid task id")
    if not isinstance(image_name, str) or not image_name:
        raise ValueError(f"FeatureBench dataset contains an invalid image for {task_id}")
    if task_id in tasks:
        raise ValueError(f"FeatureBench dataset contains duplicate task id {task_id}")
    tasks[task_id] = image_name
print(json.dumps({"dataset": ${JSON.stringify(FEATUREBENCH_DATASET)}, "revision": ${JSON.stringify(FEATUREBENCH_DATASET_REVISION)}, "split": ${JSON.stringify(FEATUREBENCH_SPLIT)}, "tasks": tasks}, sort_keys=True))`;

export const FEATUREBENCH_DATASET_DOWNLOAD_SCRIPT = `from huggingface_hub import hf_hub_download
print(hf_hub_download(repo_id=${JSON.stringify(FEATUREBENCH_DATASET)}, repo_type="dataset", revision=${JSON.stringify(FEATUREBENCH_DATASET_REVISION)}, filename="data/${FEATUREBENCH_SPLIT}-00000-of-00001.parquet"))`;

/** Verify the exact pinned parquet bytes before they enter prepared state. */
export function verifyFeatureBenchDatasetArtifact(path: string): string {
  const observed = sha256File(path);
  if (observed !== loadFeatureBenchDatasetPin().sourceParquetSha256) {
    throw new Error('FeatureBench downloaded dataset artifact does not match the audited byte pin');
  }
  return observed;
}

function normalizePatchTargetHashes(patch: string): string {
  return patch.trimEnd().replace(/^(index [0-9a-f]{40}\.\.)[0-9a-f]{40}( \d+)$/gmu, '$1<derived-target>$2');
}

async function requireExactPatch(
  executor: FeatureBenchExecutor,
  sourceDirectory: string,
  patch: string,
): Promise<void> {
  await command(executor, 'git', ['-C', sourceDirectory, 'apply', '--reverse', '--check', patch], sourceDirectory);
  const actual = await command(executor, 'git', ['-C', sourceDirectory, 'diff', '--binary', '--full-index'], sourceDirectory);
  const expected = readFileSync(patch, 'utf8');
  if (normalizePatchTargetHashes(actual) !== normalizePatchTargetHashes(expected)) {
    throw new Error('FeatureBench checkout contains changes beyond the exact tracked patch');
  }
  const untracked = await command(
    executor,
    'git',
    ['-C', sourceDirectory, 'ls-files', '--others', '--exclude-standard', '-z'],
    sourceDirectory,
  );
  const ignored = await command(
    executor,
    'git',
    ['-C', sourceDirectory, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    sourceDirectory,
  );
  const paths = (raw: string): string[] => raw.split(raw.includes('\0') ? '\0' : /\r?\n/u).filter(Boolean);
  const unexpected = [...new Set([...paths(untracked), ...paths(ignored)])]
    .filter((path) => !path.startsWith('.venv/'))
    .sort();
  if (unexpected.length > 0) throw new Error(`FeatureBench checkout contains unexpected files: ${unexpected.join(', ')}`);
}

interface ImageInspect {
  Id?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  RepoDigests?: unknown;
}

function repositoryName(image: string): string {
  const tail = image.slice(image.lastIndexOf('/') + 1);
  return tail.includes(':') ? image.slice(0, image.length - tail.length + tail.lastIndexOf(':')) : image;
}

function parseImageInspect(stdout: string, requested: string): Omit<FeatureBenchTaskInput, 'taskId' | 'sourceSha256' | 'imageRequested'> {
  let rows: ImageInspect[];
  try { rows = JSON.parse(stdout) as ImageInspect[]; } catch {
    throw new Error(`Docker returned malformed image inspection for ${requested}`);
  }
  const image = rows.length === 1 ? rows[0] : undefined;
  const repo = repositoryName(requested);
  const digests = Array.isArray(image?.RepoDigests)
    ? image.RepoDigests.filter((value): value is string => typeof value === 'string' && value.startsWith(`${repo}@sha256:`))
    : [];
  if (typeof image?.Id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image.Id)
    || typeof image.Os !== 'string' || typeof image.Architecture !== 'string' || digests.length !== 1) {
    throw new Error(`local Docker image identity does not uniquely attest ${requested}`);
  }
  return {
    imageResolvedDigest: digests[0]!,
    imageLocalId: image.Id,
    imagePlatform: `${image.Os}/${image.Architecture}`,
  };
}

function sourceTreeSha256(sourceDirectory: string): string {
  return sha256Tree(sourceDirectory, {
    exclude: ['.git', '.venv'],
  });
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
}

function pythonRuntimeRoot(environmentDirectory: string): string {
  const binary = realpathSync(join(environmentDirectory, 'bin', 'python'));
  const root = resolve(binary, '..', '..');
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || !isWithin(root, binary)) {
    throw new Error('FeatureBench Python runtime is not a real self-contained directory');
  }
  return root;
}

function assertFeatureBenchEnvironmentLinks(environmentDirectory: string, runtimeRoot: string): void {
  const unexpected: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(path);
        } catch {
          unexpected.push(relative(environmentDirectory, path));
          continue;
        }
        if (!isWithin(environmentDirectory, target) && !isWithin(runtimeRoot, target)) {
          unexpected.push(relative(environmentDirectory, path));
        }
      } else if (info.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(environmentDirectory);
  if (unexpected.length > 0) {
    throw new Error(`FeatureBench environment contains unattested external links: ${unexpected.sort().join(', ')}`);
  }
}

/** Remove executable Python cache artifacts before publishing immutable inputs. */
export function removeFeatureBenchPythonCacheArtifacts(root: string): void {
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) {
        rmSync(path, { recursive: info.isDirectory(), force: true });
      } else if (info.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(root);
}

export function assertNoFeatureBenchPythonCacheArtifacts(root: string): void {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) {
        found.push(relative(root, path));
      } else if (info.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(root);
  if (found.length > 0) {
    throw new Error(`prepared FeatureBench inputs contain Python cache artifacts: ${found.sort().join(', ')}`);
  }
}

export function featureBenchEnvironmentIdentity(environmentDirectory: string): {
  environmentSha256: string;
  pythonRuntimeSha256: string;
} {
  const runtimeRoot = pythonRuntimeRoot(environmentDirectory);
  assertFeatureBenchEnvironmentLinks(environmentDirectory, runtimeRoot);
  assertFeatureBenchEnvironmentLinks(runtimeRoot, runtimeRoot);
  const pythonRuntimeSha256 = sha256Tree(runtimeRoot);
  return {
    pythonRuntimeSha256,
    environmentSha256: sha256CanonicalJson({
      treeSha256: sha256Tree(environmentDirectory),
      pythonBinarySha256: sha256File(realpathSync(join(environmentDirectory, 'bin', 'python'))),
      pythonRuntimeSha256,
    }),
  };
}

const RELOCATABLE_PYTHON_ENTRYPOINT_HEADER = `#!/bin/sh
""":"
launcher_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
exec "$launcher_dir/python" "$0" "$@"
":"""
`;

const ACTIVATION_SCRIPT_RE = /^(?:activate|deactivate)(?:[._-]|$)/iu;

function containsStageReference(contents: Buffer | string, stageDirectory: string): boolean {
  const value = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
  const stage = resolve(stageDirectory);
  return value.includes(Buffer.from(stage, 'utf8'))
    || value.includes(Buffer.from(pathToFileURL(stage).href, 'utf8'));
}

function removeRecordedDirectUrl(path: string, environmentDirectory: string): void {
  const record = join(dirname(path), 'RECORD');
  if (existsSync(record)) {
    const contents = readFileSync(record, 'utf8');
    const lines = contents.trimEnd().split(/\r?\n/u);
    const retained = lines.filter((line) => {
      const delimiter = line.indexOf(',');
      const recordedPath = delimiter < 0 ? line : line.slice(0, delimiter);
      return recordedPath !== 'direct_url.json' && !recordedPath.endsWith('/direct_url.json');
    });
    const mode = lstatSync(record).mode & 0o777;
    writePrivateFileAtomic(environmentDirectory, record, `${retained.join('\n')}\n`);
    chmodSync(record, mode);
  }
  rmSync(path);
}

function removeStageBoundMetadata(
  directory: string,
  stageDirectory: string,
  environmentDirectory: string,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = lstatSync(path);
    if (info.isDirectory()) {
      removeStageBoundMetadata(path, stageDirectory, environmentDirectory);
    } else if (info.isFile() && entry.name === 'direct_url.json') {
      const contents = readFileSync(path);
      if (containsStageReference(contents, stageDirectory)) removeRecordedDirectUrl(path, environmentDirectory);
    }
  }
}

function relocatePythonEntryPoint(path: string, environmentDirectory: string): boolean {
  const contents = readFileSync(path);
  const lineEnd = contents.indexOf(0x0a);
  if (lineEnd < 0) return false;
  const firstLine = contents.subarray(0, lineEnd).toString('utf8').replace(/\r$/u, '');
  const pythonPrefix = `#!${join(environmentDirectory, 'bin', 'python')}`;
  const suffix = firstLine.startsWith(pythonPrefix) ? firstLine.slice(pythonPrefix.length) : null;
  if (suffix === null || !/^(?:3(?:\.\d+)?)?$/u.test(suffix)) return false;
  const mode = lstatSync(path).mode & 0o777;
  writePrivateFileAtomic(
    environmentDirectory,
    path,
    Buffer.concat([Buffer.from(RELOCATABLE_PYTHON_ENTRYPOINT_HEADER, 'utf8'), contents.subarray(lineEnd + 1)]),
  );
  chmodSync(path, mode);
  return true;
}

/** Replace stage-bound Python entry points with adjacent-interpreter launchers. */
export function makeFeatureBenchEnvironmentRelocatable(
  stageDirectory: string,
  environmentDirectory: string,
): void {
  const binDirectory = join(environmentDirectory, 'bin');
  let relocatedFb = false;
  for (const entry of readdirSync(binDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(binDirectory, entry.name);
    if (relocatePythonEntryPoint(path, environmentDirectory)) {
      if (entry.name === 'fb') relocatedFb = true;
      continue;
    }
    if (ACTIVATION_SCRIPT_RE.test(entry.name)
      && containsStageReference(readFileSync(path), stageDirectory)) {
      rmSync(path);
    }
  }
  if (!relocatedFb) throw new Error('FeatureBench uv environment did not produce the expected fb entry point');
  removeStageBoundMetadata(environmentDirectory, stageDirectory, environmentDirectory);
  assertNoFeatureBenchStageReferences(environmentDirectory, stageDirectory);
}

/** Reject any literal or file-URL reference to the random preparation stage. */
export function assertNoFeatureBenchStageReferences(root: string, stageDirectory: string): void {
  const references: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        if (containsStageReference(readlinkSync(path), stageDirectory)) references.push(relative(root, path));
      } else if (info.isDirectory()) {
        walk(path);
      } else if (info.isFile() && containsStageReference(readFileSync(path), stageDirectory)) {
        references.push(relative(root, path));
      }
    }
  };
  walk(root);
  if (references.length > 0) {
    throw new Error(`FeatureBench preparation retains stage-path references: ${references.sort().join(', ')}`);
  }
}

function requireRelocatableFeatureBenchLauncher(path: string): void {
  const info = lstatSync(path);
  const header = Buffer.from(RELOCATABLE_PYTHON_ENTRYPOINT_HEADER, 'utf8');
  const contents = readFileSync(path);
  if (!info.isFile() || (info.mode & 0o111) === 0 || !contents.subarray(0, header.length).equals(header)) {
    throw new Error('prepared FeatureBench fb launcher is not relocation-safe');
  }
}

function contentManifest(directory: string): FeatureBenchContentManifest {
  const value = readPrivateJson(directory, join(directory, CONTENT_MANIFEST)) as Partial<FeatureBenchContentManifest>;
  const sha = (candidate: unknown): candidate is string => typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate);
  if (value.schemaVersion !== 4 || value.kind !== 'ultracode-featurebench-inputs'
    || !sha(value.payloadSha256) || !sha(value.environmentSha256) || !sha(value.fbSha256)
    || !sha(value.pythonRuntimeSha256)
    || !sha(value.patchSha256) || !sha(value.datasetMapSha256) || !sha(value.datasetParquetSha256)
    || !sha(value.toolchainPayloadSha256)
    || value.pythonVersion !== FEATUREBENCH_PYTHON_VERSION || value.source === undefined
    || value.source.repository !== FEATUREBENCH_REPOSITORY || value.source.revision !== FEATUREBENCH_SOURCE_REVISION
    || !sha(value.source.treeSha256) || !Array.isArray(value.tasks) || value.tasks.length === 0
    || value.tasks.some((task) => !isPortableComponent(task.taskId)
      || task.taskId.includes('..') || typeof task.imageRequested !== 'string'
      || task.imageRequested.length === 0 || /[\0\r\n]/.test(task.imageRequested)
      || !sha(task.sourceSha256)
      || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(task.imageResolvedDigest)
      || !/^sha256:[a-f0-9]{64}$/.test(task.imageLocalId)
      || !/^linux\/[a-z0-9_]+$/.test(task.imagePlatform))) {
    throw new Error('prepared FeatureBench content manifest is malformed or incompatible');
  }
  return value as FeatureBenchContentManifest;
}

/** Load and re-attest one immutable published FeatureBench input directory. */
export function loadPreparedFeatureBenchInputs(directory: string): PreparedFeatureBenchInputs {
  const resolved = resolve(directory);
  const manifest = contentManifest(resolved);
  assertNoFeatureBenchPythonCacheArtifacts(resolved);
  const payloadSha256 = sha256Tree(resolved, { exclude: [CONTENT_MANIFEST] });
  const identity: Partial<FeatureBenchContentManifest> = { ...manifest };
  delete identity.payloadSha256;
  if (payloadSha256 !== manifest.payloadSha256 || resolved !== resolve(resolved, '..', payloadSha256)
    || canonicalJson(readPrivateJson(resolved, join(resolved, PREPARED_IDENTITY))) !== canonicalJson(identity)) {
    throw new Error('prepared FeatureBench payload identity drifted');
  }
  const sourceDirectory = join(resolved, 'source');
  const environmentDirectory = join(sourceDirectory, '.venv');
  const pythonBinary = join(environmentDirectory, 'bin', 'python');
  const fbBinary = join(environmentDirectory, 'bin', 'fb');
  requireRelocatableFeatureBenchLauncher(fbBinary);
  const mapPath = join(sourceDirectory, ...FEATUREBENCH_DATASET_MAP.split('/'));
  const datasetParquetPath = join(sourceDirectory, ...FEATUREBENCH_DATASET_PARQUET.split('/'));
  const environmentIdentity = featureBenchEnvironmentIdentity(environmentDirectory);
  const parsedMap = parseFeatureBenchDatasetMap(JSON.parse(
    readRegularFileWithinRoot(sourceDirectory, FEATUREBENCH_DATASET_MAP).toString('utf8'),
  ));
  if (sourceTreeSha256(sourceDirectory) !== manifest.source.treeSha256
    || environmentIdentity.environmentSha256 !== manifest.environmentSha256
    || environmentIdentity.pythonRuntimeSha256 !== manifest.pythonRuntimeSha256
    || sha256File(fbBinary) !== manifest.fbSha256 || sha256File(mapPath) !== manifest.datasetMapSha256
    || verifyFeatureBenchDatasetArtifact(datasetParquetPath) !== manifest.datasetParquetSha256
    || canonicalJson(Object.keys(parsedMap.tasks)) !== canonicalJson(manifest.tasks.map((task) => task.taskId))
    || manifest.tasks.some((task) => task.imageRequested !== parsedMap.tasks[task.taskId]
      || !task.imageResolvedDigest.startsWith(`${repositoryName(task.imageRequested)}@sha256:`)
      || task.sourceSha256 !== sha256CanonicalJson({
        dataset: FEATUREBENCH_DATASET,
        revision: FEATUREBENCH_DATASET_REVISION,
        split: FEATUREBENCH_SPLIT,
        taskId: task.taskId,
        imageRequested: task.imageRequested,
      }))) {
    throw new Error('prepared FeatureBench source, environment, or dataset map drifted');
  }
  return {
    directory: resolved,
    sourceDirectory,
    environmentDirectory,
    pythonBinary,
    fbBinary,
    source: manifest.source,
    pythonVersion: manifest.pythonVersion,
    environmentSha256: manifest.environmentSha256,
    pythonRuntimeSha256: manifest.pythonRuntimeSha256,
    patchSha256: manifest.patchSha256,
    datasetMapSha256: manifest.datasetMapSha256,
    datasetParquetSha256: manifest.datasetParquetSha256,
    tasks: manifest.tasks,
    toolchain: loadPreparedToolchain(join(resolved, '..', '..', 'toolchains', manifest.toolchainPayloadSha256)),
  };
}

export function loadCurrentPreparedFeatureBenchInputs(roots: BenchPathRoots): PreparedFeatureBenchInputs {
  const current = readPrivateJson(featureBenchCacheRoot(roots), featureBenchCurrentFile(roots)) as {
    schemaVersion?: unknown;
    identity?: unknown;
  };
  if (current.schemaVersion !== 3 || typeof current.identity !== 'string' || !/^[a-f0-9]{64}$/.test(current.identity)) {
    throw new Error('FeatureBench current preparation pointer is malformed');
  }
  return loadPreparedFeatureBenchInputs(featureBenchPreparedDir(roots, current.identity));
}

/** Build and publish exact pinned native inputs. This is the only networked path. */
export async function prepareFeatureBenchInputs(
  roots: BenchPathRoots,
  toolchainConfig: ToolchainConfig,
  executor: FeatureBenchExecutor = execute,
): Promise<PreparedFeatureBenchInputs> {
  await preflightFeatureBenchUv(executor, roots.benchRoot);
  requireFeatureBenchHost();
  const plan = planFeatureBenchPreparation(roots);
  const cache = ensureRealDirectoryWithin(roots.cacheRoot, featureBenchCacheRoot(roots));
  const stage = join(cache, `.stage-${process.pid}-${randomBytes(12).toString('hex')}`);
  mkdirSync(stage, { mode: 0o700 });
  const sourceDirectory = join(stage, 'source');
  try {
    const daemon = await command(executor, 'docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}'], roots.benchRoot);
    if (!['linux/x86_64', 'linux/amd64'].includes(daemon)) {
      throw new Error(`FeatureBench requires a Linux amd64 Docker daemon, got ${daemon || '(empty)'}`);
    }
    const toolchain = await prepareSharedToolchain(toolchainConfig, roots);
    await command(executor, 'git', ['clone', '--no-checkout', plan.repository, sourceDirectory], roots.benchRoot);
    await command(executor, 'git', ['-C', sourceDirectory, 'checkout', '--detach', plan.revision], sourceDirectory);
    const head = await command(executor, 'git', ['-C', sourceDirectory, 'rev-parse', 'HEAD'], sourceDirectory);
    if (head !== plan.revision) throw new Error(`FeatureBench source pin mismatch after prep: ${head}`);
    const dirty = await command(executor, 'git', ['-C', sourceDirectory, 'status', '--porcelain=v1', '--untracked-files=all'], sourceDirectory);
    if (dirty) throw new Error('FeatureBench pinned checkout is not a clean patch preimage');
    await command(executor, 'git', ['-C', sourceDirectory, 'apply', '--check', plan.patch], sourceDirectory);
    await command(executor, 'git', ['-C', sourceDirectory, 'apply', plan.patch], sourceDirectory);
    const env = allowlistedEnvironment(process.env);
    env.PYTHONDONTWRITEBYTECODE = '1';
    env.UV_LINK_MODE = 'copy';
    env.UV_NO_CONFIG = '1';
    await command(
      executor,
      'uv',
      [
        'sync',
        '--frozen',
        '--no-editable',
        '--no-config',
        '--link-mode',
        'copy',
        '--managed-python',
        '--python',
        plan.pythonVersion,
      ],
      sourceDirectory,
      env,
    );
    const environmentDirectory = join(sourceDirectory, '.venv');
    makeFeatureBenchEnvironmentRelocatable(stage, environmentDirectory);
    const pythonBinary = join(sourceDirectory, '.venv', 'bin', 'python');
    const fbBinary = join(sourceDirectory, '.venv', 'bin', 'fb');
    const pythonVersion = await command(executor, pythonBinary, ['--version'], sourceDirectory, env);
    if (pythonVersion !== `Python ${plan.pythonVersion}`) throw new Error(`unexpected FeatureBench Python version: ${pythonVersion}`);
    const downloadedParquet = await command(
      executor,
      pythonBinary,
      ['-c', FEATUREBENCH_DATASET_DOWNLOAD_SCRIPT],
      sourceDirectory,
      env,
    );
    const datasetParquetSha256 = verifyFeatureBenchDatasetArtifact(downloadedParquet);
    const datasetParquetPath = join(sourceDirectory, ...FEATUREBENCH_DATASET_PARQUET.split('/'));
    writePrivateFileAtomic(
      join(sourceDirectory, '.git'),
      datasetParquetPath,
      readFileSync(downloadedParquet),
    );
    env.FEATUREBENCH_DATASET_PARQUET = datasetParquetPath;
    const rawMap = await command(
      executor,
      pythonBinary,
      ['-c', FEATUREBENCH_DATASET_MEMBERSHIP_SCRIPT],
      sourceDirectory,
      env,
    );
    const datasetMap = parseFeatureBenchDatasetMap(JSON.parse(rawMap) as unknown);
    const mapPath = join(sourceDirectory, ...FEATUREBENCH_DATASET_MAP.split('/'));
    writePrivateFileAtomic(join(sourceDirectory, '.git'), mapPath, `${canonicalJson(datasetMap)}\n`);
    await requireExactPatch(executor, sourceDirectory, plan.patch);

    const tasks: FeatureBenchTaskInput[] = [];
    for (const imageRequested of new Set(Object.values(datasetMap.tasks))) {
      await command(executor, 'docker', ['pull', imageRequested], roots.benchRoot, env);
    }
    for (const [taskId, imageRequested] of Object.entries(datasetMap.tasks)) {
      const inspect = await command(executor, 'docker', ['image', 'inspect', imageRequested], roots.benchRoot);
      tasks.push({
        taskId,
        sourceSha256: sha256CanonicalJson({
          dataset: plan.dataset,
          revision: plan.datasetRevision,
          split: plan.split,
          taskId,
          imageRequested,
        }),
        imageRequested,
        ...parseImageInspect(inspect, imageRequested),
      });
    }
    removeFeatureBenchPythonCacheArtifacts(stage);
    assertNoFeatureBenchStageReferences(stage, stage);
    const source: SourceProvenance = {
      repository: plan.repository,
      revision: plan.revision,
      treeSha256: sourceTreeSha256(sourceDirectory),
    };
    const environmentIdentity = featureBenchEnvironmentIdentity(environmentDirectory);
    const manifestWithoutPayload = {
      schemaVersion: 4 as const,
      kind: 'ultracode-featurebench-inputs' as const,
      source,
      pythonVersion: plan.pythonVersion,
      ...environmentIdentity,
      fbSha256: sha256File(fbBinary),
      patchSha256: sha256File(plan.patch),
      datasetMapSha256: sha256File(mapPath),
      datasetParquetSha256,
      tasks,
      toolchainPayloadSha256: toolchain.provenance.payloadSha256,
    };
    writePrivateJsonAtomic(stage, join(stage, PREPARED_IDENTITY), manifestWithoutPayload);
    const payloadSha256 = sha256Tree(stage);
    writePrivateJsonAtomic(stage, join(stage, CONTENT_MANIFEST), { ...manifestWithoutPayload, payloadSha256 });
    const target = featureBenchPreparedDir(roots, payloadSha256);
    let publishedTarget = false;
    if (existsSync(target)) rmSync(stage, { recursive: true, force: true });
    else {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      renameSync(stage, target);
      publishedTarget = true;
    }
    try {
      let prepared = loadPreparedFeatureBenchInputs(target);
      await command(executor, prepared.fbBinary, ['--help'], cache, env);
      prepared = loadPreparedFeatureBenchInputs(target);
      writePrivateJsonAtomic(cache, featureBenchCurrentFile(roots), { schemaVersion: 3, identity: payloadSha256 });
      return prepared;
    } catch (error) {
      if (publishedTarget) rmSync(target, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

/** Re-attest the patched checkout immediately before native execution. */
export async function reattestPreparedFeatureBench(
  prepared: PreparedFeatureBenchInputs,
  roots: BenchPathRoots,
  executor: FeatureBenchExecutor = execute,
): Promise<void> {
  const loaded = loadPreparedFeatureBenchInputs(prepared.directory);
  const plan = planFeatureBenchPreparation(roots);
  const head = await command(executor, 'git', ['-C', loaded.sourceDirectory, 'rev-parse', 'HEAD'], loaded.sourceDirectory);
  if (head !== plan.revision) throw new Error('FeatureBench source revision drifted before launch');
  await requireExactPatch(executor, loaded.sourceDirectory, plan.patch);
}
