/**
 * Symlink-safe writes for runner-owned artifacts. The run store lives under the
 * worker-writable workspace by default, so a malicious/injected worker could
 * pre-plant a symlink at prompt.md/result.json/etc. and redirect a later
 * (unsandboxed) runner write outside the workspace. Removing any existing entry
 * first (unlink does not follow) + O_NOFOLLOW (ELOOP on a symlink leaf) closes
 * the follow. Directory-component symlinks are out of scope (would need openat).
 */
import { closeSync, constants, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW;

/** Open a fresh regular file for writing, refusing to follow a symlink leaf. */
export function openWriteFdNoFollow(path: string): number {
  rmSync(path, { force: true });
  return openSync(path, WRITE_FLAGS, 0o600);
}

/** Open a file for appending (creating it if absent), refusing to follow a
 *  symlink leaf. Unlike the write variant it does NOT unlink first — appends
 *  must preserve existing content (e.g. the append-only journal). */
export function openAppendFdNoFollow(path: string): number {
  return openSync(path, APPEND_FLAGS, 0o600);
}

export function writeFileNoFollow(path: string, data: string): void {
  const fd = openWriteFdNoFollow(path);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Atomically replace a regular file through a symlink-safe same-dir temp. */
export function writeFileAtomicNoFollow(path: string, data: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileNoFollow(tmp, data);
  try {
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
