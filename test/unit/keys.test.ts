import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { attachKeys, parseKeys, type Key, type KeyInput } from '../../src/cli/keys.js';

const types = (chunk: Buffer | string): string[] => parseKeys(chunk).map((k) => k.type);

describe('parseKeys', () => {
  it('parses CSI and SS3 arrows', () => {
    expect(parseKeys('\x1b[A')).toEqual([{ type: 'up' }]);
    expect(parseKeys('\x1b[B')).toEqual([{ type: 'down' }]);
    expect(parseKeys('\x1bOA')).toEqual([{ type: 'up' }]);
    expect(parseKeys('\x1bOB')).toEqual([{ type: 'down' }]);
  });

  it('enter on CR and LF; ctrl bytes are first-class', () => {
    expect(types('\r')).toEqual(['enter']);
    expect(types('\n')).toEqual(['enter']);
    expect(parseKeys('\x03')).toEqual([{ type: 'ctrl-c' }]);
    expect(parseKeys('\x04')).toEqual([{ type: 'ctrl-d' }]);
    expect(parseKeys('\x1a')).toEqual([{ type: 'ctrl-z' }]);
  });

  it('a lone ESC at chunk end is the esc key; ESC before an ordinary byte swallows it (alt chords)', () => {
    expect(parseKeys('\x1b')).toEqual([{ type: 'esc' }]);
    expect(parseKeys('\x1bj')).toEqual([{ type: 'esc' }]); // alt+j must not scroll
    expect(parseKeys('\x1b\x1b[A')).toEqual([{ type: 'esc' }, { type: 'up' }]);
  });

  it('unknown CSI/SS3 sequences are consumed whole and never leak as chars', () => {
    expect(parseKeys('\x1b[C')).toEqual([]); // right arrow — unmapped
    expect(parseKeys('\x1b[1;5D')).toEqual([]); // ctrl-left with params
    expect(parseKeys('\x1b[<35;10;7M')).toEqual([]); // SGR mouse report
    expect(parseKeys('\x1b[200~pasted\x1b[201~')).toEqual('pasted'.split('').map((ch) => ({ type: 'char', ch })));
    expect(parseKeys('\x1b[')).toEqual([]); // partial CSI at chunk end — dropped
    expect(parseKeys('\x1bOC')).toEqual([]); // unmapped SS3 — consumed, 'C' never leaks
    expect(parseKeys('\x1bO')).toEqual([]); // split SS3 at chunk end — dropped
    expect(parseKeys('\x1bOCq')).toEqual([{ type: 'char', ch: 'q' }]); // parsing resumes after it
  });

  it('printable ASCII becomes char keys; other control bytes are ignored', () => {
    expect(parseKeys('jkq')).toEqual([
      { type: 'char', ch: 'j' },
      { type: 'char', ch: 'k' },
      { type: 'char', ch: 'q' },
    ]);
    expect(parseKeys('\x00\x07\x7f')).toEqual([]);
  });

  it('multi-key chunks keep arrival order and accept Buffers', () => {
    expect(types(Buffer.from('\x1b[Aj\r\x1b[B\x03', 'utf8'))).toEqual(['up', 'char', 'enter', 'down', 'ctrl-c']);
  });
});

interface FakeStdin extends KeyInput {
  emitter: EventEmitter;
  rawCalls: boolean[];
  resumed: number;
  paused: number;
}

function fakeStdin(overrides: Partial<KeyInput> = {}): FakeStdin {
  const emitter = new EventEmitter();
  const fake: FakeStdin = {
    emitter,
    rawCalls: [],
    resumed: 0,
    paused: 0,
    isTTY: true,
    setRawMode(mode: boolean) {
      fake.rawCalls.push(mode);
    },
    on: (ev, l) => emitter.on(ev, l),
    removeListener: (ev, l) => emitter.removeListener(ev, l),
    resume: () => fake.resumed++,
    pause: () => fake.paused++,
    ...overrides,
  };
  return fake;
}

describe('attachKeys', () => {
  it('raw mode on attach, keys dispatched, cooked + paused + idempotent on detach', () => {
    const input = fakeStdin();
    const seen: Key[] = [];
    const attachment = attachKeys(input, (k) => seen.push(k));
    expect(attachment.interactive).toBe(true);
    expect(input.rawCalls).toEqual([true]);
    expect(input.resumed).toBe(1);

    input.emitter.emit('data', Buffer.from('\x1b[Bq', 'utf8'));
    expect(seen).toEqual([{ type: 'down' }, { type: 'char', ch: 'q' }]);

    attachment.detach();
    attachment.detach(); // idempotent
    expect(input.rawCalls).toEqual([true, false]);
    expect(input.paused).toBe(1);
    input.emitter.emit('data', 'j'); // detached — no dispatch
    expect(seen).toHaveLength(2);
  });

  it('arms a process-exit backstop that restores cooked mode, and disarms it on detach', () => {
    const before = process.listenerCount('exit');
    const input = fakeStdin();
    const attachment = attachKeys(input, () => {});
    expect(process.listenerCount('exit')).toBe(before + 1);
    attachment.detach();
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('non-TTY or raw-incapable inputs are a zero-side-effect no-op', () => {
    const notTty = fakeStdin({ isTTY: false });
    expect(attachKeys(notTty, () => {}).interactive).toBe(false);
    expect(notTty.rawCalls).toEqual([]);
    expect(notTty.resumed).toBe(0);

    const noRaw = fakeStdin({ setRawMode: undefined });
    const attachment = attachKeys(noRaw, () => {});
    expect(attachment.interactive).toBe(false);
    attachment.detach(); // safe no-op
    expect(noRaw.paused).toBe(0);
  });

  it('a destroyed stream during restore never throws (detach and exit paths are try/caught)', () => {
    const input = fakeStdin();
    const attachment = attachKeys(input, () => {});
    input.setRawMode = vi.fn(() => {
      throw new Error('stream destroyed');
    });
    expect(() => attachment.detach()).not.toThrow();
  });
});
