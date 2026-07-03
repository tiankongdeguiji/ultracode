/**
 * Incremental NDJSON splitter: handles partial lines across chunk
 * boundaries and tolerates non-JSON noise lines (returned as raw strings
 * for the caller to log, never thrown).
 */
export class NdjsonSplitter {
  private buffer = '';

  /** Feed a chunk; returns complete lines (without newline). */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim().length > 0) lines.push(line);
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
