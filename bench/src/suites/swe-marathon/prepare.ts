/** Content-addressed preparation of the pinned SWE-Marathon source and Harbor runtime. */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BenchPathRoots } from '../../shared/contracts.js';
import type { ToolchainConfig } from '../../shared/config.js';
import {
  ensureRealDirectoryWithin,
  readPrivateJson,
  readRegularFileWithinRoot,
  writePrivateJsonAtomic,
} from '../../shared/paths.js';
import { runBenchProcess } from '../../shared/process.js';
import {
  canonicalJson,
  sha256File,
  sha256Tree,
  pythonEnvironmentSha256,
  type SourceProvenance,
} from '../../shared/provenance.js';
import { loadPreparedToolchain, prepareSharedToolchain, type PreparedToolchain } from '../../shared/toolchain.js';
import {
  EXCLUDED_CUA_TASKS,
  SWE_MARATHON_HARBOR_VERSION,
  SWE_MARATHON_PYTHON_VERSION,
  SWE_MARATHON_REPOSITORY,
  SWE_MARATHON_SOURCE_REVISION,
  SWE_MARATHON_TASKS,
  marathonCacheRoot,
  marathonCurrentFile,
  marathonPreparedDir,
} from './config.js';

const CONTENT_MANIFEST = 'content-manifest.json';
const PREPARED_IDENTITY = 'prepared-identity.json';
const EXCLUDED = new Set<string>(EXCLUDED_CUA_TASKS);

export interface MarathonTaskInput {
  taskId: string;
  configRelativePath: string;
  configSha256: string;
  imageRequested: string;
  imageResolvedDigest: string;
  imageLocalId: string;
  imagePlatform: string;
}

interface MarathonContentManifest {
  schemaVersion: 2;
  kind: 'ultracode-swe-marathon-inputs';
  payloadSha256: string;
  source: SourceProvenance;
  pythonVersion: string;
  harborVersion: string;
  environmentSha256: string;
  harborSha256: string;
  ownershipPatchSha256: string;
  bridgeSha256: string;
  tasks: MarathonTaskInput[];
  toolchainPayloadSha256: string;
}

export interface PreparedMarathonInputs {
  directory: string;
  sourceDirectory: string;
  environmentDirectory: string;
  pythonBinary: string;
  harborBinary: string;
  source: SourceProvenance;
  pythonVersion: string;
  harborVersion: string;
  environmentSha256: string;
  ownershipPatchSha256: string;
  bridgeSha256: string;
  tasks: MarathonTaskInput[];
  toolchain: PreparedToolchain;
}

export interface MarathonPrepPlan {
  repository: string;
  revision: string;
  pythonVersion: string;
  harborVersion: string;
  ownershipPatch: string;
  bridge: string;
}

/** Return public immutable prep inputs without consulting credentials or the network. */
export function planMarathonPreparation(roots: BenchPathRoots): MarathonPrepPlan {
  return {
    repository: SWE_MARATHON_REPOSITORY,
    revision: SWE_MARATHON_SOURCE_REVISION,
    pythonVersion: SWE_MARATHON_PYTHON_VERSION,
    harborVersion: SWE_MARATHON_HARBOR_VERSION,
    ownershipPatch: join(roots.benchRoot, 'suites', 'swe-marathon', 'harbor-ownership.patch'),
    bridge: join(roots.benchRoot, 'suites', 'swe-marathon', 'arm_b_codex.py'),
  };
}

/** Guard known statement order in the exact pinned Harbor source used by Arm B. */
export function validateHarborCodexApiKeyContract(source: string): void {
  const markers = [
    'Codex auth: using OPENAI_API_KEY',
    'env["OPENAI_API_KEY"]',
    '"$CODEX_HOME/auth.json"',
    'mcp_command = self._build_register_mcp_servers_command()',
    'command=setup_command',
  ];
  let offset = 0;
  for (const marker of markers) {
    const index = source.indexOf(marker, offset);
    if (index === -1) {
      throw new Error('pinned Harbor Codex API-key auth no longer creates CODEX_HOME/auth.json before MCP registration');
    }
    offset = index + marker.length;
  }
}

/** Parse the immutable image reference from the pinned task TOML. */
export function taskImageReference(taskToml: string): string {
  let section = '';
  const images: string[] = [];
  for (const line of taskToml.split(/\r?\n/u)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (header) {
      section = header[1]!;
      continue;
    }
    if (section !== 'environment') continue;
    const declaration = /^\s*docker_image\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$/u.exec(line);
    if (declaration) images.push(declaration[1]!);
  }
  if (images.length !== 1 || !/^[^\s@]+@sha256:[a-f0-9]{64}$/u.test(images[0]!)) {
    throw new Error('SWE-Marathon task must declare an immutable environment.docker_image sha256 digest');
  }
  return images[0]!;
}

