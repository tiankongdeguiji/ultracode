/** Frozen Docker process, privilege, capability, and resource containment policy. */
import { z } from 'zod';
import type { BenchPathRoots } from '../../shared/contracts.js';
import { readRegularFileWithinRoot } from '../../shared/paths.js';
import { sha256CanonicalJson } from '../../shared/provenance.js';
import type { SwebenchProConfig } from './config.js';

const boundedPolicySchema = z.strictObject({
  pidsLimit: z.number().int().positive(),
  securityOpt: z.tuple([z.literal('no-new-privileges')]),
  capDrop: z.tuple([z.literal('ALL')]),
  capAdd: z.array(z.enum(['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETPCAP', 'SETUID'])),
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
});

export type SwebenchProContainerPolicy = z.infer<typeof containerPolicySchema>;

export interface EvaluatorContainerPolicy {
  pidsLimit: number;
  securityOpt: ['no-new-privileges'];
  capDrop: ['ALL'];
  capAdd: [];
  nanoCpus: number;
  memoryBytes: number;
}

export function loadSwebenchProContainerPolicy(roots: BenchPathRoots): SwebenchProContainerPolicy {
  return containerPolicySchema.parse(JSON.parse(readRegularFileWithinRoot(
    roots.benchRoot,
    'suites/swebench-pro/container-policy.json',
  ).toString('utf8')));
}

export function containerPolicySha256(policy: SwebenchProContainerPolicy): string {
  return sha256CanonicalJson(policy);
}

/** Exact Docker CLI policy segment used for every agent session container. */
export function sessionContainerPolicyArgv(
  policy: SwebenchProContainerPolicy,
  docker: SwebenchProConfig['docker'],
): string[] {
  return [
    '--pids-limit', String(policy.session.pidsLimit),
    ...policy.session.securityOpt.flatMap((option) => ['--security-opt', option]),
    ...policy.session.capDrop.flatMap((capability) => ['--cap-drop', capability]),
    ...policy.session.capAdd.flatMap((capability) => ['--cap-add', capability]),
    '--cpus', String(docker.cpus),
    '--memory', String(docker.memoryBytes),
  ];
}

/** Exact Docker SDK HostConfig inputs used for each official evaluator container. */
export function evaluatorContainerPolicy(
  policy: SwebenchProContainerPolicy,
  docker: SwebenchProConfig['docker'],
): EvaluatorContainerPolicy {
  const nanoCpus = Math.round(docker.cpus * 1_000_000_000);
  if (!Number.isSafeInteger(nanoCpus) || nanoCpus <= 0) {
    throw new Error('SWE-bench Pro evaluator CPU limit cannot be represented as NanoCPUs');
  }
  return {
    pidsLimit: policy.evaluator.pidsLimit,
    securityOpt: [...policy.evaluator.securityOpt],
    capDrop: [...policy.evaluator.capDrop],
    capAdd: [],
    nanoCpus,
    memoryBytes: docker.memoryBytes,
  };
}
