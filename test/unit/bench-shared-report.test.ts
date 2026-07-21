/** Common report envelope, evidence binding, and failure policy tests. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FAILURE_CODES,
  type FailureCode,
} from '../../bench/src/shared/contracts.js';
import {
  AGENT_AVOIDABLE_FAILURES,
  INFRASTRUCTURE_FAILURES,
  UNATTRIBUTED_FAILURES,
  failureCategory,
  failureObservationSchema,
  taskArmScope,
  taskDisposition,
  type FailureObservation,
} from '../../bench/src/shared/failure.js';
import type { NormalizedMetrics } from '../../bench/src/shared/metrics.js';
import {
  buildBenchReport,
  renderBenchReportMarkdown,
  type SuiteAnalysisHook,
  type TaskReportInput,
} from '../../bench/src/shared/report.js';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const INVOCATION = '11111111-1111-4111-8111-111111111111';
const ANALYSIS_BINDING_IDENTITY = {
  invocationId: INVOCATION,
  scope: { kind: 'suite-check' as const, name: 'aggregate' },
  nativeRecordKey: null,
};

const analysisHook: SuiteAnalysisHook<'swebench-pro'> = {
  suite: 'swebench-pro',
  analyze: () => ({
    suite: 'swebench-pro',
    native: {
      arms: {
        a: { evaluated: 1, resolved: 1, rate: 1, wilson95: { lo: 1, hi: 1 } },
        b: { evaluated: 0, resolved: 0, rate: null, wilson95: { lo: null, hi: null } },
      },
      paired: { paired: 0, aOnly: 0, bOnly: 0, both: 0, neither: 0, mcnemarExactP: null },
      thesisCut: {
        inside: { paired: 0, aResolved: 0, bResolved: 0, aRate: null, bRate: null, delta: null },
        outside: { paired: 0, aResolved: 0, bResolved: 0, aRate: null, bRate: null, delta: null },
        unclassified: 1,
      },
    },
    policyAdjusted: {
      arms: {
        a: { evaluated: 1, resolved: 1, rate: 1, wilson95: { lo: 1, hi: 1 } },
        b: { evaluated: 1, resolved: 0, rate: 0, wilson95: { lo: 0, hi: 0 } },
      },
      paired: { paired: 1, aOnly: 1, bOnly: 0, both: 0, neither: 0, mcnemarExactP: 1 },
    },
  }),
};

function failure(
  code: FailureCode,
  arm: 'a' | 'b' = 'b',
  over: Partial<FailureObservation> = {},
): FailureObservation {
  return failureObservationSchema.parse({
    code,
    scope: taskArmScope('task-one', arm),
    phase: code.startsWith('verifier-') ? 'verifier' : 'session',
    terminal: true,
    evidence: code === 'agent-timeout' ? 'native' : 'harness',
    ...over,
  });
}

const unverified = {
  verification: 'unverified' as const,
  score: null,
  resolved: null,
  artifact: null,
};

function metrics(): NormalizedMetrics {
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    nonCachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    rawTokenCount: 0,
    cachedInputWeight: 0.1,
    discountedTokenEquivalent: 0,
  };
  return {
    schemaVersion: 2,
    requested: { model: 'gpt-test', effort: 'high' },
    effectiveEffort: { verification: 'unverified', values: {}, unknownSessions: 0, matchesRequested: null },
    sessions: { total: 0, host: 0, worker: 0, unknown: 0, items: [] },
    tokens: {
      total: usage,
      byBillingClass: { billable: usage, mock: usage, 'non-billable': usage, unknown: usage },
    },
    pricing: { currency: 'USD', verification: 'unpriced', billableCost: null },
    context: {
      highWaterMark: 0,
      windows: [],
      maximumPressureRatio: null,
      pressuredSessions: 0,
      explicitCompactions: 0,
      inferredPromptResets: 0,
    },
    workflows: { count: 0, agentCount: 0, failureCount: 0, workspacesKept: 0, items: [] },
    timing: {
      runElapsedMs: 0,
      calendarSpanMs: 0,
      criticalPathMs: 0,
      summedTaskMs: 0,
      nativeRunnerMs: 0,
      verifierMs: 0,
      detachedWorkflowWaitMs: 0,
    },
    annotations: [],
    failures: [],
  };
}

function manifest() {
  return {
    schemaVersion: 2,
    kind: 'ultracode-benchmark-run',
    suite: 'swebench-pro',
    runId: 'run-one',
    createdAt: '2026-07-20T00:00:00.000Z',
    experiment: { model: 'gpt-test', requestedEffort: 'high', arm: 'both', taskIds: ['task-one'] },
    limits: {
      hostTaskTimeoutMs: null,
      hostVerifierTimeoutMs: null,
      taskConcurrency: 1,
      verifierConcurrency: 1,
    },
    metricsPolicy: {
      parserContractVersion: 2,
      cachedInputWeight: 0.1,
      compactionRule: 'max-event-record',
      resetMinDropTokens: 16_000,
      resetRetainedFraction: 0.5,
      workflowDedupeRule: 'run-id',
      implementationSha256: HASH,
    },
    pricing: null,
    provenance: {
      controlPlane: {
        manifestPolicySha256: HASH,
        metricsPolicySha256: HASH,
        failurePolicySha256: HASH,
        reportPolicySha256: HASH,
        adapterPolicySha256: HASH,
      },
      marker: 'frozen-provenance',
    },
    artifacts: {
      nativeRoot: 'native',
      runState: 'run-state.json',
      verifierReceipt: 'verifier-receipt.json',
      reportJson: 'report.json',
      reportMarkdown: 'report.md',
      executions: [
        { taskId: 'task-one', arm: 'a', key: 'unused', nativeRoot: 'native/a' },
        { taskId: 'task-one', arm: 'b', key: 'unused', nativeRoot: 'native/b' },
      ],
    },
    suiteConfig: { frozen: true },
  } as const;
}

function state() {
  return {
    schemaVersion: 2,
    kind: 'ultracode-benchmark-run-state',
    suite: 'swebench-pro',
    runId: 'run-one',
    manifestSha256: HASH,
    revision: 0,
    invocations: [],
    attempts: [],
  } as const;
}

function receipt() {
  return {
    schemaVersion: 2,
    kind: 'ultracode-benchmark-verifier-receipt',
    suite: 'swebench-pro',
    runId: 'run-one',
    manifestSha256: HASH,
    revision: 1,
    updatedAt: '2026-07-20T00:01:00.000Z',
    bindings: [{
      invocationId: INVOCATION,
      scope: { kind: 'task-arm', taskId: 'task-one', arm: 'a' },
      role: 'native-result',
      path: 'native/a/verdict.json',
      sha256: OTHER_HASH,
      nativeRecordKey: 'task-one:a',
    }],
  } as const;
}

function taskInputs(): TaskReportInput[] {
  return [
    {
      invocationId: INVOCATION,
      taskId: 'task-one',
      arm: 'a',
      nativeVerifier: {
        verification: 'verified',
        score: 1,
        resolved: true,
        artifact: { path: 'native/a/verdict.json' as never, sha256: OTHER_HASH, nativeRecordKey: 'task-one:a' },
      },
      failures: [],
      annotations: [],
      attemptRunning: false,
    },
    {
      invocationId: INVOCATION,
      taskId: 'task-one',
      arm: 'b',
      nativeVerifier: unverified,
      failures: [failure('empty-patch')],
      annotations: [],
      attemptRunning: false,
    },
  ];
}

function build(over: Record<string, unknown> = {}) {
  return buildBenchReport({
    manifest: manifest() as never,
    manifestSha256: HASH,
    runState: state() as never,
    runStateSha256: OTHER_HASH,
    runStateLedgerRootSha256: HASH,
    verifierReceipt: receipt() as never,
    verifierReceiptSha256: OTHER_HASH,
    metrics: metrics(),
    taskResults: taskInputs(),
    generatedAt: new Date('2026-07-20T00:02:00.000Z'),
    currentPolicyHashes: {
      metricsPolicySha256: HASH,
      failurePolicySha256: HASH,
      reportPolicySha256: HASH,
      adapterPolicySha256: HASH,
    },
    analysisHook,
    ...over,
  });
}

describe('shared failure and disposition policy', () => {
  it('classifies every registered code exactly once', () => {
    const policyCodes = [...AGENT_AVOIDABLE_FAILURES, ...INFRASTRUCTURE_FAILURES, ...UNATTRIBUTED_FAILURES];
    expect(new Set(policyCodes)).toEqual(new Set(FAILURE_CODES));
    expect(FAILURE_CODES.map(failureCategory)).toEqual([
      ...AGENT_AVOIDABLE_FAILURES.map(() => 'agent-avoidable' as const),
      ...INFRASTRUCTURE_FAILURES.map(() => 'infrastructure' as const),
      ...UNATTRIBUTED_FAILURES.map(() => 'unattributed' as const),
    ]);
  });

  it('requires native proof for agent-owned timeouts', () => {
    expect(() => failureObservationSchema.parse({
      ...failure('agent-timeout'),
      evidence: 'driver',
    })).toThrow(/requires native/);
  });

  it('gives native evidence authority and otherwise applies one precedence order', () => {
    const verified = { verification: 'verified' as const };
    expect(taskDisposition(verified, [failure('verifier-process-failed')], false)).toBe('included-native');
    expect(taskDisposition(unverified, [failure('empty-patch')], false)).toBe('agent-loss');
    expect(taskDisposition(unverified, [failure('empty-patch'), failure('driver-watchdog')], false))
      .toBe('infrastructure-excluded');
    expect(taskDisposition(unverified, [], true)).toBe('pending');
    expect(taskDisposition(unverified, [failure('unknown-terminal')], false)).toBe('unverified-excluded');
  });
});

describe('common report evidence envelope', () => {
  it('parses only exact receipt-bound aggregate bytes for suite analysis', () => {
    const bytes = Buffer.from('{"resolved":1}\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let observed: unknown;
    const hook: SuiteAnalysisHook<'swebench-pro'> = {
      suite: 'swebench-pro',
      analyze: (context) => {
        observed = context.nativeAnalysisInput;
        return analysisHook.analyze(context);
      },
    };
    build({
      verifierReceipt: {
        ...receipt(),
        bindings: [...receipt().bindings, {
          invocationId: INVOCATION,
          scope: { kind: 'suite-check', name: 'aggregate' },
          role: 'aggregate-report',
          path: 'native/aggregate.json',
          sha256,
          nativeRecordKey: null,
        }],
      },
      nativeAnalysisArtifact: { ...ANALYSIS_BINDING_IDENTITY, path: 'native/aggregate.json', bytes },
      analysisHook: hook,
    });
    expect(observed).toEqual({ resolved: 1 });
    expect(() => build({
      nativeAnalysisArtifact: { ...ANALYSIS_BINDING_IDENTITY, path: 'native/aggregate.json', bytes },
    })).toThrow(/not bound/);
    expect(() => build({
      verifierReceipt: {
        ...receipt(),
        bindings: [...receipt().bindings, {
          invocationId: INVOCATION,
          scope: { kind: 'suite-check', name: 'aggregate' },
          role: 'aggregate-report',
          path: 'native/aggregate.json',
          sha256,
          nativeRecordKey: null,
        }],
      },
      nativeAnalysisArtifact: {
        ...ANALYSIS_BINDING_IDENTITY,
        scope: { kind: 'suite-check', name: 'different-aggregate' },
        path: 'native/aggregate.json',
        bytes,
      },
    })).toThrow(/not bound/);
    expect(() => build({
      verifierReceipt: {
        ...receipt(),
        bindings: [...receipt().bindings, {
          invocationId: INVOCATION,
          scope: { kind: 'suite-check', name: 'aggregate' },
          role: 'aggregate-report',
          path: 'native/aggregate.json',
          sha256,
          nativeRecordKey: null,
        }],
      },
      nativeAnalysisArtifact: {
        ...ANALYSIS_BINDING_IDENTITY,
        path: 'native/aggregate.json',
        bytes: Buffer.from('{"resolved":0}\n'),
      },
    })).toThrow(/not bound/);
  });

  it('binds exact native evidence and leaves missing verifier output null/unverified', () => {
    const report = build();
    expect(report).toMatchObject({
      schemaVersion: 2,
      kind: 'ultracode-benchmark-report',
      suite: 'swebench-pro',
      runId: 'run-one',
      generatedAt: '2026-07-20T00:02:00.000Z',
    });
    expect(report.taskResults[0]).toMatchObject({
      disposition: 'included-native',
      nativeVerifier: {
        verification: 'verified',
        score: 1,
        resolved: true,
        artifact: { path: 'native/a/verdict.json', sha256: OTHER_HASH, nativeRecordKey: 'task-one:a' },
      },
    });
    expect(report.taskResults[1]).toMatchObject({
      disposition: 'agent-loss',
      nativeVerifier: { verification: 'unverified', score: null, resolved: null, artifact: null },
    });
    expect(report.reproducibility.provenance).toEqual(manifest().provenance);
    expect(report.reproducibility.runStateLedgerRootSha256).toBe(HASH);
    expect(report.analysis.policyAdjusted.paired).toMatchObject({ paired: 1, aOnly: 1, bOnly: 0 });
    expect(report.analysis.native.paired.paired).toBe(0);
    expect(renderBenchReportMarkdown(report)).toContain(`native/a/verdict.json | ${OTHER_HASH}`);
  });

  it('rejects unbound evidence, task-order drift, and policy drift', () => {
    const unbound = taskInputs();
    unbound[0]!.nativeVerifier = {
      ...unbound[0]!.nativeVerifier,
      artifact: { path: 'native/a/other.json' as never, sha256: OTHER_HASH, nativeRecordKey: 'task-one:a' },
    };
    expect(() => build({ taskResults: unbound })).toThrow(/not bound/);
    const wrongInvocation = taskInputs();
    wrongInvocation[0]!.invocationId = '22222222-2222-4222-8222-222222222222';
    expect(() => build({ taskResults: wrongInvocation })).toThrow(/not bound/);
    expect(() => build({ taskResults: [...taskInputs()].reverse() })).toThrow(/order/);
    expect(() => build({
      currentPolicyHashes: {
        metricsPolicySha256: OTHER_HASH,
        failurePolicySha256: HASH,
        reportPolicySha256: HASH,
        adapterPolicySha256: HASH,
      },
    })).toThrow(/metricsPolicySha256 drifted/);
  });

  it('rejects score-like fields on an unverified native result', () => {
    const inputs = taskInputs();
    inputs[1]!.nativeVerifier = { verification: 'unverified', score: 0, resolved: false, artifact: null };
    expect(() => build({ taskResults: inputs })).toThrow(/must be null/);
  });

  it('preserves source ordering while deduplicating normalized invocation failures report-wide', () => {
    const invocationFailure = failureObservationSchema.parse({
      code: 'unknown-terminal',
      scope: { kind: 'run' },
      phase: null,
      terminal: true,
      evidence: 'harness',
    });
    const additionalFailure = failureObservationSchema.parse({
      code: 'driver-watchdog',
      scope: { kind: 'run' },
      phase: null,
      terminal: true,
      evidence: 'harness',
    });
    const observedMetrics = metrics();
    observedMetrics.failures = [invocationFailure];
    const report = build({
      metrics: observedMetrics,
      failures: [invocationFailure, additionalFailure],
    });

    expect(report.failures).toEqual([
      invocationFailure,
      additionalFailure,
      failure('empty-patch'),
    ]);
  });
});
