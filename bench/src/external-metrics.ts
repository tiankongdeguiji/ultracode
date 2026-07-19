/**
 * Streaming Codex rollout metrics for external benchmark adapters. Inputs are
 * best-effort artifacts: missing directories, unreadable files, torn lines,
 * and unknown records are skipped instead of failing result collection.
 */
import { createReadStream } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const ROLLOUT_UUID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** Minimum absolute prompt-token drop considered a reset diagnostic. */
export const LARGE_PROMPT_RESET_MIN_DROP_TOKENS = 16_000;
/** Maximum retained prompt fraction considered a reset diagnostic. */
export const LARGE_PROMPT_RESET_MAX_RETAINED_RATIO = 0.5;

export interface ExternalUsage {
  /** Non-cached input tokens; cached input is reported separately. */
  input: number;
  cachedInput: number;
  output: number;
  /** Informational subset of `output`, never added to `total`. */
  reasoning: number;
  /** `input + output + round(0.1 * cachedInput)`. */
  total: number;
}

export type ExternalSessionRole = 'host' | 'worker';

export interface ExternalSessionMetrics {
  sessionId: string;
  file: string;
  usage: ExternalUsage;
  /** Null unless the caller supplied host ids or a default role. */
  role: ExternalSessionRole | null;
  /** Explicit rollout events, with dual record/event representations deduplicated. */
  compactions: number;
  /** Heuristic diagnostics only; never included in `compactions`. */
  inferredPromptResets: number;
  contextPeak: number;
  contextWindow: number | null;
  model: string | null;
  /** Effective reasoning effort observed in the final turn context. */
  effort: string | null;
}

export interface ExternalMetrics {
  sessions: ExternalSessionMetrics[];
  totalUsage: ExternalUsage;
  compactionEvents: number;
  inferredPromptResets: number;
  contextPeak: number;
  contextWindow: number | null;
}

export interface ExternalMetricsOptions {
  /** Codex session id belonging to the benchmark-driving host. */
  hostSessionId?: string;
  /** Host ids for adapters that execute more than one task in a single run. */
  hostSessionIds?: Iterable<string>;
  /** Role assigned when no host ids are available, for example Arm A hosts. */
  defaultRole?: ExternalSessionRole;
}

const finiteTokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

const observedTokenCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function usageTotal(input: number, cachedInput: number, output: number): number {
  return input + output + Math.round(0.1 * cachedInput);
}

function usageFromCumulative(cumulative: Record<string, unknown> | null): ExternalUsage {
  const cachedInput = finiteTokenCount(cumulative?.cached_input_tokens);
  const rawInput = finiteTokenCount(cumulative?.input_tokens);
  const input = Math.max(0, rawInput - cachedInput);
  const output = finiteTokenCount(cumulative?.output_tokens);
  const reasoning = Math.min(output, finiteTokenCount(cumulative?.reasoning_output_tokens));
  return { input, cachedInput, output, reasoning, total: usageTotal(input, cachedInput, output) };
}

/** Recursively find rollout JSONL files without following directory symlinks. */
export async function discoverRolloutFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await opendir(directory);
    } catch {
      return;
    }
    try {
      for await (const entry of entries) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(file);
      }
    } catch {
      // A disappearing or unreadable subtree is equivalent to a missing artifact.
    }
  };
  await walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

/** Stream an NDJSON file and yield only successfully parsed, non-empty lines. */
export async function* readJsonLines(file: string): AsyncGenerator<unknown> {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        yield JSON.parse(trimmed) as unknown;
      } catch {
        // Malformed and torn lines do not invalidate the surrounding rollout.
      }
    }
  } catch {
    // Missing, unreadable, and concurrently truncated files degrade to partial metrics.
  } finally {
    lines.close();
    input.destroy();
  }
}

