/**
 * Post-session metrics collection for one instance x arm. Reads the artifacts
 * a session container left in the arm dir — codex rollout files under
 * codex-home/sessions/ (arm b: host + every worker, they share CODEX_HOME),
 * the host exec --json stream under logs/host.jsonl, and the ultracode run
 * store under uc/runs/ — and folds them into an ArmMetrics. Every input is
 * optional: missing or malformed pieces degrade to zeros plus annotations,
 * never a throw, so a crashed session still yields a metrics row.
 *
 * Usage semantics mirror src/backends/usage.ts + codex-rollout.ts: codex
 * token_count records report SESSION-CUMULATIVE usage in total_token_usage
 * (summing per-turn figures would double count), cached_input_tokens is a
 * subset of input_tokens (subtracted, then re-added at the 0.1x discount in
 * the total), and reasoning_output_tokens is a subset of output_tokens.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import { CONTAINER_REPO_DIR } from './config.js';
import type { Arm, ArmMetrics, BenchConfig, SessionMeta, SessionUsage, UsageTuple } from './types.js';

/** Mirrors src/store/manifest.ts isTerminal — any other status means the run was still live. */
const TERMINAL_UC_STATUSES = new Set(['completed', 'failed', 'stopped', 'orphaned']);

const ROLLOUT_UUID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// reasoning_output_tokens is a SUBSET of output_tokens in codex usage reports
// (src/backends/codex-rollout.ts zeroes it for the same reason) — it stays in
// the tuple as information but must not be added to totals or billed.
const usageTotal = (input: number, cachedInput: number, output: number, _reasoning: number): number =>
  input + output + Math.round(0.1 * cachedInput);

/** Parse an NDJSON file leniently: missing file -> [], unparseable lines skipped. */
function readJsonLines(file: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // tolerate torn/garbage lines
    }
  }
  return out;
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function findRolloutFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** One rollout file -> one SessionUsage (last-cumulative token_count wins). */
function parseRolloutFile(file: string): SessionUsage {
  let cumulative: Record<string, unknown> | null = null;
  let contextPeak = 0;
  let contextWindow: number | null = null;
  let model: string | null = null;
  let metaSessionId: string | null = null;
  let eventCompactions = 0;
  let recordCompactions = 0;

  for (const rec of readJsonLines(file)) {
    if (rec === null || typeof rec !== 'object') continue;
    const r = rec as { type?: unknown; payload?: unknown };
    if (r.type === 'compacted') {
      recordCompactions += 1;
      continue;
    }
    const payload =
      r.payload !== null && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : null;
    if (!payload) continue;
    if (r.type === 'session_meta') {
      const sid = payload.session_id ?? payload.id;
      if (typeof sid === 'string') metaSessionId = sid;
      if (typeof payload.model === 'string') model = payload.model;
    } else if (r.type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model;
    } else if (r.type === 'event_msg') {
      if (payload.type === 'context_compacted') {
        eventCompactions += 1;
      } else if (payload.type === 'token_count') {
        const info =
          payload.info !== null && typeof payload.info === 'object'
            ? (payload.info as Record<string, unknown>)
            : null;
        if (!info) continue;
        const total =
          info.total_token_usage !== null && typeof info.total_token_usage === 'object'
            ? (info.total_token_usage as Record<string, unknown>)
            : null;
        if (total) cumulative = total;
        const last =
          info.last_token_usage !== null && typeof info.last_token_usage === 'object'
            ? (info.last_token_usage as Record<string, unknown>)
            : null;
        if (last) contextPeak = Math.max(contextPeak, num(last.input_tokens) + num(last.output_tokens));
        if (typeof info.model_context_window === 'number') contextWindow = info.model_context_window;
      }
    }
  }

  const cached = num(cumulative?.cached_input_tokens);
  const input = Math.max(0, num(cumulative?.input_tokens) - cached);
  const output = num(cumulative?.output_tokens);
  const reasoning = num(cumulative?.reasoning_output_tokens);
  const usage: UsageTuple = {
    input,
    cachedInput: cached,
    output,
    reasoning,
    total: usageTotal(input, cached, output, reasoning),
  };

  const name = basename(file);
  const uuid = ROLLOUT_UUID_RE.exec(name)?.[1];
  return {
    sessionId: uuid ?? metaSessionId ?? name.replace(/\.jsonl$/, ''),
    usage,
    // 0.144.x writes BOTH a 'compacted' record and a context_compacted
    // event_msg per compaction — prefer the event count, never add them.
    compactions: eventCompactions > 0 ? eventCompactions : recordCompactions,
    contextPeak,
    contextWindow,
    model,
  };
}

/** Liberal workflow_start scan over an exec --json stream; started/completed pairs dedupe by item id. */
function countWorkflowStarts(file: string): number {
  const ids = new Set<string>();
  let anonymous = 0;
  for (const rec of readJsonLines(file)) {
    if (rec === null || typeof rec !== 'object') continue;
    const r = rec as Record<string, unknown>;
    for (const candidate of [r.item, r.payload, r]) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const c = candidate as Record<string, unknown>;
      if (typeof c.type !== 'string' || !c.type.includes('mcp')) continue;
      const name = typeof c.tool === 'string' ? c.tool : typeof c.name === 'string' ? c.name : '';
      if (!name.includes('workflow_start')) continue;
      if (typeof c.id === 'string') ids.add(c.id);
      else anonymous += 1;
      break;
    }
  }
  return ids.size + anonymous;
}

