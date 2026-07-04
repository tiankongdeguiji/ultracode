/**
 * Worktree isolation over a real temporary git repo. Exercises the manager
 * directly and the full agent path via a fake mutating executor.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktreeManager, isGitRepo, repoRootSync } from '../../src/exec/worktree.js';
import { executeWorkflow } from '../../src/engine/run.js';
import type { AgentExecutor, AgentOutcome, AgentSpec } from '../../src/backends/types.js';
import { finalizeUsage } from '../../src/backends/usage.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uc-wt-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@test']);
  git(dir, ['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/** Executor that writes a file into the agent's cwd when the prompt says WRITE. */
class MutatingExecutor implements AgentExecutor {
  seenCwds: string[] = [];
  async execute(spec: AgentSpec): Promise<AgentOutcome> {
    this.seenCwds.push(spec.cwd);
    if (spec.prompt.startsWith('WRITE')) {
      writeFileSync(join(spec.cwd, `${spec.label}.txt`), spec.prompt);
    }
    return { ok: true, value: spec.label, usage: finalizeUsage({ outputTokens: 1 }), toolCalls: 0, attempts: 1 };
  }
}

describe('worktree manager', () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });

  it('detects the repo root and git status', async () => {
    expect(await isGitRepo(repo)).toBe(true);
    expect(repoRootSync(repo)).toBe(repo);
  });

  it('creates an isolated worktree, removes it when clean', async () => {
    const mgr = createWorktreeManager(repo, join(repo, '.ultracode/worktrees'));
    const wt = await mgr.create('wf_test', 0, 'clean');
    expect(existsSync(join(wt.path, 'seed.txt'))).toBe(true); // branched from HEAD
    const fin = await wt.finalize();
    expect(fin.removed).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
  });

  it('keeps the worktree when the agent left changes', async () => {
    const mgr = createWorktreeManager(repo, join(repo, '.ultracode/worktrees'));
    const wt = await mgr.create('wf_test', 1, 'dirty');
    writeFileSync(join(wt.path, 'new.txt'), 'agent output\n');
    const fin = await wt.finalize();
    expect(fin.removed).toBe(false);
    expect(fin.dirty).toBe(true);
    expect(existsSync(join(fin.path, 'new.txt'))).toBe(true);
  });
});

describe('isolation:worktree through the engine', () => {
  it('parallel mutating agents each get their own worktree (no cwd collision)', async () => {
    const repo = makeRepo();
    const mgr = createWorktreeManager(repo, join(repo, '.ultracode/worktrees'));
    const executor = new MutatingExecutor();

    const src = `export const meta = { name: 'uc-mutate', description: 'd' }
const r = await parallel(
  Array.from({ length: 3 }, (_, i) => () => agent('WRITE change ' + i, { label: 'edit' + i, isolation: 'worktree' })),
)
return r`;

    const out = await executeWorkflow(src, {
      executor,
      maxConcurrency: 3,
      cwd: repo,
      shared: { semaphore: new (await import('../../src/engine/semaphore.js')).Semaphore(3), counter: { count: 0 }, worktrees: mgr, runId: 'wf_iso' },
    });

    expect(out.error).toBeUndefined();
    expect(out.result).toEqual(['edit0', 'edit1', 'edit2']);
    // Each agent ran in a distinct worktree directory, none the repo root.
    expect(new Set(executor.seenCwds).size).toBe(3);
    for (const cwd of executor.seenCwds) expect(cwd).not.toBe(repo);
    // All three left changes → three kept worktrees reported.
    expect(out.workspaces).toHaveLength(3);
    // The repo root itself was never mutated.
    expect(readdirSync(repo).filter((f) => f.endsWith('.txt'))).toEqual(['seed.txt']);
  }, 30_000);
});
