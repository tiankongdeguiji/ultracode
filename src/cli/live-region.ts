/**
 * LiveRegion: inline bottom-anchored repaint over a terminal stream. Narrator
 * lines print permanently into scrollback ABOVE the frame, which is repainted
 * in place (cursor-up + erase-below). Deliberately not alt-screen: the run's
 * story and final frame must survive in scrollback, and tmux/CI capture stays
 * sane. Knows nothing about workflows — it moves lines, nothing more.
 */

/** Structural subset of tty.WriteStream — fakeable in tests. */
export interface RegionStream {
  write(chunk: string): boolean;
  columns?: number;
  rows?: number;
}

export class LiveRegion {
  private renderedLines = 0;
  private opened = false;

  constructor(private readonly stream: RegionStream) {}

  private readonly restoreCursor = (): void => {
    try {
      this.stream.write('\x1b[?25h');
    } catch {
      /* stream already gone at exit */
    }
  };

  /** Hide the cursor and arm an exit hook so a hard exit never leaves it hidden. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.stream.write('\x1b[?25l');
    process.on('exit', this.restoreCursor);
  }

  /**
   * One buffered write per repaint (the flicker defense): cursor to the top of
   * the previous frame, erase to end of screen, print the permanent lines,
   * then the new frame. Callers must pre-truncate every line to the terminal
   * width — a soft-wrapped line breaks the cursor-up count.
   */
  update(aboveLines: string[], frame: string): void {
    let buf = '';
    if (this.renderedLines > 0) buf += `\x1b[${this.renderedLines}A\r`;
    buf += '\x1b[0J';
    for (const line of aboveLines) buf += line + '\n';
    buf += frame + '\n';
    this.renderedLines = frame.split('\n').length;
    this.stream.write(buf);
  }

  /**
   * Forget the painted region without erasing it. Used on terminal resize:
   * the terminal rewraps already-painted lines, silently invalidating the
   * cursor-up count — abandoning the old frame (it stays in scrollback) and
   * painting fresh below beats corrupting the display.
   */
  reset(): void {
    this.renderedLines = 0;
  }

  /** Final paint (stays in scrollback), then restore the cursor and disarm the exit hook. */
  close(aboveLines: string[], finalFrame: string): void {
    this.update(aboveLines, finalFrame);
    this.renderedLines = 0; // the final frame is scrollback now — never repaint over it
    if (this.opened) {
      this.opened = false;
      this.stream.write('\x1b[?25h');
      process.removeListener('exit', this.restoreCursor);
    }
  }
}
