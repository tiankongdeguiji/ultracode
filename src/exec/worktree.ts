/**
 * Git worktree isolation for agents that mutate files in parallel
 * (isolation: 'worktree'). Each gets a fresh worktree branched from the
 * current HEAD; on completion it is removed if clean, kept (path reported)
 * if the agent left changes to merge.
 *
 * EXPENSIVE (~200-500ms + disk per agent) — the engine only creates one
 * when a call explicitly asks.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export interface Worktree {
  path: string;
  branch: string;
  /** Remove if clean; if the agent left changes, keep it and return its path. */
  finalize(): Promise<{ removed: boolean; path: string; dirty: boolean }>;
}

export interface WorktreeManager {
  create(runId: string, seq: number, label: string): Promise<Worktree>;
}

export function createWorktreeManager(repoRoot: string, worktreesRoot: string): WorktreeManager {
  return {
    async create(runId: string, seq: number, _label: string): Promise<Worktree> {
      const dir = join(worktreesRoot, runId, String(seq));
      const branch = `ultracode/${runId}/${seq}`;
      const base = (await git(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();
      const add = await git(repoRoot, ['worktree', 'add', '--quiet', '-b', branch, dir, 'HEAD']);
      if (add.code !== 0) {
        throw new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
      }
      return {
        path: dir,
        branch,
        async finalize() {
          const status = await git(dir, ['status', '--porcelain']);
          const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
          // "Changed" = uncommitted work OR the branch advanced past its base.
          // A prior version only checked porcelain, so an agent that COMMITTED
          // its work left a clean tree → the worktree+branch were force-deleted,
          // dropping the only ref to the committed changes.
          const changed = status.stdout.trim().length > 0 || (head !== '' && head !== base);
          if (changed) {
            // Keep the worktree + branch for the caller to inspect/merge.
            return { removed: false, path: dir, dirty: true };
          }
          await git(repoRoot, ['worktree', 'remove', '--force', dir]);
          await git(repoRoot, ['branch', '-D', branch]);
          return { removed: true, path: dir, dirty: false };
        },
      };
    },
  };
}

export function worktreesRootFor(runDir: string): string {
  // Sibling of the run dir's agents/, under the run: .ultracode/runs/<id>/worktrees
  return join(runDir, 'worktrees');
}

export function repoRootSync(startCwd: string): string | null {
  // Cheap check without spawning: walk up for a .git dir/file.
  let dir = startCwd;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
