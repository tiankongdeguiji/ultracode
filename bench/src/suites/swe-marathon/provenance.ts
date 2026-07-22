/** Linear SWE-Marathon provenance: common inputs once, then one exact task immediately before launch. */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BenchPathRoots } from '../../shared/contracts.js';
import { runBenchProcess } from '../../shared/process.js';
import { canonicalJson, sha256File } from '../../shared/provenance.js';
import type { MarathonTaskInput, PreparedMarathonInputs } from './prepare.js';
import { marathonPreparedDir } from './config.js';
import {
  loadCurrentPreparedMarathonInputs,
  loadPreparedMarathonInputs,
  taskImageReference,
} from './prepare.js';

export interface MarathonCommonAttestation {
  prepared: PreparedMarathonInputs;
  preparedIdentity: string;
}

export type MarathonTaskAttestation = MarathonTaskInput;

export interface MarathonAttestationOperations {
  attestCommon(): MarathonCommonAttestation;
  attestTask(common: MarathonCommonAttestation, taskId: string): Promise<MarathonTaskAttestation>;
}

/** Fully re-attest common source, Harbor, and toolchain inputs exactly once per invocation. */
export function attestMarathonCommon(
  roots: BenchPathRoots,
  preparedIdentity?: string,
): MarathonCommonAttestation {
  const prepared = preparedIdentity === undefined
    ? loadCurrentPreparedMarathonInputs(roots)
    : loadPreparedMarathonInputs(marathonPreparedDir(roots, preparedIdentity));
  return { prepared, preparedIdentity: prepared.directory.split('/').at(-1)! };
}

interface DockerInspect {
  Id?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  RepoDigests?: unknown;
}

/** Re-attest only the selected task config and image immediately before its Harbor process. */
export async function attestMarathonTask(
  common: MarathonCommonAttestation,
  taskId: string,
): Promise<MarathonTaskAttestation> {
  const expected = common.prepared.tasks.find((task) => task.taskId === taskId);
  if (!expected) throw new Error(`task is absent from prepared SWE-Marathon inputs: ${taskId}`);
  const config = join(common.prepared.sourceDirectory, ...expected.configRelativePath.split('/'));
  if (sha256File(config) !== expected.configSha256) throw new Error(`SWE-Marathon task config drifted: ${taskId}`);
  const requested = taskImageReference(readFileSync(config, 'utf8'));
  const result = await runBenchProcess('docker', ['image', 'inspect', requested], {
    cwd: common.prepared.sourceDirectory,
    tailBytes: 8 * 1_024 * 1_024,
  });
  let images: DockerInspect[];
  try { images = JSON.parse(result.stdout) as DockerInspect[]; } catch (error) {
    throw new Error(`Docker returned malformed task image evidence for ${taskId}`, { cause: error });
  }
  const image = images.length === 1 ? images[0] : undefined;
  const digests = Array.isArray(image?.RepoDigests)
    ? image.RepoDigests.filter((value): value is string => typeof value === 'string')
    : [];
  const actual = {
    ...expected,
    imageRequested: requested,
    imageResolvedDigest: requested,
    imageLocalId: typeof image?.Id === 'string' ? image.Id : '',
    imagePlatform: typeof image?.Os === 'string' && typeof image.Architecture === 'string'
      ? `${image.Os}/${image.Architecture}`
      : '',
  };
  if (!digests.includes(requested) || canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`SWE-Marathon task image identity drifted: ${taskId}`);
  }
  return actual;
}

/** Run a task sequence with O(1) common attestations and O(n) task attestations. */
export async function reattestTasksLinearly<T>(
  taskIds: readonly string[],
  operations: MarathonAttestationOperations,
  launch: (task: MarathonTaskAttestation, common: MarathonCommonAttestation) => Promise<T>,
): Promise<T[]> {
  const common = operations.attestCommon();
  const results: T[] = [];
  for (const taskId of taskIds) {
    const task = await operations.attestTask(common, taskId);
    results.push(await launch(task, common));
  }
  return results;
}
