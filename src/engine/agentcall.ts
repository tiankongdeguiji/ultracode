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
import { estimateUsage, finalizeUsage } from '../backends/usage.js';
import {
  SCHEMA_REPAIR_LIMIT,
  extractJsonCandidate,
  freshRepairPrompt,
  resumeRepairPrompt,
  schemaPromptSuffix,
} from '../backends/structured.js';
import { validateWithSchema } from './ajv.js';
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
import { QoderAdapter } from '../backends/qoder.js';
import { ClaudeAdapter } from '../backends/claude.js';
import { GeminiAdapter } from '../backends/gemini.js';

export interface AgentCallOptions {
  /** where to stream transcript.jsonl / stderr.log for a given spec (optional) */
  artifactDir?: (spec: AgentSpec) => string;
  /** default permission for spawned workers; 'auto' = workspace-write */
  permission?: AgentRequest['permission'];
  /** per-attempt hard timeout (default 20 minutes) */
  attemptTimeoutMs?: number;
  onToolEvent?: (spec: AgentSpec, name: string, status: 'started' | 'completed' | 'failed' | 'declined') => void;
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
    // Structured-output setup. Native adapters pre-validate the schema —
    // incompatible schemas fail deterministically server-side, so reject
    // with ZERO spawns. Emulated adapters get a prompt-contract suffix.
    let req = this.toRequest(spec);
    if (spec.schema) {
      if (this.adapter.structuredOutput === 'native' && this.adapter.checkSchema) {
        const check = this.adapter.checkSchema(spec.schema);
        if (!check.ok) {
          return {
            ok: false,
            error: `schema rejected: ${check.reason}`,
            errorKind: 'schema-rejected',
            usage: finalizeUsage({}),
            toolCalls: 0,
            attempts: 0,
          };
        }
        req = { ...req, schema: check.wireSchema };
      } else if (this.adapter.structuredOutput === 'emulated') {
        req = { ...req, prompt: req.prompt + schemaPromptSuffix(spec.schema), schema: undefined };
      }
    }

