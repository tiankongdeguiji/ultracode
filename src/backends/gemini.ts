/**
 * gemini -p adapter (Gemini CLI). NO native structured output → the
 * canonical EMULATED backend: agentcall.ts appends the schema prompt
 * contract, and this adapter's fresh-spawn repair path drives retries
 * (Gemini headless has no documented resume in this build).
 *
 * stream-json events: init / message / tool_use / tool_result / error /
 * result. Exit codes: 0 ok, 1 general, 42 input error (non-retryable),
 * 53 turn-limit.
 */
import type {
  AgentEvent,
  AgentRequest,
  BackendAdapter,
  BackendProbe,
  ExitClass,
  NormalizedUsage,
  SpawnPlan,
} from './types.js';
import { parseJsonLine } from './ndjson.js';
import { usageFromEvents } from './usage.js';
import { execFile } from 'node:child_process';

export class GeminiAdapter implements BackendAdapter {
  readonly id = 'gemini' as const;
  readonly structuredOutput = 'emulated' as const;

  constructor(private readonly bin = process.env.ULTRACODE_GEMINI_BIN ?? 'gemini') {}

  probe(): Promise<BackendProbe> {
    return new Promise((resolve) => {
      execFile(this.bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
        resolve(err ? { available: false, authHint: 'gemini CLI not found' } : { available: true, version: stdout.trim() });
      });
    });
  }

  buildSpawn(req: AgentRequest): SpawnPlan {
    const argv = ['-p', req.prompt, '--output-format', 'stream-json'];
    if (req.model) argv.push('-m', req.model);
    // Least privilege per tier: safe = default (prompt), auto = edit-only
    // auto-approval, danger = --yolo (approve everything, incl. shell). Never
    // --yolo below the danger tier — --yolo also defeats worktree isolation.
    if (req.permission === 'danger') argv.push('--yolo');
    else if (req.permission === 'auto') argv.push('--approval-mode', 'auto_edit');
    return { bin: this.bin, argv, env: req.env };
  }

  /** No documented headless resume → emulated repairs go through fresh spawns. */
  buildResume(): SpawnPlan | null {
    return null;
  }

  createParser() {
    return {
      push(line: string): AgentEvent[] {
        const obj = parseJsonLine(line) as Record<string, any> | undefined;
        if (!obj || typeof obj.type !== 'string') return [];
        switch (obj.type) {
          case 'message':
            return typeof obj.content === 'string'
              ? [{ kind: 'message', text: obj.content }]
              : typeof obj.text === 'string'
                ? [{ kind: 'message', text: obj.text }]
                : [];
          case 'tool_use':
            return [{ kind: 'tool', name: `tool:${obj.name ?? ''}`, status: 'started' }];
          case 'tool_result':
            return [{ kind: 'tool', name: `tool:${obj.name ?? ''}`, status: obj.error ? 'failed' : 'completed' }];
          case 'error':
            return [{ kind: 'notice', message: String(obj.message ?? obj.error ?? '') }];
          case 'result': {
            const text =
              typeof obj.response === 'string'
                ? obj.response
                : typeof obj.result === 'string'
                  ? obj.result
                  : undefined;
            const usage = extractGeminiUsage(obj);
            const events: AgentEvent[] = [{ kind: 'result', isError: obj.error != null, text, raw: obj }];
            if (usage) events.unshift({ kind: 'usage', usage });
            return events;
          }
          default:
            return [];
        }
      },
      end: (): AgentEvent[] => [],
    };
  }

  classifyExit(code: number | null, signal: NodeJS.Signals | null, events: AgentEvent[], stderrTail: string): ExitClass {
    if (signal) return { ok: false, errorKind: 'interrupted', retryable: false, message: `killed by ${signal}` };
    switch (code) {
      case 0: {
        // Exit 0 alone is not success: require a terminal, non-error result.
        // A truncated stream (no result) or an in-band error (obj.error →
        // isError) would otherwise resolve agent() with an empty value.
        const result = events.filter((e): e is Extract<AgentEvent, { kind: 'result' }> => e.kind === 'result').pop();
        if (!result) {
          return { ok: false, errorKind: 'infra', retryable: true, message: 'gemini exited 0 without a terminal result (truncated stream?)' };
        }
        if (result.isError) {
          return { ok: false, errorKind: 'infra', retryable: true, message: `gemini reported an in-band error: ${stderrTail.slice(-300)}` };
        }
        return { ok: true, retryable: false, message: 'ok' };
      }
      case 42:
        return { ok: false, errorKind: 'schema-rejected', retryable: false, message: `gemini input error (42): ${stderrTail.slice(-300)}` };
      case 53:
        return { ok: false, errorKind: 'max-turns', retryable: false, message: 'gemini turn limit (53)' };
      default:
        return { ok: false, errorKind: 'infra', retryable: true, message: `gemini exited ${code}: ${stderrTail.slice(-300)}` };
    }
  }

  extractUsage(events: AgentEvent[]): NormalizedUsage {
    return usageFromEvents(events);
  }
}

function extractGeminiUsage(obj: Record<string, any>): Partial<NormalizedUsage> | undefined {
  const models = obj.stats?.models;
  if (!models || typeof models !== 'object') return undefined;
  let input = 0;
  let output = 0;
  for (const m of Object.values(models as Record<string, any>)) {
    const t = (m as any).tokens ?? m;
    input += t?.prompt ?? t?.input ?? 0;
    output += t?.candidates ?? t?.output ?? 0;
  }
  return input + output > 0 ? { inputTokens: input, outputTokens: output } : undefined;
}
