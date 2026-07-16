import { describe, it, expect } from 'vitest';
import { createPanelState, displayWidth, foldEvent, type PanelState } from '../../src/cli/panel.js';
import {
  PROMPT_COLLAPSED_LINES,
  renderDetailFrame,
  wrapToWidth,
  type AgentArtifacts,
  type DetailOptions,
} from '../../src/cli/panel-detail.js';
import type { TimestampedEvent } from '../../src/store/events.js';

const ev = (type: string, fields: Record<string, unknown> = {}, ts = 0): TimestampedEvent =>
  ({ ts, type, ...fields }) as TimestampedEvent;

/** One running agent with live tool activity, one settled, one failed. */
function detailState(): PanelState {
  const s = createPanelState({
    runName: 'code-review',
    title: 'Deep review of the PR',
    phases: [{ title: 'Review' }],
    budgetTotal: null,
    startedAtMs: 0,
  });
  const events: TimestampedEvent[] = [
    ev('run_started', { name: 'code-review' }),
    ev('phase_started', { title: 'Review' }),
    ev('agent_started', { seq: 0, label: 'review cli', phase: 'Review', backend: 'claude', model: 'claude-sonnet-5' }, 120_000),
    ev('agent_usage', { seq: 0, totalTokens: 3100, estimated: false }, 130_000),
    ev('agent_tool', { seq: 0, name: 'bash:grep foldEvent', status: 'started' }, 140_000),
    ev('agent_tool', { seq: 0, name: 'bash:grep foldEvent', status: 'completed' }, 141_000),
    ev('agent_tool', { seq: 0, name: 'read:src/cli/panel.ts', status: 'started' }, 150_000),
    ev('agent_started', { seq: 1, label: 'review core', phase: 'Review', backend: 'claude' }, 10_000),
    ev('agent_completed', { seq: 1, label: 'review core', phase: 'Review', ok: true, totalTokens: 12_300, toolCalls: 14 }, 74_000),
    ev('agent_started', { seq: 2, label: 'review legacy', phase: 'Review', backend: 'claude' }, 20_000),
    ev('agent_completed', { seq: 2, label: 'review legacy', phase: 'Review', ok: false, totalTokens: 900, toolCalls: 3, error: 'schema mismatch' }, 60_000),
  ];
  for (const e of events) foldEvent(s, e);
  return s;
}

const OPTS: DetailOptions = {
  cols: 100,
  rows: 40,
  nowMs: 161_000,
  color: false,
  runStatus: 'running',
  scroll: 0,
  promptExpanded: false,
};

const render = (seq: number, art: AgentArtifacts = {}, o: Partial<DetailOptions> = {}): string =>
  renderDetailFrame(detailState(), seq, art, { ...OPTS, ...o }).text;

