/**
 * ultracode sync: maintain stamped copies of canonical workflows
 * (.ultracode/workflows/*.js) in the host engines' registries
 * (.claude/workflows/, .qoder/workflows/). Copies carry a content-hash
 * stamp; hand-edited copies are never clobbered (use --adopt to reclaim,
 * then sync again).
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { writeFileNoFollow } from '../exec/safe-write.js';

/** True if the path exists and is a symlink (repo-controlled symlinks are a
 *  read-exfil / write-redirect vector in the sync/adopt paths). */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const STAMP_RE = /^\/\/ ultracode:sync sha256=([0-9a-f]{64}) src=(\S+).*\n/;

export const HOST_WORKFLOW_DIRS = ['.claude/workflows', '.qoder/workflows'];

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function stampedCopy(canonicalRel: string, content: string): string {
  return `// ultracode:sync sha256=${sha(content)} src=${canonicalRel} — edit the source and rerun \`ultracode sync\`\n${content}`;
}

export interface SyncEntry {
  file: string;
  target: string;
  state: 'created' | 'updated' | 'current' | 'hand-edited' | 'foreign';
}

export function syncProject(projectRoot: string, opts: { write: boolean }): SyncEntry[] {
  const canonicalDir = join(projectRoot, '.ultracode/workflows');
  const entries: SyncEntry[] = [];
  if (!existsSync(canonicalDir)) return entries;

  for (const file of readdirSync(canonicalDir).filter((f) => f.endsWith('.js'))) {
    const canonical = join(canonicalDir, file);
    // A symlinked canonical entry would copy an arbitrary user file into the host
    // registries — refuse to follow it.
    if (isSymlink(canonical)) continue;
    const rel = join('.ultracode/workflows', file);
    const content = readFileSync(canonical, 'utf8');
    const expected = stampedCopy(rel, content);

    for (const hostDir of HOST_WORKFLOW_DIRS) {
      const target = join(projectRoot, hostDir, file);
      let state: SyncEntry['state'];
      if (isSymlink(target)) {
        // Never read through or write over a symlink at the host path — a
        // dangling/outside-pointing link would exfiltrate or overwrite elsewhere.
        state = 'foreign';
      } else if (!existsSync(target)) {
        state = 'created';
      } else {
        const existing = readFileSync(target, 'utf8');
        if (existing === expected) {
          state = 'current';
        } else {
          const stamp = existing.match(STAMP_RE);
          if (!stamp) {
            state = 'foreign'; // not ours — never touch
          } else if (stamp[1] === sha(existing.replace(STAMP_RE, ''))) {
            state = 'updated'; // clean stale copy → safe to refresh
          } else {
            state = 'hand-edited'; // stamped but body diverged → protect
          }
        }
      }
      if (opts.write && (state === 'created' || state === 'updated')) {
        mkdirSync(join(projectRoot, hostDir), { recursive: true });
        writeFileNoFollow(target, expected);
      }
      entries.push({ file, target, state });
    }
  }
  return entries;
}

/** Reclaim a host copy back into the canonical dir (stamp stripped). */
export function adoptCopy(projectRoot: string, hostFile: string): string {
  const content = readFileSync(hostFile, 'utf8').replace(STAMP_RE, '');
  const canonicalDir = join(projectRoot, '.ultracode/workflows');
  mkdirSync(canonicalDir, { recursive: true });
  const dest = join(canonicalDir, basename(hostFile));
  writeFileNoFollow(dest, content); // refuse a symlink planted at dest
  return dest;
}

export function syncCommand(opts: { check?: boolean; adopt?: string }): number {
  const root = process.cwd();
  if (opts.adopt) {
    const dest = adoptCopy(root, opts.adopt);
    process.stdout.write(`adopted → ${dest}\nrun \`ultracode sync\` to restamp host copies\n`);
    return 0;
  }
  const entries = syncProject(root, { write: !opts.check });
  if (entries.length === 0) {
    process.stdout.write('no canonical workflows under .ultracode/workflows/\n');
    return 0;
  }
  let drift = false;
  for (const e of entries) {
    const mark =
      e.state === 'current' ? '·' : e.state === 'hand-edited' || e.state === 'foreign' ? '⚠' : '✓';
    if (e.state !== 'current') drift = e.state === 'hand-edited' || e.state === 'foreign' || opts.check ? true : drift;
    process.stdout.write(`${mark} ${e.state.padEnd(11)} ${e.target}\n`);
    if (e.state === 'hand-edited') {
      process.stdout.write(`    → reclaim with: ultracode sync --adopt ${e.target}\n`);
    }
  }
  return opts.check && drift ? 1 : 0;
}