function collectUcRuns(runsDir: string): { uc: NonNullable<ArmMetrics['uc']>; annotations: string[] } {
  const runs: NonNullable<ArmMetrics['uc']>['runs'] = [];
  const annotations: string[] = [];
  let engineTotalTokens = 0;
  let agentCount = 0;
  let workspacesKept = 0;

  let entries: Dirent[];
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(runsDir, entry.name);
    const output = readJsonObject(join(dir, 'output.json'));
    const manifest = readJsonObject(join(dir, 'manifest.json'));
    const config = readJsonObject(join(dir, 'config.json'));

    let totalTokens = 0;
    let agents = 0;
    let failures = 0;
    if (output) {
      totalTokens = num(output.totalTokens);
      agents = num(output.agentCount);
      failures = Array.isArray(output.failures) ? output.failures.length : 0;
      workspacesKept += Array.isArray(output.workspaces) ? output.workspaces.length : 0;
    } else {
      // killed/live runs have no output.json — journal agent rows are the fallback
      for (const rec of readJsonLines(join(dir, 'journal.jsonl'))) {
        if (rec === null || typeof rec !== 'object') continue;
        const row = rec as { t?: unknown; status?: unknown; totalTokens?: unknown };
        if (row.t !== 'agent') continue;
        agents += 1;
        totalTokens += num(row.totalTokens);
        if (row.status === 'error') failures += 1;
      }
    }
    if (config) {
      if (config.backend === 'mock') annotations.push('mock-backend');
      if (config.cwd !== CONTAINER_REPO_DIR) annotations.push('cwd-mismatch');
    }
    const status = typeof manifest?.status === 'string' ? manifest.status : 'unknown';
    runs.push({ runId: entry.name, status, totalTokens, agentCount: agents, failures });
    engineTotalTokens += totalTokens;
    agentCount += agents;
  }
  return { uc: { runs, engineTotalTokens, agentCount, workspacesKept }, annotations };
}

/**
 * Fold every artifact under armDirPath into an ArmMetrics. Pure filesystem
 * read — never throws on missing/partial artifacts, never writes.
 */
export function collectMetrics(
  armDirPath: string,
  arm: Arm,
  opts: { pricing?: BenchConfig['pricing']; meta?: SessionMeta | null } = {},
): ArmMetrics {
  const annotations: string[] = [];
  const note = (a: string): void => {
    if (!annotations.includes(a)) annotations.push(a);
  };

  const sessions = findRolloutFiles(join(armDirPath, 'codex-home', 'sessions')).map(parseRolloutFile);

  const input = sessions.reduce((n, s) => n + s.usage.input, 0);
  const cachedInput = sessions.reduce((n, s) => n + s.usage.cachedInput, 0);
  const output = sessions.reduce((n, s) => n + s.usage.output, 0);
  const reasoning = sessions.reduce((n, s) => n + s.usage.reasoning, 0);
  const totalUsage: UsageTuple = {
    input,
    cachedInput,
    output,
    reasoning,
    total: usageTotal(input, cachedInput, output, reasoning),
  };

  if (arm === 'b' && countWorkflowStarts(join(armDirPath, 'logs', 'host.jsonl')) === 0) {
    note('no-orchestration');
  }

  let uc: ArmMetrics['uc'];
  const runsDir = join(armDirPath, 'uc', 'runs');
  if (existsSync(runsDir)) {
    const collected = collectUcRuns(runsDir);
    uc = collected.uc;
    for (const a of collected.annotations) note(a);
  }

  const meta = opts.meta ?? null;
  if (meta && meta.ucRuns.length > 0 && sessions.every((s) => s.usage.total === 0)) note('no-rollouts');
  if (
    arm === 'b' &&
    meta &&
    meta.waitedForTerminalMs > 0 &&
    meta.ucRuns.some((r) => !TERMINAL_UC_STATUSES.has(r.status))
  ) {
    note('monitor-abandoned');
  }

  const metrics: ArmMetrics = {
    arm,
    totalUsage,
    sessions,
    compactionEvents: sessions.reduce((n, s) => n + s.compactions, 0),
    contextPeak: sessions.reduce((m, s) => Math.max(m, s.contextPeak), 0),
    contextWindow: sessions.find((s) => s.contextWindow !== null)?.contextWindow ?? null,
    wallClockMs: meta ? (meta.endedAt - meta.startedAt) * 1000 + num(meta.waitedForTerminalMs) : 0,
    annotations,
  };
  if (uc) metrics.uc = uc;

  const model = sessions.find((s) => s.model !== null)?.model ?? null;
  const price = model !== null ? opts.pricing?.[model] : undefined;
  if (price) {
    const cost = sessions.reduce(
      (c, s) =>
        c +
        (s.usage.input / 1e6) * price.inputPerM +
        (s.usage.cachedInput / 1e6) * price.cachedPerM +
        (s.usage.output / 1e6) * price.outputPerM,
      0,
    );
    metrics.costUSD = Math.round(cost * 100) / 100;
  }
  return metrics;
}
