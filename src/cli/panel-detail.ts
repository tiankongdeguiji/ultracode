/**
 * Per-agent detail view for the interactive panel: a pure renderer beside the
 * overview frame (same zero-I/O contract — the watch loop reads prompt.md /
 * result.json and passes their contents in as data). Layout: pinned run header
 * + agent status line, a scrollable body (Prompt / Activity / Outcome
 * sections), and a scroll-indicator + keymap line. Every line obeys the
 * overview's invariants: pre-truncated to cols, frame clamped to rows - 1.
 */
import { isTerminal } from '../store/manifest.js';
import {
  displayWidth,
  fitLine,
  formatDuration,
  formatTokens,
  headerLines,
  isInterruptedRow,
  rowGlyph,
  sanitizeText,
  spinnerFrame,
  truncateToWidth,
  type AgentRow,
  type FrameOptions,
  type Paint,
  type PanelState,
  type ToolStatus,
} from './panel.js';

/** Pre-read on-disk artifacts for the selected agent; undefined until readable. */
export interface AgentArtifacts {
  /** agents/<dir>/prompt.md — written at agent start (live) */
  prompt?: string;
  /** parsed agents/<dir>/result.json — written at settle; untrusted shape */
  result?: unknown;
  /** renderDetailFrame's wrap memo — rewrapping a 64KB artifact at 8fps just
   *  to redraw the spinner is pure churn. Keyed by inputs; callers never touch it. */
  wrapMemo?: WrapMemo;
}

/** Memoized lines are stored ALREADY indented, so a paint only copies array
 *  references into the body instead of allocating one string per line. */
interface WrapMemo {
  width: number;
  promptFor?: string;
  promptLines?: string[];
  valueFor?: unknown;
  valueLines?: string[];
}

export interface DetailOptions extends FrameOptions {
  /** first visible body line; the renderer clamps and reports maxScroll back */
  scroll: number;
  promptExpanded: boolean;
  /** final frozen frame: keys are dead, so scroll to the Outcome section —
   *  a frozen ↓ hiding the result would make it unreachable forever */
  snapToOutcome?: boolean;
}

/** Wrapped prompt lines shown while collapsed. */
export const PROMPT_COLLAPSED_LINES = 6;
const BODY_INDENT = '  ';

/**
 * Hard-wrap text to a display-cell width, preserving the text's own line
 * breaks (sanitizeText would flatten them — it runs per line here). No word
 * awareness: the panel never soft-wraps, so a cell-exact split is what keeps
 * the repaint cursor math sound.
 */
export function wrapToWidth(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = sanitizeText(rawLine);
    if (line.length === 0) {
      out.push('');
      continue;
    }
    let cur = '';
    let curW = 0;
    for (const ch of line) {
      const cw = displayWidth(ch);
      if (curW + cw > w && cur !== '') {
        out.push(cur);
        cur = '';
        curW = 0;
      }
      cur += ch;
      curW += cw;
    }
    if (cur !== '') out.push(cur);
  }
  return out;
}

function statusLine(row: AgentRow, opts: DetailOptions, paint: Paint): string {
  const lost = isInterruptedRow(row, opts.runStatus);
  const parts: string[] = [];
  if (row.tokens > 0) parts.push(`${row.estimated ? '~' : ''}${formatTokens(row.tokens)} tok`);
  if (row.toolCalls > 0) parts.push(`${row.toolCalls} tool${row.toolCalls === 1 ? '' : 's'}`);
  if (row.startedTs !== undefined) parts.push(formatDuration((row.endedTs ?? opts.nowMs) - row.startedTs));
  if (row.model) parts.push(paint('2', row.model));
  if (lost) parts.push(paint('33', row.status === 'running' ? 'interrupted' : 'never started'));
  else if (row.status === 'running') {
    if (row.attempt >= 2) parts.push(paint('33', `attempt ${row.attempt}`));
    const lastActivity = row.lastActivityTs ?? row.startedTs;
    if (lastActivity !== undefined && opts.nowMs - lastActivity >= 10_000) {
      parts.push(paint('2', `idle ${formatDuration(opts.nowMs - lastActivity)}`));
    }
  } else if (row.status === 'failed') parts.push(paint('31', 'failed'));
  else if (row.status === 'skipped') parts.push(paint('2', 'skipped'));
  else if (row.status === 'cached') parts.push(paint('2', 'cached'));
  const meta = parts.join(paint('2', ' · '));
  return `${rowGlyph(row, opts, paint)} ${paint('1', row.label)}${meta ? `   ${meta}` : ''}`;
}

