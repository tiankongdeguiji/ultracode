/** Incremental, lenient JSONL parsing for long Codex rollout and journal files. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const READ_CHUNK_BYTES = 64 * 1_024;
export const DEFAULT_MAX_JSONL_LINE_BYTES = 16 * 1_024 * 1_024;
export const DEFAULT_MAX_JSONL_FILE_BYTES = 16 * 1_024 * 1_024 * 1_024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface JsonLineReadStats {
  opened: boolean;
  parsedLines: number;
  malformedLines: number;
  oversizeLines: number;
  unterminatedTail: boolean;
}

/** Visit parseable JSON records from one descriptor without following the leaf. */
export function forEachJsonLine(
  file: string,
  visit: (value: unknown) => void,
  options: { maximumLineBytes?: number; maximumFileBytes?: number } = {},
): JsonLineReadStats {
  const maximumLineBytes = options.maximumLineBytes ?? DEFAULT_MAX_JSONL_LINE_BYTES;
  if (!Number.isSafeInteger(maximumLineBytes) || maximumLineBytes <= 0) {
    throw new Error('maximum JSONL line size must be a positive safe integer');
  }
  const maximumFileBytes = options.maximumFileBytes ?? DEFAULT_MAX_JSONL_FILE_BYTES;
  if (!Number.isSafeInteger(maximumFileBytes) || maximumFileBytes <= 0) {
    throw new Error('maximum JSONL file size must be a positive safe integer');
  }
  const stats: JsonLineReadStats = {
    opened: false,
    parsedLines: 0,
    malformedLines: 0,
    oversizeLines: 0,
    unterminatedTail: false,
  };
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return stats;
  }
  stats.opened = true;
  const opened = fstatSync(fd);
  if (!opened.isFile() || opened.nlink !== 1) {
    closeSync(fd);
    throw new Error(`JSONL input must be a singly linked regular file: ${file}`);
  }
  if (!Number.isSafeInteger(opened.size) || opened.size > maximumFileBytes) {
    closeSync(fd);
    throw new Error(`JSONL input exceeds the maximum file size: ${file}`);
  }
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let discardingOversize = false;
  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      visit(JSON.parse(trimmed));
      stats.parsedLines += 1;
    } catch {
      stats.malformedLines += 1;
    }
  };
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      pending += decoder.write(buffer.subarray(0, bytes));
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        if (discardingOversize || Buffer.byteLength(line, 'utf8') > maximumLineBytes) {
          stats.oversizeLines += 1;
        } else {
          consume(line);
        }
        pending = pending.slice(newline + 1);
        discardingOversize = false;
        newline = pending.indexOf('\n');
      }
      if (Buffer.byteLength(pending, 'utf8') > maximumLineBytes) {
        pending = '';
        discardingOversize = true;
      }
    }
    pending += decoder.end();
    if (pending.length > 0 || discardingOversize) {
      stats.unterminatedTail = true;
      if (!discardingOversize) consume(pending.replace(/\r$/, ''));
      else stats.oversizeLines += 1;
    }
    const completed = fstatSync(fd);
    if (completed.dev !== opened.dev || completed.ino !== opened.ino
      || completed.size !== opened.size || completed.mtimeMs !== opened.mtimeMs
      || completed.ctimeMs !== opened.ctimeMs || completed.nlink !== 1) {
      throw new Error(`JSONL input changed while it was being read: ${file}`);
    }
  } finally {
    closeSync(fd);
  }
  return stats;
}
