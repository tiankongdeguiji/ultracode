import { ZERO_USAGE, type AgentEvent, type NormalizedUsage } from './types.js';

/** totalTokens = input + output + reasoning + round(0.1 × cached) — cached input discounted. */
export function finalizeUsage(partial: Partial<NormalizedUsage>): NormalizedUsage {
  const inputTokens = partial.inputTokens ?? 0;
  const outputTokens = partial.outputTokens ?? 0;
  const cachedInputTokens = partial.cachedInputTokens ?? 0;
  const reasoningTokens = partial.reasoningTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens + Math.round(0.1 * cachedInputTokens),
    costUSD: partial.costUSD,
    estimated: partial.estimated ?? false,
  };
}

/** Merge usage events (later events win per-field); zero usage if none. */
export function usageFromEvents(events: AgentEvent[]): NormalizedUsage {
  let acc: Partial<NormalizedUsage> | undefined;
  for (const ev of events) {
    if (ev.kind === 'usage') acc = { ...acc, ...ev.usage };
  }
  return acc ? finalizeUsage(acc) : { ...ZERO_USAGE };
}

/** chars/4 fallback when a backend omits usage entirely — flagged estimated. */
export function estimateUsage(promptChars: number, outputChars: number): NormalizedUsage {
  return finalizeUsage({
    inputTokens: Math.ceil(promptChars / 4),
    outputTokens: Math.ceil(outputChars / 4),
    estimated: true,
  });
}
