/**
 * Backend layer contracts.
 *
 * Two seams:
 *  - AgentExecutor: what the engine's hostapi dispatches agent() calls to.
 *    The mock backend implements it directly; real backends get it from
 *    agentcall.ts layered over a BackendAdapter.
 *  - BackendAdapter: per-CLI plumbing (spawn plan, NDJSON parsing, exit
 *    classification, usage extraction).
 */

export type JsonSchema = Record<string, unknown>;

export type BackendId = 'mock' | 'codex' | 'qoder' | 'claude' | 'gemini' | 'cursor' | 'copilot' | 'opencode' | 'amp';

export type ErrorKind =
  | 'auth'
  | 'schema-rejected'
  | 'max-turns'
  | 'budget'
  | 'rate-limit'
  | 'structured-output-retries'
  | 'interrupted'
  | 'stalled'
  | 'infra'
  | 'unknown';

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  /** input + output + reasoning + round(0.1 × cached) — see usage.ts */
  totalTokens: number;
  costUSD?: number;
  /** true when derived from a chars/4 estimate because the backend omitted usage */
  estimated: boolean;
}

export const ZERO_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  estimated: false,
};

/** One agent() dispatch, fully resolved by the engine. */
export interface AgentSpec {
  seq: number;
  prompt: string;
  label: string;
  phase?: string;
  schema?: JsonSchema;
  model?: string;
  effort?: string;
  agentType?: string;
  isolation?: 'worktree';
  backend: string;
  cwd: string;
  /** task retry budget, clamped 0–5; independent of schema-repair retries */
  retries: number;
  stallMs?: number;
  timeoutMs?: number;
}

export interface AgentOutcome {
  ok: boolean;
  /** schema-validated object when spec.schema was set, else final text */
  value?: unknown;
  error?: string;
  errorKind?: ErrorKind;
  usage: NormalizedUsage;
  sessionId?: string;
  toolCalls: number;
  attempts: number;
  /** loud-but-nonfatal conditions (e.g. silent no-op: actions auto-rejected) */
  warnings?: string[];
}

/**
 * Mid-execution progress surfaced by an executor. Display-only: final
 * accounting always comes from AgentOutcome.usage (a usage tick may lag or
 * slightly overshoot the authoritative total). `usage` is cumulative across
 * the executor's internal attempts/repairs, never per-attempt deltas.
 */
export type AgentProgress =
  | { type: 'usage'; usage: NormalizedUsage }
  | { type: 'retry'; attempt: number; maxAttempts: number; kind: 'task' | 'schema-repair'; reason?: string }
  | { type: 'model'; model: string };

export interface AgentExecutor {
  execute(spec: AgentSpec, signal: AbortSignal, onProgress?: (p: AgentProgress) => void): Promise<AgentOutcome>;
}

// ---------------------------------------------------------------------------
// BackendAdapter (real CLI backends; implemented from M5 onward)
// ---------------------------------------------------------------------------

export interface AgentRequest {
  prompt: string;
  schema?: JsonSchema;
  model?: string;
  effort?: string;
  agentType?: string;
  /** resolved working directory (worktree path when isolation:'worktree') */
  cwd: string;
  permission: 'safe' | 'auto' | 'danger';
  env: Record<string, string>;
}

export interface SpawnPlan {
  bin: string;
  argv: string[];
  env: Record<string, string>;
  /** prompt via stdin where supported (avoids argv length limits and shell-history leaks) */
  stdinData?: string;
  /** codex --output-schema wants a file path; content written to a temp file pre-spawn */
  schemaTempFile?: { content: string };
}

export type AgentEvent =
  /** model is the backend-resolved id when the stream reports one (init lines) */
  | { kind: 'session'; sessionId: string; model?: string }
  /** assistant text; consumers keep the LAST one (codex #19816) */
  | { kind: 'message'; text: string }
  | { kind: 'tool'; name: string; status: 'started' | 'completed' | 'failed' | 'declined' }
  /** interim: a mid-run snapshot (per API call) — excluded from usage accounting.
   *  threadCumulative: the figure is the session's running total, not this
   *  attempt's own (codex turn.completed) — resumed attempts repeat the prefix. */
  | { kind: 'usage'; usage: Partial<NormalizedUsage>; interim?: boolean; threadCumulative?: boolean }
  | {
      kind: 'result';
      text?: string;
      structured?: unknown;
      isError: boolean;
      errorKind?: ErrorKind;
      raw?: unknown;
    }
  /** benign chatter, e.g. codex "Reconnecting… n/5" */
  | { kind: 'notice'; message: string };

export interface ExitClass {
  ok: boolean;
  errorKind?: ErrorKind;
  retryable: boolean;
  message: string;
}

export interface BackendProbe {
  available: boolean;
  version?: string;
  authHint?: string;
  warnings?: string[];
}

/** Handle for a display-only live-progress side channel (see BackendAdapter.createSidecar). */
export interface AgentSidecar {
  close(): void;
}

export interface BackendAdapter {
  readonly id: BackendId;
  readonly structuredOutput: 'native' | 'emulated';
  /** Optional live-progress sidecar for backends whose stdout stream omits
   *  usage/model (codex exec --json swallows TokenCount and never names the
   *  model): started once the session id is known; emits DISPLAY-ONLY
   *  AgentEvents (interim usage, session model) into the progress path —
   *  never into accounting. Must be best-effort: errors degrade silently. */
  createSidecar?(sessionId: string, emit: (ev: AgentEvent) => void): AgentSidecar | null;
  probe(): Promise<BackendProbe>;
  /** Reject/normalize schema BEFORE spawn where the backend enforces a subset (codex strict). */
  checkSchema?(schema: JsonSchema): { ok: true; wireSchema: JsonSchema } | { ok: false; reason: string };
  buildSpawn(req: AgentRequest): SpawnPlan;
  buildResume(sessionId: string, followupPrompt: string, req: AgentRequest): SpawnPlan | null;
  /** stateful NDJSON parser; push() per line, end() at EOF */
  createParser(): { push(line: string): AgentEvent[]; end(): AgentEvent[] };
  classifyExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    events: AgentEvent[],
    stderrTail: string,
  ): ExitClass;
  extractUsage(events: AgentEvent[]): NormalizedUsage;
}
