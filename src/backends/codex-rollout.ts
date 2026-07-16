/**
 * Live-progress sidecar for codex workers. `codex exec --json` deliberately
 * omits mid-run token usage and the resolved model from stdout — exec's JSON
 * processor receives core's TokenCount notifications but only stores them
 * (event_processor_with_jsonl_output.rs), and no event carries the model.
 * Both DO land in the session rollout file the CLI writes for `exec resume`:
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl records an
 * event_msg/token_count per model response (last_token_usage = that response's
 * own figures) and a turn_context with the resolved model. Tail it read-only.
 *
 * Display-only by contract: events go to the progress tracker, never into
 * accounting, and ANY surprise (missing file, format drift across codex
 * versions) silently disables the sidecar — verified against codex-cli
 * 0.144.4 output and the recorder source (rollout/src/recorder.rs).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEventsFrom } from '../store/events.js';
import type { AgentEvent, AgentSidecar, NormalizedUsage } from './types.js';

/**
 * codex usage figures → NormalizedUsage partial. cached_input_tokens is a
 * SUBSET of input_tokens and reasoning_output_tokens a subset of
 * output_tokens: subtract cached (finalizeUsage re-adds it at the 0.1×
 * discount) and drop reasoning, so neither is double-counted.
 */
export function codexUsageToPartial(u: Record<string, unknown>): Partial<NormalizedUsage> {
  const inputRaw = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const cached = typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : 0;
  return {
    inputTokens: Math.max(0, inputRaw - cached),
    cachedInputTokens: cached,
    outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
    reasoningTokens: 0,
  };
}

const DISCOVERY_TIMEOUT_MS = 30_000;
const ROLLOUT_PAGE_BYTES = 1024 * 1024;
/** Fallback only (the executor passes resumedSession explicitly): a rollout
 *  last written this long before the sidecar started is not this attempt's. */
const RESUMED_SESSION_AGE_MS = 30_000;

export function createCodexRolloutSidecar(
  sessionId: string,
  emit: (ev: AgentEvent) => void,
  opts: { home?: string; pollMs?: number; resumedSession?: boolean } = {},
): AgentSidecar {
  const pollMs = opts.pollMs ?? 500;
  const sessionsDir = join(opts.home ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  const startedAt = Date.now();
  let file: string | undefined;
  let offset = 0;
  let lastModel: string | undefined;

  const discover = (): void => {
    // Date-partitioned by the LOCAL clock; check today then yesterday so a
    // session spanning midnight is still found.
    for (const dayDelta of [0, 1]) {
      const d = new Date(Date.now() - dayDelta * 86_400_000);
      const dir = join(
        sessionsDir,
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      );
      if (!existsSync(dir)) continue;
      const hit = readdirSync(dir).find((f) => f.endsWith(`-${sessionId}.jsonl`));
      if (!hit) continue;
      file = join(dir, hit);
      const stat = statSync(file);
      // A resumed session (schema repair rewrites the SAME rollout seconds
      // later, so mtime alone can't tell) tails only records newer than this
      // attempt — replaying the prior attempt's token_counts would double the
      // live figure until turn.completed corrects it. The stale-mtime check
      // stays as a fallback for unflagged callers.
      if (opts.resumedSession || stat.mtimeMs < startedAt - RESUMED_SESSION_AGE_MS) offset = stat.size;
      return;
    }
  };

  const drain = (): void => {
    if (!file) return;
    // readEventsFrom is shape-agnostic offset tailing: it advances only past
    // the last complete newline (multi-byte sequences straddling a read
    // boundary are re-read next tick, never decoded torn), skips unparseable
    // lines, and bounds each read — all the boundary handling a hand-rolled
    // carry buffer gets wrong.
    const page = readEventsFrom(file, offset, ROLLOUT_PAGE_BYTES);
    offset = page.nextOffset;
    for (const rec of page.events) {
      const p = (rec as { payload?: Record<string, unknown> }).payload;
      if (!p) continue;
      if (rec.type === 'turn_context' && typeof p.model === 'string' && p.model !== lastModel) {
        lastModel = p.model;
        emit({ kind: 'session', sessionId, model: p.model });
      } else if (rec.type === 'event_msg' && p.type === 'token_count') {
        const info = p.info as { last_token_usage?: Record<string, unknown> } | undefined;
        if (info?.last_token_usage) {
          emit({ kind: 'usage', usage: codexUsageToPartial(info.last_token_usage), interim: true });
        }
      }
    }
  };

  const timer = setInterval(() => {
    try {
      if (!file) {
        discover();
        if (!file && Date.now() - startedAt > DISCOVERY_TIMEOUT_MS) {
          clearInterval(timer);
          return;
        }
      }
      if (file) drain();
    } catch {
      clearInterval(timer); // display-only: any surprise disables the sidecar
    }
  }, pollMs);
  timer.unref();

  // No final drain on close: a tick after the attempt settles would fight the
  // authoritative turn.completed figure; the tail is covered by it anyway.
  return { close: () => clearInterval(timer) };
}
