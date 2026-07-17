import { describe, it, expect, vi, afterEach } from 'vitest';
import { readCountOpt, readMaxConcurrencyOpt } from '../../src/cli/options.js';

function captureStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

describe('readCountOpt', () => {
  it('absent → ok with no value (and writes nothing)', () => {
    const err = captureStderr();
    expect(readCountOpt(undefined)).toEqual({ ok: true });
    err.restore();
    expect(err.chunks).toEqual([]);
  });

  it('a positive integer → ok with the parsed value', () => {
    expect(readCountOpt('3')).toEqual({ ok: true, value: 3 });
  });

  // Each raw exercises a distinct isPositiveInt branch: NaN, zero (the slice(-0)
  // boundary), negative, and fractional (Number.isInteger).
  it.each(['abc', '0', '-1', '2.5'])('rejects %s with the canonical error and no value', (raw) => {
    const err = captureStderr();
    const res = readCountOpt(raw);
    err.restore();
    expect(res).toEqual({ ok: false });
    expect(err.chunks.join('')).toBe('ultracode: --count must be a positive integer\n');
  });
});

describe('readMaxConcurrencyOpt (shares the same guard, distinct flag)', () => {
  it('absent → ok; valid → value; invalid → its own canonical error', () => {
    expect(readMaxConcurrencyOpt(undefined)).toEqual({ ok: true });
    expect(readMaxConcurrencyOpt('4')).toEqual({ ok: true, value: 4 });
    const err = captureStderr();
    expect(readMaxConcurrencyOpt('0')).toEqual({ ok: false });
    err.restore();
    expect(err.chunks.join('')).toBe('ultracode: --max-concurrency must be a positive integer\n');
  });
});
