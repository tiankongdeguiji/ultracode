/** One exhaustive failure taxonomy and disposition policy for every suite. */
import { z } from 'zod';
import { FAILURE_CODES, type Arm, type FailureCode } from './contracts.js';
import { sha256CanonicalJson } from './provenance.js';
import { validateTaskId } from './paths.js';

export const AGENT_AVOIDABLE_FAILURES = [
  'agent-crash',
  'agent-timeout',
  'empty-patch',
  'patch-too-large',
  'unapplyable-diff',
] as const satisfies readonly FailureCode[];

export const INFRASTRUCTURE_FAILURES = [
  'driver-watchdog',
  'driver-interrupted',
  'spawn-failed',
  'descendant-cleanup-failed',
  'native-runner-failed',
  'image-failed',
  'image-identity-drift',
  'toolchain-incompatible',
  'provenance-drift',
  'invalid-instance',
  'base-mismatch',
  'auth-failed',
  'rate-limited',
  'broker-failed',
  'network-policy-failed',
  'verifier-timeout',
  'verifier-process-failed',
  'verifier-output-missing',
  'verifier-output-malformed',
  'receipt-incomplete',
  'artifact-unsafe',
  'ownership-unsafe',
  'harness-setup-failed',
] as const satisfies readonly FailureCode[];

export const UNATTRIBUTED_FAILURES = [
  'unattributed-verifier-absence',
  'unknown-terminal',
] as const satisfies readonly FailureCode[];

export type FailureCategory = 'agent-avoidable' | 'infrastructure' | 'unattributed';
export type TaskDisposition =
  | 'included-native'
  | 'agent-loss'
  | 'infrastructure-excluded'
  | 'pending'
  | 'unverified-excluded';

interface DispositionNativeResult {
  verification: 'verified' | 'unverified';
}

const failureCodeSchema = z.enum(FAILURE_CODES);
const armSchema = z.enum(['a', 'b']);

export const observationScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run') }),
  z.strictObject({
    kind: z.literal('task-arm'),
    taskId: z.string().transform(validateTaskId),
    arm: armSchema,
  }),
  z.strictObject({ kind: z.literal('suite-check'), name: z.string().min(1).max(128) }),
]);

export const failureObservationSchema = z.strictObject({
  code: failureCodeSchema,
  scope: observationScopeSchema,
  phase: z.enum(['prep', 'inference', 'session', 'verifier', 'detached-wait', 'cleanup', 'report']).nullable(),
  terminal: z.boolean(),
  evidence: z.enum(['native', 'driver', 'verifier', 'harness']),
}).superRefine((failure, context) => {
  if (failure.code === 'agent-timeout' && failure.evidence !== 'native') {
    context.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: 'agent-timeout requires native task/session evidence; use driver-watchdog otherwise',
    });
  }
});

export const annotationSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/),
  scope: observationScopeSchema,
});

export type ObservationScope = z.infer<typeof observationScopeSchema>;
export type FailureObservation = z.infer<typeof failureObservationSchema>;
export type Annotation = z.infer<typeof annotationSchema>;

const AGENT_SET = new Set<FailureCode>(AGENT_AVOIDABLE_FAILURES);
const INFRASTRUCTURE_SET = new Set<FailureCode>(INFRASTRUCTURE_FAILURES);
const UNATTRIBUTED_SET = new Set<FailureCode>(UNATTRIBUTED_FAILURES);

if (new Set([...AGENT_SET, ...INFRASTRUCTURE_SET, ...UNATTRIBUTED_SET]).size !== FAILURE_CODES.length) {
  throw new Error('benchmark failure policy is not exhaustive');
}

export function failureCategory(code: FailureCode): FailureCategory {
  if (AGENT_SET.has(code)) return 'agent-avoidable';
  if (INFRASTRUCTURE_SET.has(code)) return 'infrastructure';
  if (UNATTRIBUTED_SET.has(code)) return 'unattributed';
  throw new Error(`unclassified failure code: ${String(code)}`);
}

export function taskArmScope(taskId: string, arm: Arm): ObservationScope {
  return observationScopeSchema.parse({ kind: 'task-arm', taskId, arm });
}

/** Apply policy without changing or synthesizing native verifier fields. */
export function taskDisposition(
  nativeVerifier: DispositionNativeResult,
  failures: readonly FailureObservation[],
  attemptRunning: boolean,
): TaskDisposition {
  if (nativeVerifier.verification === 'verified') return 'included-native';
  if (failures.some((failure) => failureCategory(failure.code) === 'infrastructure')) {
    return 'infrastructure-excluded';
  }
  const terminalAgentFailures = failures.filter((failure) =>
    failure.terminal && failureCategory(failure.code) === 'agent-avoidable');
  if (failures.length === 1 && terminalAgentFailures.length === 1) return 'agent-loss';
  if (attemptRunning) return 'pending';
  return 'unverified-excluded';
}

export const FAILURE_POLICY_SHA256 = sha256CanonicalJson({
  version: 2,
  categories: {
    agentAvoidable: AGENT_AVOIDABLE_FAILURES,
    infrastructure: INFRASTRUCTURE_FAILURES,
    unattributed: UNATTRIBUTED_FAILURES,
  },
  precedence: [
    'verified-native',
    'infrastructure',
    'single-terminal-agent-avoidable',
    'pending',
    'unverified',
  ],
  agentTimeoutEvidence: 'native-only',
  annotationsDoNotAffectDisposition: true,
});
