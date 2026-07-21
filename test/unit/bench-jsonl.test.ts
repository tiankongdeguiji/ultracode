/** Streaming JSONL behavior shared by rollout and suite-native readers. */
import { linkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { forEachJsonLine } from '../../bench/src/shared/jsonl.js';

describe('shared JSONL reader', () => {
  it('handles CRLF, malformed lines, a parseable tail, and missing files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'uc-jsonl-'));
    const file = join(directory, 'rows.jsonl');
    writeFileSync(file, '{"one":1}\r\nnot-json\n{"tail":true}');
    const rows: unknown[] = [];
    const stats = forEachJsonLine(file, (row) => rows.push(row));
    expect(rows).toEqual([{ one: 1 }, { tail: true }]);
    expect(stats).toMatchObject({
      opened: true,
      parsedLines: 2,
      malformedLines: 1,
      oversizeLines: 0,
      unterminatedTail: true,
    });
    expect(forEachJsonLine(join(directory, 'missing'), () => undefined).opened).toBe(false);
  });

  it('discards an oversize record and resumes at the next newline', () => {
    const directory = mkdtempSync(join(tmpdir(), 'uc-jsonl-oversize-'));
    const file = join(directory, 'rows.jsonl');
    writeFileSync(file, `${'x'.repeat(128)}\n{"ok":true}\n`);
    const rows: unknown[] = [];
    const stats = forEachJsonLine(file, (row) => rows.push(row), { maximumLineBytes: 16 });
    expect(rows).toEqual([{ ok: true }]);
    expect(stats.oversizeLines).toBe(1);
  });

  it('propagates visitor failures instead of classifying them as malformed JSON', () => {
    const directory = mkdtempSync(join(tmpdir(), 'uc-jsonl-visitor-'));
    const file = join(directory, 'rows.jsonl');
    writeFileSync(file, '{"ok":true}\n');
    const failure = new Error('visitor failed');
    expect(() => forEachJsonLine(file, () => { throw failure; })).toThrow(failure);
  });

  it('parses a near-limit record across many read chunks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'uc-jsonl-chunks-'));
    const file = join(directory, 'rows.jsonl');
    const value = 'x'.repeat(512 * 1_024);
    writeFileSync(file, `${JSON.stringify({ value })}\n`);
    const rows: unknown[] = [];
    const stats = forEachJsonLine(file, (row) => rows.push(row), {
      maximumLineBytes: 1 * 1_024 * 1_024,
    });
    expect(rows).toEqual([{ value }]);
    expect(stats).toMatchObject({ parsedLines: 1, malformedLines: 0, oversizeLines: 0 });
  });

  it('rejects multiply linked and oversized inputs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'uc-jsonl-boundary-'));
    const file = join(directory, 'rows.jsonl');
    writeFileSync(file, '{"ok":true}\n');
    linkSync(file, join(directory, 'alias.jsonl'));
    expect(() => forEachJsonLine(file, () => undefined)).toThrow(/singly linked regular file/);

    const other = join(directory, 'oversized.jsonl');
    writeFileSync(other, '{"ok":true}\n');
    expect(() => forEachJsonLine(other, () => undefined, { maximumFileBytes: 4 })).toThrow(/maximum file size/);
  });
});