interface DockerImageInspect {
  Id?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  RepoDigests?: unknown;
}

function parseDockerImageInspect(stdout: string, requested: string): Pick<MarathonTaskInput,
  'imageResolvedDigest' | 'imageLocalId' | 'imagePlatform'> {
  let parsed: DockerImageInspect[];
  try {
    parsed = JSON.parse(stdout) as DockerImageInspect[];
  } catch (error) {
    throw new Error(`Docker returned malformed image inspection for ${requested}`, { cause: error });
  }
  const image = parsed.length === 1 ? parsed[0] : undefined;
  const digests = Array.isArray(image?.RepoDigests) ? image.RepoDigests.filter((value): value is string => typeof value === 'string') : [];
  if (typeof image?.Id !== 'string' || typeof image.Os !== 'string' || typeof image.Architecture !== 'string'
    || !digests.includes(requested)) {
    throw new Error(`local Docker image identity does not attest ${requested}`);
  }
  return {
    imageResolvedDigest: requested,
    imageLocalId: image.Id,
    imagePlatform: `${image.Os}/${image.Architecture}`,
  };
}

async function command(file: string, argv: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return (await runBenchProcess(file, argv, { cwd, env, tailBytes: 64 * 1_024 * 1_024 })).stdout.trim();
}

export type MarathonPreparationCommand = (
  file: string,
  argv: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

/** Fail before preparation side effects when suite-specific host tools are unavailable. */
export async function preflightMarathonPreparation(
  cwd: string,
  uvBinary = 'uv',
  executor: MarathonPreparationCommand = command,
): Promise<void> {
  try {
    const version = await executor(uvBinary, ['--version'], cwd);
    if (!/^uv\s+\S+/u.test(version)) throw new Error('malformed uv version output');
  } catch (error) {
    throw new Error('SWE-Marathon prep requires uv on PATH (`uv --version` failed)', { cause: error });
  }
  try {
    const version = await executor('patch', ['--version'], cwd);
    if (!/\bGNU patch\b/iu.test(version)) throw new Error('unsupported patch implementation');
  } catch (error) {
    throw new Error('SWE-Marathon prep requires GNU patch on PATH (`patch --version` failed)', { cause: error });
  }
}

function assertHostPlatform(): void {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`SWE-Marathon requires a Linux x64 host, got ${process.platform}-${process.arch}`);
  }
}

