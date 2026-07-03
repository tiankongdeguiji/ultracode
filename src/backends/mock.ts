/**
 * Mock backend: a fault-injecting AgentExecutor driven by directives in the
 * prompt itself. First-class test substrate (and the --dry-run engine).
 *
 * Directive grammar (prompt prefix):
 *   MOCK:ok <json|text>        → succeed with parsed JSON (or raw text)
 *   MOCK:echo                  → succeed with the full prompt text
 *   MOCK:fail [msg]            → fail every attempt
 *   MOCK:fail-then-ok <n> <v>  → fail the first n attempts, then succeed with v
 *   MOCK:delay <ms> <rest...>  → wait ms (abortable), then process rest
 *   MOCK:badjson               → succeed with a value that violates any schema
 *                                expecting different keys ({"unexpected": true})
 *   anything else              → succeed with "mock response: <prompt head>"
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentExecutor, AgentOutcome, AgentSpec, NormalizedUsage } from './types.js';

export interface MockStats {
  calls: number;
  attempts: number;
  maxConcurrent: number;
}

function usageFor(spec: AgentSpec): NormalizedUsage {
  const inputTokens = Math.ceil(spec.prompt.length / 4);
  const outputTokens = 20;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    estimated: false,
  };
}

export class MockExecutor implements AgentExecutor {
  readonly stats: MockStats = { calls: 0, attempts: 0, maxConcurrent: 0 };
  private inFlight = 0;
  /** attempt counters keyed by agent seq, for MOCK:fail-then-ok */
  private readonly attemptCounts = new Map<number, number>();

  constructor(private readonly opts: { latencyMs?: number } = {}) {}

  async execute(spec: AgentSpec, signal: AbortSignal): Promise<AgentOutcome> {
    this.stats.calls++;
    this.inFlight++;
    this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, this.inFlight);
    try {
      const maxAttempts = spec.retries + 1;
      let lastError = 'mock failure';
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        this.stats.attempts++;
        if (signal.aborted) {
          return this.outcome(spec, { ok: false, error: 'aborted', errorKind: 'interrupted', attempts: attempt });
        }
        const res = await this.attempt(spec, signal);
        if (res.ok) return this.outcome(spec, { ...res, attempts: attempt });
        lastError = res.error ?? lastError;
      }
      return this.outcome(spec, { ok: false, error: lastError, errorKind: 'unknown', attempts: maxAttempts });
    } finally {
      this.inFlight--;
    }
  }

  private outcome(
    spec: AgentSpec,
    partial: { ok: boolean; value?: unknown; error?: string; errorKind?: AgentOutcome['errorKind']; attempts: number },
  ): AgentOutcome {
    return {
      ok: partial.ok,
      value: partial.value,
      error: partial.error,
      errorKind: partial.errorKind,
      usage: usageFor(spec),
      sessionId: `mock-session-${spec.seq}`,
      toolCalls: 1,
      attempts: partial.attempts,
    };
  }

  private async attempt(
    spec: AgentSpec,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    if (this.opts.latencyMs) await sleep(this.opts.latencyMs, undefined, { signal }).catch(() => {});
    return this.interpret(spec.prompt.trim(), spec, signal);
  }

  private async interpret(
    prompt: string,
    spec: AgentSpec,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    const delayMatch = prompt.match(/^MOCK:delay (\d+)\s*([\s\S]*)$/);
    if (delayMatch) {
      await sleep(Number(delayMatch[1]), undefined, { signal }).catch(() => {});
      if (signal.aborted) return { ok: false, error: 'aborted' };
      return this.interpret(delayMatch[2] ?? '', spec, signal);
    }

    const failThenOk = prompt.match(/^MOCK:fail-then-ok (\d+)\s*([\s\S]*)$/);
    if (failThenOk) {
      const failures = Number(failThenOk[1]);
      const seen = (this.attemptCounts.get(spec.seq) ?? 0) + 1;
      this.attemptCounts.set(spec.seq, seen);
      if (seen <= failures) return { ok: false, error: `injected failure ${seen}/${failures}` };
      return this.parseValue(failThenOk[2] ?? '', spec);
    }

    const fail = prompt.match(/^MOCK:fail\s*([\s\S]*)$/);
    if (fail) return { ok: false, error: fail[1]?.trim() || 'injected failure' };

    if (prompt.startsWith('MOCK:badjson')) return { ok: true, value: { unexpected: true } };
    if (prompt.startsWith('MOCK:echo')) return { ok: true, value: spec.prompt };

    const okDirective = prompt.match(/^MOCK:ok\s*([\s\S]*)$/);
    if (okDirective) return this.parseValue(okDirective[1] ?? '', spec);

    return { ok: true, value: `mock response: ${prompt.slice(0, 60)}` };
  }

  private parseValue(raw: string, spec: AgentSpec): { ok: true; value: unknown } {
    const text = raw.trim();
    if (text.length === 0) return { ok: true, value: `mock response: ${spec.label}` };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: true, value: text };
    }
  }
}
