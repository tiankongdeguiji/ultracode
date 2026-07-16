import { describe, it, expect } from 'vitest';
import { LiveRegion, type RegionStream } from '../../src/cli/live-region.js';

function fakeStream(): RegionStream & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    columns: 80,
    rows: 24,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
}

describe('LiveRegion', () => {
  it('first update erases below without cursor-up; narrator lines land before the frame in ONE write', () => {
    const s = fakeStream();
    const r = new LiveRegion(s);
    r.update(['· hello'], 'line1\nline2');
    expect(s.chunks).toEqual(['\x1b[0J· hello\nline1\nline2\n']);
  });

  it('subsequent updates cursor-up by the previous frame height, tracking shrink and growth', () => {
    const s = fakeStream();
    const r = new LiveRegion(s);
    r.update([], 'a\nb\nc');
    r.update([], 'x'); // shrink: previous frame was 3 lines
    r.update([], 'y\nz'); // grow: previous frame was 1 line
    expect(s.chunks[1]).toBe('\x1b[3A\r\x1b[0Jx\n');
    expect(s.chunks[2]).toBe('\x1b[1A\r\x1b[0Jy\nz\n');
  });

  it('open hides the cursor once; close paints the final frame then restores it', () => {
    const s = fakeStream();
    const r = new LiveRegion(s);
    r.open();
    r.open(); // idempotent
    r.update([], 'work');
    r.close(['· done'], 'final');
    expect(s.chunks).toEqual([
      '\x1b[?25l',
      '\x1b[0Jwork\n',
      '\x1b[1A\r\x1b[0J· done\nfinal\n',
      '\x1b[?25h',
    ]);
    expect(process.listeners('exit').includes((r as unknown as { restoreCursor: () => void }).restoreCursor)).toBe(false);
  });

  it('reset abandons the painted region: the next update paints below without cursor-up', () => {
    const s = fakeStream();
    const r = new LiveRegion(s);
    r.update([], 'a\nb');
    r.reset(); // e.g. terminal resize rewrapped the old frame
    r.update([], 'c');
    expect(s.chunks[1]).toBe('\x1b[0Jc\n');
  });

  it('every repaint is exactly one write call', () => {
    const s = fakeStream();
    const r = new LiveRegion(s);
    r.update(['· a', '· b'], 'f1\nf2\nf3');
    r.update([], 'f1');
    expect(s.chunks).toHaveLength(2);
  });
});
