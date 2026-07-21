/** Frozen Docker process, privilege, capability, and resource containment policy. */
import { z } from 'zod';
import type { BenchPathRoots } from '../../shared/contracts.js';
import { readRegularFileWithinRoot } from '../../shared/paths.js';
import { sha256CanonicalJson } from '../../shared/provenance.js';
import type { SwebenchProConfig } from './config.js';

const PREFERRED_SESSION_TASK_ID = 1_000;

export interface SessionTaskIdentity {
  uid: number;
  gid: number;
}

/** Choose a stable positive task identity distinct from both host owner ids. */
export function sessionTaskIdentity(artifactOwner: SessionTaskIdentity): SessionTaskIdentity {
  const distinct = (owner: number): number => owner === PREFERRED_SESSION_TASK_ID
    ? PREFERRED_SESSION_TASK_ID + 1
    : PREFERRED_SESSION_TASK_ID;
  return { uid: distinct(artifactOwner.uid), gid: distinct(artifactOwner.gid) };
}

const boundedPolicySchema = z.strictObject({
  pidsLimit: z.literal(1_024),
  securityOpt: z.tuple([z.literal('no-new-privileges')]),
  capDrop: z.tuple([z.literal('ALL')]),
  capAdd: z.array(z.enum(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETPCAP', 'SETUID'])),
  resources: z.literal('manifest-docker'),
});

const containerPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('ultracode-swebench-pro-container-policy'),
  session: boundedPolicySchema.extend({
    capAdd: z.tuple([
      z.literal('CHOWN'),
      z.literal('DAC_OVERRIDE'),
      z.literal('SETGID'),
      z.literal('SETPCAP'),
      z.literal('SETUID'),
    ]),
  }),
  evaluator: boundedPolicySchema.extend({
    capAdd: z.tuple([]),
  }),
  reclamation: boundedPolicySchema.extend({
    pidsLimit: z.literal(64),
    capAdd: z.tuple([
      z.literal('CHOWN'),
      z.literal('DAC_OVERRIDE'),
      z.literal('FOWNER'),
    ]),
    networkMode: z.literal('none'),
    user: z.literal('0:0'),
  }),
});

export type SwebenchProContainerPolicy = z.infer<typeof containerPolicySchema>;

/** Reviewed canonical JSON identity of the complete static container policy. */
export const SWEBENCH_PRO_CONTAINER_POLICY_SHA256 =
  'a8963e9656e5e128ac2b4dfbe7c3d3ddc0457af21ba37e3203c7345d03cc70a0';

export interface EvaluatorContainerPolicy {
  pidsLimit: 1_024;
  securityOpt: ['no-new-privileges'];
  capDrop: ['ALL'];
  capAdd: [];
  nanoCpus: number;
  memoryBytes: number;
}

export function loadSwebenchProContainerPolicy(roots: BenchPathRoots): SwebenchProContainerPolicy {
  const policy = containerPolicySchema.parse(JSON.parse(readRegularFileWithinRoot(
    roots.benchRoot,
    'suites/swebench-pro/container-policy.json',
  ).toString('utf8')));
  containerPolicySha256(policy);
  return policy;
}

export function containerPolicySha256(policy: SwebenchProContainerPolicy): string {
  const observed = sha256CanonicalJson(policy);
  if (observed !== SWEBENCH_PRO_CONTAINER_POLICY_SHA256) {
    throw new Error('SWE-bench Pro static container policy does not match its reviewed canonical hash');
  }
  return observed;
}

/** Exact Docker CLI policy segment used for every agent session container. */
export function sessionContainerPolicyArgv(
  policy: SwebenchProContainerPolicy,
  docker: SwebenchProConfig['docker'],
): string[] {
  containerPolicySha256(policy);
  assertManifestResources(docker);
  return [
    '--pids-limit', String(policy.session.pidsLimit),
    ...policy.session.securityOpt.flatMap((option) => ['--security-opt', option]),
    ...policy.session.capDrop.flatMap((capability) => ['--cap-drop', capability]),
    ...policy.session.capAdd.flatMap((capability) => ['--cap-add', capability]),
    '--cpus', dockerCpuString(docker.cpus),
    '--memory', String(docker.memoryBytes),
  ];
}

/** Exact Docker CLI policy segment used for each root ownership-reclamation helper. */
export function reclamationContainerPolicyArgv(
  policy: SwebenchProContainerPolicy,
  docker: SwebenchProConfig['docker'],
): string[] {
  containerPolicySha256(policy);
  assertManifestResources(docker);
  return [
    '--network', policy.reclamation.networkMode,
    '--pids-limit', String(policy.reclamation.pidsLimit),
    ...policy.reclamation.securityOpt.flatMap((option) => ['--security-opt', option]),
    ...policy.reclamation.capDrop.flatMap((capability) => ['--cap-drop', capability]),
    ...policy.reclamation.capAdd.flatMap((capability) => ['--cap-add', capability]),
    '--cpus', dockerCpuString(docker.cpus),
    '--memory', String(docker.memoryBytes),
    '--user', policy.reclamation.user,
  ];
}

/** Exact Docker SDK HostConfig inputs used for each official evaluator container. */
export function evaluatorContainerPolicy(
  policy: SwebenchProContainerPolicy,
  docker: SwebenchProConfig['docker'],
): EvaluatorContainerPolicy {
  containerPolicySha256(policy);
  assertManifestResources(docker);
  const nanoCpus = dockerNanoCpus(docker.cpus);
  return {
    pidsLimit: policy.evaluator.pidsLimit,
    securityOpt: [...policy.evaluator.securityOpt],
    capDrop: [...policy.evaluator.capDrop],
    capAdd: [],
    nanoCpus,
    memoryBytes: docker.memoryBytes,
  };
}

/** Convert a manifest CPU limit to Docker's exact shared nanocore unit. */
export function dockerNanoCpus(cpus: number): number {
  if (typeof cpus !== 'number' || !Number.isFinite(cpus)) {
    throw new Error('SWE-bench Pro manifest CPU limit is invalid');
  }
  const nanoCpus = cpus * 1_000_000_000;
  if (!Number.isSafeInteger(nanoCpus) || nanoCpus <= 0) {
    throw new Error('SWE-bench Pro CPU limit must be an exact positive number of nanocores');
  }
  return nanoCpus;
}

function dockerCpuString(cpus: number): string {
  const nanoCpus = dockerNanoCpus(cpus);
  const wholeCpus = Math.floor(nanoCpus / 1_000_000_000);
  const fractionalCpus = String(nanoCpus % 1_000_000_000).padStart(9, '0').replace(/0+$/u, '');
  return fractionalCpus === '' ? String(wholeCpus) : `${wholeCpus}.${fractionalCpus}`;
}

function assertManifestResources(docker: SwebenchProConfig['docker']): void {
  dockerNanoCpus(docker.cpus);
  if (typeof docker.memoryBytes !== 'number'
    || !Number.isSafeInteger(docker.memoryBytes)
    || docker.memoryBytes <= 0) {
    throw new Error('SWE-bench Pro manifest memory limit is invalid');
  }
}
