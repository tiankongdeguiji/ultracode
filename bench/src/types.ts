/**
 * Shared contracts for the SWE-bench Pro A/B benchmark harness (`bench/`).
 * Arm 'a' = codex CLI solo; arm 'b' = codex + ultracode orchestration. Every
 * module (instances, prompt, session, state, metrics, eval, report) types its
 * seams against this file so the pieces can be built and tested independently.
 */

export type Arm = 'a' | 'b';

/** One SWE-bench Pro instance, camelCased from the HF dataset row. */
export interface BenchInstance {
  /** dataset `instance_id` — the eval-harness join key */
  instanceId: string;
  /** upstream repo slug, e.g. "NodeBB/NodeBB" */
  repo: string;
  /** dataset `repo_language`: python | js | go | ts */
  repoLanguage: string;
  /** commit the image's /app checkout must sit at; eval resets to it */
  baseCommit: string;
  problemStatement: string;
  requirements: string | null;
  interface: string | null;
  /** raw list-literal strings from the dataset — passed through to eval verbatim */
  failToPass: string;
  passToPass: string;
  /** image tag under jefzda/sweap-images */
  dockerhubTag: string;
  beforeRepoSetCmd: string;
  selectedTestFilesToRun: string;
  /** gold patch — eval --gold only; MUST never reach a prompt */
  goldPatch: string;
  /** gold test patch — kept for completeness; MUST never reach a prompt */
  testPatch: string;
}

/** bench.config.json shape; flags override individual fields. */
export interface BenchConfig {
  instances: {
    /** explicit instance ids; null = seeded stratified sample of `count` */
    ids: string[] | null;
    count: number;
    seed: number;
    stratifyBy: 'repo_language' | 'repo';
  };
  /** codex model pin, e.g. "gpt-5.2-codex"; required by `run` (no silent default) */
  model: string;
  /** model_reasoning_effort; required for new runs so model-catalog defaults cannot drift */
  effort: string;
  auth: {
    /** 'chatgpt' copies ~/.codex/auth.json into each container; 'api-key' uses CODEX_API_KEY */
    mode: 'chatgpt' | 'api-key';
  };
  arms: 'a' | 'b' | 'both';
  timeouts: {
    /** in-container `timeout` around codex exec, per instance x arm */
    sessionSecs: number;
    /** driver kills eval containers older than this (local eval has none) */
    evalWatchdogSecs: number;
  };
  parallel: {
    /** instances driven concurrently (arms are sequential within an instance) */
    instances: number;
    /** --num_workers for the official eval harness */
    evalWorkers: number;
  };
  docker: {
    cpus: number;
    memoryGb: number;
    /** keep ucbench:* overlay images after eval instead of pruning */
    keepImages: boolean;
  };
  toolchain: {
    nodeVersion: string;
    /** tarball source: npmmirror (cn-friendly) | nodejs | unofficial-glibc217 */
    nodeDist: 'npmmirror' | 'nodejs' | 'unofficial-glibc217';
    /** 'auto' = readlink -f $(which codex); else explicit path to a codex binary */
    codexBin: string;
  };
  harness: {
    repo: string;
    /** commit pin for scaleapi/SWE-bench_Pro-os */
    pin: string;
  };
  pipIndex: string;
  /** strip remotes/foreign refs/reflog in the agent container (gold-fix leakage guard) */
  sanitizeGitHistory: boolean;
  /** optional $/M-token map keyed by model name for USD normalization in the report */
  pricing?: Record<string, { inputPerM: number; cachedPerM: number; outputPerM: number }>;
}

/** Per instance x arm progress; `status.json` in the arm dir is the source of truth. */
export type BenchPhase = 'pending' | 'image-ready' | 'session-done' | 'patched' | 'evaled';

/**
 * Failure taxonomy (pre-registered): infra kinds (image-failed, toolchain-incompatible,
 * eval-fail, harness-error, invalid-instance, auth-or-rate-limit) drop the pair from the
 * primary comparison; agent-avoidable kinds count as losses for that arm.
 */
