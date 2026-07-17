import { describe, it, expect } from 'vitest';
import {
  createPanelState,
  displayWidth,
  foldEvent,
  takeNarratorLines,
  formatTokens,
  formatDuration,
  sanitizeText,
  truncateToWidth,
  RECENT_TOOLS_CAP,
  type PanelSeed,
  type PanelState,
} from '../../src/cli/panel.js';
import type { TimestampedEvent } from '../../src/store/events.js';

const seed = (o: Partial<PanelSeed> = {}): PanelSeed => ({
  runName: 'demo',
  budgetTotal: null,
  startedAtMs: 1_000,
  ...o,
});

const ev = (type: string, fields: Record<string, unknown> = {}, ts = 1): TimestampedEvent =>
  ({ ts, type, ...fields }) as TimestampedEvent;

function fold(state: PanelState, events: TimestampedEvent[]): PanelState {
  for (const e of events) foldEvent(state, e);
  return state;
}

describe('panel fold', () => {
  it('tracks the queued → running → done lifecycle with live tokens and timing', () => {
    const s = fold(createPanelState(seed({ phases: [{ title: 'Scan', detail: 'find things' }] })), [
      ev('run_started', { name: 'demo' }),
      ev('phase_started', { title: 'Scan' }),
      ev('agent_queued', { seq: 0, label: 'finder', phase: 'Scan' }, 10),
      ev('agent_started', { seq: 0, label: 'finder', phase: 'Scan', backend: 'mock', model: 'sonnet' }, 20),
      ev('agent_usage', { seq: 0, totalTokens: 100, estimated: false }, 30),
      ev('agent_usage', { seq: 0, totalTokens: 250, estimated: false }, 40),
      ev('agent_completed', { seq: 0, label: 'finder', phase: 'Scan', ok: true, totalTokens: 300 }, 50),
      ev('budget_tick', { spent: 300 }, 50),
    ]);
    const row = s.agents.get(0)!;
    expect(row).toMatchObject({ status: 'ok', tokens: 300, model: 'sonnet', startedTs: 20, endedTs: 50 });
    expect(s.phases).toEqual([{ title: 'Scan', detail: 'find things', childId: undefined, started: true }]);
    expect(s.spentTokens).toBe(300);
    expect(s.order).toEqual([0]);
  });

  it('agent_completed settles the estimated flag both ways (stale interim ~ cleared, estimated total marked)', () => {
    const s = fold(createPanelState(seed()), [
      ev('agent_started', { seq: 0, label: 'a', backend: 'mock' }),
      ev('agent_usage', { seq: 0, totalTokens: 50, estimated: true }), // interim estimate → ~
      ev('agent_completed', { seq: 0, label: 'a', ok: true, totalTokens: 60, estimated: false }),
      ev('agent_started', { seq: 1, label: 'b', backend: 'mock' }),
      ev('agent_completed', { seq: 1, label: 'b', ok: true, totalTokens: 40, estimated: true }),
    ]);
    expect(s.agents.get(0)).toMatchObject({ tokens: 60, estimated: false }); // real total, no stale ~
    expect(s.agents.get(1)).toMatchObject({ tokens: 40, estimated: true }); // estimated total keeps ~
  });

  it('agent_usage is monotonic, stops after completion, and ignores unknown seqs', () => {
    const s = fold(createPanelState(seed()), [
      ev('agent_started', { seq: 0, label: 'a', backend: 'mock' }, 1),
      ev('agent_usage', { seq: 0, totalTokens: 200 }, 2),
      ev('agent_usage', { seq: 0, totalTokens: 150 }, 3), // late/duplicate tick — never regress
      ev('agent_usage', { seq: 99, totalTokens: 999 }, 4), // unknown seq — dropped
      ev('agent_completed', { seq: 0, label: 'a', ok: true, totalTokens: 180 }, 5), // authority may correct down
      ev('agent_usage', { seq: 0, totalTokens: 500 }, 6), // tick after completion — dropped
    ]);
    expect(s.agents.get(0)!.tokens).toBe(180);
    expect(s.agents.has(99)).toBe(false);
  });

  it('retry bumps attempt and keeps the row running', () => {
    const s = fold(createPanelState(seed()), [
      ev('agent_started', { seq: 0, label: 'r', backend: 'mock' }),
      ev('agent_retry', { seq: 0, label: 'r', attempt: 2, maxAttempts: 3, kind: 'task' }),
    ]);
    expect(s.agents.get(0)).toMatchObject({ status: 'running', attempt: 2 });
  });

  it('status precedence: skipped, explicit cached, old-stream cached heuristic, failed', () => {
    const s = fold(createPanelState(seed()), [
      ev('agent_completed', { seq: 0, label: 'sk', ok: true, skipped: true, totalTokens: 0 }),
      ev('agent_completed', { seq: 1, label: 'new-cached', ok: true, cached: true, totalTokens: 0 }),
      ev('agent_completed', { seq: 2, label: 'old-cached', ok: true, totalTokens: 0 }), // lone, zero tokens
      ev('agent_started', { seq: 3, label: 'zero-real', backend: 'mock' }),
      ev('agent_completed', { seq: 3, label: 'zero-real', ok: true, totalTokens: 0 }), // seen starting → NOT cached
      ev('agent_started', { seq: 4, label: 'boom', backend: 'mock' }),
      ev('agent_completed', { seq: 4, label: 'boom', ok: false, totalTokens: 5, error: 'exploded' }),
    ]);
    expect(s.agents.get(0)!.status).toBe('skipped');
    expect(s.agents.get(1)!.status).toBe('cached');
    expect(s.agents.get(2)!.status).toBe('cached');
    expect(s.agents.get(3)!.status).toBe('ok');
    expect(s.agents.get(4)).toMatchObject({ status: 'failed', error: 'exploded' });
  });

  it('agent_model overrides the requested model from agent_started', () => {
    const s = fold(createPanelState(seed()), [
      ev('agent_started', { seq: 0, label: 'm', backend: 'claude', model: 'sonnet' }),
      ev('agent_model', { seq: 0, model: 'claude-sonnet-5' }),
    ]);
    expect(s.agents.get(0)!.model).toBe('claude-sonnet-5');
  });

  it('tagged child events scope rows and phases separately from same-titled parent phases', () => {
    const s = fold(createPanelState(seed()), [
      ev('phase_started', { title: 'Scan' }),
      ev('agent_started', { seq: 0, label: 'parent-scan', phase: 'Scan', backend: 'mock' }),
      ev('child_started', { childId: 0, name: 'sub' }),
      ev('phase_started', { title: 'Scan', childId: 0, childName: 'sub' }),
      ev('agent_started', { seq: 1, label: 'child-scan', phase: 'Scan', backend: 'mock', childId: 0, childName: 'sub' }),
      ev('agent_completed', { seq: 1, label: 'child-scan', phase: 'Scan', ok: true, totalTokens: 10, childId: 0, childName: 'sub' }),
      ev('child_completed', { childId: 0, name: 'sub', ok: true, agentCount: 1 }),
    ]);
    expect(s.agents.get(0)!.childId).toBeUndefined();
    expect(s.agents.get(1)!.childId).toBe(0);
    expect(s.phases.map((p) => [p.title, p.childId])).toEqual([
      ['Scan', undefined],
      ['Scan', 0],
    ]);
    expect(s.children).toEqual([{ childId: 0, name: 'sub', done: true, ok: true }]);
  });

  it('old streams: a second run_started opens an inferred child; run_completed closes it without touching run status', () => {
    const s = fold(createPanelState(seed()), [
      ev('run_started', { name: 'parent' }),
      ev('agent_completed', { seq: 0, label: 'pa', ok: true, totalTokens: 9 }),
      ev('run_started', { name: 'old-child' }), // nested child on an old engine
      ev('agent_started', { seq: 1, label: 'ca', backend: 'mock' }),
      ev('agent_completed', { seq: 1, label: 'ca', ok: true, totalTokens: 5 }),
      ev('run_completed', {}), // the child's — closes the inferred group
      ev('agent_started', { seq: 2, label: 'pb', backend: 'mock' }),
      ev('run_completed', {}), // the parent's — ignored entirely
    ]);
    expect(s.children).toEqual([{ childId: -1, name: 'old-child', done: true, ok: true }]);
    expect(s.agents.get(1)!.childId).toBe(-1);
    expect(s.agents.get(2)!.childId).toBeUndefined(); // after the boundary closed
  });

  it('drains narrator lines once and records stop_requested', () => {
    const s = fold(createPanelState(seed()), [
      ev('workflow_log', { message: 'first' }),
      ev('workflow_log', { message: 'second' }),
      ev('stop_requested', {}),
    ]);
    expect(s.stopRequested).toBe(true);
    expect(takeNarratorLines(s)).toEqual(['· first', '· second']);
    expect(takeNarratorLines(s)).toEqual([]);
  });

  it('malformed events from the worker-writable store degrade instead of crashing the attach', () => {
    const s = createPanelState(seed());
    const garbage: TimestampedEvent[] = [
      ev('agent_started', { seq: 'x', label: {}, backend: 42, model: [] }),
      ev('agent_queued', { seq: 0, label: 7, phase: { evil: true } }),
      ev('agent_usage', { seq: 0, totalTokens: 'lots', estimated: 'yes' }),
      ev('agent_retry', { seq: 0, attempt: '2' }),
      ev('agent_completed', { seq: 0, ok: true, totalTokens: null }),
      ev('phase_started', { title: 5 }),
      ev('child_started', { childId: 'zero', name: 9 }),
      ev('workflow_log', { message: { nested: true } }),
      ev('budget_tick', { spent: 'NaN' }),
      ev('agent_completed', {}), // no seq at all
      { ts: 'later', type: 'agent_started', seq: 1, label: 'ok-row' } as unknown as TimestampedEvent,
    ];
    for (const g of garbage) foldEvent(s, g); // must not throw
    expect(s.agents.get(0)).toMatchObject({ label: '#0', tokens: 0, status: 'ok' });
    expect(s.agents.get(1)).toMatchObject({ label: 'ok-row', startedTs: undefined }); // non-number ts dropped
    expect(s.phases).toEqual([]); // numeric title rejected
    expect(takeNarratorLines(s)).toEqual([]);
    expect(s.spentTokens).toBe(0);
  });

  it('agent_tool counts starts only; lifecycle events upgrade the newest matching entry in place', () => {
    const s = fold(createPanelState(seed()), [
      ev('agent_started', { seq: 0, label: 'worker', backend: 'codex' }, 10),
      ev('agent_tool', { seq: 0, name: 'bash:ls', status: 'started' }, 20),
      ev('agent_tool', { seq: 0, name: 'bash:ls', status: 'completed' }, 30),
      ev('agent_tool', { seq: 0, name: 'web_search:docs', status: 'started' }, 40),
      ev('agent_tool', { seq: 0, name: 'web_search:docs', status: 'failed' }, 50),
    ]);
    const row = s.agents.get(0)!;
    expect(row.toolCalls).toBe(2); // started ticks only — completed/failed never increment
    expect(row.recentTools).toEqual([
      { name: 'bash:ls', status: 'completed' },
      { name: 'web_search:docs', status: 'failed' },
    ]);
    expect(row.lastActivityTs).toBe(50);
  });

  it('recentTools is a ring: oldest evicted at the cap; an upgrade after eviction appends instead', () => {
    const events = [ev('agent_started', { seq: 0, label: 'busy', backend: 'codex' }, 1)];
    for (let i = 1; i <= RECENT_TOOLS_CAP + 2; i++) {
      events.push(ev('agent_tool', { seq: 0, name: `bash:cmd${i}`, status: 'started' }, i + 1));
    }
    // cmd1 was evicted; its completion has no matching entry → appended (evicting again)
    events.push(ev('agent_tool', { seq: 0, name: 'bash:cmd1', status: 'completed' }, 99));
    const s = fold(createPanelState(seed()), events);
    const row = s.agents.get(0)!;
    expect(row.toolCalls).toBe(RECENT_TOOLS_CAP + 2);
    expect(row.recentTools).toHaveLength(RECENT_TOOLS_CAP);
    expect(row.recentTools.at(-1)).toEqual({ name: 'bash:cmd1', status: 'completed' });
  });

  it('agent_tool drops garbage, unknown seqs, and ticks after completion; agent_completed.toolCalls is authoritative', () => {
    const s = fold(createPanelState(seed()), [
      ev('agent_started', { seq: 0, label: 'a', backend: 'codex' }, 1),
      ev('agent_tool', { seq: 0, name: 'bash:x', status: 'started' }, 2),
      ev('agent_tool', { seq: 99, name: 'bash:x', status: 'started' }, 3), // unknown seq
      ev('agent_tool', { seq: 0, name: 'bash:y', status: 'exploded' }, 4), // bad status
      ev('agent_tool', { seq: 0, status: 'started' }, 5), // no name
      ev('agent_tool', { seq: 0, name: 'evil\x1b[2J', status: 'started' }, 6), // control bytes scrubbed
      ev('agent_completed', { seq: 0, label: 'a', ok: true, totalTokens: 10, toolCalls: 7 }, 7),
      ev('agent_tool', { seq: 0, name: 'bash:late', status: 'started' }, 8), // after completion — dropped
    ]);
    const row = s.agents.get(0)!;
    expect(row.toolCalls).toBe(7); // completion overrides the live count of 2
    expect(row.recentTools.map((t) => t.name)).toEqual(['bash:x', 'evil [2J']);
  });

  it('old-stream agent_completed without toolCalls keeps the live count; retries never reset the ring', () => {
    const s = fold(createPanelState(seed()), [
      ev('agent_started', { seq: 0, label: 'a', backend: 'codex' }, 1),
      ev('agent_tool', { seq: 0, name: 'bash:one', status: 'started' }, 2),
      ev('agent_retry', { seq: 0, label: 'a', attempt: 2, maxAttempts: 3, kind: 'task' }, 3),
      ev('agent_tool', { seq: 0, name: 'bash:two', status: 'started' }, 4),
      ev('agent_completed', { seq: 0, label: 'a', ok: true, totalTokens: 10 }, 5), // no toolCalls field
    ]);
    const row = s.agents.get(0)!;
    expect(row.toolCalls).toBe(2); // accumulated across attempts, kept at completion
    expect(row.recentTools.map((t) => t.name)).toEqual(['bash:one', 'bash:two']);
  });

  it('lastActivityTs comes from the envelope ts of tool/usage/retry events, never a wall clock', () => {
    const s = fold(createPanelState(seed()), [
      ev('agent_started', { seq: 0, label: 'a', backend: 'mock' }, 100),
      ev('agent_usage', { seq: 0, totalTokens: 10 }, 200),
      ev('agent_retry', { seq: 0, label: 'a', attempt: 2, maxAttempts: 3, kind: 'task' }, 300),
      ev('agent_tool', { seq: 0, name: 'bash:z', status: 'started' }, 400),
      { type: 'agent_tool', seq: 0, name: 'bash:no-ts', status: 'completed' } as unknown as TimestampedEvent,
    ]);
    expect(s.agents.get(0)!.lastActivityTs).toBe(400); // missing ts leaves the last value
  });

  it('merges event phases into seeded ones by title and appends unseeded phases', () => {
    const s = fold(createPanelState(seed({ phases: [{ title: 'A', detail: 'da' }, { title: 'B' }] })), [
      ev('phase_started', { title: 'A' }),
      ev('phase_started', { title: 'C' }),
    ]);
    expect(s.phases.map((p) => [p.title, p.started, p.detail])).toEqual([
      ['A', true, 'da'],
      ['B', false, undefined],
      ['C', true, undefined],
    ]);
  });
});

