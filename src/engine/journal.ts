/**
 * Journal: append-only journal.jsonl with hash-chained cache keys enabling
 * longest-unchanged-prefix replay on resume.
 *
 *   key_0 = "u1:" + sha256("ultracode-seed\0" + stableStringify(args) + "\0" + permission)
 *   key_n = "u1:" + sha256(key_{n-1} + "\0" + prompt + "\0" +
 *           stableStringify({agentType, isolation, model, effort, contextWindow,
 *                            executionRevision, schema, backend, cwd?}))
 *
 * The seed deliberately EXCLUDES the script hash: editing the script and
 * resuming must replay the unchanged prefix of agent() calls (the calls
 * themselves are what the chain hashes). Changing args changes the seed →
 * full re-run.
 *
 * Keys are assigned at DISPATCH time (agent() prologue runs synchronously in
 * seq order), never at completion time — concurrent completions settle in
 * nondeterministic order, dispatch order is reproducible.
 *
 * Deliberately NOT byte-compatible with Qoder's "v2:" keys: backend and
 * effort are in the hash because a resume after switching either must not
 * silently replay results produced under different conditions.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { openAppendFdNoFollow } from '../exec/safe-write.js';
import type { AgentSpec } from '../backends/types.js';

export const KEY_PREFIX = 'u1:';

// Increment a backend revision whenever an adapter change can alter output
// without changing AgentSpec. This prevents pre-upgrade results from replaying
// under new CLI semantics; absent entries preserve compatible backend caches.
const BACKEND_EXECUTION_REVISIONS: Readonly<Record<string, number>> = {
  claude: 2,
  qoder: 3,
};

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function seedKey(args: unknown, permission?: string): string {
  // Permission is a run-level capability that changes what agents may do and
  // therefore their observable output, and MCP resume can override it. Fold it
  // into the seed so resuming under a different permission (safe↔danger)
  // invalidates the whole prefix instead of replaying results produced under
  // different capabilities.
  return KEY_PREFIX + sha256(`ultracode-seed\0${stableStringify(args ?? null)}\0${permission ?? ''}`);
}

export function argsHash(args: unknown): string {
  return sha256(stableStringify(args ?? null));
}

/** Sequential cache-key chain. next() must be called in dispatch (seq) order. */
export class KeyChain {
  private last: string;

  constructor(
    seed: string,
    private readonly rootCwd: string,
    private readonly executionRevisions: Readonly<Record<string, number>> = BACKEND_EXECUTION_REVISIONS,
  ) {
    this.last = seed;
  }

  next(spec: AgentSpec): string {
    const optHash = stableStringify({
      agentType: spec.agentType,
      isolation: spec.isolation,
      model: spec.model,
      effort: spec.effort,
      contextWindow: spec.contextWindow,
      executionRevision: this.executionRevisions[spec.backend],
      schema: spec.schema,
      backend: spec.backend,
      cwd: spec.cwd === this.rootCwd ? undefined : spec.cwd,
    });
    this.last = KEY_PREFIX + sha256(`${this.last}\0${spec.prompt}\0${optHash}`);
    return this.last;
  }
}

export type JournalRecord =
  | {
      t: 'started';
      runId: string;
      engineVersion: string;
      scriptHash: string;
      argsHash: string;
      seedKey: string;
    }
  | {
      t: 'agent';
      seq: number;
      key: string;
      status: 'ok' | 'error' | 'skip';
      label: string;
      phase?: string;
      backend: string;
      model?: string;
      effort?: string;
      contextWindow?: number;
      cached?: boolean;
      sessionId?: string;
      totalTokens: number;
      resultRef?: string;
      error?: string;
    }
  | { t: 'child-enter'; name: string; argsHash: string }
  | { t: 'child-exit'; name: string };

export class JournalWriter {
  private fd: number | undefined;
  constructor(private readonly file: string) {}

  append(record: JournalRecord): void {
    // Held append fd opened O_NOFOLLOW: the run store is worker-writable, so
    // refuse to follow a symlink planted at the journal path (consistent with
    // the artifact writers). Process-lifetime fd — released on runner exit.
    if (this.fd === undefined) this.fd = openAppendFdNoFollow(this.file);
    writeSync(this.fd, JSON.stringify(record) + '\n');
  }
}

type AgentRecord = Extract<JournalRecord, { t: 'agent' }>;

/**
 * Longest-unchanged-prefix replay over a prior run's journal.
 *
 * lookup() compares the NEXT prior agent record's chain key with the new
 * dispatch's key, sequentially. A hit resolves instantly from the prior
 * run's result.json. The FIRST miss disables all later hits — beyond an
 * edit point everything runs live (hash chaining makes any earlier
 * divergence change all subsequent keys anyway).
 *
 * Skip records are advanced over: skipped agents in the new run return
 * null without consulting the cache, but they occupy journal positions.
 * Error records are misses by design — failed agents re-run on resume.
 */
export class PrefixReplayCache {
  private readonly queue: AgentRecord[];
  private idx = 0;
  private prefixMissed = false;
  readonly stats = { hits: 0, misses: 0 };

  constructor(records: JournalRecord[], private readonly priorRunDir: string) {
    // Records are appended in COMPLETION order (a parallel batch settles out of
    // order), but the chain keys are assigned in DISPATCH (seq) order and the
    // new run dispatches in seq order. Sort by seq so replay compares like with
    // like — otherwise one out-of-order parallel agent breaks the whole prefix.
    this.queue = records.filter((r): r is AgentRecord => r.t === 'agent').sort((a, b) => a.seq - b.seq);
  }

  readonly lookup = (_spec: AgentSpec, cacheKey: string | undefined): { hit: boolean; value?: unknown } | undefined => {
    if (this.prefixMissed || !cacheKey) return undefined;
    while (this.idx < this.queue.length && this.queue[this.idx]!.status === 'skip') this.idx++;
    const head = this.queue[this.idx];
    if (!head || head.key !== cacheKey || head.status !== 'ok' || !head.resultRef) {
      this.prefixMissed = true;
      this.stats.misses++;
      return undefined;
    }
    // resultRef comes from the prior run's journal, which lives in the
    // worker-writable run dir — untrusted. Confine the read to priorRunDir so a
    // rewritten `../../..`-escaping ref can't turn resume into an arbitrary-file
    // read gadget (the parsed .value flows back into the host agent's context).
    const base = resolve(this.priorRunDir);
    const target = resolve(base, head.resultRef);
    if (target !== base && !target.startsWith(base + sep)) {
      this.prefixMissed = true;
      this.stats.misses++;
      return undefined;
    }
    try {
      const result = JSON.parse(readFileSync(target, 'utf8')) as {
        value?: unknown;
      };
      this.idx++;
      this.stats.hits++;
      return { hit: true, value: result.value ?? null };
    } catch {
      this.prefixMissed = true;
      this.stats.misses++;
      return undefined;
    }
  };
}

export function readJournal(file: string): JournalRecord[] {
  if (!existsSync(file)) return [];
  const out: JournalRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as JournalRecord);
    } catch {
      // torn tail line from a crashed writer — ignore
    }
  }
  return out;
}
