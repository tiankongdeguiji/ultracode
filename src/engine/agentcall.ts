/**
 * AgentCallExecutor: the real AgentExecutor over a BackendAdapter — one
 * agent() dispatch end to end: spawn plan → process-group spawn → NDJSON
 * stream parse → transcript persistence → exit classification → bounded
 * retries → outcome. Schema enforcement layers on in M6; watchdogs
 * (stallMs / timeout) tighten in M7.
 */
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NdjsonSplitter } from '../backends/ndjson.js';
import { estimateUsage } from '../backends/usage.js';
import { spawnAgentProcess, TailBuffer } from '../exec/spawn.js';
import type {
  AgentEvent,
  AgentExecutor,
  AgentOutcome,
  AgentRequest,
  AgentSpec,
  BackendAdapter,
  ExitClass,
  SpawnPlan,
} from '../backends/types.js';
import { CodexAdapter } from '../backends/codex.js';

export interface AgentCallOptions {
  /** where to stream transcript.jsonl / stderr.log for a given spec (optional) */
  artifactDir?: (spec: AgentSpec) => string;
  /** default permission for spawned workers; 'auto' = workspace-write */
  permission?: AgentRequest['permission'];
  /** per-attempt hard timeout (default 20 minutes) */
  attemptTimeoutMs?: number;
  onToolEvent?: (spec: AgentSpec, name: string, status: 'started' | 'completed' | 'failed') => void;
}

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 20 * 60_000;

interface AttemptResult {
  exit: ExitClass;
  events: AgentEvent[];
  finalText?: string;
  structured?: unknown;
  sessionId?: string;
  toolCalls: number;
  declinedActions: number;
  outputChars: number;
}

export class AgentCallExecutor implements AgentExecutor {
  constructor(
    private readonly adapter: BackendAdapter,
    private readonly opts: AgentCallOptions = {},
  ) {}