    const maxAttempts = spec.retries + 1;
    let last: AttemptResult | undefined;
    let attemptsUsed = 0;
    const usages: AttemptResult[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) {
        return this.toOutcome(spec, last, usages, attemptsUsed, 'aborted');
      }
      const plan = this.adapter.buildSpawn(req);
      last = await this.runAttempt(spec, plan, signal, attempt);
      attemptsUsed = attempt;
      usages.push(last);
      if (last.exit.ok) {
        if (!spec.schema) return this.toOutcome(spec, last, usages, attemptsUsed);
        // Schema repair budget is independent of task retries; a schema
        // failure after repairs is terminal (no task-retry loop).
        return this.enforceSchema(spec, req, last, usages, signal, attemptsUsed);
      }
      if (!last.exit.retryable) break;
    }
    return this.toOutcome(spec, last, usages, attemptsUsed);
  }

  /** Extract → validate against the ORIGINAL schema → ≤2 repair turns (resume preferred). */
  private async enforceSchema(
    spec: AgentSpec,
    req: AgentRequest,
    first: AttemptResult,
    usages: AttemptResult[],
    signal: AbortSignal,
    attemptsUsed: number,
  ): Promise<AgentOutcome> {
    const schema = spec.schema!;
    let current = first;
    let lastErrors: string[] = [];
    let lastRaw: string | undefined;

    for (let round = 0; round <= SCHEMA_REPAIR_LIMIT; round++) {
      const candidate =
        current.structured !== undefined
          ? { value: current.structured, raw: JSON.stringify(current.structured) }
          : current.finalText !== undefined
            ? extractJsonCandidate(current.finalText)
            : null;
      if (candidate) {
        const validation = validateWithSchema(schema, candidate.value);
        if (validation.ok) {
          return {
            ok: true,
            value: candidate.value,
            usage: this.mergedUsage(spec, usages),
            sessionId: current.sessionId ?? first.sessionId,
            toolCalls: usages.reduce((n, a) => n + a.toolCalls, 0),
            attempts: attemptsUsed,
            warnings: this.warningsFor(usages),
          };
        }
        lastErrors = validation.errors;
        lastRaw = candidate.raw;
      } else {
        lastErrors = ['output was not parseable as JSON'];
        lastRaw = current.finalText;
      }

      if (round === SCHEMA_REPAIR_LIMIT || signal.aborted) break;

      const sessionId = current.sessionId ?? first.sessionId;
      const resumePlan =
        sessionId !== undefined ? this.adapter.buildResume(sessionId, resumeRepairPrompt(lastErrors, schema), req) : null;
      const plan =
        resumePlan ??
        this.adapter.buildSpawn({
          ...req,
          prompt: freshRepairPrompt(spec.prompt, lastRaw, lastErrors, schema),
        });
      current = await this.runAttempt(spec, plan, signal, attemptsUsed + round + 1);
      usages.push(current);
      if (!current.exit.ok) {
        return {
          ok: false,
          error: `schema repair attempt failed: ${current.exit.message}`,
          errorKind: current.exit.errorKind ?? 'structured-output-retries',
          usage: this.mergedUsage(spec, usages),
          sessionId,
          toolCalls: usages.reduce((n, a) => n + a.toolCalls, 0),
          attempts: attemptsUsed + round + 1,
        };
      }
    }

    return {
      ok: false,
      error: `structured output failed validation after ${SCHEMA_REPAIR_LIMIT} repair attempts: ${lastErrors.slice(0, 5).join('; ')}`,
      errorKind: 'structured-output-retries',
      usage: this.mergedUsage(spec, usages),
      sessionId: current.sessionId ?? first.sessionId,
      toolCalls: usages.reduce((n, a) => n + a.toolCalls, 0),
      attempts: attemptsUsed + SCHEMA_REPAIR_LIMIT,
    };
  }

  /** Silent no-op detector: codex exec auto-rejects approvals yet exits 0. */
  private warningsFor(attempts: AttemptResult[]): string[] | undefined {
    const declined = attempts.reduce((n, a) => n + a.declinedActions, 0);
    if (declined === 0) return undefined;
    return [
      `${declined} action(s) auto-rejected by the backend (headless approvals unavailable) — wrong sandbox/permission mode? The agent may have silently done nothing.`,
    ];
  }

  private mergedUsage(spec: AgentSpec, attempts: AttemptResult[]) {
    let input = 0;
    let output = 0;
    let cached = 0;
    let reasoning = 0;
    let any = false;
    let outputChars = 0;
    for (const a of attempts) {
      const u = this.adapter.extractUsage(a.events);
      outputChars += a.outputChars;
      if (u.totalTokens > 0) {
        any = true;
        input += u.inputTokens;
        output += u.outputTokens;
        cached += u.cachedInputTokens;
        reasoning += u.reasoningTokens;
      }
    }
    if (!any) return estimateUsage(spec.prompt.length * Math.max(1, attempts.length), outputChars);
    return finalizeUsage({ inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningTokens: reasoning });
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
            if (ev.status === 'declined') declinedActions++;
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
      let stalled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.killTree('SIGTERM');
        setTimeout(() => proc.killTree('SIGKILL'), 5_000).unref();
      }, timeoutMs);
      timer.unref();

      // Stall watchdog: no stream activity within stallMs → kill and retry.
      let lastActivityAt = Date.now();
      let stallTimer: ReturnType<typeof setInterval> | undefined;
      if (spec.stallMs && spec.stallMs > 0) {
        stallTimer = setInterval(() => {
          if (Date.now() - lastActivityAt > spec.stallMs!) {
            stalled = true;
            proc.killTree('SIGTERM');
            setTimeout(() => proc.killTree('SIGKILL'), 5_000).unref();
          }
        }, Math.max(50, Math.min(1_000, spec.stallMs / 2)));
        stallTimer.unref();
      }
      const onAbort = () => {
        proc.killTree('SIGTERM');
        setTimeout(() => proc.killTree('SIGKILL'), 5_000).unref();
      };
      signal.addEventListener('abort', onAbort, { once: true });

      proc.child.stdout?.setEncoding('utf8');
      proc.child.stderr?.setEncoding('utf8');
      proc.child.stdout?.on('data', (chunk: string) => {
        lastActivityAt = Date.now();
        for (const line of splitter.push(chunk)) {
          if (transcriptFile) appendFileSync(transcriptFile, line + '\n');
          consume(parser.push(line));
        }
      });
      proc.child.stderr?.on('data', (chunk: string) => {
        lastActivityAt = Date.now();
        stderrTail.push(chunk);
      });

      const [code, sig] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
        proc.child.on('error', reject);
        proc.child.on('close', (c, s) => resolve([c, s]));
      });
      clearTimeout(timer);
      if (stallTimer) clearInterval(stallTimer);
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
      } else if (stalled) {
        exit = {
          ok: false,
          errorKind: 'stalled',
          retryable: true,
          message: `no stream activity for ${spec.stallMs}ms (stall watchdog)`,
        };
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
    usages: AttemptResult[],
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
    const usage = this.mergedUsage(spec, usages.length > 0 ? usages : [last]);
    const toolCalls = (usages.length > 0 ? usages : [last]).reduce((n, a) => n + a.toolCalls, 0);
    if (!last.exit.ok) {
      return {
        ok: false,
        error: overrideError ?? last.exit.message,
        errorKind: last.exit.errorKind ?? 'unknown',
        usage,
        sessionId: last.sessionId,
        toolCalls,
        attempts,
      };
    }
    return {
      ok: true,
      value: last.structured !== undefined ? last.structured : (last.finalText ?? ''),
      usage,
      sessionId: last.sessionId,
      toolCalls,
      attempts,
      warnings: this.warningsFor(usages.length > 0 ? usages : [last]),
    };
  }
}

/** Backend registry: id → executor. The mock stays a direct executor. */
export function createExecutorForBackend(backend: string, opts: AgentCallOptions = {}): AgentExecutor | null {
  switch (backend) {
    case 'codex':
      return new AgentCallExecutor(new CodexAdapter(), opts);
    case 'qoder':
      return new AgentCallExecutor(new QoderAdapter(), opts);
    case 'claude':
      return new AgentCallExecutor(new ClaudeAdapter(), opts);
    case 'gemini':
      return new AgentCallExecutor(new GeminiAdapter(), opts);
    default:
      return null;
  }
}
