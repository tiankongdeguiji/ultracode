/**
 * Pure state core for the live run panel: fold events.jsonl into PanelState,
 * then render a frame (frame rendering lives beside the fold so the whole
 * panel is one testable unit). Zero I/O and zero timers — callers supply the
 * clock, geometry, and events, which keeps every path deterministic in tests.
 */
import type { TimestampedEvent } from '../store/events.js';

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
      if (typeof e.attempt === 'number') row.attempt = e.attempt;
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