export type FailureKind =
  | 'agent-crash'
  | 'timeout'
  | 'empty-patch'
  | 'patch-too-large'
  | 'unapplyable-diff'
  | 'unmerged-workspace'
  | 'toolchain-incompatible'
  | 'no-app-dir'
  | 'image-failed'
  | 'auth-or-rate-limit'
  | 'eval-fail'
  | 'harness-error'
  | 'invalid-instance';

/** Written by entrypoint.sh as /bench/out/meta.json when the session ends. */
export interface SessionMeta {
  codexExit: number;
  /** epoch seconds, in-container clock */
  startedAt: number;
  endedAt: number;
  /** git rev-parse HEAD before the session — the diff base */
  baseSha: string;
  /** dataset base_commit the driver passed in; mismatch is logged, not fatal */
  expectedBase: string;
  patchBytes: number;
  /** git apply --check verdict on the captured diff (null when patch is empty) */
  applyCheck: boolean | null;
  /** arm b: ultracode runs seen in /bench/uc at capture time */
  ucRuns: { runId: string; status: string }[];
  /** arm b: ms spent waiting for detached runs to reach a terminal state */
  waitedForTerminalMs: number;
  /** untracked/modified paths present BEFORE the session (image runtime state, excluded from the patch) */
  preDirtyPaths?: number;
  /** binary diff sections dropped from patch.diff (mirrors the official harness's stripping) */
  binaryHunksStripped?: number;
  /** set by entrypoint only for its own hard failures (toolchain-incompatible, no-app-dir) */
  failure: FailureKind | null;
}

export interface ArmStatus {
  phase: BenchPhase;
  failure: FailureKind | null;
  /** ISO timestamps, driver clock */
  startedAt?: string;
  endedAt?: string;
  codexExit?: number;
  wallClockMs?: number;
  patchBytes?: number;
  applyCheck?: boolean | null;
  /** non-fatal observations: no-orchestration, mock-backend, monitor-abandoned, base-sha-mismatch, ... */
  annotations: string[];
}

/** Raw codex usage 4-tuple summed per session (last-cumulative semantics). */
export interface UsageTuple {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  /** input + output + round(0.1 * cachedInput); reasoning is a subset of output */
  total: number;
}

export interface SessionUsage {
  sessionId: string;
  usage: UsageTuple;
  /** count of context_compacted events in this session's rollout */
  compactions: number;
  /** max live context (per-response input+output) observed */
  contextPeak: number;
  contextWindow: number | null;
  model: string | null;
}

/** Arm-level metrics.json, produced by metrics.ts after a session. */
export interface ArmMetrics {
  arm: Arm;
  /** sum over all sessions (arm b: host + every worker) */
  totalUsage: UsageTuple;
  sessions: SessionUsage[];
  compactionEvents: number;
  contextPeak: number;
  contextWindow: number | null;
  wallClockMs: number;
  /** arm b only: engine-side cross-check from the run store */
  uc?: {
    runs: { runId: string; status: string; totalTokens: number; agentCount: number; failures: number }[];
    engineTotalTokens: number;
    agentCount: number;
    /** kept worktrees reported in output.json.workspaces */
    workspacesKept: number;
  };
  annotations: string[];
  costUSD?: number;
}

/** One entry of the eval predictions JSON consumed by swe_bench_pro_eval.py. */
export interface EvalPrediction {
  instance_id: string;
  patch: string;
  prefix: string;
}

/** run.json — frozen at `run` start so resumes never re-sample or drift config. */
export interface RunManifest {
  runId: string;
  createdAt: string;
  config: BenchConfig;
  instanceIds: string[];
  /** seeded per-instance arm order, e.g. { iid: ['a','b'] } */
  armOrder: Record<string, Arm[]>;
  ultracodeSha: string;
  codexVersion: string;
  codexSha256: string;
}
