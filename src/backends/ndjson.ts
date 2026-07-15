/**
 * Incremental NDJSON splitter: handles partial lines across chunk
 * boundaries and tolerates non-JSON noise lines (returned as raw strings
 * for the caller to log, never thrown).
 */
/** Bound the in-memory line buffer so a newline-less stream (a giant single
 *  `structured_output`, an echoed multi-MB tool result, or a hung/adversarial
 *  worker) can't grow it without limit and OOM the long-lived detached runner. */
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;

export class NdjsonSplitter {
  private buffer = '';

  constructor(private readonly maxLineBytes = DEFAULT_MAX_LINE_BYTES) {}

  /** Feed a chunk; returns complete lines (without newline). */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    // Scan with a moving offset and slice the buffer ONCE at the end, rather
    // than re-slicing the whole (possibly large) buffer on every newline — the
    // latter is O(n²) on bursty multi-line chunks.
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf('\n', start);
      if (nl === -1) break;
      const line = this.buffer.slice(start, nl).replace(/\r$/, '');
      start = nl + 1;
      if (line.trim().length > 0) lines.push(line);
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    // No newline in sight and the pending line already exceeds the cap → drop it
    // (surfacing a short raw notice, logged as noise) rather than buffering more.
    if (this.buffer.length > this.maxLineBytes) {
      this.buffer = '';
      lines.push(`[ultracode] dropped a ${this.maxLineBytes}+ byte line with no newline`);
    }
    return lines;
  }

  /** Flush any trailing unterminated line at EOF. */
  end(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? [rest] : [];
  }
}

export function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
