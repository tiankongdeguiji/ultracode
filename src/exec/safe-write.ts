/**
 * Symlink-safe writes for runner-owned artifacts. The run store lives under the
 * worker-writable workspace by default, so a malicious/injected worker could
 * pre-plant a symlink at prompt.md/result.json/etc. and redirect a later
 * (unsandboxed) runner write outside the workspace. Removing any existing entry
 * first (unlink does not follow) + O_NOFOLLOW (ELOOP on a symlink leaf) closes
 * the follow. Directory-component symlinks are out of scope (would need openat).
 */
import { closeSync, constants, openSync, rmSync, writeSync } from 'node:fs';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW;

/** Open a fresh regular file for writing, refusing to follow a symlink leaf. */
export function openWriteFdNoFollow(path: string): number {
  rmSync(path, { force: true });
  return openSync(path, WRITE_FLAGS, 0o600);
}

export function writeFileNoFollow(path: string, data: string): void {
  const fd = openWriteFdNoFollow(path);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}
