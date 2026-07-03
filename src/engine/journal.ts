/**
 * Journal: append-only journal.jsonl with hash-chained cache keys enabling
 * longest-unchanged-prefix replay on resume.
 *
 *   key_0 = "u1:" + sha256(scriptHash + "\0" + stableStringify(args))
 *   key_n = "u1:" + sha256(key_{n-1} + "\0" + prompt + "\0" +
 *           stableStringify({agentType, isolation, model, effort, schema, backend, cwd?}))
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
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { AgentSpec } from '../backends/types.js';

export const KEY_PREFIX = 'u1:';

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

export function seedKey(scriptHash: string, args: unknown): string {
  return KEY_PREFIX + sha256(`${scriptHash}\0${stableStringify(args ?? null)}`);
}

export function argsHash(args: unknown): string {
  return sha256(stableStringify(args ?? null));
}

/** Sequential cache-key chain. next() must be called in dispatch (seq) order. */
export class KeyChain {
  private last: string;

  constructor(seed: string, private readonly rootCwd: string) {
    this.last = seed;
  }

  next(spec: AgentSpec): string {
    const optHash = stableStringify({
      agentType: spec.agentType,
      isolation: spec.isolation,
      model: spec.model,
      effort: spec.effort,
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
      cached?: boolean;
      sessionId?: string;
      totalTokens: number;
      resultRef?: string;
      error?: string;
    }
  | { t: 'child-enter'; name: string; argsHash: string }
  | { t: 'child-exit'; name: string };

export class JournalWriter {
  constructor(private readonly file: string) {}

  append(record: JournalRecord): void {
    appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8');
  }
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
