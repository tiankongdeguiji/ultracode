/**
 * events.jsonl: append-only progress stream, separate from the journal so
 * cache logic stays pure. Single writer (the runner); readers tail by byte
 * offset — the substrate for `status --watch`, `logs --follow`, and the MCP
 * long-poll cursor.
 */
import { closeSync, existsSync, openSync, readSync, statSync, writeSync } from 'node:fs';

export interface TimestampedEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

export class EventWriter {
  private readonly fd: number;

  constructor(file: string) {
    this.fd = openSync(file, 'a');
  }

  write<T extends { type: string }>(event: T): void {
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    writeSync(this.fd, line);
  }

  close(): void {
    try {
      closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

export interface EventPage {
  events: TimestampedEvent[];
  nextOffset: number;
}

/** Read complete JSONL lines from a byte offset; incomplete tail lines are left for the next read. */
export function readEventsFrom(file: string, offset: number): EventPage {
  if (!existsSync(file)) return { events: [], nextOffset: offset };
  const size = statSync(file).size;
  if (size <= offset) return { events: [], nextOffset: offset };

  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return { events: [], nextOffset: offset };
    const complete = text.slice(0, lastNewline);
    const consumed = Buffer.byteLength(complete, 'utf8') + 1;
    const events: TimestampedEvent[] = [];
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TimestampedEvent);
      } catch {
        /* torn line — skip */
      }
    }
    return { events, nextOffset: offset + consumed };
  } finally {
    closeSync(fd);
  }
}