const TOOL_GLYPH_CODE: Record<Exclude<ToolStatus, 'started'>, [string, string]> = {
  completed: ['32', '✓'],
  failed: ['31', '✗'],
  declined: ['2', '⊘'],
};

function activityLines(row: AgentRow, opts: DetailOptions, paint: Paint, width: number): string[] {
  if (row.recentTools.length === 0) {
    return [paint('2', row.toolCalls > 0 ? '(earlier calls scrolled off)' : '(no tool calls yet)')];
  }
  const live = !isTerminal(opts.runStatus) && row.endedTs === undefined;
  return row.recentTools.map((t) => {
    const glyph =
      t.status === 'started'
        ? live
          ? paint('36', spinnerFrame(opts.nowMs))
          : paint('2', '◌')
        : paint(...TOOL_GLYPH_CODE[t.status]);
    // Truncate here so fitLine never has to drop the glyph's color on overflow.
    return `${glyph} ${truncateToWidth(t.name, Math.max(1, width - 2))}`;
  });
}

function outcomeLines(
  row: AgentRow,
  art: AgentArtifacts,
  opts: DetailOptions,
  paint: Paint,
  width: number,
  memo: WrapMemo,
): string[] {
  if (row.endedTs === undefined && !isTerminal(opts.runStatus)) {
    return [BODY_INDENT + paint('2', 'Still running…')];
  }
  if (row.status === 'running' || row.status === 'queued') {
    return [BODY_INDENT + paint('33', row.status === 'running' ? 'interrupted' : 'never started')];
  }
  if (row.status === 'skipped') return [BODY_INDENT + paint('2', 'skipped')];
  const res = (art.result ?? undefined) as { value?: unknown; error?: unknown } | undefined;
  if (row.status === 'failed') {
    const error = row.error ?? (typeof res?.error === 'string' ? res.error : undefined);
    return wrapToWidth(`failed: ${error ?? 'unknown error'}`, width).map((l) => BODY_INDENT + paint('31', l));
  }
  if (res === undefined || typeof res !== 'object') {
    return [BODY_INDENT + paint('2', '(finalizing…)')]; // result.json not readable yet — caller retries next paint
  }
  // Memoized on the parsed result's identity: stringify+wrap of a large value
  // is pure and its inputs only change when the artifact cache replaces `res`.
  if (memo.valueFor !== res || memo.valueLines === undefined) {
    const value = res.value;
    memo.valueFor = res;
    memo.valueLines = wrapToWidth(
      typeof value === 'string' ? value : value === undefined ? 'null' : JSON.stringify(value, null, 2),
      width,
    ).map((l) => BODY_INDENT + l);
  }
  return memo.valueLines;
}

/**
 * Render the detail frame for the agent at `seq`. Returns the frame text and
 * the maximum valid scroll offset so the caller can write the clamp back into
 * its UI state (self-healing when the body shrinks or the terminal resizes).
 */
