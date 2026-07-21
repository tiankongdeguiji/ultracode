/** Incremental, lenient JSONL parsing for long Codex rollout and journal files. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

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
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discardingOversize = false;
  const consume = (line: Buffer): void => {
    const content = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    const trimmed = content.toString('utf8').trim();
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
      let offset = 0;
      while (offset < bytes) {
        const newline = buffer.indexOf(0x0a, offset);
        const end = newline < 0 || newline >= bytes ? bytes : newline;
        const length = end - offset;
        if (!discardingOversize && pendingBytes + length > maximumLineBytes) {
          pending = [];
          pendingBytes = 0;
          discardingOversize = true;
        } else if (!discardingOversize && length > 0) {
          pending.push(Buffer.from(buffer.subarray(offset, end)));
          pendingBytes += length;
        }
        if (newline < 0 || newline >= bytes) break;
        if (discardingOversize) {
          stats.oversizeLines += 1;
        } else {
          consume(pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes));
        }
        pending = [];
        pendingBytes = 0;
        discardingOversize = false;
        offset = newline + 1;
      }
    }
    if (pendingBytes > 0 || discardingOversize) {
      stats.unterminatedTail = true;
      if (!discardingOversize) {
        consume(pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes));
      }
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
