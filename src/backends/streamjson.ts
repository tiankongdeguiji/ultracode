/**
 * Shared stream-json (SDKMessage) parser for the Claude-Code-lineage CLIs:
 * `claude -p` and `qodercli --print` emit the same envelope. One JSON object
 * per line:
 *   {type:'system', subtype:'init', session_id, ...}
 *   {type:'assistant', message:{content:[{type:'text'|'tool_use', ...}]}}
 *   {type:'user', ...}  (tool results echoed back)
 *   {type:'result', subtype:'success'|'error_*', result, structured_output?,
 *      session_id, usage, total_cost_usd, is_error, errors?}
 */
import type { AgentEvent, ErrorKind, NormalizedUsage } from './types.js';
import { parseJsonLine } from './ndjson.js';

interface StreamJsonParserOptions {
  /**
   * Qoder reports a context-window occupancy ratio for each model request but
   * currently leaves every token counter at zero. When enabled, convert those
   * per-request snapshots into cumulative model-throughput estimates.
   */
  estimateContextUsage?: boolean;
  /** Requested context window used as the ratio denominator. */
  contextWindow?: number;
}

const RESULT_ERROR_KIND: Record<string, ErrorKind> = {
  error_max_turns: 'max-turns',
  error_max_budget_usd: 'budget',
  error_max_structured_output_retries: 'structured-output-retries',
  error_during_execution: 'infra',
};

const ASSISTANT_ERROR_KIND: Record<string, ErrorKind> = {
  authentication_failed: 'auth',
  billing_error: 'auth',
  rate_limit: 'rate-limit',
  invalid_request: 'schema-rejected',
  max_output_tokens: 'max-turns',
  server_error: 'infra',
};

