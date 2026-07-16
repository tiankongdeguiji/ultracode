import { describe, it, expect } from 'vitest';
import {
  createPanelState,
  displayWidth,
  foldEvent,
  renderFrame,
  spinnerFrame,
  type PanelState,
} from '../../src/cli/panel.js';
import type { TimestampedEvent } from '../../src/store/events.js';

const ev = (type: string, fields: Record<string, unknown> = {}, ts = 0): TimestampedEvent =>
  ({ ts, type, ...fields }) as TimestampedEvent;

/** One state exercising every row kind: done/collapsed, cached, running, retry, failed, queued, skipped, child. */
function richState(budgetTotal: number | null = 500_000): PanelState {
  const s = createPanelState({
    runName: 'code-review',
    title: 'Deep review of the PR',
    phases: [
      { title: 'Explore', detail: 'map the codebase' },
      { title: 'Review', detail: 'one agent per file' },
      { title: 'Synthesize' },
    ],
    budgetTotal,
    startedAtMs: 0,
  });
  const events: TimestampedEvent[] = [
    ev('run_started', { name: 'code-review' }),
    ev('phase_started', { title: 'Explore' }),
    ev('agent_started', { seq: 0, label: 'repo-mapper', phase: 'Explore', backend: 'claude' }, 1000),
    ev('agent_completed', { seq: 0, label: 'repo-mapper', phase: 'Explore', ok: true, totalTokens: 6800 }, 33_000),
    ev('agent_started', { seq: 1, label: 'dep-scan', phase: 'Explore', backend: 'claude' }, 2000),
    ev('agent_completed', { seq: 1, label: 'dep-scan', phase: 'Explore', ok: true, totalTokens: 5100 }, 9000),
    ev('agent_started', { seq: 2, label: 'conv-scan', phase: 'Explore', backend: 'claude' }, 2000),
    ev('agent_completed', { seq: 2, label: 'conv-scan', phase: 'Explore', ok: true, totalTokens: 5000 }, 9500),
    ev('agent_started', { seq: 3, label: 'api-scan', phase: 'Explore', backend: 'claude' }, 2100),
    ev('agent_completed', { seq: 3, label: 'api-scan', phase: 'Explore', ok: true, totalTokens: 4200 }, 9900),
    ev('phase_started', { title: 'Review' }),
    ev('agent_started', { seq: 4, label: 'review core', phase: 'Review', backend: 'claude', model: 'sonnet' }, 10_000),
    ev('agent_model', { seq: 4, model: 'claude-sonnet-5' }),
    ev('agent_completed', { seq: 4, label: 'review core', phase: 'Review', ok: true, totalTokens: 12_300 }, 74_000),
    ev('agent_completed', { seq: 5, label: 'review store', phase: 'Review', ok: true, cached: true, totalTokens: 0 }, 74_100),
    ev('agent_started', { seq: 6, label: 'review cli', phase: 'Review', backend: 'claude', model: 'claude-sonnet-5' }, 120_000),
    ev('agent_usage', { seq: 6, totalTokens: 3100, estimated: false }, 150_000),
    ev('agent_started', { seq: 7, label: 'review engine', phase: 'Review', backend: 'claude' }, 106_000),
    ev('agent_usage', { seq: 7, totalTokens: 1200, estimated: true }, 150_000),
    ev('agent_retry', { seq: 7, label: 'review engine', attempt: 2, maxAttempts: 3, kind: 'task' }, 150_500),
    ev('agent_started', { seq: 8, label: 'review legacy', phase: 'Review', backend: 'claude' }, 110_000),
    ev('agent_completed', { seq: 8, label: 'review legacy', phase: 'Review', ok: false, totalTokens: 900, error: 'schema mismatch' }, 140_000),
    ev('agent_queued', { seq: 9, label: 'review mcp', phase: 'Review' }, 140_500),
    ev('child_started', { childId: 0, name: 'security-scan' }, 141_000),
    ev('agent_started', { seq: 10, label: 'scan-deps', backend: 'claude', childId: 0, childName: 'security-scan' }, 149_000),
    ev('agent_usage', { seq: 10, totalTokens: 400, estimated: false, childId: 0, childName: 'security-scan' }, 152_000),
    ev('agent_completed', { seq: 11, label: 'gate-check', phase: 'Synthesize', ok: true, skipped: true, totalTokens: 0 }, 155_000),
    ev('budget_tick', { spent: 34_300 }, 140_000),
  ];
  for (const e of events) foldEvent(s, e);
  return s;
}