describe('wrapToWidth', () => {
  it('hard-wraps by display cells, preserving the text own line breaks', () => {
    expect(wrapToWidth('abcdef', 3)).toEqual(['abc', 'def']);
    expect(wrapToWidth('ab\n\ncd', 10)).toEqual(['ab', '', 'cd']);
    expect(wrapToWidth('日本語テスト', 4)).toEqual(['日本', '語テ', 'スト']); // 2 cells each
    expect(wrapToWidth('', 5)).toEqual(['']);
    for (const line of wrapToWidth('x'.repeat(23) + '日本語', 10)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  it('sanitizes control bytes per line (ESC cannot survive into the frame)', () => {
    expect(wrapToWidth('a\x1b[2Jb', 20)).toEqual(['a [2Jb']);
  });
});

describe('renderDetailFrame', () => {
  it('renders a running agent byte-exactly: header, live status, sections, still running', () => {
    const art = { prompt: 'Review the CLI layer for correctness.' };
    expect(render(0, art)).toBe(
      '⏺ code-review — Deep review of the PR   running · 2m41s\n' +
        '⠋ review cli   3.1k tok · 2 tools · 41s · claude-sonnet-5 · idle 11s\n' +
        'Prompt · 1 line\n' +
        '  Review the CLI layer for correctness.\n' +
        '\n' +
        'Activity · 2 tool calls\n' +
        '  ✓ bash:grep foldEvent\n' +
        '  ⠋ read:src/cli/panel.ts\n' +
        '\n' +
        'Outcome\n' +
        '  Still running…',
    );
  });

  it('prompt collapses past the cap with an expand hint; expanded shows everything', () => {
    const prompt = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const collapsed = render(0, { prompt });
    expect(collapsed).toContain(`line ${PROMPT_COLLAPSED_LINES}`);
    expect(collapsed).not.toContain(`line ${PROMPT_COLLAPSED_LINES + 1}`);
    expect(collapsed).toContain(`… ${10 - PROMPT_COLLAPSED_LINES} more lines (⏎ expand)`);
    const expanded = render(0, { prompt }, { promptExpanded: true });
    expect(expanded).toContain('line 10');
    expect(expanded).toContain('(⏎ collapse)');
    expect(expanded).toContain('Prompt · 10 lines');
  });

  it('missing artifacts degrade to placeholders; a settled row without result.json shows finalizing', () => {
    const frame = render(0);
    expect(frame).toContain('(prompt not yet written)');
    expect(render(1)).toContain('(finalizing…)');
  });

  it('settled agents show the outcome: string values verbatim, objects pretty-printed', () => {
    const asText = render(1, { result: { ok: true, status: 'ok', value: 'looks good' } });
    expect(asText).toContain('✓ review core   12.3k tok · 14 tools · 1m04s\n');
    expect(asText).toContain('Outcome\n  looks good');
    const asJson = render(1, { result: { ok: true, status: 'ok', value: { findings: [1, 2] } } });
    expect(asJson).toContain('  {\n    "findings": [');
  });

  it('a failed row without an event error falls back to result.json error', () => {
    const s = detailState();
    foldEvent(s, ev('agent_started', { seq: 9, label: 'quiet-fail', phase: 'Review', backend: 'claude' }, 1000));
    foldEvent(s, ev('agent_completed', { seq: 9, label: 'quiet-fail', ok: false, totalTokens: 1 }, 2000)); // no error field
    const { text } = renderDetailFrame(s, 9, { result: { ok: false, status: 'error', error: 'error-from-result-json' } }, OPTS);
    expect(text).toContain('failed: error-from-result-json');
  });

  it('failed agents show the error in the outcome; running rows on terminal frames read interrupted', () => {
    const failed = render(2, { result: { ok: false, status: 'error', error: 'schema mismatch' } });
    expect(failed).toContain('✗ review legacy   900 tok · 3 tools · 40s · failed');
    expect(failed).toContain('Outcome\n  failed: schema mismatch');
    const interrupted = render(0, { prompt: 'p' }, { runStatus: 'stopped' });
    expect(interrupted).toContain('✗ review cli');
    expect(interrupted).toContain('interrupted');
    expect(interrupted).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/); // no fake liveness anywhere
  });

  it('scrolls the body with a range indicator and clamps + reports maxScroll', () => {
    const prompt = Array.from({ length: 60 }, (_, i) => `p${i + 1}`).join('\n');
    const state = detailState();
    const opts = { ...OPTS, rows: 16, promptExpanded: true };
    const r0 = renderDetailFrame(state, 0, { prompt }, opts);
    expect(r0.maxScroll).toBeGreaterThan(0);
    const first = r0.text.split('\n');
    expect(first.at(-1)).toMatch(/^1–\d+ of \d+ ↓$/);
    expect(first.length).toBeLessThanOrEqual(15);

    const mid = renderDetailFrame(state, 0, { prompt }, { ...opts, scroll: 5 }).text.split('\n');
    expect(mid.at(-1)).toMatch(/^6–\d+ of \d+ ↑ ↓$/);
    expect(mid).toContain('  p5'); // virtual line 6 = body[5] ('Prompt' header is body[0])
    expect(mid).not.toContain('  p4');

    const over = renderDetailFrame(state, 0, { prompt }, { ...opts, scroll: 10_000 });
    const last = over.text.split('\n');
    expect(last.at(-1)).toMatch(/↑$/); // clamped to the end — nothing below
    expect(over.maxScroll).toBeLessThan(10_000);
  });

  it('merges the keymap into the bottom line and honors width/height budgets', () => {
    const prompt = Array.from({ length: 60 }, (_, i) => `p${i + 1}`).join('\n');
    const keymap = 'j/k scroll · ⏎ expand · esc back';
    const frame = renderDetailFrame(detailState(), 0, { prompt }, { ...OPTS, rows: 14, keymap, promptExpanded: true }).text;
    const lines = frame.split('\n');
    expect(lines.at(-1)).toMatch(/^1–\d+ of \d+ ↓ · j\/k scroll/);
    expect(lines.length).toBeLessThanOrEqual(13);
    for (const cols of [20, 40, 80]) {
      const narrow = renderDetailFrame(detailState(), 0, { prompt: '日本語'.repeat(40) }, { ...OPTS, cols, keymap }).text;
      for (const line of narrow.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(cols);
    }
  });

  it('color mode adds SGR but never changes the visible text; hostile artifact content is scrubbed', () => {
    const art = { prompt: 'evil\x1b[2J\nsecond', result: undefined };
    const plain = render(0, art);
    const colored = render(0, art, { color: true });
    expect(colored.replace(/\x1b\[[0-9;]*m/g, '')).toBe(plain);
    expect(plain).toContain('evil [2J');
    const value = render(1, { result: { value: 'own\x1b[9999HGOTCHA' } });
    expect(value).toContain('own [9999HGOTCHA');
  });

  it('an exact-fit final frame keeps its last body line — no spurious ↓ indicator when keys are dead', () => {
    // Reference render with room to spare: no keymap (final frame), no indicator.
    const art = { prompt: 'p', result: { ok: true, status: 'ok', value: 'done' } };
    const full = renderDetailFrame(detailState(), 1, art, { ...OPTS, runStatus: 'completed', rows: 40 }).text;
    expect(full).not.toMatch(/of \d+/);
    const lineCount = full.split('\n').length;
    // Exact fit: rowsBudget == lineCount. Reserving the bottom row up front
    // would swallow the last body line behind an unscrollable '… of N ↓'.
    const exact = renderDetailFrame(detailState(), 1, art, { ...OPTS, runStatus: 'completed', rows: lineCount + 1 });
    expect(exact.text).toBe(full);
    expect(exact.maxScroll).toBe(0);
  });

  it('never exceeds rows-1 even on degenerate terminals (pinned + body + bottom overshoot is clamped)', () => {
    const prompt = Array.from({ length: 30 }, (_, i) => `p${i + 1}`).join('\n');
    for (const rows of [2, 3, 4, 5, 6]) {
      for (const runStatus of ['running', 'orphaned'] as const) {
        const { text } = renderDetailFrame(detailState(), 0, { prompt }, { ...OPTS, rows, runStatus, keymap: 'j/k scroll' });
        expect(text.split('\n').length).toBeLessThanOrEqual(Math.max(1, rows - 1));
      }
    }
  });

  it('unknown seq yields a placeholder frame instead of throwing', () => {
    const r = renderDetailFrame(detailState(), 42, {}, OPTS);
    expect(r.text).toContain('agent #42 not found');
    expect(r.maxScroll).toBe(0);
  });
});
