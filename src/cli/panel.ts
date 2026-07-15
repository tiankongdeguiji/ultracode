/**
 * Pure state core for the live run panel: fold events.jsonl into PanelState,
 * then render a frame (frame rendering lives beside the fold so the whole
 * panel is one testable unit). Zero I/O and zero timers — callers supply the
 * clock, geometry, and events, which keeps every path deterministic in tests.
 */
import type { TimestampedEvent } from '../store/events.js';
import type { RunStatus } from '../store/manifest.js';

export type AgentRowStatus = 'queued' | 'running' | 'ok' | 'failed' | 'skipped' | 'cached';

export interface AgentRow {
  seq: number;
  label: string;
  phase?: string;
  /** set when the agent ran inside a nested workflow() child */
  childId?: number;
  status: AgentRowStatus;
  backend?: string;
  model?: string;
  /** live cumulative tokens (agent_usage ticks); authoritative once completed */
  tokens: number;
  estimated: boolean;
  /** >= 2 while the executor retries (agent_retry) */
  attempt: number;
  startedTs?: number;
  endedTs?: number;
  error?: string;
}

export interface PhaseGroup {
  title: string;
  /** from meta.phases (seed) — never in the manifest or events */
  detail?: string;
  childId?: number;
  /** false until a phase_started (or member agent) arrives — seeded phases render dim */
  started: boolean;
}

export interface ChildGroup {
  childId: number;
  name: string;
  done: boolean;
  ok?: boolean;
}

export interface PanelSeed {
  runName: string;
  /** meta.title, when script.js parses */
  title?: string;
  phases?: { title: string; detail?: string }[];
  budgetTotal: number | null;
  startedAtMs: number;
}

export interface PanelState {
  seed: PanelSeed;
  phases: PhaseGroup[];
  agents: Map<number, AgentRow>;
  /** seqs in first-seen order — stable render order */
  order: number[];
  children: ChildGroup[];
  /** pending narrator lines, drained per tick by takeNarratorLines */
  narrator: string[];
  /** last budget_tick.spent — completed agents only */
  spentTokens: number;
  stopRequested: boolean;
  /**
   * Old-stream fallback: engines without child boundary events let the child's
   * own run_started/run_completed through untagged. A second run_started opens
   * an inferred child (negative childId) and attribution becomes
   * interval-based — approximate when parent agents run concurrently, which is
   * why new engines tag every event instead.
   */
  inferredChild?: ChildGroup;
  inferredChildCount: number;
  sawRunStarted: boolean;
}

/** Loose field view over a TimestampedEvent; every use site guards its own fields. */
interface Ev {
  ts: number;
  type: string;
  name?: string;
  title?: string;
  seq?: number;
  label?: string;
  phase?: string;
  backend?: string;
  model?: string;
  ok?: boolean;
  skipped?: boolean;
  cached?: boolean;
  totalTokens?: number;
  estimated?: boolean;
  attempt?: number;
  maxAttempts?: number;
  message?: string;
  spent?: number;
  error?: string;
  childId?: number;
  childName?: string;
}

export function createPanelState(seed: PanelSeed): PanelState {
  return {
    seed,
    phases: (seed.phases ?? []).map((p) => ({ title: p.title, detail: p.detail, started: false })),
    agents: new Map(),
    order: [],
    children: [],
    narrator: [],
    spentTokens: 0,
    stopRequested: false,
    inferredChildCount: 0,
    sawRunStarted: false,
  };
}

function ensurePhase(state: PanelState, title: string, childId: number | undefined): PhaseGroup {
  let p = state.phases.find((g) => g.title === title && g.childId === childId);
  if (!p) {
    p = { title, childId, started: false };
    state.phases.push(p);
  }
  return p;
}

function ensureChild(state: PanelState, childId: number, name: string): ChildGroup {
  let c = state.children.find((g) => g.childId === childId);
  if (!c) {
    c = { childId, name, done: false };
    state.children.push(c);
  }
  return c;
}

