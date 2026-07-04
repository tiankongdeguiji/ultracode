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

export function createStreamJsonParser(): { push(line: string): AgentEvent[]; end(): AgentEvent[] } {
  return {
    push(line: string): AgentEvent[] {
      const obj = parseJsonLine(line) as Record<string, any> | undefined;
      if (!obj || typeof obj.type !== 'string') return [];
      const out: AgentEvent[] = [];

      switch (obj.type) {
        case 'system':
          if (typeof obj.session_id === 'string') out.push({ kind: 'session', sessionId: obj.session_id });
          break;
        case 'assistant': {
          if (typeof obj.session_id === 'string') out.push({ kind: 'session', sessionId: obj.session_id });
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'text' && typeof block.text === 'string') out.push({ kind: 'message', text: block.text });
              if (block?.type === 'tool_use') out.push({ kind: 'tool', name: `tool:${block.name ?? ''}`, status: 'started' });
            }
          }
          if (typeof obj.error === 'string') {
            out.push({ kind: 'result', isError: true, errorKind: ASSISTANT_ERROR_KIND[obj.error] ?? 'infra', text: obj.error, raw: obj });
          }
          break;
        }
        case 'result': {
          if (typeof obj.session_id === 'string') out.push({ kind: 'session', sessionId: obj.session_id });
          out.push({ kind: 'usage', usage: usageFromResult(obj) });
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
      return [];
    },
  };
}

function usageFromResult(obj: Record<string, any>): Partial<NormalizedUsage> {
  const u = obj.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cachedInputTokens: u.cache_read_input_tokens ?? 0,
    reasoningTokens: 0,
    costUSD: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
  };
}