export function createStreamJsonParser(
  options: StreamJsonParserOptions = {},
): { push(line: string): AgentEvent[]; end(): AgentEvent[] } {
  // The CLI emits one assistant line PER CONTENT BLOCK of an API call (same
  // message.id, byte-identical usage repeated) — deduped here or a text+tool_use
  // turn would count its usage twice in interim accumulation.
  const reportedUsageMessages = new Set<string>();
  let contextWindow = positiveContextWindow(options.contextWindow);
  const contextRatios = new Map<string, number>();
  const reportedUsageKeys = new Set<string>();
  const requestKeysByMessage = new Map<string, Set<string>>();
  let unkeyedContextRatioSum = 0;
  let lastContextRatio: number | undefined;
  let terminalUsageEmitted = false;
  let assistantReportedUsage: Partial<NormalizedUsage> | undefined;
  let lastAssistantMessageId: string | undefined;

  const accumulateReportedUsage = (usage: Partial<NormalizedUsage>): void => {
    assistantReportedUsage = {
      inputTokens: (assistantReportedUsage?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
      outputTokens: (assistantReportedUsage?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
      cachedInputTokens:
        (assistantReportedUsage?.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
      reasoningTokens:
        (assistantReportedUsage?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
    };
  };

  const contextRequestKey = (
    usage: Record<string, any>,
    fallbackKey: string | undefined,
  ): string | undefined =>
    typeof usage.request_id === 'string'
      ? `request:${usage.request_id}`
      : fallbackKey !== undefined
        ? `message:${fallbackKey}`
        : undefined;

  const observeContextRatio = (
    usage: Record<string, any> | undefined,
    fallbackKey: string | undefined,
    terminal: boolean,
  ): number => {
    if (!options.estimateContextUsage || !usage) return 0;
    const ratio = usage.context_usage_ratio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) return 0;
    const requestKey = contextRequestKey(usage, fallbackKey);
    // A terminal result repeats the final assistant request. Older streams may
    // omit request_id, so identical adjacent ratios are the only safe fallback.
    if (requestKey === undefined) {
      if (terminal && lastContextRatio === ratio) return 0;
      unkeyedContextRatioSum += ratio;
      lastContextRatio = ratio;
      return ratio;
    }
    const previous = contextRatios.get(requestKey);
    if (previous !== undefined && ratio <= previous) return 0;
    contextRatios.set(requestKey, ratio);
    const delta = ratio - (previous ?? 0);
    lastContextRatio = ratio;
    return delta;
  };

  const estimatedContextUsage = (ratio: number): Partial<NormalizedUsage> | undefined => {
    if (contextWindow === undefined || ratio <= 0) return undefined;
    return {
      // The snapshot covers the entire request context, including hidden
      // instructions, tool schemas/results, conversation history, and the
      // generated assistant turn. Keep it in one bucket to avoid double count.
      inputTokens: Math.max(1, Math.round(ratio * contextWindow)),
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      estimated: true,
    };
  };

  const uncoveredContextRatio = (): number =>
    (
      unkeyedContextRatioSum +
      [...contextRatios.entries()]
        .filter(([key]) => !reportedUsageKeys.has(key))
        .reduce((sum, [, ratio]) => sum + ratio, 0)
    );

  const settledObservedUsage = (): Partial<NormalizedUsage> | undefined => {
    const uncoveredRatio = uncoveredContextRatio();
    const estimated = estimatedContextUsage(uncoveredRatio);
    if (assistantReportedUsage === undefined) return estimated;
    if (estimated === undefined) return assistantReportedUsage;
    return {
      inputTokens: (assistantReportedUsage.inputTokens ?? 0) + (estimated.inputTokens ?? 0),
      outputTokens: (assistantReportedUsage.outputTokens ?? 0) + (estimated.outputTokens ?? 0),
      cachedInputTokens:
        (assistantReportedUsage.cachedInputTokens ?? 0) + (estimated.cachedInputTokens ?? 0),
      reasoningTokens:
        (assistantReportedUsage.reasoningTokens ?? 0) + (estimated.reasoningTokens ?? 0),
      estimated: true,
    };
  };

  const contextTelemetryIncomplete = (): boolean =>
    options.estimateContextUsage === true &&
    contextWindow === undefined &&
    uncoveredContextRatio() > 0;

  return {
    push(line: string): AgentEvent[] {
      const obj = parseJsonLine(line) as Record<string, any> | undefined;
      if (!obj || typeof obj.type !== 'string') return [];
      const out: AgentEvent[] = [];

      switch (obj.type) {
        case 'system': {
          const reportedWindow = contextWindowFromObject(obj);
          if (reportedWindow !== undefined) contextWindow = reportedWindow;
          if (typeof obj.session_id === 'string') {
            out.push({ kind: 'session', sessionId: obj.session_id, model: typeof obj.model === 'string' ? obj.model : undefined });
          }
          break;
        }
        case 'assistant': {
          if (typeof obj.session_id === 'string') out.push({ kind: 'session', sessionId: obj.session_id });
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'text' && typeof block.text === 'string') out.push({ kind: 'message', text: block.text });
              if (block?.type === 'tool_use') out.push({ kind: 'tool', name: `tool:${block.name ?? ''}`, status: 'started' });
            }
          }
          // Assistant lines carry per-API-call usage (qoder omits it) —
          // surfaced as interim ticks for live progress, never for accounting.
          if (obj.message?.usage && typeof obj.message.usage === 'object') {
            const messageId = typeof obj.message.id === 'string' ? obj.message.id : undefined;
            lastAssistantMessageId = messageId;
            const messageUsage = obj.message.usage as Record<string, any>;
            const requestKey = contextRequestKey(messageUsage, messageId);
            if (messageId !== undefined && requestKey !== undefined) {
              const keys = requestKeysByMessage.get(messageId) ?? new Set<string>();
              keys.add(requestKey);
              requestKeysByMessage.set(messageId, keys);
              if (reportedUsageMessages.has(messageId)) reportedUsageKeys.add(requestKey);
            }
            const reported = usageFromResult({ usage: messageUsage });
            const ratioDelta = observeContextRatio(messageUsage, messageId, false);
            if (hasTokenUsage(reported)) {
              const duplicateMessage = messageId !== undefined && reportedUsageMessages.has(messageId);
              const duplicateRequest = requestKey !== undefined && reportedUsageKeys.has(requestKey);
              if (!duplicateMessage && !duplicateRequest) {
                if (messageId !== undefined) reportedUsageMessages.add(messageId);
                accumulateReportedUsage(reported);
                out.push({ kind: 'usage', usage: reported, interim: true });
              }
              if (requestKey !== undefined) reportedUsageKeys.add(requestKey);
              if (messageId !== undefined) {
                reportedUsageKeys.add(`message:${messageId}`);
                for (const key of requestKeysByMessage.get(messageId) ?? []) reportedUsageKeys.add(key);
              }
            } else {
              // Unlike Claude's byte-identical blocks, Qoder 1.1.4 adds the
              // ratio only on the final tool/end block of the same message.
              const estimated = estimatedContextUsage(ratioDelta);
              const covered =
                (requestKey !== undefined && reportedUsageKeys.has(requestKey)) ||
                (messageId !== undefined && reportedUsageMessages.has(messageId));
              if (estimated && !covered) out.push({ kind: 'usage', usage: estimated, interim: true });
            }
          }
          if (typeof obj.error === 'string') {
            out.push({ kind: 'result', isError: true, errorKind: ASSISTANT_ERROR_KIND[obj.error] ?? 'infra', text: obj.error, raw: obj });
          }
          break;
        }
        case 'result': {
          if (typeof obj.session_id === 'string') out.push({ kind: 'session', sessionId: obj.session_id });
          const reportedWindow = contextWindowFromModelUsage(obj.modelUsage);
          if (reportedWindow !== undefined) contextWindow = reportedWindow;
          observeContextRatio(obj.usage, undefined, true);
          const reported = usageFromResult(obj);
          let usage: Partial<NormalizedUsage>;
          if (options.estimateContextUsage) {
            const terminalUsage =
              obj.usage && typeof obj.usage === 'object'
                ? obj.usage as Record<string, any>
                : undefined;
            const requestKey =
              terminalUsage === undefined ? undefined : contextRequestKey(terminalUsage, undefined);
            if (hasTokenUsage(reported)) {
              const lastMessageAliases =
                lastAssistantMessageId === undefined
                  ? undefined
                  : requestKeysByMessage.get(lastAssistantMessageId);
              const lastMessageUsedFallback =
                lastAssistantMessageId !== undefined &&
                reportedUsageMessages.has(lastAssistantMessageId) &&
                lastMessageAliases?.has(`message:${lastAssistantMessageId}`) === true;
              const alreadyReported =
                (requestKey !== undefined && reportedUsageKeys.has(requestKey)) ||
                (requestKey === undefined &&
                  lastAssistantMessageId !== undefined &&
                  reportedUsageMessages.has(lastAssistantMessageId)) ||
                (requestKey !== undefined && lastMessageUsedFallback);
              if (!alreadyReported) accumulateReportedUsage(reported);
              if (requestKey !== undefined) reportedUsageKeys.add(requestKey);
              if (lastAssistantMessageId !== undefined) {
                const fallbackAlias = `message:${lastAssistantMessageId}`;
                if (requestKey === undefined) {
                  reportedUsageKeys.add(fallbackAlias);
                  for (const alias of lastMessageAliases ?? []) reportedUsageKeys.add(alias);
                } else if (lastMessageAliases?.has(fallbackAlias)) {
                  reportedUsageKeys.add(fallbackAlias);
                }
              }
            }
            const observed = settledObservedUsage();
            usage = observed ?? reported;
            if (reported.costUSD !== undefined) usage = { ...usage, costUSD: reported.costUSD };
          } else {
            // Claude's terminal envelope is aggregate; unlike Qoder's
            // request-scoped result usage it authoritatively replaces interim
            // per-request counters.
            const observed = settledObservedUsage();
            usage = hasTokenUsage(reported) || observed === undefined ? reported : observed;
          }
          out.push({
            kind: 'usage',
            usage,
            ...(contextTelemetryIncomplete() ? { telemetryIncomplete: true } : {}),
          });
          terminalUsageEmitted = true;
          const isError = obj.is_error === true || (typeof obj.subtype === 'string' && obj.subtype.startsWith('error'));
          out.push({
            kind: 'result',
            isError,
            text: typeof obj.result === 'string' ? obj.result : undefined,
            structured: obj.structured_output,
            errorKind: isError ? (RESULT_ERROR_KIND[obj.subtype] ?? 'infra') : undefined,
            raw: obj,
          });
          break;
        }
        case 'stream_event':
        case 'user':
        case 'rate_limit_event':
        default:
          break;
      }
      return out;
    },
    end(): AgentEvent[] {
      if (terminalUsageEmitted) return [];
      const observed = settledObservedUsage();
      if (observed === undefined) return [];
      terminalUsageEmitted = true;
      return [{
        kind: 'usage',
        usage: observed,
        ...(contextTelemetryIncomplete() ? { telemetryIncomplete: true } : {}),
      }];
    },
  };
}

function positiveContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function contextWindowFromObject(obj: Record<string, any>): number | undefined {
  return (
    positiveContextWindow(obj.context_window) ??
    positiveContextWindow(obj.contextWindow) ??
    positiveContextWindow(obj.model_context_window)
  );
}

function contextWindowFromModelUsage(modelUsage: unknown): number | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const windows = new Set<number>();
  for (const value of Object.values(modelUsage as Record<string, any>)) {
    const window = positiveContextWindow(value?.contextWindow);
    if (window !== undefined) windows.add(window);
  }
  return windows.size === 1 ? windows.values().next().value : undefined;
}

function hasTokenUsage(usage: Partial<NormalizedUsage>): boolean {
  return (
    (usage.inputTokens ?? 0) > 0 ||
    (usage.outputTokens ?? 0) > 0 ||
    (usage.cachedInputTokens ?? 0) > 0 ||
    (usage.reasoningTokens ?? 0) > 0
  );
}

function usageFromResult(obj: Record<string, any>): Partial<NormalizedUsage> {
  const u = obj.usage ?? {};
  return {
    // cache_creation_input_tokens is prompt Anthropic reports separately from
    // input_tokens (write-through, billed ~1.25×). Fold it into input — on
    // cache-populating turns it's often the bulk, and dropping it lets real
    // spend overshoot the budget dispatch gate. (cache_read stays discounted to
    // 0.1× via cachedInputTokens.)
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    cachedInputTokens: u.cache_read_input_tokens ?? 0,
    reasoningTokens: 0,
    costUSD: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
  };
}
