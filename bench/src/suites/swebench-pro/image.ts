/** Digest-pinned Pro base images and re-attested COPY-only overlays. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BenchPathRoots } from '../../shared/contracts.js';
import { validateRunId } from '../../shared/paths.js';
import { runBenchProcess } from '../../shared/process.js';
import type { DockerImageAttestation, SwebenchProInstance } from './types.js';
import { ownershipUnsafe, ownershipUnsafeAggregate } from './cleanup.js';

export const BASE_IMAGE_REPOSITORY = 'jefzda/sweap-images';
const PULL_BACKOFF_MS = [10_000, 30_000, 90_000];
const IMAGE_QUERY_TIMEOUT_MS = 60_000;
const IMAGE_TRANSFER_TIMEOUT_MS = 30 * 60_000;

export type DockerExecutor = (argv: readonly string[], timeoutMs?: number) => Promise<string>;

export const defaultDockerExecutor: DockerExecutor = async (argv, timeoutMs) => {
  const result = await runBenchProcess('docker', argv, {
    cwd: process.cwd(),
    tailBytes: 64 * 1_024 * 1_024,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return result.stdout;
};

interface ImageInspect {
  Id?: string;
  RepoDigests?: string[];
  Os?: string;
  Architecture?: string;
  Config?: { OnBuild?: unknown; Volumes?: unknown };
}

function parseInspect(output: string, description: string): ImageInspect {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === null || typeof parsed[0] !== 'object') {
    throw new Error(`${description} inspect returned an unexpected shape`);
  }
  return parsed[0] as ImageInspect;
}

function identity(record: ImageInspect, description: string): { localId: string; platform: string } {
  if (!record.Id || !/^sha256:[a-f0-9]{64}$/.test(record.Id)
    || !record.Os || !/^[a-z0-9_]+$/.test(record.Os)
    || !record.Architecture || !/^[a-z0-9_]+$/.test(record.Architecture)) {
    throw new Error(`${description} has incomplete local identity`);
  }
  return { localId: record.Id, platform: `${record.Os}/${record.Architecture}` };
}

function assertNoInheritedBuildTriggers(record: ImageInspect): void {
  const onBuild = record.Config?.OnBuild;
  if (onBuild !== null && !(Array.isArray(onBuild) && onBuild.length === 0)) {
    throw new Error('base image must declare no inherited ONBUILD triggers');
  }
  const volumes = record.Config?.Volumes;
  if (volumes !== null && volumes !== undefined
    && (typeof volumes !== 'object' || Array.isArray(volumes) || Object.keys(volumes).length > 0)) {
    throw new Error('base image must declare no inherited volumes');
  }
}

function stageTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: lstatSync(source).mode & 0o777 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) stageTree(from, to);
    else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (entry.isFile()) {
      try {
        linkSync(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        copyFileSync(from, to);
        chmodSync(to, lstatSync(from).mode & 0o777);
      }
    } else {
      throw new Error(`unsupported prepared-toolchain entry: ${from}`);
    }
  }
}

interface PrepContainerInspect {
  Id?: string;
  Name?: string;
  Image?: string;
  Config?: { Labels?: Record<string, string> };
  State?: { Running?: boolean };
}

function prepLabels(runId: string, taskId: string): Record<string, string> {
  return {
    'ultracode.benchmark.schema': '2',
    'ultracode.benchmark.suite': 'swebench-pro',
    'ultracode.benchmark.run': runId,
    'ultracode.benchmark.task': taskId,
    'ultracode.benchmark.purpose': 'prep',
    'ultracode.benchmark.ownership': '1',
  };
}

async function exactPrepContainer(
  name: string,
  baseLocalId: string,
  labels: Record<string, string>,
  docker: DockerExecutor,
): Promise<PrepContainerInspect | null> {
  const ids = (await docker([
    'ps', '-aq', '--no-trunc', '--filter', `name=^/${name}$`,
  ], IMAGE_QUERY_TIMEOUT_MS)).split('\n').map((entry) => entry.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0]!)) {
    throw new Error('repository-prep container name is not uniquely bound');
  }
  const parsed = JSON.parse(await docker(['inspect', ids[0]!], IMAGE_QUERY_TIMEOUT_MS)) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === null || typeof parsed[0] !== 'object') {
    throw new Error('repository-prep container inspection is malformed');
  }
  const record = parsed[0] as PrepContainerInspect;
  const observedLabels = record.Config?.Labels ?? {};
  const labelsMatch = Object.entries(labels).every(([key, value]) => observedLabels[key] === value);
  if (record.Id !== ids[0] || record.Name !== `/${name}` || record.Image !== baseLocalId
    || record.State?.Running !== false
    || !labelsMatch) {
    throw new Error('repository-prep container does not match its exact stopped identity');
  }
  return record;
}

async function removePrepContainer(
  name: string,
  baseLocalId: string,
  labels: Record<string, string>,
  docker: DockerExecutor,
): Promise<void> {
  const record = await exactPrepContainer(name, baseLocalId, labels, docker);
  if (record === null) return;
  await docker(['rm', '-fv', record.Id!], IMAGE_QUERY_TIMEOUT_MS);
  if (await exactPrepContainer(name, baseLocalId, labels, docker) !== null) {
    throw new Error('repository-prep container absence was not proven');
  }
}

export interface TaskBuildContextInput {
  roots: BenchPathRoots;
  contextDirectory: string;
  toolchainDirectory: string;
  runId: string;
  instance: SwebenchProInstance;
  resolvedDigest: string;
  baseLocalId: string;
  docker: DockerExecutor;
}

/** Extract without starting task code, then sanitize once with host-side trusted Git tooling. */
export async function prepareTaskBuildContext(input: TaskBuildContextInput): Promise<void> {
  stageTree(input.toolchainDirectory, input.contextDirectory);
  const repository = join(input.contextDirectory, 'sanitized-repository');
  const audit = join(input.contextDirectory, '.git-audit');
  mkdirSync(repository, { mode: 0o700 });
  mkdirSync(audit, { mode: 0o700 });
  const key = createHash('sha256')
    .update(`${input.runId}\0${input.instance.instanceId}`, 'utf8')
    .digest('hex').slice(0, 32);
  const name = `ucbench-prep-${key}`;
  const labels = prepLabels(input.runId, input.instance.instanceId);
  await removePrepContainer(name, input.baseLocalId, labels, input.docker);
  let created = false;
  try {
    const id = (await input.docker([
      'create', '--name', name, '--network', 'none', '--no-healthcheck',
      ...Object.entries(labels).flatMap(([label, value]) => ['--label', `${label}=${value}`]),
      '--entrypoint', '/bin/false', input.resolvedDigest,
    ], IMAGE_QUERY_TIMEOUT_MS)).trim();
    created = true;
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker returned an invalid repository-prep id');
    const record = await exactPrepContainer(name, input.baseLocalId, labels, input.docker);
    if (record?.Id !== id) throw new Error('repository-prep id changed after creation');
    await input.docker(['cp', `${id}:/app/.`, repository], IMAGE_TRANSFER_TIMEOUT_MS);
  } finally {
    if (created || await exactPrepContainer(name, input.baseLocalId, labels, input.docker) !== null) {
      await removePrepContainer(name, input.baseLocalId, labels, input.docker);
    }
  }
  const tracked = await runBenchProcess('git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-C', repository, 'status', '--porcelain', '--untracked-files=no',
  ], {
    cwd: input.contextDirectory,
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    timeoutMs: IMAGE_QUERY_TIMEOUT_MS,
  });
  if (tracked.stdout.trim() !== '') {
    throw new Error('base image repository has tracked changes before host sanitization');
  }
  const sanitizer = join(input.roots.benchRoot, 'suites', 'swebench-pro', 'sanitize-git.sh');
  await runBenchProcess('bash', [sanitizer, repository, input.instance.baseCommit, audit], {
    cwd: input.contextDirectory,
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    timeoutMs: IMAGE_TRANSFER_TIMEOUT_MS,
    tailBytes: 8 * 1_024 * 1_024,
  });
  const status = await runBenchProcess('git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-C', repository, 'status', '--porcelain', '-z', '--untracked-files=all',
  ], {
    cwd: input.contextDirectory,
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    timeoutMs: IMAGE_QUERY_TIMEOUT_MS,
  });
  const parts = status.stdout.split('\0').filter(Boolean);
  const preDirty: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index]!;
    if (entry.startsWith('?? ')) preDirty.push(`:(literal)${entry.slice(3)}`);
    if (entry[0] === 'R' || entry[0] === 'C') index += 1;
  }
  writeFileSync(join(input.contextDirectory, 'predirty.z'), `${preDirty.join('\0')}${preDirty.length ? '\0' : ''}`);
  writeFileSync(join(input.contextDirectory, 'pre-status.txt'), status.stdout.replaceAll('\0', '\n'));
  copyFileSync(join(audit, 'safe.txt'), join(input.contextDirectory, 'git-audit.txt'));
  rmSync(audit, { recursive: true, force: true });
}