  async execute(spec: AgentSpec, signal: AbortSignal): Promise<AgentOutcome> {
    const maxAttempts = spec.retries + 1;
    let last: AttemptResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) {
        return this.toOutcome(spec, last, attempt - 1, 'aborted');
      }
      const req = this.toRequest(spec);
      const plan = this.adapter.buildSpawn(req);
      last = await this.runAttempt(spec, plan, signal, attempt);
      if (last.exit.ok) {
        return this.toOutcome(spec, last, attempt);
      }
      if (!last.exit.retryable) break;
    }
    return this.toOutcome(spec, last, Math.min(maxAttempts, (last ? 1 : 0) + spec.retries));
  }

  toRequest(spec: AgentSpec): AgentRequest {
    return {
      prompt: spec.prompt,
      schema: spec.schema,
      model: spec.model,
      effort: spec.effort,
      agentType: spec.agentType,
      cwd: spec.cwd,
      permission: this.opts.permission ?? 'auto',
      env: {},
    };
  }

  private async runAttempt(
    spec: AgentSpec,
    plan: SpawnPlan,
    signal: AbortSignal,
    attempt: number,
  ): Promise<AttemptResult> {
    const artifactDir = this.opts.artifactDir?.(spec);
    if (artifactDir) mkdirSync(artifactDir, { recursive: true });
    const transcriptFile = artifactDir ? join(artifactDir, 'transcript.jsonl') : undefined;

    // Schema temp file (codex --output-schema wants a path). Inserted before
    // the trailing '-' stdin positional when present.
    let schemaTmpDir: string | undefined;
    const argv = [...plan.argv];
    if (plan.schemaTempFile) {
      schemaTmpDir = mkdtempSync(join(tmpdir(), 'uc-schema-'));
      const schemaPath = join(schemaTmpDir, 'schema.json');
      writeFileSync(schemaPath, plan.schemaTempFile.content, 'utf8');
      const flags = ['--output-schema', schemaPath];
      if (argv.at(-1) === '-') argv.splice(argv.length - 1, 0, ...flags);
      else argv.push(...flags);
    }

    const events: AgentEvent[] = [];
    const parser = this.adapter.createParser();
    const splitter = new NdjsonSplitter();
    const stderrTail = new TailBuffer();
    let finalText: string | undefined;
    let structured: unknown;
    let sessionId: string | undefined;
    let toolCalls = 0;
    let declinedActions = 0;
    let outputChars = 0;

    const consume = (evs: AgentEvent[]): void => {
      for (const ev of evs) {
        events.push(ev);
        switch (ev.kind) {
          case 'session':
            sessionId = ev.sessionId;
            break;
          case 'message':
            finalText = ev.text; // keep the LAST message (codex #19816)
            outputChars += ev.text.length;
            break;
          case 'result':
            if (!ev.isError) {
              if (ev.structured !== undefined) structured = ev.structured;
              if (ev.text !== undefined) finalText = ev.text;
            }
            break;
          case 'tool':
            if (ev.status === 'started') toolCalls++;
            if (ev.status === 'failed') declinedActions++;
            this.opts.onToolEvent?.(spec, ev.name, ev.status);
            break;
          default:
            break;
        }
      }
    };

    try {
      const proc = spawnAgentProcess(plan.bin, argv, {
        cwd: spec.cwd,
        env: { ...process.env, ...plan.env },
        stdinData: plan.stdinData,
      });

      const timeoutMs = spec.timeoutMs ?? this.opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.killTree('SIGTERM');
        setTimeout(() => proc.killTree('SIGKILL'), 5_000).unref();
      }, timeoutMs);
      timer.unref();
      const onAbort = () => {
        proc.killTree('SIGTERM');
        setTimeout(() => proc.killTree('SIGKILL'), 5_000).unref();
      };
      signal.addEventListener('abort', onAbort, { once: true });

      proc.child.stdout?.setEncoding('utf8');
      proc.child.stderr?.setEncoding('utf8');
      proc.child.stdout?.on('data', (chunk: string) => {
        for (const line of splitter.push(chunk)) {
          if (transcriptFile) appendFileSync(transcriptFile, line + '\n');
          consume(parser.push(line));
        }
      });
      proc.child.stderr?.on('data', (chunk: string) => stderrTail.push(chunk));

      const [code, sig] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
        proc.child.on('error', reject);
        proc.child.on('close', (c, s) => resolve([c, s]));
      });
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);

      for (const line of splitter.end()) {
        if (transcriptFile) appendFileSync(transcriptFile, line + '\n');
        consume(parser.push(line));
      }
      consume(parser.end());

      if (artifactDir) {
        writeFileSync(join(artifactDir, `stderr.attempt${attempt}.log`), stderrTail.text, 'utf8');
      }

      let exit = this.adapter.classifyExit(code, sig, events, stderrTail.text);
      if (timedOut) {
        exit = { ok: false, errorKind: 'stalled', retryable: true, message: `attempt timed out after ${timeoutMs}ms` };
      } else if (signal.aborted) {
        exit = { ok: false, errorKind: 'interrupted', retryable: false, message: 'aborted' };
      }
      return { exit, events, finalText, structured, sessionId, toolCalls, declinedActions, outputChars };
    } catch (err) {
      return {
        exit: {
          ok: false,
          errorKind: 'infra',
          retryable: true,
          message: `spawn failed: ${(err as Error).message}`,
        },
        events,
        finalText,
        structured,
        sessionId,
        toolCalls,
        declinedActions,
        outputChars,
      };
    } finally {
      if (schemaTmpDir) rmSync(schemaTmpDir, { recursive: true, force: true });
    }
  }

  private toOutcome(
    spec: AgentSpec,
    last: AttemptResult | undefined,
    attempts: number,
    overrideError?: string,
  ): AgentOutcome {
    if (!last) {
      return {
        ok: false,
        error: overrideError ?? 'no attempt executed',
        errorKind: 'interrupted',
        usage: estimateUsage(spec.prompt.length, 0),
        toolCalls: 0,
        attempts,
      };
    }
    let usage = this.adapter.extractUsage(last.events);
    if (usage.totalTokens === 0) {
      usage = estimateUsage(spec.prompt.length, last.outputChars);
    }
    if (!last.exit.ok) {
      return {
        ok: false,
        error: overrideError ?? last.exit.message,
        errorKind: last.exit.errorKind ?? 'unknown',
        usage,
        sessionId: last.sessionId,
        toolCalls: last.toolCalls,
        attempts,
      };
    }
    return {
      ok: true,
      value: last.structured !== undefined ? last.structured : (last.finalText ?? ''),
      usage,
      sessionId: last.sessionId,
      toolCalls: last.toolCalls,
      attempts,
    };
  }
}

/** Backend registry: id → executor. The mock stays a direct executor. */
export function createExecutorForBackend(backend: string, opts: AgentCallOptions = {}): AgentExecutor | null {
  switch (backend) {
    case 'codex':
      return new AgentCallExecutor(new CodexAdapter(), opts);
    default:
      return null;
  }
}