const FRAME_OPTS = { cols: 100, rows: 40, nowMs: 161_000, color: false, runStatus: 'running' as const };

describe('panel frame', () => {
  it('renders the full panel byte-exactly (colors off, pinned clock)', () => {
    // Verified by hand: durations from event ts deltas, Explore collapse
    // (4 done → keep 3, fold repo-mapper's 6.8k), Review 2/6 = ok+cached,
    // footer 39k = 34.3k budget_tick + 3.1k + 1.2k + 0.4k running ticks.
    expect(renderFrame(richState(), FRAME_OPTS)).toBe(
      '⏺ code-review — Deep review of the PR   running · 2m41s\n' +
        '  ⏺ Explore (4/4) — map the codebase\n' +
        '    ⎿ … +1 done (6.8k tok)\n' +
        '    ⎿ ✓ dep-scan                 5.1k tok · 7s\n' +
        '    ⎿ ✓ conv-scan                5k tok · 7s\n' +
        '    ⎿ ✓ api-scan                 4.2k tok · 7s\n' +
        '  ⠋ Review (2/6) — one agent per file\n' +
        '    ⎿ ✓ review core              12.3k tok · 1m04s · claude-sonnet-5\n' +
        '    ⎿ ⟳ review store             cached\n' +
        '    ⎿ ⠋ review cli               3.1k tok · 41s · claude-sonnet-5\n' +
        '    ⎿ ↻ review engine            ~1.2k tok · 55s · attempt 2\n' +
        '    ⎿ ✗ review legacy            failed: schema mismatch\n' +
        '    ⎿ ◌ review mcp\n' +
        '  ▸ security-scan (child)\n' +
        '    ⎿ ⠋ scan-deps                400 tok · 12s\n' +
        '  ⏺ Synthesize (0/1)\n' +
        '    ⎿ ⊘ gate-check               skipped\n' +
        'agents 8/12 · 3 running · 1 queued · 1 failed | tokens 39k/500k | elapsed 2m41s',
    );
  });

  it('color mode adds SGR codes but never changes the visible text', () => {
    const plain = renderFrame(richState(), FRAME_OPTS);
    const colored = renderFrame(richState(), { ...FRAME_OPTS, color: true });
    expect(colored).toContain('\x1b[32m✓\x1b[0m');
    expect(colored.replace(/\x1b\[[0-9;]*m/g, '')).toBe(plain);
  });

  it('the spinner is a pure function of the clock', () => {
    expect(spinnerFrame(0)).toBe('⠋');
    expect(spinnerFrame(100)).toBe('⠙');
    expect(spinnerFrame(950)).toBe('⠏');
    expect(spinnerFrame(1000)).toBe('⠋');
  });

  it('folds queued rows past the visible cap', () => {
    const s = createPanelState({ runName: 'q', budgetTotal: null, startedAtMs: 0 });
    foldEvent(s, ev('phase_started', { title: 'P' }));
    for (let i = 0; i < 8; i++) foldEvent(s, ev('agent_queued', { seq: i, label: `q${i}`, phase: 'P' }, i));
    const frame = renderFrame(s, { ...FRAME_OPTS, nowMs: 10_000 });
    expect(frame).toContain('⎿ ◌ q4');
    expect(frame).not.toContain('⎿ ◌ q5');
    expect(frame).toContain('⎿ ◌ … +3 queued');
  });

  it('clamps to the terminal height, escalating collapse before hard truncation', () => {
    const frame = renderFrame(richState(), { ...FRAME_OPTS, rows: 12 });
    const lines = frame.split('\n');
    expect(lines.length).toBeLessThanOrEqual(11);
    expect(lines[0]).toContain('code-review'); // header always survives
    expect(lines.at(-1)).toContain('agents 8/12'); // footer always survives
  });

  it('omits /total when no budget is set and keeps live running tokens in the footer', () => {
    const frame = renderFrame(richState(null), FRAME_OPTS);
    expect(frame).toContain('| tokens 39k |');
  });

  it('orphaned runs get a warning line; stop_requested renders stopping…', () => {
    const orphaned = renderFrame(richState(), { ...FRAME_OPTS, runStatus: 'orphaned' });
    expect(orphaned.split('\n')[1]).toBe('✗ runner died without finalizing (orphaned) — see runner.log');
    const s = richState();
    foldEvent(s, ev('stop_requested', {}));
    expect(renderFrame(s, FRAME_OPTS).split('\n')[0]).toContain('stopping…');
  });

  it('terminal frames do not fake liveness: in-flight rows render interrupted, never spinning', () => {
    const frame = renderFrame(richState(), { ...FRAME_OPTS, runStatus: 'orphaned' });
    expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏↻]/); // no spinner or retry glyph anywhere
    expect(frame).toContain('✗ review cli'); // was running → interrupted
    expect(frame).toContain('interrupted');
    expect(frame).toContain('⊘ review mcp'); // was queued → never started
    expect(frame).toContain('never started');
    expect(frame).toContain('agents 8/12 · 4 interrupted · 1 failed');
    expect(frame).not.toContain('running'); // neither rows nor footer claim liveness
    // last known live tokens still count toward the post-mortem total
    expect(frame).toContain('| tokens 39k/500k |');
  });

  it('never emits a line wider than cols, measured in display cells (CJK labels)', () => {
    const s = richState();
    foldEvent(
      s,
      ev('agent_completed', { seq: 20, label: 'x'.repeat(60), ok: false, totalTokens: 0, error: 'e'.repeat(200) }, 1),
    );
    foldEvent(s, ev('agent_started', { seq: 21, label: '非常に長い日本語のエージェントラベルです', phase: 'Review', backend: 'mock' }, 2));
    for (const cols of [20, 41, 80]) {
      for (const line of renderFrame(s, { ...FRAME_OPTS, cols }).split('\n')) {
        expect(displayWidth(line)).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('honors real geometry down to 1×2: never taller or wider than the screen', () => {
    for (const rows of [2, 3, 4, 5, 6]) {
      const lines = renderFrame(richState(), { ...FRAME_OPTS, rows }).split('\n');
      expect(lines.length).toBeLessThanOrEqual(Math.max(1, rows - 1));
    }
    for (const cols of [1, 8, 19]) {
      for (const line of renderFrame(richState(), { ...FRAME_OPTS, cols }).split('\n')) {
        expect(displayWidth(line)).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('a child workflow with NAMED phases renders its phase headers inside the ▸ group', () => {
    const s = createPanelState({ runName: 'p', budgetTotal: null, startedAtMs: 0 });
    foldEvent(s, ev('child_started', { childId: 0, name: 'sub' }, 1));
    foldEvent(s, ev('phase_started', { title: 'Scan', childId: 0, childName: 'sub' }, 2));
    foldEvent(s, ev('agent_started', { seq: 0, label: 'c-scan', phase: 'Scan', backend: 'mock', childId: 0, childName: 'sub' }, 3));
    foldEvent(s, ev('agent_completed', { seq: 0, label: 'c-scan', phase: 'Scan', ok: true, totalTokens: 10, childId: 0, childName: 'sub' }, 4));
    foldEvent(s, ev('child_completed', { childId: 0, name: 'sub', ok: true, agentCount: 1 }, 5));
    const frame = renderFrame(s, { ...FRAME_OPTS, runStatus: 'completed', nowMs: 5 });
    const lines = frame.split('\n');
    const childIdx = lines.findIndex((l) => l.includes('▸ sub (child)'));
    expect(childIdx).toBeGreaterThan(-1);
    expect(lines[childIdx + 1]).toContain('Scan (1/1)'); // named child phase, indented inside the group
    expect(lines[childIdx + 2]).toContain('✓ c-scan');
  });

  it('selectedSeq marks the row with ❯ (bold cyan in color mode) without shifting other lines', () => {
    const base = renderFrame(richState(), FRAME_OPTS).split('\n');
    const selected = renderFrame(richState(), { ...FRAME_OPTS, selectedSeq: 6 }).split('\n');
    expect(selected).toHaveLength(base.length);
    const idx = base.findIndex((l) => l.includes('review cli'));
    expect(selected[idx]).toBe(base[idx]!.replace('⎿', '❯')); // marker only — spacing identical
    for (let i = 0; i < base.length; i++) {
      if (i !== idx) expect(selected[i]).toBe(base[i]);
    }
    const colored = renderFrame(richState(), { ...FRAME_OPTS, color: true, selectedSeq: 6 });
    expect(colored).toContain('\x1b[36;1m❯\x1b[0m');
    expect(colored).toContain('\x1b[1mreview cli'); // bold label
  });

  it('the selected row is exempt from collapse folding at every level', () => {
    // Level 0: repo-mapper (seq 0) folds into "+1 done" by default…
    const base = renderFrame(richState(), FRAME_OPTS);
    expect(base).toContain('… +1 done');
    expect(base).not.toContain('repo-mapper');
    // …but stays visible while selected (and the fold notice disappears with it).
    const withSel = renderFrame(richState(), { ...FRAME_OPTS, selectedSeq: 0 });
    expect(withSel).toContain('❯ ✓ repo-mapper');
    expect(withSel).not.toContain('… +1 done');
    // Level 2 (small terminal): the fully-settled Explore phase collapses to
    // its header unless the selection lives inside it. (The last-resort
    // hard truncation on even smaller terminals is selection-blind by design.)
    const small = renderFrame(richState(), { ...FRAME_OPTS, rows: 16, selectedSeq: 0 });
    expect(small).toContain('❯ ✓ repo-mapper');
    expect(small.split('\n').length).toBeLessThanOrEqual(15);
    const noSel = renderFrame(richState(), { ...FRAME_OPTS, rows: 16 });
    expect(noSel).not.toContain('repo-mapper'); // without selection the phase folds to its header
  });

  it('selection also survives the queued-overflow fold', () => {
    const s = createPanelState({ runName: 'q', budgetTotal: null, startedAtMs: 0 });
    foldEvent(s, ev('phase_started', { title: 'P' }));
    for (let i = 0; i < 8; i++) foldEvent(s, ev('agent_queued', { seq: i, label: `q${i}`, phase: 'P' }, i));
    const frame = renderFrame(s, { ...FRAME_OPTS, nowMs: 10_000, selectedSeq: 7 });
    expect(frame).toContain('❯ ◌ q7');
    expect(frame).toContain('… +2 queued'); // one fewer hidden — the selected row escaped the fold
  });

  it('keymap renders as the last line and counts toward the height budget', () => {
    const keymap = '↑/↓ select · ⏎ details · q detach';
    const frame = renderFrame(richState(), { ...FRAME_OPTS, keymap });
    expect(frame.split('\n').at(-1)).toBe(keymap);
    for (const rows of [4, 6, 12]) {
      const lines = renderFrame(richState(), { ...FRAME_OPTS, rows, keymap }).split('\n');
      expect(lines.length).toBeLessThanOrEqual(Math.max(1, rows - 1));
    }
    const colored = renderFrame(richState(), { ...FRAME_OPTS, color: true, keymap });
    expect(colored).toContain(`\x1b[2m${keymap}\x1b[0m`);
  });

  it('hostile control bytes in events cannot reach the frame', () => {
    const s = createPanelState({ runName: 'inj', budgetTotal: null, startedAtMs: 0 });
    foldEvent(s, ev('agent_started', { seq: 0, label: 'l\x1b[10A\x1b[2J', backend: 'mock', model: 'm\x9b1J' }, 1));
    foldEvent(s, ev('agent_completed', { seq: 0, label: 'l\x1b[10A\x1b[2J', ok: false, totalTokens: 1, error: 'e\nr\rn\x1b[H' }, 2));
    const frame = renderFrame(s, FRAME_OPTS);
    expect(frame).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/); // only \n between lines
    // an embedded newline in the error must not add uncounted physical rows
    expect(frame.split('\n').every((l) => displayWidth(l) <= FRAME_OPTS.cols)).toBe(true);
  });
});
