/**
 * Keyboard input for the interactive panel: a pure byte→key parser plus a thin
 * raw-mode wrapper over a stdin-shaped stream. The parser is stateless and
 * timer-free — TTYs deliver an escape sequence in one data chunk in practice,
 * so a lone ESC at the end of a chunk is treated as the esc key (a sequence
 * split across chunks degrades to a harmless esc). Raw mode suppresses
 * terminal signal generation: Ctrl-C arrives as byte 0x03 and MUST be routed
 * to the caller's SIGINT semantics, which is why ctrl keys are first-class.
 */

export type Key =
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'enter' }
  | { type: 'esc' }
  /** printable ASCII, e.g. 'j', 'k', 'q' */
  | { type: 'char'; ch: string }
  | { type: 'ctrl-c' }
  | { type: 'ctrl-d' }
  | { type: 'ctrl-z' };

/** Structural subset of process.stdin — fakeable with an EventEmitter in tests. */
export interface KeyInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface KeyAttachment {
  /** false when the input is not a raw-mode-capable TTY — zero side effects then */
  interactive: boolean;
  /** idempotent: restores cooked mode, pauses the stream, disarms the exit backstop */
  detach(): void;
}

const ESC = '\x1b';

/**
 * One input chunk → zero or more keys. Unknown CSI sequences (mouse reports,
 * pasted junk) are consumed whole and dropped so they never leak through as
 * char keys; ESC followed by a non-sequence byte swallows that byte too
 * (alt+letter chords must not act as bare letters).
 */
export function parseKeys(chunk: Buffer | string): Key[] {
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const keys: Key[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ESC) {
      const next = s[i + 1];
      if (next === undefined) {
        keys.push({ type: 'esc' });
        i++;
      } else if (next === '[') {
        // CSI: params 0x30-0x3f, intermediates 0x20-0x2f, final 0x40-0x7e.
        let j = i + 2;
        while (j < s.length && (s.charCodeAt(j) < 0x40 || s.charCodeAt(j) > 0x7e)) j++;
        if (j < s.length) {
          if (s[j] === 'A') keys.push({ type: 'up' });
          else if (s[j] === 'B') keys.push({ type: 'down' });
          i = j + 1;
        } else {
          i = s.length; // partial CSI at chunk end — drop it
        }
      } else if (next === 'O') {
        // SS3 (application cursor mode)
        if (s[i + 2] === 'A') keys.push({ type: 'up' });
        else if (s[i + 2] === 'B') keys.push({ type: 'down' });
        i += 3;
      } else if (next === ESC) {
        keys.push({ type: 'esc' });
        i++; // the second ESC may open a real sequence — reparse it
      } else {
        keys.push({ type: 'esc' });
        i += 2; // swallow the alt-chorded byte
      }
      continue;
    }
    if (c === '\r' || c === '\n') keys.push({ type: 'enter' });
    else if (c === '\x03') keys.push({ type: 'ctrl-c' });
    else if (c === '\x04') keys.push({ type: 'ctrl-d' });
    else if (c === '\x1a') keys.push({ type: 'ctrl-z' });
    else {
      const code = s.charCodeAt(i);
      if (code >= 0x20 && code <= 0x7e) keys.push({ type: 'char', ch: c });
    }
    i++;
  }
  return keys;
}

/**
 * Enable raw mode on `input` and dispatch parsed keys to `onKey`. Returns a
 * no-op attachment ({ interactive: false }) when the input cannot do raw mode
 * (pipe, CI, /dev/null) — callers branch interactivity on this flag. A
 * process-exit backstop restores cooked mode even when a handler calls
 * process.exit() directly (mirrors LiveRegion's cursor restore).
 */
export function attachKeys(input: KeyInput, onKey: (key: Key) => void): KeyAttachment {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return { interactive: false, detach: () => {} };
  }
  const onData = (chunk: Buffer | string): void => {
    for (const key of parseKeys(chunk)) onKey(key);
  };
  const restoreRaw = (): void => {
    try {
      input.setRawMode?.(false);
    } catch {
      /* stream already destroyed */
    }
  };
  input.setRawMode(true);
  input.resume?.();
  input.on('data', onData);
  process.on('exit', restoreRaw);
  let detached = false;
  return {
    interactive: true,
    detach: (): void => {
      if (detached) return;
      detached = true;
      input.removeListener('data', onData);
      restoreRaw();
      // A resumed stdin holds the event loop open — the process would never
      // exit naturally after the run completes without this.
      input.pause?.();
      process.removeListener('exit', restoreRaw);
    },
  };
}
