/**
 * The only Codex rollout parser and normalized benchmark telemetry aggregator.
 * Suite adapters enumerate exact artifacts; this module owns cumulative usage,
 * effort, context, workflow, billability, and timing semantics.
 */
import { basename } from 'node:path';
import type { Arm } from './contracts.js';
import {
  annotationSchema,
  failureObservationSchema,
  taskArmScope,
  type Annotation,
  type FailureObservation,
  type ObservationScope,
} from './failure.js';
import { forEachJsonLine } from './jsonl.js';
import {
  metricsPolicySnapshotSchema,
  type BenchRunManifest,
  type MetricsPolicySnapshot,
  type PricingSnapshot,
} from './manifest.js';
import { canonicalJson, sha256CanonicalJson } from './provenance.js';
import { resolveRegularFileWithinRoot, validateRelativeArtifactPath, validateTaskId } from './paths.js';
import type { BenchRunState } from './run-state.js';

export const LARGE_PROMPT_RESET_MIN_DROP_TOKENS = 16_000;
export const LARGE_PROMPT_RESET_MAX_RETAINED_RATIO = 0.5;
export const CONTEXT_PRESSURE_RATIO = 0.8;

const ROLLOUT_UUID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const BILLING_CLASSES = ['billable', 'mock', 'non-billable', 'unknown'] as const;

export type SessionRole = 'host' | 'worker' | 'unknown';
export type BillingClass = typeof BILLING_CLASSES[number];

export interface MetricsScope {
  taskId: string;
  arm: Arm;
}

export interface RolloutArtifact {
  scope: MetricsScope;
  path: string;
  roleHint: SessionRole;
  backend: string | null;
  billingClass: BillingClass;
}

export interface WorkflowArtifact {
  scope: MetricsScope;
  workflowId: string;
  status: string;
  agentCount: number;
  failureCount: number;
  workspacesKept: number;
  backend: string | null;
  billingClass: BillingClass;
}

export type TimingPhase = 'prep' | 'inference' | 'session' | 'verifier' | 'detached-wait' | 'cleanup';

export interface TimingObservation {
  sourceKey: string;
  invocationId: string;
  /** Non-empty shared identity for per-task projections of one physical batch process. */
  timingGroupId?: string;
  scope: MetricsScope | null;
  phase: TimingPhase;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
}

export interface MetricsArtifactIndex {
  rollouts: readonly RolloutArtifact[];
  workflows: readonly WorkflowArtifact[];
  timings: readonly TimingObservation[];
  annotations: readonly Annotation[];
  failures: readonly FailureObservation[];
  /** True when a suite knows potentially billable usage artifacts are absent. */
  pricingEvidenceIncomplete?: boolean;
}

export interface TokenUsage {
  /** Session-cumulative input, including cached input. */
  inputTokens: number;
  cachedInputTokens: number;
  nonCachedInputTokens: number;
  outputTokens: number;
  /** Informational subset of output, never added or priced separately. */
  reasoningOutputTokens: number;
  /** Input including cached input, plus output. */
  rawTokenCount: number;
  cachedInputWeight: number;
  discountedTokenEquivalent: number;
}

export interface NormalizedSessionMetrics {
  scope: MetricsScope;
  sessionId: string;
  path: string;
  role: SessionRole;
  backend: string | null;
  billingClass: BillingClass;
  model: string | null;
  effectiveEffort: string | null;
  usage: TokenUsage;
  explicitCompactions: number;
  inferredPromptResets: number;
  contextHighWaterMark: number;
  contextWindow: number | null;
  contextPressureRatio: number | null;
  underContextPressure: boolean;
  annotations: Annotation[];
}

export interface NormalizedTiming {
  runElapsedMs: number;
  calendarSpanMs: number;
  criticalPathMs: number;
  summedTaskMs: number;
  nativeRunnerMs: number;
  verifierMs: number;
  detachedWorkflowWaitMs: number;
}

