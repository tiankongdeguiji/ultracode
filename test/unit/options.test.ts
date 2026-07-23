import { describe, it, expect, vi, afterEach } from 'vitest';
import { readContextWindowOpt, readCountOpt, readMaxConcurrencyOpt, readNonEmptyOpt } from '../../src/cli/options.js';

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

describe('subagent CLI option guards', () => {
  it('validates and parses context-window', () => {
    expect(readContextWindowOpt(undefined)).toEqual({ ok: true });
    expect(readContextWindowOpt('200000')).toEqual({ ok: true, value: 200_000 });
    const err = captureStderr();
    expect(readContextWindowOpt('1.5')).toEqual({ ok: false });
    err.restore();
    expect(err.chunks.join('')).toBe('ultracode: --context-window must be a positive integer\n');
  });

  it('trims model/effort and rejects empty values', () => {
    expect(readNonEmptyOpt(' model ', '--model')).toEqual({ ok: true, value: 'model' });
    expect(readNonEmptyOpt(' high ', '--effort')).toEqual({ ok: true, value: 'high' });
    const err = captureStderr();
    expect(readNonEmptyOpt('  ', '--effort')).toEqual({ ok: false });
    err.restore();
    expect(err.chunks.join('')).toBe('ultracode: --effort must be a non-empty string\n');
  });
});
