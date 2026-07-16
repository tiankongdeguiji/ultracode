/**
 * codex exec adapter (pinned against codex-cli 0.142.x; the exec --json event
 * shape re-verified live on 0.144.4 — the rollout sidecar in codex-rollout.ts
 * is verified against 0.144.4 only).
 *
 * Load-bearing quirks (verified against codex-cli 0.142.x source and live
 * exec/--output-schema behavior):
 *  - prompt via stdin ('-' positional): no argv length limits, no shell history.
 *  - NEVER -o/--output-last-message: the file is not written (nor truncated)
 *    on failure — a stale artifact from a prior run masquerades as output.
 *  - final answer = the LAST item.completed agent_message; with
 *    --output-schema, INTERMEDIATE messages are also schema-shaped (#19816).
 *  - standalone {"type":"error"} events include benign retry chatter
 *    ("Reconnecting... n/5"); turn.failed + exit code are the only
 *    authoritative failure signals. Exit codes: 0 ok, 1 everything fatal,
 *    2 usage error.
 *  - --output-schema is enforced server-side (Responses strict:true); a
 *    schema outside the strict subset 400s deterministically — zero retries
 *    (classified schema-rejected, non-retryable).
 *  - exec has no -a flag in 0.142; approvals are auto-rejected. A run can
 *    "succeed" (exit 0) having done nothing — the silent no-op trap
 *    (declined actions surfaced by the executor in M7).
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
import { checkCodexStrictSchema } from './schema-strict.js';
import { codexUsageToPartial, createCodexRolloutSidecar } from './codex-rollout.js';
import type { JsonSchema } from './types.js';
import { execFile } from 'node:child_process';

const PERMISSION_TO_SANDBOX: Record<AgentRequest['permission'], string> = {
  safe: 'read-only',
  auto: 'workspace-write',
  danger: 'danger-full-access',
};

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  status?: string;
  command?: string;
  query?: string;
  tool?: string;
}

export class CodexAdapter implements BackendAdapter {
  readonly id = 'codex' as const;
  readonly structuredOutput = 'native' as const;

  constructor(private readonly bin = process.env.ULTRACODE_CODEX_BIN ?? 'codex') {}

  probe(): Promise<BackendProbe> {
    return new Promise((resolve) => {
      execFile(this.bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
        if (err) {
          resolve({ available: false, authHint: `codex binary not found (${this.bin})` });
          return;
        }
        resolve({ available: true, version: stdout.trim() });
      });
    });
  }

  /** Strict-subset pre-validation: incompatible schemas 400 deterministically — reject before any spawn. */
  checkSchema(schema: JsonSchema): { ok: true; wireSchema: JsonSchema } | { ok: false; reason: string } {
    return checkCodexStrictSchema(schema);
  }

  buildSpawn(req: AgentRequest): SpawnPlan {
    const argv = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      req.cwd,
      '--sandbox',
      PERMISSION_TO_SANDBOX[req.permission],
    ];
    if (req.model) argv.push('-m', req.model);
    if (req.effort) argv.push('-c', `model_reasoning_effort=${JSON.stringify(req.effort)}`);
    const plan: SpawnPlan = {
      bin: this.bin,
      argv,
      env: req.env,
      stdinData: req.prompt,
    };
    if (req.schema) {
      plan.schemaTempFile = { content: JSON.stringify(req.schema) };
      // caller appends: --output-schema <tempfile path> (path known post-write)
    }
    argv.push('-'); // read prompt from stdin
    return plan;
  }

  /** --output-schema is a global flag: it re-attaches on resume repair turns. */
  buildResume(sessionId: string, followupPrompt: string, req: AgentRequest): SpawnPlan | null {
    const argv = [
      'exec',
      'resume',
      sessionId,
      '--json',
      '--skip-git-repo-check',
      '--cd',
      req.cwd,
      '--sandbox',
      PERMISSION_TO_SANDBOX[req.permission],
    ];
    if (req.model) argv.push('-m', req.model);
    const plan: SpawnPlan = { bin: this.bin, argv, env: req.env, stdinData: followupPrompt };
    if (req.schema) plan.schemaTempFile = { content: JSON.stringify(req.schema) };
    argv.push('-');
    return plan;
  }

  /** codex --output-schema position: appended by the spawner once the temp file exists. */
  schemaFlag(tempFilePath: string): string[] {
    return ['--output-schema', tempFilePath];
  }

  createParser(): { push(line: string): AgentEvent[]; end(): AgentEvent[] } {
    return {
      push(line: string): AgentEvent[] {
        const obj = parseJsonLine(line) as Record<string, any> | undefined;
        if (!obj || typeof obj.type !== 'string') {
          return [{ kind: 'notice', message: line }];
        }
        switch (obj.type) {
          case 'thread.started':
            return typeof obj.thread_id === 'string' ? [{ kind: 'session', sessionId: obj.thread_id }] : [];
          case 'turn.started':
            return [];
          case 'turn.completed': {
            // Subset semantics handled in codexUsageToPartial (cached ⊂ input,
            // reasoning ⊂ output). threadCumulative: exec populates this from
            // the SESSION's running total, so an `exec resume` attempt (schema
            // repair) repeats every prior attempt's tokens — the executor
            // counts only the last cumulative report per session.
            return [
              { kind: 'usage', usage: codexUsageToPartial(obj.usage ?? {}), threadCumulative: true },
              { kind: 'result', isError: false, raw: obj },
            ];
          }
          case 'turn.failed': {
            const message: string = obj.error?.message ?? 'turn failed';
            return [
              {
                kind: 'result',
                isError: true,
                errorKind: classifyFailureMessage(message),
                text: message,
                raw: obj,
              },
            ];
          }
          case 'error':
            // Retryable + fatal notifications share this event type; benign
            // "Reconnecting... n/5" chatter included. Never authoritative.
            return [{ kind: 'notice', message: String(obj.message ?? '') }];
          case 'item.started':
          case 'item.updated':
          case 'item.completed': {
            const item = (obj.item ?? {}) as CodexItem;
            if (item.type === 'agent_message' && obj.type === 'item.completed') {
              return [{ kind: 'message', text: String(item.text ?? '') }];
            }
            if (item.type === 'command_execution' || item.type === 'mcp_tool_call' || item.type === 'web_search') {
              const status =
                obj.type === 'item.started'
                  ? 'started'
                  : item.status === 'declined'
                    ? 'declined'
                    : item.status === 'failed'
                      ? 'failed'
                      : obj.type === 'item.completed'
                        ? 'completed'
                        : 'started';
              const name =
                item.type === 'command_execution'
                  ? `bash:${(item.command ?? '').slice(0, 40)}`
                  : item.type === 'web_search'
                    ? `web_search:${(item.query ?? '').slice(0, 40)}`
                    : `mcp:${item.tool ?? ''}`;
              return [{ kind: 'tool', name, status }];
            }
            return [];
          }
          default:
            return [{ kind: 'notice', message: line }];
        }
      },
      end(): AgentEvent[] {
        return [];
      },
    };
  }

  classifyExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    events: AgentEvent[],
    stderrTail: string,
  ): ExitClass {
    const turnFailed = events.find((e) => e.kind === 'result' && e.isError);
    const turnCompleted = events.some((e) => e.kind === 'result' && !e.isError);

    if (signal) {
      return { ok: false, errorKind: 'interrupted', retryable: false, message: `killed by ${signal}` };
    }
    if (code === 0 && turnCompleted && !turnFailed) {
      return { ok: true, retryable: false, message: 'ok' };
    }
    if (turnFailed && turnFailed.kind === 'result') {
      const kind = turnFailed.errorKind ?? 'infra';
      return {
        ok: false,
        errorKind: kind,
        // codex already burned its internal stream retries (default 5);
        // at most one agent-level re-run, and only for infra failures.
        retryable: kind === 'infra',
        message: turnFailed.text ?? 'turn failed',
      };
    }
    if (code === 0 && !turnCompleted) {
      return { ok: false, errorKind: 'infra', retryable: true, message: 'stream ended without turn.completed' };
    }
    if (code === 2) {
      return { ok: false, errorKind: 'unknown', retryable: false, message: `codex usage error: ${stderrTail.slice(-500)}` };
    }
    return {
      ok: false,
      errorKind: 'interrupted',
      retryable: false,
      message: `codex exited ${code} without turn.failed: ${stderrTail.slice(-500)}`,
    };
  }

  /** Live usage + resolved model via the session rollout file — exec --json
   *  itself never surfaces either (display-only; see codex-rollout.ts). */
  createSidecar(sessionId: string, emit: (ev: AgentEvent) => void, opts?: { resumedSession?: boolean }) {
    return createCodexRolloutSidecar(sessionId, emit, { resumedSession: opts?.resumedSession });
  }

  extractUsage(events: AgentEvent[]): NormalizedUsage {
    return usageFromEvents(events);
  }
}

export function classifyFailureMessage(message: string): ExitClass['errorKind'] {
  if (/invalid_json_schema|Invalid schema for response_format 'codex_output_schema'/.test(message)) {
    return 'schema-rejected';
  }
  if (/usage_limit|usage limit|quota/i.test(message)) return 'rate-limit';
  if (/context window|context_window/i.test(message)) return 'max-turns';
  if (/refresh token|401|authentication/i.test(message)) return 'auth';
  return 'infra';
}