export interface NormalizedMetrics {
  schemaVersion: 2;
  requested: { model: string; effort: string };
  effectiveEffort: {
    verification: 'verified' | 'unverified';
    values: Record<string, number>;
    unknownSessions: number;
    matchesRequested: boolean | null;
  };
  sessions: {
    total: number;
    host: number;
    worker: number;
    unknown: number;
    items: NormalizedSessionMetrics[];
  };
  tokens: {
    total: TokenUsage;
    byBillingClass: Record<BillingClass, TokenUsage>;
  };
  pricing: {
    currency: 'USD';
    verification: 'priced' | 'partial' | 'unpriced';
    billableCost: number | null;
  };
  context: {
    highWaterMark: number;
    windows: number[];
    maximumPressureRatio: number | null;
    pressuredSessions: number;
    explicitCompactions: number;
    inferredPromptResets: number;
  };
  workflows: {
    count: number;
    agentCount: number;
    failureCount: number;
    workspacesKept: number;
    items: WorkflowArtifact[];
  };
  timing: NormalizedTiming;
  annotations: Annotation[];
  failures: FailureObservation[];
}

export interface NormalizeMetricsOptions {
  runDirectory: string;
  index: MetricsArtifactIndex;
  requested: { model: string; effort: string };
  policy: MetricsPolicySnapshot;
  pricing: PricingSnapshot | null;
  runState?: BenchRunState | null;
}

interface ParsedCumulative {
  usage: TokenUsage;
  cachedClamped: boolean;
  reasoningClamped: boolean;
}

interface ParsedRollout {
  session: NormalizedSessionMetrics;
  observedModels: readonly string[];
  observedEfforts: readonly string[];
  modelEvidenceComplete: boolean;
  effortEvidenceComplete: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isBoundedMetric(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function emptyUsage(weight: number): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    nonCachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    rawTokenCount: 0,
    cachedInputWeight: weight,
    discountedTokenEquivalent: 0,
  };
}

function cumulativeUsage(value: unknown, weight: number): ParsedCumulative | null {
  if (!isRecord(value)) return null;
  const inputTokens = nonnegativeSafeInteger(value.input_tokens);
  const observedCached = nonnegativeSafeInteger(value.cached_input_tokens);
  const outputTokens = nonnegativeSafeInteger(value.output_tokens);
  if (inputTokens === null || observedCached === null || outputTokens === null) return null;
  const cachedInputTokens = Math.min(inputTokens, observedCached);
  const observedReasoning = nonnegativeSafeInteger(value.reasoning_output_tokens) ?? 0;
  const reasoningOutputTokens = Math.min(outputTokens, observedReasoning);
  const nonCachedInputTokens = inputTokens - cachedInputTokens;
  const rawTokenCount = inputTokens + outputTokens;
  const discountedTokenEquivalent = nonCachedInputTokens + outputTokens + cachedInputTokens * weight;
  if (!Number.isSafeInteger(rawTokenCount) || !isBoundedMetric(discountedTokenEquivalent)) return null;
  return {
    usage: {
      inputTokens,
      cachedInputTokens,
      nonCachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      rawTokenCount,
      cachedInputWeight: weight,
      discountedTokenEquivalent,
    },
    cachedClamped: cachedInputTokens !== observedCached,
    reasoningClamped: reasoningOutputTokens !== observedReasoning,
  };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  if (left.cachedInputWeight !== right.cachedInputWeight) {
    throw new Error('cannot aggregate token usage with different cached-input weights');
  }
  const inputTokens = left.inputTokens + right.inputTokens;
  const cachedInputTokens = left.cachedInputTokens + right.cachedInputTokens;
  const outputTokens = left.outputTokens + right.outputTokens;
  const reasoningOutputTokens = left.reasoningOutputTokens + right.reasoningOutputTokens;
  const rawTokenCount = inputTokens + outputTokens;
  const discountedTokenEquivalent =
    inputTokens - cachedInputTokens + outputTokens + cachedInputTokens * left.cachedInputWeight;
  if (![inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, rawTokenCount]
    .every(Number.isSafeInteger)
    || !isBoundedMetric(discountedTokenEquivalent)) {
    throw new Error('aggregated token usage exceeds the normalized numeric range');
  }
  return {
    inputTokens,
    cachedInputTokens,
    nonCachedInputTokens: inputTokens - cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    rawTokenCount,
    cachedInputWeight: left.cachedInputWeight,
    discountedTokenEquivalent,
  };
}

function annotation(code: string, scope: ObservationScope): Annotation {
  return annotationSchema.parse({ code, scope });
}

function validateScope(scope: MetricsScope): MetricsScope {
  validateTaskId(scope.taskId);
  if (scope.arm !== 'a' && scope.arm !== 'b') throw new Error(`invalid metrics arm '${String(scope.arm)}'`);
  return scope;
}

