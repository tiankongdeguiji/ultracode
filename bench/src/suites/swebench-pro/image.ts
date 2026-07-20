/** Digest-pinned Pro base images and re-attested COPY-only overlays. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BenchPathRoots } from '../../shared/contracts.js';
import { runBenchProcess } from '../../shared/process.js';
import type { DockerImageAttestation, SwebenchProInstance } from './types.js';

export const BASE_IMAGE_REPOSITORY = 'jefzda/sweap-images';
const PULL_BACKOFF_MS = [10_000, 30_000, 90_000];

export type DockerExecutor = (argv: readonly string[]) => Promise<string>;

export const defaultDockerExecutor: DockerExecutor = async (argv) => {
  const result = await runBenchProcess('docker', argv, { cwd: process.cwd(), tailBytes: 64 * 1_024 * 1_024 });
  return result.stdout;
};

interface ImageInspect {
  Id?: string;
  RepoDigests?: string[];
  Os?: string;
  Architecture?: string;
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
  return parseInspect(await docker(['image', 'inspect', reference]), reference);
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
      await docker(['pull', requested]);
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
  toolchainDirectory: string;
  toolchainPayloadSha256: string;
  docker?: DockerExecutor;
}

/** Build FROM the immutable digest and freeze both local image identities. */
export async function prepareTaskImage(
  instance: SwebenchProInstance,
  options: PrepareTaskImageOptions,
): Promise<DockerImageAttestation> {
  const docker = options.docker ?? defaultDockerExecutor;
  const requested = `${BASE_IMAGE_REPOSITORY}:${instance.dockerhubTag}`;
  await ensurePulled(requested, docker);
  const tagged = await inspect(requested, docker);
  const resolvedDigest = repositoryDigest(tagged);
  const base = await inspect(resolvedDigest, docker);
  const baseIdentity = identity(base, resolvedDigest);
  const overlayKey = createHash('sha256')
    .update(`${resolvedDigest}\0${options.toolchainPayloadSha256}\0${instance.instanceId}`, 'utf8')
    .digest('hex');
  const overlayName = `ultracode-swebench-pro:${overlayKey.slice(0, 48)}`;
  await docker([
    'build',
    '--pull=false',
    '--label', 'ultracode.benchmark.schema=2',
    '--label', 'ultracode.benchmark.suite=swebench-pro',
    '--label', 'ultracode.benchmark.purpose=prep',
    '-f', join(options.roots.benchRoot, 'suites', 'swebench-pro', 'Dockerfile'),
    '--build-arg', `BASE_IMAGE=${resolvedDigest}`,
    '-t', overlayName,
    options.toolchainDirectory,
  ]);
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
  let removed = 0;
  const exact = new Map(attestations.map((entry) => [entry.overlayLocalId, entry]));
  for (const attestation of exact.values()) {
    await reattestTaskImage(attestation, docker);
    try {
      await docker(['image', 'rm', attestation.overlayLocalId]);
      removed += 1;
    } catch {
      // An in-use image remains owned and can be retried by an exact run clean.
    }
  }
  return removed;
}