export function renderDetailFrame(
  state: PanelState,
  seq: number,
  art: AgentArtifacts,
  opts: DetailOptions,
): { text: string; maxScroll: number } {
  const cols = Math.max(1, opts.cols);
  const rowsBudget = Math.max(1, opts.rows - 1);
  const paint: Paint = opts.color ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_code, s) => s;
  const row = state.agents.get(seq);
  if (!row) {
    // Defensive: rows are never removed from PanelState, but a frame must
    // still come back if the store misbehaves.
    return { text: fitLine(paint('2', `(agent #${seq} not found)`), cols), maxScroll: 0 };
  }

  const pinned = [...headerLines(state, opts, paint), statusLine(row, opts, paint)];
  const bodyWidth = cols - BODY_INDENT.length;

  // Wrap memo: resize starts a fresh one (width key); artifact replacement
  // invalidates per input identity below.
  const memo: WrapMemo = art.wrapMemo?.width === bodyWidth ? art.wrapMemo : (art.wrapMemo = { width: bodyWidth });
  const body: string[] = [];
  let promptLines: string[] | undefined;
  if (art.prompt !== undefined) {
    if (memo.promptFor !== art.prompt || memo.promptLines === undefined) {
      memo.promptFor = art.prompt;
      memo.promptLines = wrapToWidth(art.prompt, bodyWidth).map((l) => BODY_INDENT + l);
    }
    promptLines = memo.promptLines;
  }
  const promptCount = promptLines === undefined ? '' : paint('2', ` · ${promptLines.length} line${promptLines.length === 1 ? '' : 's'}`);
  body.push(`${paint('1', 'Prompt')}${promptCount}`);
  if (promptLines === undefined) {
    body.push(BODY_INDENT + paint('2', '(prompt not yet written)'));
  } else if (opts.promptExpanded || promptLines.length <= PROMPT_COLLAPSED_LINES) {
    for (const l of promptLines) body.push(l); // pre-indented; loop — spread would overflow argc on huge prompts
    if (opts.promptExpanded && promptLines.length > PROMPT_COLLAPSED_LINES) {
      body.push(BODY_INDENT + paint('2', '(⏎ collapse)'));
    }
  } else {
    body.push(...promptLines.slice(0, PROMPT_COLLAPSED_LINES));
    body.push(BODY_INDENT + paint('2', `… ${promptLines.length - PROMPT_COLLAPSED_LINES} more lines (⏎ expand)`));
  }
  body.push('');
  body.push(`${paint('1', 'Activity')}${row.toolCalls > 0 ? paint('2', ` · ${row.toolCalls} tool call${row.toolCalls === 1 ? '' : 's'}`) : ''}`);
  for (const l of activityLines(row, opts, paint, bodyWidth)) body.push(BODY_INDENT + l);
  body.push('');
  const outcomeIdx = body.length;
  body.push(paint('1', 'Outcome'));
  for (const l of outcomeLines(row, art, opts, paint, bodyWidth, memo)) body.push(l); // pre-indented

  // One bottom line merges the scroll indicator and the keymap. Decide whether
  // it exists against the FULL unreserved capacity first — reserving it up
  // front would hide an exact-fit body's last line behind a pointless ↓ on
  // final frames, where the keys that could reveal it are already dead.
  const unreserved = Math.max(1, rowsBudget - pinned.length);
  const reserveBottom = opts.keymap !== undefined || body.length > unreserved;
  const budget = reserveBottom ? Math.max(1, unreserved - 1) : unreserved;
  const maxScroll = Math.max(0, body.length - budget);
  const scroll = opts.snapToOutcome ? Math.min(outcomeIdx, maxScroll) : Math.min(Math.max(0, opts.scroll), maxScroll);
  const visible = body.slice(scroll, scroll + budget);

  let lines = [...pinned, ...visible];
  if (reserveBottom) {
    const bottom: string[] = [];
    if (body.length > visible.length) {
      const up = scroll > 0 ? ' ↑' : '';
      const down = scroll + visible.length < body.length ? ' ↓' : '';
      bottom.push(`${scroll + 1}–${scroll + visible.length} of ${body.length}${up}${down}`);
    }
    if (opts.keymap !== undefined) bottom.push(opts.keymap);
    lines.push(paint('2', bottom.join(' · ')));
  }
  // Degenerate terminals (rowsBudget smaller than pinned + 1 body + 1 bottom):
  // the budget floors above can overshoot — hard-clamp so an oversized frame
  // never scrolls the screen and desyncs the repaint's cursor-up count.
  if (lines.length > rowsBudget) lines = lines.slice(0, rowsBudget);
  return { text: lines.map((l) => fitLine(l, cols)).join('\n'), maxScroll };
}