/** Select only the digest belonging to the requested repository. */
export function repositoryDigest(record: ImageInspect, repository = BASE_IMAGE_REPOSITORY): string {
  const prefix = `${repository}@sha256:`;
  const matches = (record.RepoDigests ?? []).filter((value) => value.startsWith(prefix));
  if (matches.length !== 1 || !/^.+@sha256:[a-f0-9]{64}$/.test(matches[0]!)) {
    throw new Error(`base image must expose exactly one digest for ${repository}`);
  }
  return matches[0]!;
}

async function inspect(reference: string, docker: DockerExecutor): Promise<ImageInspect> {
  return parseInspect(await docker(['image', 'inspect', reference], IMAGE_QUERY_TIMEOUT_MS), reference);
}

async function ensurePulled(requested: string, docker: DockerExecutor): Promise<void> {
  try {
    await inspect(requested, docker);
    return;
  } catch {
    // Pull below; a missing local tag is expected on first preparation.
  }
  let failure: unknown;
  for (let attempt = 0; attempt < PULL_BACKOFF_MS.length; attempt += 1) {
    try {
      await docker(['pull', requested], IMAGE_TRANSFER_TIMEOUT_MS);
      return;
    } catch (error) {
      failure = error;
      if (attempt < PULL_BACKOFF_MS.length - 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, PULL_BACKOFF_MS[attempt]));
      }
    }
  }
  throw new Error(`failed to pull ${requested}: ${failure instanceof Error ? failure.message : String(failure)}`);
}

