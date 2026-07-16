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
  sanitizeText,
  spinnerFrame,
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
}

export interface DetailOptions extends FrameOptions {
  /** first visible body line; the renderer clamps and reports maxScroll back */
  scroll: number;
  promptExpanded: boolean;
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

function statusGlyph(row: AgentRow, opts: DetailOptions, paint: Paint): string {
  const lost = isTerminal(opts.runStatus) && (row.status === 'running' || row.status === 'queued');
  if (lost) return row.status === 'running' ? paint('33', '✗') : paint('2', '⊘');
  switch (row.status) {
    case 'running':
      return row.attempt >= 2 ? paint('33', '↻') : paint('36', spinnerFrame(opts.nowMs));
    case 'ok':
      return paint('32', '✓');
    case 'failed':
      return paint('31', '✗');
    case 'queued':
      return paint('2', '◌');
    case 'skipped':
      return paint('2', '⊘');
    default:
      return paint('2', '⟳'); // cached
  }
}

function statusLine(row: AgentRow, opts: DetailOptions, paint: Paint): string {
  const lost = isTerminal(opts.runStatus) && (row.status === 'running' || row.status === 'queued');
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
  return `${statusGlyph(row, opts, paint)} ${paint('1', row.label)}${meta ? `   ${meta}` : ''}`;
}

const TOOL_GLYPH_CODE: Record<Exclude<ToolStatus, 'started'>, [string, string]> = {
  completed: ['32', '✓'],
  failed: ['31', '✗'],
  declined: ['2', '⊘'],
};

function activityLines(row: AgentRow, opts: DetailOptions, paint: Paint): string[] {
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
    return `${glyph} ${t.name}`;
  });
}

function outcomeLines(row: AgentRow, art: AgentArtifacts, opts: DetailOptions, paint: Paint, width: number): string[] {
  if (row.endedTs === undefined && !isTerminal(opts.runStatus)) {
    return [paint('2', 'Still running…')];
  }
  if (row.status === 'running' || row.status === 'queued') {
    return [paint('33', row.status === 'running' ? 'interrupted' : 'never started')];
  }
  if (row.status === 'skipped') return [paint('2', 'skipped')];
  const res = (art.result ?? undefined) as { value?: unknown; error?: unknown } | undefined;
  if (row.status === 'failed') {
    const error = row.error ?? (typeof res?.error === 'string' ? res.error : undefined);
    return wrapToWidth(`failed: ${error ?? 'unknown error'}`, width).map((l) => paint('31', l));
  }
  if (res === undefined || typeof res !== 'object') {
    return [paint('2', '(finalizing…)')]; // result.json not readable yet — caller retries next paint
  }
  const value = res.value;
  const text = typeof value === 'string' ? value : value === undefined ? 'null' : JSON.stringify(value, null, 2);
  return wrapToWidth(text, width);
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

  const body: string[] = [];
  const promptLines = art.prompt === undefined ? undefined : wrapToWidth(art.prompt, bodyWidth);
  const promptCount = promptLines === undefined ? '' : paint('2', ` · ${promptLines.length} line${promptLines.length === 1 ? '' : 's'}`);
  body.push(`${paint('1', 'Prompt')}${promptCount}`);
  if (promptLines === undefined) {
    body.push(BODY_INDENT + paint('2', '(prompt not yet written)'));
  } else if (opts.promptExpanded || promptLines.length <= PROMPT_COLLAPSED_LINES) {
    for (const l of promptLines) body.push(BODY_INDENT + l);
    if (opts.promptExpanded && promptLines.length > PROMPT_COLLAPSED_LINES) {
      body.push(BODY_INDENT + paint('2', '(⏎ collapse)'));
    }
  } else {
    for (const l of promptLines.slice(0, PROMPT_COLLAPSED_LINES)) body.push(BODY_INDENT + l);
    body.push(BODY_INDENT + paint('2', `… ${promptLines.length - PROMPT_COLLAPSED_LINES} more lines (⏎ expand)`));
  }
  body.push('');
  body.push(`${paint('1', 'Activity')}${row.toolCalls > 0 ? paint('2', ` · ${row.toolCalls} tool call${row.toolCalls === 1 ? '' : 's'}`) : ''}`);
  for (const l of activityLines(row, opts, paint)) body.push(BODY_INDENT + l);
  body.push('');
  body.push(paint('1', 'Outcome'));
  for (const l of outcomeLines(row, art, opts, paint, bodyWidth)) body.push(BODY_INDENT + l);

  // One bottom line merges the scroll indicator and the keymap; it exists
  // whenever either does, and its row is budgeted before windowing the body.
  const bodyBudget = Math.max(1, rowsBudget - pinned.length - 1);
  const maxScroll = Math.max(0, body.length - bodyBudget);
  const needIndicator = maxScroll > 0;
  const reserveBottom = needIndicator || opts.keymap !== undefined;
  const budget = reserveBottom ? bodyBudget : Math.max(1, rowsBudget - pinned.length);
  const scroll = Math.min(Math.max(0, opts.scroll), Math.max(0, body.length - budget));
  const visible = body.slice(scroll, scroll + budget);

  const lines = [...pinned, ...visible];
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
  return { text: lines.map((l) => fitLine(l, cols)).join('\n'), maxScroll: Math.max(0, body.length - budget) };
}