function parseCodexRolloutWithEvidence(
  runDirectory: string,
  artifact: RolloutArtifact,
  policy: MetricsPolicySnapshot,
): ParsedRollout {
  const scope = validateScope(artifact.scope);
  const relativePath = validateRelativeArtifactPath(artifact.path);
  const file = resolveRegularFileWithinRoot(runDirectory, relativePath, 'Codex rollout');
  let finalCumulative: ParsedCumulative | null = null;
  let contextHighWaterMark = 0;
  let contextWindow: number | null = null;
  let model: string | null = null;
  const observedModels: string[] = [];
  const observedEfforts: string[] = [];
  let effectiveEffort: string | null = null;
  let metadataSessionId: string | null = null;
  let eventCompactions = 0;
  let recordCompactions = 0;
  let inferredPromptResets = 0;
  let previousPromptTokens: number | null = null;
  const annotations: Annotation[] = [];

  const stats = forEachJsonLine(file, (record) => {
    if (!isRecord(record)) return;
    if (record.type === 'compacted') {
      recordCompactions += 1;
      return;
    }
    if (!isRecord(record.payload)) return;
    const payload = record.payload;
    if (record.type === 'session_meta') {
      const id = payload.session_id ?? payload.id;
      if (typeof id === 'string' && id.length > 0) metadataSessionId = id;
      if (typeof payload.model === 'string' && payload.model.length > 0) {
        model = payload.model;
        observedModels.push(model);
      }
      return;
    }
    if (record.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model.length > 0) {
        model = payload.model;
        observedModels.push(model);
      }
      if (typeof payload.effort === 'string' && payload.effort.length > 0) {
        effectiveEffort = payload.effort;
        observedEfforts.push(payload.effort);
      }
      if (isRecord(payload.collaboration_mode) && isRecord(payload.collaboration_mode.settings)) {
        const nested = payload.collaboration_mode.settings.reasoning_effort;
        if (typeof nested === 'string' && nested.length > 0) {
          effectiveEffort = nested;
          observedEfforts.push(nested);
        }
      }
      return;
    }
    if (record.type !== 'event_msg') return;
    if (payload.type === 'context_compacted') {
      eventCompactions += 1;
      return;
    }
    if (payload.type !== 'token_count' || !isRecord(payload.info)) return;
    const info = payload.info;
    const parsed = cumulativeUsage(info.total_token_usage, policy.cachedInputWeight);
    if (parsed !== null) finalCumulative = parsed;
    if (isRecord(info.last_token_usage)) {
      const prompt = nonnegativeSafeInteger(info.last_token_usage.input_tokens);
      const output = nonnegativeSafeInteger(info.last_token_usage.output_tokens);
      const contextTokens = prompt === null || output === null ? null : prompt + output;
      if (contextTokens !== null && Number.isSafeInteger(contextTokens)) {
        contextHighWaterMark = Math.max(contextHighWaterMark, contextTokens);
      }
      if (
        prompt !== null
        && previousPromptTokens !== null
        && previousPromptTokens - prompt >= policy.resetMinDropTokens
        && prompt <= previousPromptTokens * policy.resetRetainedFraction
      ) {
        inferredPromptResets += 1;
      }
      if (prompt !== null) previousPromptTokens = prompt;
    }
    const observedWindow = nonnegativeSafeInteger(info.model_context_window);
    if (observedWindow !== null && observedWindow > 0) contextWindow = observedWindow;
  });
  if (!stats.opened) throw new Error(`Codex rollout could not be opened: ${relativePath}`);

  const scopeValue = taskArmScope(scope.taskId, scope.arm);
  const cumulative = finalCumulative as ParsedCumulative | null;
  if (stats.malformedLines > 0) annotations.push(annotation('rollout-malformed-json', scopeValue));
  if (stats.oversizeLines > 0) annotations.push(annotation('rollout-oversize-line', scopeValue));
  if (stats.unterminatedTail) annotations.push(annotation('rollout-unterminated-tail', scopeValue));
  if (cumulative === null) annotations.push(annotation('rollout-usage-missing', scopeValue));
  else {
    if (cumulative.cachedClamped) annotations.push(annotation('cached-input-clamped', scopeValue));
    if (cumulative.reasoningClamped) annotations.push(annotation('reasoning-output-clamped', scopeValue));
  }

  const name = basename(file);
  const filenameSessionId = ROLLOUT_UUID_RE.exec(name)?.[1] ?? null;
  if (filenameSessionId !== null && metadataSessionId !== null && filenameSessionId !== metadataSessionId) {
    annotations.push(annotation('rollout-session-id-mismatch', scopeValue));
  }
  const sessionId = filenameSessionId ?? metadataSessionId ?? name.replace(/\.jsonl$/, '');
  const explicitCompactions = Math.max(eventCompactions, recordCompactions);
  const contextPressureRatio = contextWindow === null ? null : contextHighWaterMark / contextWindow;
  return {
    session: {
      scope,
      sessionId,
      path: relativePath,
      role: artifact.roleHint,
      backend: artifact.backend,
      billingClass: artifact.billingClass,
      model,
      effectiveEffort,
      usage: cumulative?.usage ?? emptyUsage(policy.cachedInputWeight),
      explicitCompactions,
      inferredPromptResets,
      contextHighWaterMark,
      contextWindow,
      contextPressureRatio,
      underContextPressure: explicitCompactions > 0
        || (contextPressureRatio !== null && contextPressureRatio >= CONTEXT_PRESSURE_RATIO),
      annotations,
    },
    observedModels,
    observedEfforts,
    modelEvidenceComplete: stats.malformedLines === 0
      && stats.oversizeLines === 0
      && !stats.unterminatedTail,
    effortEvidenceComplete: stats.malformedLines === 0
      && stats.oversizeLines === 0
      && !stats.unterminatedTail,
  };
}