/** Parse one rollout using the final session-cumulative token_count record. */
export async function parseRolloutMetrics(
  file: string,
  options: ExternalMetricsOptions = {},
): Promise<ExternalSessionMetrics> {
  let cumulative: Record<string, unknown> | null = null;
  let contextPeak = 0;
  let contextWindow: number | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let metadataSessionId: string | null = null;
  let eventCompactions = 0;
  let recordCompactions = 0;
  let inferredPromptResets = 0;
  let previousPromptTokens: number | null = null;

  for await (const record of readJsonLines(file)) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    const row = record as { type?: unknown; payload?: unknown };
    if (row.type === 'compacted') {
      recordCompactions += 1;
      continue;
    }
    const payload =
      row.payload !== null && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : null;
    if (!payload) continue;
    if (row.type === 'session_meta') {
      const id = payload.session_id ?? payload.id;
      if (typeof id === 'string' && id.length > 0) metadataSessionId = id;
      if (typeof payload.model === 'string') model = payload.model;
      continue;
    }
    if (row.type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model;
      if (typeof payload.effort === 'string') effort = payload.effort;
      const collaboration = payload.collaboration_mode;
      if (collaboration !== null && typeof collaboration === 'object' && !Array.isArray(collaboration)) {
        const settings = (collaboration as Record<string, unknown>).settings;
        if (settings !== null && typeof settings === 'object' && !Array.isArray(settings)) {
          const nested = (settings as Record<string, unknown>).reasoning_effort;
          if (typeof nested === 'string') effort = nested;
        }
      }
      continue;
    }
    if (row.type !== 'event_msg') continue;
    if (payload.type === 'context_compacted') {
      eventCompactions += 1;
      continue;
    }
    if (payload.type !== 'token_count') continue;
    const info =
      payload.info !== null && typeof payload.info === 'object' && !Array.isArray(payload.info)
        ? (payload.info as Record<string, unknown>)
        : null;
    if (!info) continue;
    const total =
      info.total_token_usage !== null
      && typeof info.total_token_usage === 'object'
      && !Array.isArray(info.total_token_usage)
        ? (info.total_token_usage as Record<string, unknown>)
        : null;
    if (total) cumulative = total;
    const last =
      info.last_token_usage !== null
      && typeof info.last_token_usage === 'object'
      && !Array.isArray(info.last_token_usage)
        ? (info.last_token_usage as Record<string, unknown>)
        : null;
    if (last) {
      const observedPromptTokens = observedTokenCount(last.input_tokens);
      const liveTokens = finiteTokenCount(last.input_tokens) + finiteTokenCount(last.output_tokens);
      contextPeak = Math.max(contextPeak, liveTokens);
      if (
        observedPromptTokens !== null
        && previousPromptTokens !== null
        && previousPromptTokens - observedPromptTokens >= LARGE_PROMPT_RESET_MIN_DROP_TOKENS
        && observedPromptTokens <= previousPromptTokens * LARGE_PROMPT_RESET_MAX_RETAINED_RATIO
      ) {
        inferredPromptResets += 1;
      }
      if (observedPromptTokens !== null) previousPromptTokens = observedPromptTokens;
    }
    if (
      typeof info.model_context_window === 'number'
      && Number.isFinite(info.model_context_window)
      && info.model_context_window > 0
    ) {
      contextWindow = info.model_context_window;
    }
  }

  const name = basename(file);
  const sessionId = ROLLOUT_UUID_RE.exec(name)?.[1]
    ?? metadataSessionId
    ?? name.replace(/\.jsonl$/, '');
  const hostSessionIds = new Set(options.hostSessionIds ?? []);
  if (options.hostSessionId !== undefined) hostSessionIds.add(options.hostSessionId);
  const role = hostSessionIds.size > 0
    ? hostSessionIds.has(sessionId) ? 'host' : 'worker'
    : options.defaultRole ?? null;
  return {
    sessionId,
    file,
    usage: usageFromCumulative(cumulative),
    role,
    compactions: Math.max(eventCompactions, recordCompactions),
    inferredPromptResets,
    contextPeak,
    contextWindow,
    model,
    effort,
  };
}

/** Collect and aggregate every rollout beneath a caller-owned artifact root. */
export async function collectExternalMetrics(
  root: string,
  options: ExternalMetricsOptions = {},
): Promise<ExternalMetrics> {
  const files = await discoverRolloutFiles(root);
  const sessions: ExternalSessionMetrics[] = [];
  for (const file of files) sessions.push(await parseRolloutMetrics(file, options));

  const input = sessions.reduce((sum, session) => sum + session.usage.input, 0);
  const cachedInput = sessions.reduce((sum, session) => sum + session.usage.cachedInput, 0);
  const output = sessions.reduce((sum, session) => sum + session.usage.output, 0);
  const reasoning = sessions.reduce((sum, session) => sum + session.usage.reasoning, 0);
  return {
    sessions,
    totalUsage: { input, cachedInput, output, reasoning, total: usageTotal(input, cachedInput, output) },
    compactionEvents: sessions.reduce((sum, session) => sum + session.compactions, 0),
    inferredPromptResets: sessions.reduce((sum, session) => sum + session.inferredPromptResets, 0),
    contextPeak: sessions.reduce((peak, session) => Math.max(peak, session.contextPeak), 0),
    contextWindow: sessions.find((session) => session.contextWindow !== null)?.contextWindow ?? null,
  };
}