describe('format helpers', () => {
  it('formatTokens', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(20_000)).toBe('20k');
    expect(formatTokens(145_200)).toBe('145.2k');
    expect(formatTokens(999_949)).toBe('999.9k');
    expect(formatTokens(999_950)).toBe('1m'); // never "1000k"
    expect(formatTokens(1_450_000)).toBe('1.45m');
    expect(formatTokens(2_000_000)).toBe('2m');
  });

  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(130_000)).toBe('2m10s');
    expect(formatDuration(125_000)).toBe('2m05s');
    expect(formatDuration(4_020_000)).toBe('1h07m');
  });

  it('truncateToWidth measures display cells (wide glyphs count 2)', () => {
    expect(truncateToWidth('hello', 10)).toBe('hello');
    expect(truncateToWidth('hello', 5)).toBe('hello');
    expect(truncateToWidth('hello', 4)).toBe('hel…');
    expect(truncateToWidth('日本語テスト', 12)).toBe('日本語テスト'); // 6 wide chars = 12 cells
    expect(truncateToWidth('日本語テスト', 4)).toBe('日…'); // 2 cells + ellipsis fits a 4-cell budget
    expect(truncateToWidth('x', 0)).toBe('');
    expect(truncateToWidth('xy', 1)).toBe('…');
  });

  it('displayWidth counts CJK/emoji as 2 cells, and ambiguous symbols as 2 (safe overcount)', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('a日b')).toBe(4);
    expect(displayWidth('🎉')).toBe(2);
    expect(displayWidth('✅')).toBe(2); // emoji-presentation misc symbol
    expect(displayWidth('⚡')).toBe(2);
    expect(displayWidth('🀄')).toBe(2); // mahjong block below U+1F300
    expect(displayWidth('✓')).toBe(2); // wcwidth says 1 — deliberately overcounted (undercount soft-wraps)
    for (const ch of ['⌚', '⏰', '⏳', '◽', '⬛', '⭐', '⭕']) {
      expect(displayWidth(ch)).toBe(2); // emoji-presentation gaps between the CJK ranges
    }
  });

  it('sanitizeText also neutralizes bidi overrides and Unicode line separators', () => {
    expect(sanitizeText('a‮gnp.exe')).toBe('a gnp.exe'); // RLO spoof
    expect(sanitizeText('x y z')).toBe('x y z'); // LS/PS render as line breaks on some terminals
    expect(sanitizeText('i⁦solate⁩')).toBe('i solate ');
  });

  it('sanitizeText strips C0/C1 control bytes (incl. ESC and newlines) to spaces', () => {
    expect(sanitizeText('plain text')).toBe('plain text');
    expect(sanitizeText('a\x1b[2Jb')).toBe('a [2Jb'); // ESC neutralized → sequence is inert text
    expect(sanitizeText('line1\nline2\r\t')).toBe('line1 line2  ');
    expect(sanitizeText('del\x7fc1')).toBe('del c1 ');
  });

  it('fold sanitizes worker-sourced text: labels, errors, models, narrator lines', () => {
    const s = fold(createPanelState(seed()), [
      ev('agent_started', { seq: 0, label: 'evil\x1b[5Alabel', backend: 'mock', model: 'm\x1b[2J' }),
      ev('agent_completed', { seq: 0, label: 'evil\x1b[5Alabel', ok: false, totalTokens: 1, error: 'boom\nline2\x1b[H' }),
      ev('workflow_log', { message: 'hi\x1b]0;spoof\x07there' }),
    ]);
    const row = s.agents.get(0)!;
    expect(row.label).toBe('evil [5Alabel');
    expect(row.model).toBe('m [2J');
    expect(row.error).toBe('boom line2 [H');
    expect(takeNarratorLines(s)[0]).toBe('· hi ]0;spoof there');
  });
});