function normalizeEnvironmentEntrypoints(environmentDirectory: string): void {
  const bin = join(environmentDirectory, 'bin');
  for (const entry of readdirSync(bin, { withFileTypes: true })) {
    const path = join(bin, entry.name);
    if (entry.isFile() && /^activate(?:\.|$)/u.test(entry.name)) {
      rmSync(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = lstatSync(path);
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 2).toString('utf8') !== '#!') continue;
    const text = bytes.toString('utf8');
    writeFileSync(path, text.replace(/^#![^\r\n]+/u, '#!/usr/bin/env python3'));
    chmodSync(path, info.mode & 0o777);
  }
}

function manifestFrom(directory: string): MarathonContentManifest {
  const value = readPrivateJson(directory, join(directory, CONTENT_MANIFEST)) as Partial<MarathonContentManifest>;
  const sha256 = (candidate: unknown): candidate is string => typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate);
  const runnableTasks = SWE_MARATHON_TASKS.filter((taskId) => !EXCLUDED.has(taskId));
  if (value.schemaVersion !== 2 || value.kind !== 'ultracode-swe-marathon-inputs'
    || !sha256(value.payloadSha256) || !sha256(value.environmentSha256)
    || !sha256(value.harborSha256) || !sha256(value.ownershipPatchSha256)
    || !sha256(value.bridgeSha256) || !sha256(value.toolchainPayloadSha256)
    || !Array.isArray(value.tasks) || value.source === undefined
    || value.source.repository !== SWE_MARATHON_REPOSITORY
    || value.source.revision !== SWE_MARATHON_SOURCE_REVISION
    || !sha256(value.source.treeSha256)
    || canonicalJson(value.tasks.map((task) => task.taskId)) !== canonicalJson(runnableTasks)
    || value.tasks.some((task) => task.configRelativePath !== `tasks/${task.taskId}/task.toml`
      || !sha256(task.configSha256)
      || task.imageRequested !== task.imageResolvedDigest
      || !/^[^\s@]+@sha256:[a-f0-9]{64}$/u.test(task.imageRequested)
      || typeof task.imageLocalId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(task.imageLocalId)
      || typeof task.imagePlatform !== 'string' || !/^linux\/[a-z0-9_]+$/u.test(task.imagePlatform))
    || value.pythonVersion !== SWE_MARATHON_PYTHON_VERSION || value.harborVersion !== SWE_MARATHON_HARBOR_VERSION) {
    throw new Error('prepared SWE-Marathon content manifest is malformed or incompatible');
  }
  return value as MarathonContentManifest;
}

/** Load and fully re-attest one published suite input directory. */
export function loadPreparedMarathonInputs(directory: string): PreparedMarathonInputs {
  const resolved = resolve(directory);
  const manifest = manifestFrom(resolved);
  const payloadSha256 = sha256Tree(resolved, { exclude: [CONTENT_MANIFEST], excludePythonCacheArtifacts: true });
  const manifestIdentity: Partial<MarathonContentManifest> = { ...manifest };
  delete manifestIdentity.payloadSha256;
  const storedIdentity = readPrivateJson(resolved, join(resolved, PREPARED_IDENTITY));
  if (payloadSha256 !== manifest.payloadSha256 || resolved !== resolve(resolved, '..', payloadSha256)) {
    throw new Error('prepared SWE-Marathon payload identity drifted');
  }
  if (canonicalJson(storedIdentity) !== canonicalJson(manifestIdentity)) {
    throw new Error('prepared SWE-Marathon identity record drifted');
  }
  const sourceDirectory = join(resolved, 'source');
  const environmentDirectory = join(resolved, 'environment');
  const pythonBinary = join(environmentDirectory, 'bin', 'python');
  const harborBinary = join(environmentDirectory, 'bin', 'harbor');
  if (sha256Tree(sourceDirectory) !== manifest.source.treeSha256
    || pythonEnvironmentSha256(environmentDirectory) !== manifest.environmentSha256
    || sha256File(harborBinary) !== manifest.harborSha256) {
    throw new Error('prepared SWE-Marathon source or Harbor environment drifted');
  }
  for (const task of manifest.tasks) {
    const configPath = join(sourceDirectory, ...task.configRelativePath.split('/'));
    if (sha256File(configPath) !== task.configSha256
      || taskImageReference(readRegularFileWithinRoot(sourceDirectory, task.configRelativePath).toString('utf8')) !== task.imageRequested) {
      throw new Error(`prepared SWE-Marathon task input drifted: ${task.taskId}`);
    }
  }
  return {
    directory: resolved,
    sourceDirectory,
    environmentDirectory,
    pythonBinary,
    harborBinary,
    source: manifest.source,
    pythonVersion: manifest.pythonVersion,
    harborVersion: manifest.harborVersion,
    environmentSha256: manifest.environmentSha256,
    ownershipPatchSha256: manifest.ownershipPatchSha256,
    bridgeSha256: manifest.bridgeSha256,
    tasks: manifest.tasks,
    toolchain: loadPreparedToolchain(join(resolved, '..', '..', 'toolchains', manifest.toolchainPayloadSha256)),
  };
}

/** Resolve the current pointer and reject any mutable or missing preparation. */
export function loadCurrentPreparedMarathonInputs(roots: BenchPathRoots): PreparedMarathonInputs {
  const cache = marathonCacheRoot(roots);
  const current = readPrivateJson(cache, marathonCurrentFile(roots)) as { schemaVersion?: unknown; identity?: unknown };
  if (current.schemaVersion !== 2 || typeof current.identity !== 'string' || !/^[a-f0-9]{64}$/.test(current.identity)) {
    throw new Error('SWE-Marathon current preparation pointer is malformed');
  }
  return loadPreparedMarathonInputs(marathonPreparedDir(roots, current.identity));
}

/** Build and publish exact pinned native inputs. This is the only networked preparation path. */
export async function prepareMarathonInputs(
  roots: BenchPathRoots,
  toolchainConfig: ToolchainConfig,
  uvBinary = 'uv',
): Promise<PreparedMarathonInputs> {
  assertHostPlatform();
  await preflightMarathonPreparation(roots.benchRoot, uvBinary);
  const plan = planMarathonPreparation(roots);
  const cache = ensureRealDirectoryWithin(roots.cacheRoot, marathonCacheRoot(roots));
  const stage = join(cache, `.stage-${process.pid}-${randomBytes(12).toString('hex')}`);
  mkdirSync(stage, { mode: 0o700 });
  const sourceDirectory = join(stage, 'source');
  const environmentDirectory = join(stage, 'environment');
  try {
    const daemon = await command('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}'], roots.benchRoot);
    if (!['linux/x86_64', 'linux/amd64'].includes(daemon)) {
      throw new Error(`SWE-Marathon requires a Linux amd64 Docker daemon, got ${daemon || '(empty)'}`);
    }
    const toolchain = await prepareSharedToolchain(toolchainConfig, roots);
    await command('git', ['clone', '--filter=blob:none', '--no-checkout', plan.repository, sourceDirectory], roots.benchRoot);
    await command('git', ['-C', sourceDirectory, 'fetch', '--depth=1', 'origin', plan.revision], roots.benchRoot);
    await command('git', ['-C', sourceDirectory, 'checkout', '--detach', plan.revision], roots.benchRoot);
    const head = await command('git', ['-C', sourceDirectory, 'rev-parse', 'HEAD'], roots.benchRoot);
    if (head !== plan.revision) throw new Error(`SWE-Marathon source pin mismatch after prep: ${head}`);
    const dirty = await command('git', ['-C', sourceDirectory, 'status', '--porcelain', '--untracked-files=all'], roots.benchRoot);
    if (dirty) throw new Error('fresh SWE-Marathon checkout is unexpectedly dirty');
    await command(uvBinary, [
      'sync', '--project', sourceDirectory, '--python', plan.pythonVersion, '--frozen', '--no-install-project',
    ], roots.benchRoot, {
      UV_PROJECT_ENVIRONMENT: environmentDirectory,
    });
    const pythonBinary = join(environmentDirectory, 'bin', 'python');
    const harborBinary = join(environmentDirectory, 'bin', 'harbor');
    const pythonVersion = await command(pythonBinary, ['--version'], roots.benchRoot);
    const harborVersion = await command(harborBinary, ['--version'], roots.benchRoot);
    if (pythonVersion !== `Python ${plan.pythonVersion}`) throw new Error(`unexpected Python version: ${pythonVersion}`);
    if (harborVersion !== plan.harborVersion) throw new Error(`unexpected Harbor version: ${harborVersion}`);
    const sitePackages = await command(pythonBinary, [
      '-c', 'import pathlib, harbor; print(pathlib.Path(harbor.__file__).resolve().parent.parent)',
    ], roots.benchRoot);
    validateHarborCodexApiKeyContract(readFileSync(
      join(sitePackages, 'harbor', 'agents', 'installed', 'codex.py'),
      'utf8',
    ));
    await command('patch', ['--batch', '--forward', '-p1', '-d', sitePackages, '-i', plan.ownershipPatch], roots.benchRoot);
    normalizeEnvironmentEntrypoints(environmentDirectory);
    if (!readFileSync(harborBinary, 'utf8').startsWith('#!/usr/bin/env python3')) {
      throw new Error('prepared Harbor entrypoint has no normalized Python shebang');
    }

    const tasks: MarathonTaskInput[] = [];
    for (const taskId of SWE_MARATHON_TASKS) {
      if (EXCLUDED.has(taskId)) continue;
      const configRelativePath = `tasks/${taskId}/task.toml`;
      const configPath = join(sourceDirectory, ...configRelativePath.split('/'));
      const imageRequested = taskImageReference(readFileSync(configPath, 'utf8'));
      await command('docker', ['pull', imageRequested], roots.benchRoot);
      const inspect = await command('docker', ['image', 'inspect', imageRequested], roots.benchRoot);
      tasks.push({
        taskId,
        configRelativePath,
        configSha256: sha256File(configPath),
        imageRequested,
        ...parseDockerImageInspect(inspect, imageRequested),
      });
    }
    rmSync(join(sourceDirectory, '.git'), { recursive: true, force: true });
    const source: SourceProvenance = {
      repository: plan.repository,
      revision: plan.revision,
      treeSha256: sha256Tree(sourceDirectory),
    };
    const environmentSha256 = pythonEnvironmentSha256(environmentDirectory);
    const manifestWithoutPayload = {
      schemaVersion: 2 as const,
      kind: 'ultracode-swe-marathon-inputs' as const,
      source,
      pythonVersion: plan.pythonVersion,
      harborVersion: plan.harborVersion,
      environmentSha256,
      harborSha256: sha256File(harborBinary),
      ownershipPatchSha256: sha256File(plan.ownershipPatch),
      bridgeSha256: sha256File(plan.bridge),
      tasks,
      toolchainPayloadSha256: toolchain.provenance.payloadSha256,
    };
    writePrivateJsonAtomic(stage, join(stage, PREPARED_IDENTITY), manifestWithoutPayload);
    const payloadSha256 = sha256Tree(stage, { excludePythonCacheArtifacts: true });
    const manifest: MarathonContentManifest = { ...manifestWithoutPayload, payloadSha256 };
    writePrivateJsonAtomic(stage, join(stage, CONTENT_MANIFEST), manifest);
    const target = marathonPreparedDir(roots, payloadSha256);
    if (existsSync(target)) rmSync(stage, { recursive: true, force: true });
    else {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      renameSync(stage, target);
    }
    writePrivateJsonAtomic(cache, marathonCurrentFile(roots), { schemaVersion: 2, identity: payloadSha256 });
    return loadPreparedMarathonInputs(target);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
