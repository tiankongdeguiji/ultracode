/** Unit coverage for lenient streaming metrics over external rollout trees. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectExternalMetrics,
  discoverRolloutFiles,
  parseRolloutMetrics,
  readJsonLines,
} from '../../bench/src/external-metrics.js';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';

const jsonl = (...records: unknown[]): string => `${records.map((record) =>
  typeof record === 'string' ? record : JSON.stringify(record)).join('\n')}\n`;

const sessionMeta = (id: string, model = 'gpt-test'): unknown => ({
  type: 'session_meta',
  payload: { id, model },
});

const tokenCount = (
  total: { input: number; cached: number; output: number; reasoning: number },
  last: { input: number; cached?: number; output: number; reasoning?: number },
  contextWindow = 200_000,
): unknown => ({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: total.input,
        cached_input_tokens: total.cached,
        output_tokens: total.output,
        reasoning_output_tokens: total.reasoning,
      },
      last_token_usage: {
        input_tokens: last.input,
        cached_input_tokens: last.cached ?? 0,
        output_tokens: last.output,
        reasoning_output_tokens: last.reasoning ?? 0,
      },
      model_context_window: contextWindow,
    },
  },
});

function put(root: string, relativePath: string, contents: string): string {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function fixture(): { root: string; host: string; worker: string } {
  const root = mkdtempSync(join(tmpdir(), 'uc-external-metrics-'));
  const host = put(
    root,
    `host/deep/rollout-2026-07-19T00-00-00-${HOST_ID}.jsonl`,
    jsonl(
      sessionMeta(HOST_ID),
      tokenCount(
        { input: 10_000, cached: 4_000, output: 1_000, reasoning: 300 },
        { input: 50_000, output: 1_000 },
      ),
      '{torn json',
      { type: 'compacted', payload: {} },
      { type: 'event_msg', payload: { type: 'context_compacted' } },
      tokenCount(
        { input: 30_000, cached: 12_000, output: 4_000, reasoning: 1_200 },
        { input: 8_000, output: 400 },
      ),
    ),
  );
  const worker = put(
    root,
    `workers/rollout-2026-07-19T00-00-00-${WORKER_ID}.jsonl`,
    jsonl(
      sessionMeta(WORKER_ID, 'gpt-worker'),
      tokenCount(
        { input: 1_000, cached: 200, output: 300, reasoning: 100 },
        { input: 1_000, output: 300 },
        100_000,
      ),
      tokenCount(
        { input: 5_000, cached: 2_000, output: 900, reasoning: 400 },
        { input: 3_000, output: 600 },
        100_000,
      ),
      { type: 'compacted', payload: {} },
      { type: 'compacted', payload: {} },
    ),
  );
  put(root, 'workers/not-a-rollout.jsonl', jsonl(tokenCount(
    { input: 999_999, cached: 0, output: 0, reasoning: 0 },
    { input: 999_999, output: 0 },
  )));
  return { root, host, worker };
}

describe('external rollout discovery and parsing', () => {
  it('recursively discovers only rollout JSONL files in deterministic order', async () => {
    const { root, host, worker } = fixture();
    expect(await discoverRolloutFiles(root)).toEqual([host, worker].sort((a, b) => a.localeCompare(b)));
    expect(await discoverRolloutFiles(join(root, 'missing'))).toEqual([]);
  });

  it('stream-parses valid lines while skipping blanks, garbage, and missing files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-external-lines-'));
    const file = put(root, 'rows.jsonl', '\n{"ok":1}\r\nnot json\n[2]\n');
    const rows: unknown[] = [];
    for await (const row of readJsonLines(file)) rows.push(row);
    expect(rows).toEqual([{ ok: 1 }, [2]]);
    const missing: unknown[] = [];
    for await (const row of readJsonLines(join(root, 'missing.jsonl'))) missing.push(row);
    expect(missing).toEqual([]);
  });

  it('uses final cumulative usage and keeps prompt reset inference separate from compactions', async () => {
    const { host } = fixture();
    const session = await parseRolloutMetrics(host, { hostSessionId: HOST_ID });
    expect(session.sessionId).toBe(HOST_ID);
    expect(session.role).toBe('host');
    expect(session.usage).toEqual({
      input: 18_000,
      cachedInput: 12_000,
      output: 4_000,
      reasoning: 1_200,
      total: 23_200,
    });
    expect(session.compactions).toBe(1);
    expect(session.inferredPromptResets).toBe(1);
    expect(session.contextPeak).toBe(51_000);
    expect(session.contextWindow).toBe(200_000);
    expect(session.model).toBe('gpt-test');
  });

  it('reconciles mixed compaction representations without undercounting torn artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-external-mixed-compactions-'));
    const file = put(root, `rollout-test-${HOST_ID}.jsonl`, jsonl(
      sessionMeta(HOST_ID),
      { type: 'compacted', payload: {} },
      { type: 'event_msg', payload: { type: 'context_compacted' } },
      { type: 'compacted', payload: {} },
    ));
    expect((await parseRolloutMetrics(file)).compactions).toBe(2);
  });
});

describe('external rollout aggregation', () => {
  it('labels host and workers and aggregates cached discounts without adding reasoning twice', async () => {
    const { root } = fixture();
    const metrics = await collectExternalMetrics(root, { hostSessionId: HOST_ID });
    expect(metrics.sessions.map(({ sessionId, role }) => ({ sessionId, role }))).toEqual([
      { sessionId: HOST_ID, role: 'host' },
      { sessionId: WORKER_ID, role: 'worker' },
    ]);
    expect(metrics.totalUsage).toEqual({
      input: 21_000,
      cachedInput: 14_000,
      output: 4_900,
      reasoning: 1_600,
      total: 27_300,
    });
    expect(metrics.compactionEvents).toBe(3);
    expect(metrics.inferredPromptResets).toBe(1);
    expect(metrics.contextPeak).toBe(51_000);
    expect(metrics.contextWindow).toBe(200_000);
  });

  it('leaves roles unknown without a host id and degrades missing roots to zero totals', async () => {
    const { root } = fixture();
    expect((await collectExternalMetrics(root)).sessions.every((session) => session.role === null)).toBe(true);
    await expect(collectExternalMetrics(join(root, 'missing'))).resolves.toEqual({
      sessions: [],
      totalUsage: { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 },
      compactionEvents: 0,
      inferredPromptResets: 0,
      contextPeak: 0,
      contextWindow: null,
    });
  });
});
