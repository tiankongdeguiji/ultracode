/**
 * qodercli --print worker adapter. Native structured output via the
 * undocumented --json-schema flag (SDK-source-proven) → structured_output on
 * the terminal result line; the engine ALWAYS revalidates with ajv, so if
 * the flag ever drops, correctness is unaffected (more repair turns only).
 *
 * exit 41 = auth (terminal); PAT auth is stateless and parallel-safe, but a
 * stored /login credential silently overrides the env PAT.
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
  safe: 'dont_ask',
  auto: 'accept_edits',
  danger: 'bypass_permissions',
};

export const QODER_AUTH_EXIT = 41;

export class QoderAdapter implements BackendAdapter {
  readonly id = 'qoder' as const;
  readonly structuredOutput = 'native' as const;

  constructor(private readonly bin = process.env.ULTRACODE_QODER_BIN ?? 'qodercli') {}

  probe(): Promise<BackendProbe> {
    return new Promise((resolve) => {
      execFile(this.bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
        if (err) {
          resolve({ available: false, authHint: 'qodercli not found' });
          return;
        }
        const warnings: string[] = [];
        if (!process.env.QODER_PERSONAL_ACCESS_TOKEN) {
          warnings.push('QODER_PERSONAL_ACCESS_TOKEN unset — headless runs need it (or a stored /login, which overrides env PATs)');
        }
        resolve({ available: true, version: stdout.trim(), warnings });
      });
    });
  }

  checkSchema(schema: JsonSchema): { ok: true; wireSchema: JsonSchema } {
    return { ok: true, wireSchema: schema };
  }

  buildSpawn(req: AgentRequest): SpawnPlan {
    const argv = [
      '--print',
      '--output-format',
      'stream-json',
      '--permission-mode',
      PERMISSION_MODE[req.permission],
      '-w',
      req.cwd,
    ];
    if (req.model) argv.push('--model', req.model);
    if (req.agentType) argv.push('--agent', req.agentType);
    if (req.schema) argv.push('--json-schema', JSON.stringify(req.schema));
    return { bin: this.bin, argv, env: req.env, stdinData: req.prompt };
  }

  buildResume(sessionId: string, followupPrompt: string, req: AgentRequest): SpawnPlan {
    // Same pinned --permission-mode (and model/agent) as buildSpawn: without
    // them the resumed leg would drift to settings defaults instead of the
    // permission the run was started with.
    const argv = [
      '--print',
      '--output-format',
      'stream-json',
      '--permission-mode',
      PERMISSION_MODE[req.permission],
      '-r',
      sessionId,
      '-w',
      req.cwd,
    ];
    if (req.model) argv.push('--model', req.model);
    if (req.agentType) argv.push('--agent', req.agentType);
    if (req.schema) argv.push('--json-schema', JSON.stringify(req.schema));
    return { bin: this.bin, argv, env: req.env, stdinData: followupPrompt };
  }

  createParser() {
    return createStreamJsonParser();
  }

  classifyExit(code: number | null, signal: NodeJS.Signals | null, events: AgentEvent[], stderrTail: string): ExitClass {
    if (signal) return { ok: false, errorKind: 'interrupted', retryable: false, message: `killed by ${signal}` };
    if (code === QODER_AUTH_EXIT) {
      return { ok: false, errorKind: 'auth', retryable: false, message: `qodercli auth error (exit 41): ${stderrTail.slice(-300)}` };
    }
    // Terminal result is authoritative (see claude.ts): an earlier assistant-level
    // result{isError:true} would otherwise mask a successful terminal result.
    const result = events.filter((e): e is Extract<AgentEvent, { kind: 'result' }> => e.kind === 'result').pop();
    if (code === 0 && result && result.kind === 'result' && !result.isError) {
      return { ok: true, retryable: false, message: 'ok' };
    }
    if (result && result.kind === 'result' && result.isError) {
      const kind = result.errorKind ?? 'infra';
      return { ok: false, errorKind: kind, retryable: kind === 'infra', message: result.text ?? `result ${result.errorKind}` };
    }
    return {
      ok: false,
      errorKind: 'infra',
      retryable: true,
      message: `qodercli exited ${code} without a success result: ${stderrTail.slice(-400)}`,
    };
  }

  extractUsage(events: AgentEvent[]): NormalizedUsage {
    return usageFromEvents(events);
  }
}