/** Parse one exact rollout using the final complete cumulative usage object. */
export function parseCodexRollout(
  runDirectory: string,
  artifact: RolloutArtifact,
  policy: MetricsPolicySnapshot,
): NormalizedSessionMetrics {
  return parseCodexRolloutWithEvidence(runDirectory, artifact, policy).session;
}

function dedupeWorkflows(workflows: readonly WorkflowArtifact[]): WorkflowArtifact[] {
  const byId = new Map<string, WorkflowArtifact>();
  for (const workflow of workflows) {
    validateScope(workflow.scope);
    if (!workflow.workflowId || !Number.isSafeInteger(workflow.agentCount) || workflow.agentCount < 0
      || !Number.isSafeInteger(workflow.failureCount) || workflow.failureCount < 0
      || !Number.isSafeInteger(workflow.workspacesKept) || workflow.workspacesKept < 0) {
      throw new Error(`invalid workflow telemetry '${workflow.workflowId}'`);
    }
    const previous = byId.get(workflow.workflowId);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(workflow)) {
      throw new Error(`conflicting workflow telemetry for '${workflow.workflowId}'`);
    }
    byId.set(workflow.workflowId, { ...workflow, scope: { ...workflow.scope } });
  }
  return [...byId.values()].sort((left, right) => left.workflowId.localeCompare(right.workflowId));
}

interface Interval {
  invocationId: string;
  timingGroupId: string | null;
  scope: MetricsScope | null;
  phase: TimingPhase;
  startedAt: string;
  endedAt: string;
  start: number;
  end: number;
  elapsedMs: number;
}