function rowFor(state: PanelState, e: Ev): AgentRow {
  const seq = e.seq ?? -1;
  let row = state.agents.get(seq);
  if (!row) {
    row = {
      seq,
      label: e.label ?? `#${seq}`,
      phase: e.phase,
      childId: e.childId ?? state.inferredChild?.childId,
      status: 'queued',
      tokens: 0,
      estimated: false,
      attempt: 1,
    };
    if (row.childId !== undefined && e.childName) ensureChild(state, row.childId, e.childName);
    state.agents.set(seq, row);
    state.order.push(seq);
  }
  if (e.label) row.label = e.label;
  if (e.phase) {
    row.phase = e.phase;
    ensurePhase(state, e.phase, row.childId).started = true;
  }
  return row;
}

/** Mutating fold. Unknown event types and unknown seqs are ignored — the panel must never crash the attach. */
export function foldEvent(state: PanelState, raw: TimestampedEvent): void {
  const e = raw as unknown as Ev;
  switch (e.type) {
    case 'run_started': {
      if (e.childId !== undefined) return; // tagged child lifecycle (never emitted today; drop defensively)
      if (!state.sawRunStarted) {
        state.sawRunStarted = true;
        return;
      }
      // Old-stream inference: a second untagged run_started is a nested child.
      const childId = -(++state.inferredChildCount);
      state.inferredChild = ensureChild(state, childId, e.name ?? '(child)');
      return;
    }
    case 'run_completed':
    case 'run_failed':
    case 'run_stopped': {
      // Run status always comes from the manifest (liveStatus), never events —
      // this also makes an old stream's child run_completed harmless.
      if (state.inferredChild) {
        state.inferredChild.done = true;
        state.inferredChild.ok = e.type === 'run_completed';
        state.inferredChild = undefined;
      }
      return;
    }
    case 'child_started': {
      if (e.childId !== undefined) ensureChild(state, e.childId, e.name ?? '(child)');
      return;
    }
    case 'child_completed': {
      if (e.childId === undefined) return;
      const c = ensureChild(state, e.childId, e.name ?? '(child)');
      c.done = true;
      c.ok = e.ok === true;
      return;
    }
    case 'phase_started': {
      if (typeof e.title !== 'string') return;
      const childId = e.childId ?? state.inferredChild?.childId;
      if (childId !== undefined && e.childName) ensureChild(state, childId, e.childName);
      ensurePhase(state, e.title, childId).started = true;
      return;
    }
    case 'agent_queued': {
      rowFor(state, e); // created rows start queued
      return;
    }
    case 'agent_started': {
      const row = rowFor(state, e);
      row.status = 'running';
      row.startedTs = e.ts;
      if (e.backend) row.backend = e.backend;
      if (e.model) row.model = e.model;
      return;
    }
    case 'agent_retry': {
      const row = state.agents.get(e.seq ?? -1);
      if (!row) return;
      // max: a schema-repair notice must never roll a displayed attempt back
      if (typeof e.attempt === 'number') row.attempt = Math.max(row.attempt, e.attempt);
      if (row.status === 'queued') row.status = 'running';
      return;
    }
    case 'agent_usage': {
      const row = state.agents.get(e.seq ?? -1);
      if (!row || row.endedTs !== undefined) return;
      // Monotonic guard: ticks race the completion event in one fold batch.
      row.tokens = Math.max(row.tokens, e.totalTokens ?? 0);
      if (e.estimated === true) row.estimated = true;
      return;
    }
    case 'agent_model': {
      const row = state.agents.get(e.seq ?? -1);
      if (row && typeof e.model === 'string') row.model = e.model;
      return;
    }
    case 'agent_completed': {
      const existed = state.agents.has(e.seq ?? -1);
      const row = rowFor(state, e);
      row.endedTs = e.ts;
      row.tokens = e.totalTokens ?? row.tokens; // authoritative
      if (e.skipped === true) row.status = 'skipped';
      else if (e.cached === true || (!existed && e.ok === true && (e.totalTokens ?? 0) === 0)) {
        // Explicit flag on new streams; old streams: a lone zero-token ok
        // completion (no queued/started) is a prefix-replay hit.
        row.status = 'cached';
      } else if (e.ok === true) row.status = 'ok';
      else {
        row.status = 'failed';
        row.error = e.error;
      }
      return;
    }
    case 'workflow_log': {
      if (typeof e.message === 'string') state.narrator.push(`· ${e.message}`);
      return;
    }
    case 'budget_tick': {
      if (typeof e.spent === 'number') state.spentTokens = Math.max(state.spentTokens, e.spent);
      return;
    }
    case 'stop_requested': {
      state.stopRequested = true;
      return;
    }
    default:
      return;
  }
}