export interface PrepareTaskImageOptions {
  roots: BenchPathRoots;
  runId: string;
  toolchainDirectory: string;
  toolchainPayloadSha256: string;
  docker?: DockerExecutor;
  prepareBuildContext?: (input: TaskBuildContextInput) => Promise<void>;
}

/** Remove run-owned pre-publication image tags and prove no matching tag remains. */
export async function removeTaskImageTargets(
  targets: readonly string[],
  docker: DockerExecutor = defaultDockerExecutor,
): Promise<number> {
  let removed = 0;
  for (const target of new Set(targets)) {
    if (!/^ultracode-swebench-pro:[a-f0-9]{48}$/.test(target)) {
      throw new Error(`invalid run-owned overlay target: ${target}`);
    }
    let removalFailure: unknown;
    try {
      await docker(['image', 'rm', target], IMAGE_QUERY_TIMEOUT_MS);
    } catch (error) {
      removalFailure = error;
    }
    const remaining = (await docker(
      ['image', 'ls', '-q', '--no-trunc', target],
      IMAGE_QUERY_TIMEOUT_MS,
    )).split('\n').map((entry) => entry.trim()).filter(Boolean);
    if (remaining.length > 0 || remaining.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id))) {
      throw ownershipUnsafeAggregate('run-owned overlay target absence was not proven', [
        removalFailure,
        new Error(`run-owned overlay target remains present: ${target}`),
      ]);
    }
    removed += 1;
  }
  return removed;
}

