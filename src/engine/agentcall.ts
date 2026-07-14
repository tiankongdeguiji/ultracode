/**
 * AgentCallExecutor: the real AgentExecutor over a BackendAdapter — one
 * agent() dispatch end to end: spawn plan → process-group spawn → NDJSON
 * stream parse → transcript persistence → exit classification → bounded
 * retries → outcome. Schema enforcement layers on in M6; watchdogs
 * (stallMs / timeout) tighten in M7.
 */
import { mkdirSync, writeFileSync, writeSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { openWriteFdNoFollow, writeFileNoFollow } from '../exec/safe-write.js';
import { readProcStat } from '../exec/procinfo.js';
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

/** Known credential env vars per backend. A worker for one backend does not need
 *  another backend's secrets — a prompt-injected worker reading hostile repo
 *  content should not be able to exfiltrate them. (This scrubs cross-backend
 *  credentials only; a full runtime allowlist covering unrelated host secrets
 *  like GH_TOKEN/cloud creds is left to the caller's environment hygiene.) */
const BACKEND_SECRET_ENV: Record<string, readonly string[]> = {
  codex: ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME'],
  qoder: ['QODER_PERSONAL_ACCESS_TOKEN'],
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
};

/** Copy of `env` with every OTHER backend's credential vars removed (the target
 *  backend keeps its own). */
export function scrubForeignBackendSecrets(env: NodeJS.ProcessEnv, backend: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [b, vars] of Object.entries(BACKEND_SECRET_ENV)) {
    if (b === backend) continue;
    for (const v of vars) delete out[v];
  }
  return out;
}

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
    let realAny = false;
    let estimatedAny = false;
    for (const a of attempts) {
      const u = this.adapter.extractUsage(a.events);
      if (u.totalTokens > 0) {
        realAny = true;
        input += u.inputTokens;
        output += u.outputTokens;
        cached += u.cachedInputTokens;
        reasoning += u.reasoningTokens;
      } else {
        // This attempt reported no usage — estimate it (its prompt + its own
        // output) rather than dropping it, so a failed attempt or schema-repair
        // that died before emitting a usage event is still counted. (Previously
        // any attempt with usage suppressed estimation for the ones without.)
        const est = estimateUsage(spec.prompt.length, a.outputChars);
        input += est.inputTokens;
        output += est.outputTokens;
        estimatedAny = true;
      }
    }
    if (!realAny && !estimatedAny) return estimateUsage(spec.prompt.length, 0);
    const merged = finalizeUsage({
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
      reasoningTokens: reasoning,
    });
    merged.estimated = estimatedAny; // any estimated portion → flag the total
    return merged;
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

    let transcriptFd: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    let onAbort: (() => void) | undefined;
    // Delayed SIGKILL escalations scheduled after a SIGTERM. Tracked so `finally`
    // can cancel any still pending — otherwise a kill stays armed 5s out against
    // a pid that has already closed and may be recycled (→ kill the wrong group).
    const escalationTimers: ReturnType<typeof setTimeout>[] = [];
    try {
      // Open the transcript once and writeSync to a persistent fd — not
      // appendFileSync (open+write+close) per NDJSON line, which serializes
      // every concurrent agent's IO behind blocking syscalls on the hot path.
      if (transcriptFile) transcriptFd = openWriteFdNoFollow(transcriptFile);
      const proc = spawnAgentProcess(plan.bin, argv, {
        cwd: spec.cwd,
        // Scrub OTHER backends' credentials so a prompt-injected worker can't
        // exfiltrate them. ULTRACODE_INSIDE_RUN marks spawned workers so an
        // ultracode MCP server inherited by a worker refuses workflow_start.
        env: { ...scrubForeignBackendSecrets(process.env, spec.backend), ...plan.env, ULTRACODE_INSIDE_RUN: '1' },
        stdinData: plan.stdinData,
      });
      // Persist the worker's PGID so `ultracode stop` can kill the group if the
      // runner is unresponsive and gets SIGKILL'd (detached workers survive it).
      // Record `<pid> <starttime>`: the kernel start-time binds the pgid to this
      // exact process instance so a later forced stop can't be redirected to a
      // recycled — or worker-forged — PID (see stop.ts killWorkerGroups).
      if (artifactDir && proc.child.pid) {
        const stat = readProcStat(proc.child.pid);
        writeFileNoFollow(join(artifactDir, 'pgid'), `${proc.child.pid} ${stat?.starttime ?? ''}`);
      }

      // SIGTERM the tree, then escalate to SIGKILL if it survives — but track the
      // escalation so `finally` can cancel it if the child closes first.
      const killWithEscalation = () => {
        proc.killTree('SIGTERM');
        escalationTimers.push(setTimeout(() => proc.killTree('SIGKILL'), 5_000).unref());
      };

      const timeoutMs = spec.timeoutMs ?? this.opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
      let timedOut = false;
      let stalled = false;
      timer = setTimeout(() => {
        timedOut = true;
        killWithEscalation();
      }, timeoutMs);
      timer.unref();

      // Stall watchdog: no stream activity within stallMs → kill and retry.
      let lastActivityAt = Date.now();
      if (spec.stallMs && spec.stallMs > 0) {
        stallTimer = setInterval(() => {
          if (Date.now() - lastActivityAt > spec.stallMs!) {
            stalled = true;
            killWithEscalation();
          }
        }, Math.max(50, Math.min(1_000, spec.stallMs / 2)));
        stallTimer.unref();
      }
      onAbort = () => killWithEscalation();
      signal.addEventListener('abort', onAbort, { once: true });

      proc.child.stdout?.setEncoding('utf8');
      proc.child.stderr?.setEncoding('utf8');
      proc.child.stdout?.on('data', (chunk: string) => {
        lastActivityAt = Date.now();
        for (const line of splitter.push(chunk)) {
          if (transcriptFd !== undefined) writeSync(transcriptFd, line + '\n');
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

      for (const line of splitter.end()) {
        if (transcriptFd !== undefined) writeSync(transcriptFd, line + '\n');
        consume(parser.push(line));
      }
      consume(parser.end());

      if (artifactDir) {
        writeFileNoFollow(join(artifactDir, `stderr.attempt${attempt}.log`), stderrTail.text);
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
      // Runs on both success and the spawn-error path — the error path is
      // retryable, so leaking the interval/timer/abort-listener would compound
      // across retries.
      if (timer) clearTimeout(timer);
      if (stallTimer) clearInterval(stallTimer);
      for (const t of escalationTimers) clearTimeout(t);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (transcriptFd !== undefined) closeSync(transcriptFd);
      if (artifactDir) rmSync(join(artifactDir, 'pgid'), { force: true });
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