/** Drain narrator lines accumulated since the last call (already `· `-prefixed, un-colored). */
export function takeNarratorLines(state: PanelState): string[] {
  if (state.narrator.length === 0) return [];
  return state.narrator.splice(0, state.narrator.length);
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

const trimZeros = (s: string): string => s.replace(/\.?0+$/, '');

/** 950 → "950", 12_345 → "12.3k", 145_200 → "145.2k", 1_450_000 → "1.45m". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimZeros((n / 1000).toFixed(1))}k`;
  return `${trimZeros((n / 1_000_000).toFixed(2))}m`;
}

/** 45_000 → "45s", 130_000 → "2m10s", 4_020_000 → "1h07m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** Code-point-safe truncation with an ellipsis (display-width of wide glyphs not handled). */
export function truncateToWidth(s: string, width: number): string {
  if (width <= 0) return '';
  const chars = [...s];
  if (chars.length <= width) return s;
  if (width === 1) return '…';
  return chars.slice(0, width - 1).join('') + '…';
}

// ---------------------------------------------------------------------------
// Frame renderer
// ---------------------------------------------------------------------------

export interface FrameOptions {
  cols: number;
  /** terminal rows; the frame clamps itself to rows - 1 so repaint math never scrolls */
  rows: number;
  /** explicit clock → deterministic tests; the final frame passes endedAt */
  nowMs: number;
  /** false → zero SGR bytes in the output */
  color: boolean;
  /** from liveStatus(manifest) — events never decide run status */
  runStatus: RunStatus;
  /** manifest.budget.spent — may lead the folded budget_tick after a torn tail */
  spentFloor?: number;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const VISIBLE_DONE_PER_PHASE = 3;
const VISIBLE_QUEUED_PER_PHASE = 5;
const LABEL_WIDTH = 24;

/** Pure spinner frame — a function of the clock, so tests pin it via nowMs. */
export function spinnerFrame(nowMs: number): string {
  return SPINNER_FRAMES[Math.floor(nowMs / 100) % SPINNER_FRAMES.length]!;
}

type Paint = (code: string, s: string) => string;

const SETTLED: ReadonlySet<AgentRowStatus> = new Set(['ok', 'failed', 'skipped', 'cached']);
const DONE_LIKE: ReadonlySet<AgentRowStatus> = new Set(['ok', 'cached', 'skipped']);

interface Section {
  kind: 'phase' | 'child';
  childId?: number;
  phase?: PhaseGroup;
  child?: ChildGroup;
  firstSeq: number;
}

function rowsOf(state: PanelState): AgentRow[] {
  return state.order.map((seq) => state.agents.get(seq)!).filter(Boolean);
}

function agentRowLine(row: AgentRow, indent: string, opts: FrameOptions, paint: Paint): string {
  const spin = row.attempt >= 2 ? paint('33', '↻') : paint('36', spinnerFrame(opts.nowMs));
  const glyph =
    row.status === 'running'
      ? spin
      : row.status === 'ok'
        ? paint('32', '✓')
        : row.status === 'failed'
          ? paint('31', '✗')
          : row.status === 'queued'
            ? paint('2', '◌')
            : row.status === 'skipped'
              ? paint('2', '⊘')
              : paint('2', '⟳'); // cached
  const label = truncateToWidth(row.label, LABEL_WIDTH).padEnd(LABEL_WIDTH);
  const parts: string[] = [];
  if (row.status === 'failed') {
    parts.push(paint('31', `failed: ${row.error ?? 'unknown error'}`));
  } else if (row.status === 'skipped') {
    parts.push(paint('2', 'skipped'));
  } else if (row.status === 'cached') {
    parts.push(paint('2', 'cached'));
  } else if (row.status === 'queued') {
    // no metadata — the row itself signals the wait
  } else {
    if (row.tokens > 0) parts.push(`${row.estimated ? '~' : ''}${formatTokens(row.tokens)} tok`);
    const end = row.endedTs ?? opts.nowMs;
    if (row.startedTs !== undefined) parts.push(formatDuration(end - row.startedTs));
    if (row.model) parts.push(paint('2', row.model));
    if (row.status === 'running' && row.attempt >= 2) parts.push(paint('33', `attempt ${row.attempt}`));
  }
  const meta = parts.join(paint('2', ' · '));
  return `${indent}⎿ ${glyph} ${label}${meta ? ` ${meta}` : ''}`.trimEnd();
}

function sectionRows(state: PanelState, childId: number | undefined, phase: string | undefined): AgentRow[] {
  return rowsOf(state).filter((r) => r.childId === childId && r.phase === phase);
}

function phaseLines(
  state: PanelState,
  phase: PhaseGroup | undefined,
  childId: number | undefined,
  indent: string,
  opts: FrameOptions,
  paint: Paint,
  level: number,
): string[] {
  const members = sectionRows(state, childId, phase?.title);
  const lines: string[] = [];
  if (phase) {
    const running = members.some((r) => r.status === 'running');
    const glyph = running ? paint('36', spinnerFrame(opts.nowMs)) : phase.started ? '⏺' : paint('2', '⏺');
    const done = members.filter((r) => r.status === 'ok' || r.status === 'cached').length;
    const count = members.length > 0 ? ` (${done}/${members.length})` : '';
    const detail = phase.detail ? paint('2', ` — ${phase.detail}`) : '';
    const title = phase.started ? phase.title : paint('2', phase.title);
    lines.push(`${indent}${glyph} ${title}${count}${detail}`);
  }
  if (level >= 2 && members.length > 0 && members.every((r) => SETTLED.has(r.status))) {
    return lines; // fully-terminal phase collapses to its header under pressure
  }
  const rowIndent = phase ? `${indent}  ` : indent;
  const visibleDone = level >= 1 ? 0 : VISIBLE_DONE_PER_PHASE;
  const doneRows = members.filter((r) => DONE_LIKE.has(r.status));
  const hiddenDone = doneRows.slice(0, Math.max(0, doneRows.length - visibleDone));
  const hiddenSet = new Set(hiddenDone.map((r) => r.seq));
  if (hiddenDone.length > 0) {
    const tok = hiddenDone.reduce((n, r) => n + r.tokens, 0);
    lines.push(paint('2', `${rowIndent}⎿ … +${hiddenDone.length} done${tok > 0 ? ` (${formatTokens(tok)} tok)` : ''}`));
  }
  const queuedRows = members.filter((r) => r.status === 'queued');
  const hiddenQueued = queuedRows.slice(VISIBLE_QUEUED_PER_PHASE);
  for (const row of members) {
    if (hiddenSet.has(row.seq)) continue;
    if (hiddenQueued.includes(row)) continue;
    lines.push(agentRowLine(row, rowIndent, opts, paint));
  }
  if (hiddenQueued.length > 0) {
    lines.push(paint('2', `${rowIndent}⎿ ◌ … +${hiddenQueued.length} queued`));
  }
  return lines;
}

function buildSections(state: PanelState): Section[] {
  const rows = rowsOf(state);
  const firstSeq = (pred: (r: AgentRow) => boolean): number => {
    const hit = rows.find(pred);
    return hit ? hit.seq : Number.POSITIVE_INFINITY;
  };
  const sections: Section[] = [];
  // Implicit no-phase parent group (only when it has rows).
  if (rows.some((r) => r.childId === undefined && r.phase === undefined)) {
    sections.push({ kind: 'phase', firstSeq: firstSeq((r) => r.childId === undefined && r.phase === undefined) });
  }
  for (const phase of state.phases.filter((p) => p.childId === undefined)) {
    sections.push({ kind: 'phase', phase, firstSeq: firstSeq((r) => r.childId === undefined && r.phase === phase.title) });
  }
  for (const child of state.children) {
    sections.push({ kind: 'child', child, childId: child.childId, firstSeq: firstSeq((r) => r.childId === child.childId) });
  }
  // Chronological by first agent; empty sections keep their declared order at
  // the bottom (upcoming seeded phases render below active work). Stable sort.
  return sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.firstSeq - b.s.firstSeq) || (a.i - b.i))
    .map((x) => x.s);
}