function parseTimestamp(value: string, description: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${description} must be an ISO timestamp`);
  return parsed;
}

function validateTimingGroups(intervals: readonly Interval[]): void {
  const groups = new Map<string, {
    interval: Interval;
    taskIds: Set<string>;
  }>();
  for (const interval of intervals) {
    if (interval.timingGroupId === null) continue;
    if (interval.scope === null) {
      throw new Error(`timing group '${interval.timingGroupId}' must contain only task-scoped records`);
    }
    const previous = groups.get(interval.timingGroupId);
    if (previous === undefined) {
      groups.set(interval.timingGroupId, {
        interval,
        taskIds: new Set([interval.scope.taskId]),
      });
      continue;
    }
    const expected = previous.interval;
    if (
      expected.invocationId !== interval.invocationId
      || expected.scope?.arm !== interval.scope.arm
      || expected.phase !== interval.phase
      || expected.startedAt !== interval.startedAt
      || expected.endedAt !== interval.endedAt
      || expected.elapsedMs !== interval.elapsedMs
    ) {
      throw new Error(`conflicting timing group '${interval.timingGroupId}'`);
    }
    if (previous.taskIds.has(interval.scope.taskId)) {
      throw new Error(`timing group '${interval.timingGroupId}' repeats task '${interval.scope.taskId}'`);
    }
    previous.taskIds.add(interval.scope.taskId);
  }
}

function observationIntervals(observations: readonly TimingObservation[]): Interval[] {
  const bySource = new Map<string, TimingObservation>();
  for (const observation of observations) {
    const timingGroupId = observation.timingGroupId;
    if (!observation.sourceKey || !observation.invocationId
      || timingGroupId !== undefined
        && (typeof timingGroupId !== 'string' || timingGroupId.length === 0 || timingGroupId.length > 256)) {
      throw new Error('timing identity must be non-empty');
    }
    if (observation.scope !== null) validateScope(observation.scope);
    if (!Number.isFinite(observation.elapsedMs) || observation.elapsedMs < 0) {
      throw new Error(`invalid elapsed time for '${observation.sourceKey}'`);
    }
    const previous = bySource.get(observation.sourceKey);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(observation)) {
      throw new Error(`conflicting timing telemetry for '${observation.sourceKey}'`);
    }
    bySource.set(observation.sourceKey, observation);
  }
  const intervals = [...bySource.values()].map((observation) => {
    const start = parseTimestamp(observation.startedAt, 'timing start');
    const end = parseTimestamp(observation.endedAt, 'timing end');
    if (end < start) throw new Error(`timing end precedes start for '${observation.sourceKey}'`);
    return {
      invocationId: observation.invocationId,
      timingGroupId: observation.timingGroupId ?? null,
      scope: observation.scope,
      phase: observation.phase,
      startedAt: observation.startedAt,
      endedAt: observation.endedAt,
      start,
      end,
      elapsedMs: observation.elapsedMs,
    };
  });
  validateTimingGroups(intervals);
  return intervals;
}

function intervalUnionMs(intervals: readonly Pick<Interval, 'start' | 'end'>[]): number {
  const sorted = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const interval of sorted) {
    if (start === null || end === null) {
      start = interval.start;
      end = interval.end;
    } else if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  return start === null || end === null ? total : total + end - start;
}

function timingMetrics(state: BenchRunState | null, observations: readonly TimingObservation[]): NormalizedTiming {
  const nativeIntervals = observationIntervals(observations);
  const stateIntervals: Interval[] = [];
  if (state !== null) {
    for (const attempt of state.attempts) {
      if (attempt.endedAt === null || attempt.elapsedMs === null) continue;
      const start = parseTimestamp(attempt.startedAt, 'attempt start');
      const end = parseTimestamp(attempt.endedAt, 'attempt end');
      stateIntervals.push({
        invocationId: attempt.invocationId,
        timingGroupId: attempt.timingGroupId ?? null,
        scope: { taskId: attempt.taskId, arm: attempt.arm },
        phase: attempt.phase,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        start,
        end,
        elapsedMs: attempt.elapsedMs,
      });
    }
  }
  validateTimingGroups(stateIntervals);
  const stateKeys = new Set(stateIntervals.map((interval) =>
    `${interval.invocationId}\0${interval.scope?.taskId ?? ''}\0${interval.scope?.arm ?? ''}\0${interval.phase}`));
  const intervals = [
    ...stateIntervals,
    ...nativeIntervals.filter((interval) => !stateKeys.has(
      `${interval.invocationId}\0${interval.scope?.taskId ?? ''}\0${interval.scope?.arm ?? ''}\0${interval.phase}`,
    )),
  ];
  validateTimingGroups(intervals);
  const byInvocation = new Map<string, Interval[]>();
  for (const interval of intervals) {
    const values = byInvocation.get(interval.invocationId) ?? [];
    values.push(interval);
    byInvocation.set(interval.invocationId, values);
  }
  const criticalPathMs = [...byInvocation.values()].reduce((sum, values) => sum + intervalUnionMs(values), 0);
  const completedInvocations = state?.invocations.filter((invocation) =>
    invocation.endedAt !== null && invocation.activeElapsedMs !== null) ?? [];
  const runElapsedMs = completedInvocations.length > 0
    ? completedInvocations.reduce((sum, invocation) => sum + invocation.activeElapsedMs!, 0)
    : criticalPathMs;
  const spanIntervals = completedInvocations.length > 0
    ? completedInvocations.map((invocation) => ({
      start: parseTimestamp(invocation.startedAt, 'invocation start'),
      end: parseTimestamp(invocation.endedAt!, 'invocation end'),
    }))
    : intervals;
  const first = spanIntervals.reduce<number | null>((value, interval) =>
    value === null ? interval.start : Math.min(value, interval.start), null);
  const last = spanIntervals.reduce<number | null>((value, interval) =>
    value === null ? interval.end : Math.max(value, interval.end), null);
  const taskIntervals = intervals.filter((interval) => interval.scope !== null);
  const elapsedFor = (phases: readonly TimingPhase[], groupAware: boolean): number => {
    const timingGroups = new Set<string>();
    return taskIntervals
      .filter((interval) => phases.includes(interval.phase))
      .reduce((sum, interval) => {
        if (groupAware && interval.timingGroupId !== null) {
          if (timingGroups.has(interval.timingGroupId)) return sum;
          timingGroups.add(interval.timingGroupId);
        }
        return sum + interval.elapsedMs;
      }, 0);
  };
  const taskAttemptPhases: readonly TimingPhase[] = ['inference', 'session', 'verifier', 'detached-wait'];
  const taskAttemptIntervals = new Map<string, Interval[]>();
  for (const interval of taskIntervals.filter((entry) => taskAttemptPhases.includes(entry.phase))) {
    const key = interval.timingGroupId === null
      ? `task\0${interval.invocationId}\0${interval.scope!.taskId}\0${interval.scope!.arm}`
      : `group\0${interval.timingGroupId}`;
    const values = taskAttemptIntervals.get(key) ?? [];
    values.push(interval);
    taskAttemptIntervals.set(key, values);
  }
  return {
    runElapsedMs,
    calendarSpanMs: first === null || last === null ? 0 : last - first,
    criticalPathMs,
    summedTaskMs: [...taskAttemptIntervals.values()].reduce(
      (sum, values) => sum + intervalUnionMs(values),
      0,
    ),
    nativeRunnerMs: elapsedFor(['inference', 'session'], true),
    verifierMs: elapsedFor(['verifier'], true),
    detachedWorkflowWaitMs: elapsedFor(['detached-wait'], true),
  };
}

function billableCost(usage: TokenUsage, pricing: PricingSnapshot): number {
  const cost = usage.nonCachedInputTokens / 1_000_000 * pricing.uncachedInputPerMTokens
    + usage.cachedInputTokens / 1_000_000 * pricing.cachedInputPerMTokens
    + usage.outputTokens / 1_000_000 * pricing.outputPerMTokens;
  if (!isBoundedMetric(cost)) throw new Error('billable cost exceeds the normalized numeric range');
  return cost;
}

function priceableBillableUsage(
  parsedSessions: readonly ParsedRollout[],
  pricingModel: string,
  cachedInputWeight: number,
): { usage: TokenUsage; incomplete: boolean } {
  let usage = emptyUsage(cachedInputWeight);
  let incomplete = false;
  for (const parsed of parsedSessions) {
    const { session, observedModels, modelEvidenceComplete } = parsed;
    if (session.billingClass !== 'billable' || session.usage.rawTokenCount === 0) continue;
    const scope = taskArmScope(session.scope.taskId, session.scope.arm);
    const distinctModels = new Set(observedModels);
    if (!modelEvidenceComplete) {
      incomplete = true;
    } else if (observedModels.length === 0) {
      session.annotations.push(annotation('model-unobserved', scope));
      incomplete = true;
    } else if (distinctModels.size > 1) {
      session.annotations.push(annotation('model-multiple', scope));
      incomplete = true;
    } else if (observedModels[0] !== pricingModel) {
      session.annotations.push(annotation('model-mismatch', scope));
      incomplete = true;
    } else {
      usage = addUsage(usage, session.usage);
    }
  }
  return { usage, incomplete };
}

/** Normalize an adapter-provided exact artifact index into the public contract. */
export function normalizeMetrics(options: NormalizeMetricsOptions): NormalizedMetrics {
  const { index } = options;
  const policy = metricsPolicySnapshotSchema.parse(options.policy);
  if (options.pricing !== null && options.pricing.model !== options.requested.model) {
    throw new Error('pricing model must match requested model');
  }
  const paths = new Set<string>();
  for (const rollout of index.rollouts) {
    if (!['host', 'worker', 'unknown'].includes(rollout.roleHint)) {
      throw new Error(`invalid rollout role '${String(rollout.roleHint)}'`);
    }
    if (!(BILLING_CLASSES as readonly string[]).includes(rollout.billingClass)) {
      throw new Error(`invalid rollout billing class '${String(rollout.billingClass)}'`);
    }
    const path = validateRelativeArtifactPath(rollout.path);
    if (paths.has(path)) throw new Error(`duplicate rollout path '${path}'`);
    paths.add(path);
  }
  const failures = index.failures.map((failure) => failureObservationSchema.parse(failure));
  const parsedSessions: ParsedRollout[] = [];
  const sessions: NormalizedSessionMetrics[] = [];
  let pricingUsageIncomplete = index.pricingEvidenceIncomplete === true;
  let unparsedRollouts = 0;
  for (const artifact of index.rollouts) {
    try {
      const parsed = parseCodexRolloutWithEvidence(options.runDirectory, artifact, policy);
      parsedSessions.push(parsed);
      sessions.push(parsed.session);
      if ((artifact.billingClass === 'billable' || artifact.billingClass === 'unknown')
        && parsed.session.annotations.some((entry) => entry.code === 'rollout-usage-missing')) {
        pricingUsageIncomplete = true;
      }
    } catch {
      unparsedRollouts += 1;
      if (artifact.billingClass === 'billable' || artifact.billingClass === 'unknown') {
        pricingUsageIncomplete = true;
      }
      failures.push(failureObservationSchema.parse({
        code: 'artifact-unsafe',
        scope: taskArmScope(artifact.scope.taskId, artifact.scope.arm),
        phase: 'report',
        terminal: false,
        evidence: 'harness',
      }));
    }
  }
  for (const invocation of options.runState?.invocations ?? []) {
    if (invocation.failure === null) continue;
    failures.push(failureObservationSchema.parse({
      code: invocation.failure,
      scope: { kind: 'run' },
      phase: null,
      terminal: true,
      evidence: invocation.failure === 'agent-timeout' ? 'native' : 'harness',
    }));
  }
  sessions.sort((left, right) => left.path.localeCompare(right.path));
  const scopedSessionIds = new Set<string>();
  for (const session of sessions) {
    const key = `${session.scope.taskId}\0${session.scope.arm}\0${session.sessionId}`;
    if (scopedSessionIds.has(key)) throw new Error(`duplicate rollout session in one task/arm scope: ${session.sessionId}`);
    scopedSessionIds.add(key);
  }

  const byBillingClass = Object.fromEntries(BILLING_CLASSES.map((billingClass) =>
    [billingClass, emptyUsage(policy.cachedInputWeight)])) as Record<BillingClass, TokenUsage>;
  let total = emptyUsage(policy.cachedInputWeight);
  for (const session of sessions) {
    byBillingClass[session.billingClass] = addUsage(byBillingClass[session.billingClass], session.usage);
    total = addUsage(total, session.usage);
  }
  const pricedBillable = priceableBillableUsage(
    parsedSessions,
    options.pricing?.model ?? options.requested.model,
    policy.cachedInputWeight,
  );

  const effortValues: Record<string, number> = {};
  let unknownEffort = unparsedRollouts;
  for (const parsed of parsedSessions) {
    const { session, observedEfforts, effortEvidenceComplete } = parsed;
    const distinctEfforts = new Set(observedEfforts);
    const scope = taskArmScope(session.scope.taskId, session.scope.arm);
    if (!effortEvidenceComplete) {
      unknownEffort += 1;
    } else if (observedEfforts.length === 0) {
      unknownEffort += 1;
    } else if (distinctEfforts.size > 1) {
      session.annotations.push(annotation('effort-multiple', scope));
      unknownEffort += 1;
    } else {
      const effort = observedEfforts[0]!;
      effortValues[effort] = (effortValues[effort] ?? 0) + 1;
    }
  }
  const effortVerified = sessions.length > 0 && unknownEffort === 0;
  const workflows = dedupeWorkflows(index.workflows);
  const windows = [...new Set(sessions.flatMap((session) =>
    session.contextWindow === null ? [] : [session.contextWindow]))].sort((left, right) => left - right);
  const pressureRatios = sessions.flatMap((session) =>
    session.contextPressureRatio === null ? [] : [session.contextPressureRatio]);
  const annotations = [
    ...index.annotations.map((entry) => annotationSchema.parse(entry)),
    ...sessions.flatMap((session) => session.annotations),
  ];
  const pricing = options.pricing;
  const unknownUsage = byBillingClass.unknown.rawTokenCount;
  return {
    schemaVersion: 2,
    requested: { ...options.requested },
    effectiveEffort: {
      verification: effortVerified ? 'verified' : 'unverified',
      values: Object.fromEntries(Object.entries(effortValues).sort(([left], [right]) => left.localeCompare(right))),
      unknownSessions: unknownEffort,
      matchesRequested: effortVerified
        ? Object.keys(effortValues).every((effort) => effort === options.requested.effort)
        : null,
    },
    sessions: {
      total: sessions.length,
      host: sessions.filter((session) => session.role === 'host').length,
      worker: sessions.filter((session) => session.role === 'worker').length,
      unknown: sessions.filter((session) => session.role === 'unknown').length,
      items: sessions,
    },
    tokens: { total, byBillingClass },
    pricing: {
      currency: 'USD',
      verification: pricing === null
        ? 'unpriced'
        : unknownUsage > 0 || pricingUsageIncomplete || pricedBillable.incomplete ? 'partial' : 'priced',
      billableCost: pricing === null ? null : billableCost(pricedBillable.usage, pricing),
    },
    context: {
      highWaterMark: sessions.reduce((peak, session) => Math.max(peak, session.contextHighWaterMark), 0),
      windows,
      maximumPressureRatio: pressureRatios.length === 0 ? null : Math.max(...pressureRatios),
      pressuredSessions: sessions.filter((session) => session.underContextPressure).length,
      explicitCompactions: sessions.reduce((sum, session) => sum + session.explicitCompactions, 0),
      inferredPromptResets: sessions.reduce((sum, session) => sum + session.inferredPromptResets, 0),
    },
    workflows: {
      count: workflows.length,
      agentCount: workflows.reduce((sum, workflow) => sum + workflow.agentCount, 0),
      failureCount: workflows.reduce((sum, workflow) => sum + workflow.failureCount, 0),
      workspacesKept: workflows.reduce((sum, workflow) => sum + workflow.workspacesKept, 0),
      items: workflows,
    },
    timing: timingMetrics(options.runState ?? null, index.timings),
    annotations,
    failures,
  };
}

export function emptyMetricsArtifactIndex(): MetricsArtifactIndex {
  return { rollouts: [], workflows: [], timings: [], annotations: [], failures: [] };
}

/** Normalize against the immutable manifest and reject adapter scope drift. */
export function normalizeBenchMetrics(
  manifest: BenchRunManifest,
  runDirectory: string,
  index: MetricsArtifactIndex,
  runState: BenchRunState | null = null,
): NormalizedMetrics {
  const executions = new Set(manifest.artifacts.executions.map((execution) =>
    `${execution.taskId}\0${execution.arm}`));
  const assertScope = (scope: MetricsScope): void => {
    validateScope(scope);
    if (!executions.has(`${scope.taskId}\0${scope.arm}`)) {
      throw new Error(`metrics scope is not frozen in the manifest: ${scope.taskId}/${scope.arm}`);
    }
  };
  for (const rollout of index.rollouts) assertScope(rollout.scope);
  for (const workflow of index.workflows) assertScope(workflow.scope);
  for (const timing of index.timings) {
    if (timing.scope !== null) assertScope(timing.scope);
  }
  for (const observation of [...index.annotations, ...index.failures]) {
    if (observation.scope.kind === 'task-arm') assertScope(observation.scope);
  }
  return normalizeMetrics({
    runDirectory,
    index,
    requested: {
      model: manifest.experiment.model,
      effort: manifest.experiment.requestedEffort,
    },
    policy: manifest.metricsPolicy,
    pricing: manifest.pricing,
    runState,
  });
}

export const METRICS_POLICY_SHA256 = sha256CanonicalJson({
  parserContractVersion: 2,
  cumulativeUsage: 'last-complete-total-token-usage',
  cachedInputWeight: 0.1,
  reasoningOutput: 'subset-of-output',
  compactionRule: 'max-event-record',
  resetMinDropTokens: LARGE_PROMPT_RESET_MIN_DROP_TOKENS,
  resetRetainedFraction: LARGE_PROMPT_RESET_MAX_RETAINED_RATIO,
  workflowDedupeRule: 'run-id',
  invocationFailures: 'adapter-and-artifact-failures-then-run-scoped-terminal-invocation-order',
  pricing: 'positive-billable-subtotal-with-record-integrity-and-uniform-exact-observed-model-evidence',
  timing: 'detached-wait-subset-of-wall-time',
  timingGroups: 'dedupe-task-projections-with-matching-invocation-arm-phase-timestamps-elapsed',
});

export const DEFAULT_METRICS_POLICY: MetricsPolicySnapshot = {
  parserContractVersion: 2,
  cachedInputWeight: 0.1,
  compactionRule: 'max-event-record',
  resetMinDropTokens: LARGE_PROMPT_RESET_MIN_DROP_TOKENS,
  resetRetainedFraction: LARGE_PROMPT_RESET_MAX_RETAINED_RATIO,
  workflowDedupeRule: 'run-id',
  implementationSha256: METRICS_POLICY_SHA256,
};
