/**
 * claude -p adapter (Claude Code headless). Native structured output via
 * --json-schema; the result envelope is the ancestor of Qoder's.
 */
import type {
  AgentEvent,
  AgentRequest,
  BackendAdapter,
  BackendProbe,
  ExitClass,
  JsonSchema,
  NormalizedUsage,
  SpawnPlan,
} from './types.js';
import { createStreamJsonParser } from './streamjson.js';
import { usageFromEvents } from './usage.js';
import { execFile } from 'node:child_process';

const PERMISSION_MODE: Record<AgentRequest['permission'], string> = {
  safe: 'default',
  auto: 'acceptEdits',
  danger: 'bypassPermissions',
};

export class ClaudeAdapter implements BackendAdapter {
  readonly id = 'claude' as const;
  readonly structuredOutput = 'native' as const;

  constructor(private readonly bin = process.env.ULTRACODE_CLAUDE_BIN ?? 'claude') {}

  probe(): Promise<BackendProbe> {
    return new Promise((resolve) => {
      execFile(this.bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
        resolve(err ? { available: false, authHint: 'claude CLI not found' } : { available: true, version: stdout.trim() });
      });
    });
  }

  checkSchema(schema: JsonSchema): { ok: true; wireSchema: JsonSchema } {
    return { ok: true, wireSchema: schema }; // claude accepts full JSON Schema; ajv still revalidates
  }

  buildSpawn(req: AgentRequest): SpawnPlan {
    const argv = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      PERMISSION_MODE[req.permission],
    ];
    if (req.model) argv.push('--model', req.model);
    if (req.schema) argv.push('--json-schema', JSON.stringify(req.schema));
    return { bin: this.bin, argv, env: req.env, stdinData: req.prompt };
  }

  buildResume(sessionId: string, followupPrompt: string, req: AgentRequest): SpawnPlan {
    // Same pinned --permission-mode as buildSpawn: without it the resumed leg
    // would drift to CLI/user/project settings defaults — a repo-supplied
    // .claude/settings.json could escalate a 'safe' worker on its retry.
    const argv = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      PERMISSION_MODE[req.permission],
      '--resume',
      sessionId,
    ];
    if (req.model) argv.push('--model', req.model);
    if (req.schema) argv.push('--json-schema', JSON.stringify(req.schema));
    return { bin: this.bin, argv, env: req.env, stdinData: followupPrompt };
  }

  createParser() {
    return createStreamJsonParser();
  }

  classifyExit(code: number | null, signal: NodeJS.Signals | null, events: AgentEvent[], stderrTail: string): ExitClass {
    if (signal) return { ok: false, errorKind: 'interrupted', retryable: false, message: `killed by ${signal}` };
    // The TERMINAL result is authoritative: an assistant message can emit an
    // earlier result{isError:true} (from obj.error) before a successful terminal
    // result, so `.find()` (first) would misclassify success as failure.
    const result = events.filter((e): e is Extract<AgentEvent, { kind: 'result' }> => e.kind === 'result').pop();
    if (code === 0 && result && result.kind === 'result' && !result.isError) {
      return { ok: true, retryable: false, message: 'ok' };
    }
    if (result && result.kind === 'result' && result.isError) {
      const kind = result.errorKind ?? 'infra';
      return { ok: false, errorKind: kind, retryable: kind === 'infra', message: result.text ?? 'result error' };
    }
    return {
      ok: false,
      errorKind: 'infra',
      retryable: true,
      message: `claude exited ${code} without a success result: ${stderrTail.slice(-400)}`,
    };
  }

  extractUsage(events: AgentEvent[]): NormalizedUsage {
    return usageFromEvents(events);
  }
}