function childLines(state: PanelState, child: ChildGroup, opts: FrameOptions, paint: Paint, level: number): string[] {
  const glyph = child.done ? (child.ok ? paint('32', '▸') : paint('31', '▸')) : paint('36', '▸');
  const lines = [`  ${glyph} ${child.name} ${paint('2', '(child)')}`];
  const childPhases = state.phases.filter((p) => p.childId === child.childId);
  lines.push(...phaseLines(state, undefined, child.childId, '    ', opts, paint, level));
  for (const phase of childPhases) {
    lines.push(...phaseLines(state, phase, child.childId, '    ', opts, paint, level));
  }
  return lines;
}

function footerLine(state: PanelState, opts: FrameOptions, paint: Paint): string {
  const rows = rowsOf(state);
  const settled = rows.filter((r) => SETTLED.has(r.status)).length;
  const running = rows.filter((r) => r.status === 'running');
  const queued = rows.filter((r) => r.status === 'queued').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const liveTokens = Math.max(state.spentTokens, opts.spentFloor ?? 0) + running.reduce((n, r) => n + r.tokens, 0);
  const parts = [`agents ${settled}/${rows.length}`];
  if (running.length > 0) parts.push(`${running.length} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  if (failed > 0) parts.push(paint('31', `${failed} failed`));
  const total = state.seed.budgetTotal;
  const tokens = `tokens ${formatTokens(liveTokens)}${total ? `/${formatTokens(total)}` : ''}`;
  const elapsed = `elapsed ${formatDuration(opts.nowMs - state.seed.startedAtMs)}`;
  return paint('2', `${parts.join(' · ')} | ${tokens} | ${elapsed}`);
}

function headerLines(state: PanelState, opts: FrameOptions, paint: Paint): string[] {
  const statusText =
    state.stopRequested && opts.runStatus === 'running' ? 'stopping…' : opts.runStatus;
  const statusColor =
    opts.runStatus === 'completed'
      ? '32'
      : opts.runStatus === 'failed' || opts.runStatus === 'orphaned'
        ? '31'
        : statusText === 'stopping…' || opts.runStatus === 'stopped'
          ? '33'
          : '36';
  const name = paint('1', state.seed.runName) + (state.seed.title ? paint('2', ` — ${state.seed.title}`) : '');
  const lines = [
    `⏺ ${name}   ${paint(statusColor, statusText)} ${paint('2', '·')} ${formatDuration(opts.nowMs - state.seed.startedAtMs)}`,
  ];
  if (opts.runStatus === 'orphaned') {
    lines.push(paint('31', '✗ runner died without finalizing (orphaned) — see runner.log'));
  }
  return lines;
}

/**
 * Pure full-frame render: '\n'-joined lines, every line pre-truncated to cols
 * (lines must never soft-wrap — the repaint cursor math counts them). Collapse
 * escalates until the frame fits rows - 1: hide done rows per phase → hide all
 * done rows → collapse terminal phases to headers → hard-truncate with notice.
 */
export function renderFrame(state: PanelState, opts: FrameOptions): string {
  const cols = Math.max(20, opts.cols);
  const rowsBudget = Math.max(6, opts.rows - 1);
  const paint: Paint = opts.color ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_code, s) => s;

  let lines: string[] = [];
  for (let level = 0; level <= 2; level++) {
    lines = headerLines(state, opts, paint);
    for (const section of buildSections(state)) {
      if (section.kind === 'child' && section.child) {
        lines.push(...childLines(state, section.child, opts, paint, level));
      } else {
        lines.push(...phaseLines(state, section.phase, undefined, '  ', opts, paint, level));
      }
    }
    lines.push(footerLine(state, opts, paint));
    if (lines.length <= rowsBudget) break;
  }
  if (lines.length > rowsBudget) {
    // Last resort: keep the header and the most recent tail (incl. footer).
    const tail = lines.slice(lines.length - (rowsBudget - 2));
    lines = [lines[0]!, paint('2', `  … ${lines.length - tail.length - 1} lines hidden (terminal too small)`), ...tail];
  }
  // Overlong lines would soft-wrap and break the repaint's cursor-up count.
  // Truncating through SGR codes could cut a reset and bleed color, so an
  // overlong colored line drops its color instead (rare: long error text).
  const fit = (l: string): string => {
    const plain = l.replace(ANSI_RE, '');
    return [...plain].length <= cols ? l : truncateToWidth(plain, cols);
  };
  return lines.map(fit).join('\n');
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
