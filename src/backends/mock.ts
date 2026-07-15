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
import { validateWithSchema } from '../engine/ajv.js';
import type { AgentExecutor, AgentOutcome, AgentSpec, NormalizedUsage } from './types.js';

export interface MockStats {
  calls: number;
  attempts: number;
  maxConcurrent: number;
}

/** Minimal valid instance for a JSON Schema (dry-run stubs). */
export function stubFromSchema(schema: Record<string, unknown>): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return stubFromSchema(schema.anyOf[0] as Record<string, unknown>);
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = new Set((schema.required as string[]) ?? Object.keys(props));
      for (const [key, sub] of Object.entries(props)) {
        if (required.has(key)) out[key] = stubFromSchema(sub);
      }
      return out;
    }
    case 'array': {
      const minItems = typeof schema.minItems === 'number' ? schema.minItems : 1;
      const item = schema.items ? stubFromSchema(schema.items as Record<string, unknown>) : 'mock';
      return Array.from({ length: Math.max(1, minItems) }, () => item);
    }
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return true;
    case 'string': {
      const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
      return 'mock'.padEnd(min, 'x');
    }
    default:
      return null;
  }
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
        if (res.ok) {
          // agent({schema}) contract holds on mock too (dry-run rehearsal):
          // validate against the ORIGINAL schema, fail as the real pipeline would.
          if (spec.schema) {
            const validation = validateWithSchema(spec.schema, res.value);
            if (!validation.ok) {
              return this.outcome(spec, {
                ok: false,
                error: `structured output failed validation: ${validation.errors.slice(0, 5).join('; ')}`,
                errorKind: 'structured-output-retries',
                attempts: attempt,
              });
            }
          }
          return this.outcome(spec, { ...res, attempts: attempt });
        }
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

    // Default (no directive): schema-aware stub so dry-runs of typed
    // workflows rehearse cleanly. Explicit directives stay strict.
    if (spec.schema) return { ok: true, value: stubFromSchema(spec.schema) };
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
