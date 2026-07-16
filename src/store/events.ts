/**
 * events.jsonl: append-only progress stream, separate from the journal so
 * cache logic stays pure. Single writer (the runner); readers tail by byte
 * offset — the substrate for `status --watch`, `logs --follow`, and the MCP
 * long-poll cursor.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, writeSync } from 'node:fs';

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

/** Standard page size for tailing readers: bounds one read so a late attach to
 *  a large backlog pages instead of allocating the whole remainder at once. */
export const EVENT_PAGE_BYTES = 4 * 1024 * 1024;

export interface EventPage {
  events: TimestampedEvent[];
  nextOffset: number;
  /** more complete lines remain past nextOffset (only when maxBytes clipped the read) */
  hasMore?: boolean;
}

/**
 * Read complete JSONL lines from a byte offset; incomplete tail lines are left
 * for the next read. maxBytes bounds one read so a late attach to a large
 * backlog pages instead of allocating the whole remainder at once.
 */
export function readEventsFrom(file: string, offset: number, maxBytes?: number): EventPage {
  // The run dir is worker-writable: O_NOFOLLOW rejects a swapped-in symlink
  // and O_NONBLOCK keeps a swapped-in FIFO from blocking the open(2) forever —
  // a blocked reader loop cannot even service Ctrl-C (raw-mode input and JS
  // signal handlers both need the event loop). fstat on the fd gates the rest.
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return { events: [], nextOffset: offset }; // absent (or refused) — nothing to read yet
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { events: [], nextOffset: offset };
    const size = stat.size;
    if (size <= offset) return { events: [], nextOffset: offset };
    let window = maxBytes !== undefined ? Math.min(size - offset, maxBytes) : size - offset;
    let text: string;
    for (;;) {
      const buf = Buffer.alloc(window);
      readSync(fd, buf, 0, window, offset);
      text = buf.toString('utf8');
      // A single line larger than the window must not stall the tail forever
      // (no newline → no offset progress): grow the window until a newline
      // lands or EOF — a genuinely torn tail then waits for the writer.
      if (text.lastIndexOf('\n') !== -1 || offset + window >= size) break;
      window = Math.min(size - offset, window * 2);
    }
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return { events: [], nextOffset: offset, hasMore: false };
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
    // Clip condition only (against the FINAL window — growth may have widened
    // it past maxBytes): a torn trailing line at EOF is NOT more data.
    return { events, nextOffset: offset + consumed, hasMore: offset + window < size };
  } finally {
    closeSync(fd);
  }
}