/** Build FROM the immutable digest and freeze both local image identities. */
export async function prepareTaskImage(
  instance: SwebenchProInstance,
  options: PrepareTaskImageOptions,
): Promise<DockerImageAttestation> {
  const docker = options.docker ?? defaultDockerExecutor;
  const runId = validateRunId(options.runId);
  const requested = `${BASE_IMAGE_REPOSITORY}:${instance.dockerhubTag}`;
  await ensurePulled(requested, docker);
  const tagged = await inspect(requested, docker);
  const resolvedDigest = repositoryDigest(tagged);
  const base = await inspect(resolvedDigest, docker);
  assertNoInheritedBuildTriggers(base);
  const baseIdentity = identity(base, resolvedDigest);
  const overlayKey = createHash('sha256')
    .update(`${runId}\0${resolvedDigest}\0${options.toolchainPayloadSha256}\0${instance.instanceId}`, 'utf8')
    .digest('hex');
  const overlayName = `ultracode-swebench-pro:${overlayKey.slice(0, 48)}`;
  const contextDirectory = mkdtempSync(join(tmpdir(), 'uc-pro-build-context-'));
  try {
    await (options.prepareBuildContext ?? prepareTaskBuildContext)({
      roots: options.roots,
      contextDirectory,
      toolchainDirectory: options.toolchainDirectory,
      runId,
      instance,
      resolvedDigest,
      baseLocalId: baseIdentity.localId,
      docker,
    });
    await docker([
      'build',
      '--pull=false',
      '--network=none',
      '--label', 'ultracode.benchmark.schema=2',
      '--label', 'ultracode.benchmark.suite=swebench-pro',
      '--label', 'ultracode.benchmark.purpose=prep',
      '--label', `ultracode.benchmark.run=${runId}`,
      '-f', join(options.roots.benchRoot, 'suites', 'swebench-pro', 'Dockerfile'),
      '--build-arg', `BASE_IMAGE=${resolvedDigest}`,
      '-t', overlayName,
      contextDirectory,
    ], IMAGE_TRANSFER_TIMEOUT_MS);
    const overlay = identity(await inspect(overlayName, docker), overlayName);
    return {
      requested,
      resolvedDigest,
      baseLocalId: baseIdentity.localId,
      basePlatform: baseIdentity.platform,
      overlayName,
      overlayLocalId: overlay.localId,
      overlayPlatform: overlay.platform,
    };
  } catch (error) {
    try {
      await removeTaskImageTargets([overlayName], docker);
    } catch (cleanupError) {
      throw ownershipUnsafeAggregate('failed to clean an unpublishable task overlay', [
        error,
        cleanupError,
      ]);
    }
    throw error;
  } finally {
    rmSync(contextDirectory, { recursive: true, force: true });
  }
}

/** Fail immediately if either immutable launch identity drifted. */
export async function reattestTaskImage(
  attestation: DockerImageAttestation,
  docker: DockerExecutor = defaultDockerExecutor,
): Promise<void> {
  const base = identity(await inspect(attestation.resolvedDigest, docker), attestation.resolvedDigest);
  const overlay = identity(await inspect(attestation.overlayName, docker), attestation.overlayName);
  if (base.localId !== attestation.baseLocalId || base.platform !== attestation.basePlatform) {
    throw new Error(`base image identity drifted for ${attestation.requested}`);
  }
  if (overlay.localId !== attestation.overlayLocalId || overlay.platform !== attestation.overlayPlatform) {
    throw new Error(`overlay image identity drifted for ${attestation.overlayName}`);
  }
}

export async function removeTaskImages(
  attestations: readonly DockerImageAttestation[],
  docker: DockerExecutor = defaultDockerExecutor,
): Promise<number> {
  try {
    const exact = new Map(attestations.map((entry) => [entry.overlayName, entry]));
    for (const attestation of exact.values()) {
      await reattestTaskImage(attestation, docker);
    }
    return await removeTaskImageTargets([...exact.keys()], docker);
  } catch (error) {
    throw ownershipUnsafe('unsafe SWE-bench Pro overlay image cleanup', error);
  }
}
