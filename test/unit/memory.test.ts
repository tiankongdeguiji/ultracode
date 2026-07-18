import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryHookPayload, startupMemoryContext } from '../../src/memory/hook.js';
import { migrateClaudeMemory } from '../../src/memory/migrate-claude.js';
import { pathRulesContext, unconditionalRulesContext } from '../../src/memory/rules.js';
import {
  forgetTopic,
  isAutoMemoryEnabled,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_MAX_LINES,
  memoryContext,
  readMemoryTopic,
  remember,
  resolveMemoryProject,
  searchMemory,
  setAutoMemoryEnabled,
} from '../../src/memory/store.js';

function tmp(prefix = 'uc-memory-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function projectFixture(): { root: string; memoryHome: string } {
  const root = tmp('uc-memory-project-');
  const memoryHome = tmp('uc-memory-home-');
  git(root, 'init', '-q');
  writeFileSync(join(root, 'tracked.txt'), 'one\n');
  git(root, 'add', 'tracked.txt');
  git(root, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'init');
  return { root, memoryHome };
}

describe('portable memory store', () => {
  it('shares one project identity across subdirectories and git worktrees', () => {
    const { root, memoryHome } = projectFixture();
    mkdirSync(join(root, 'src', 'nested'), { recursive: true });
    const main = resolveMemoryProject({ cwd: root, memoryHome });
    const nested = resolveMemoryProject({ cwd: join(root, 'src', 'nested'), memoryHome });
    expect(nested.id).toBe(main.id);

    const worktree = tmp('uc-memory-worktree-');
    git(root, 'worktree', 'add', '-q', '-b', 'memory-test-worktree', worktree);
    const secondary = resolveMemoryProject({ cwd: worktree, memoryHome });
    expect(secondary.id).toBe(main.id);
    expect(secondary.memoryDir).toBe(main.memoryDir);
  });

  it('remembers, deduplicates, searches, reads, and forgets topic files', () => {
    const { root, memoryHome } = projectFixture();
    const options = { cwd: root, memoryHome, topic: 'Debugging Notes', summary: 'API tests need Redis.' };
    const first = remember('API tests require a local Redis instance.', options);
    const second = remember('API tests require a local Redis instance.', options);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(first.topic).toBe('debugging-notes');
    expect(readMemoryTopic('debugging-notes', { cwd: root, memoryHome }).content).toContain('local Redis');
    expect(searchMemory('redis api', { cwd: root, memoryHome })[0]?.topic).toBe('debugging-notes');

    const context = memoryContext({ cwd: root, memoryHome });
    expect(context).toContain('<ultracode-memory>');
    expect(context).toContain('[debugging-notes](debugging-notes.md): API tests need Redis.');

    expect(forgetTopic('debugging-notes', { cwd: root, memoryHome }).removed).toBe(true);
    expect(existsSync(first.topicPath)).toBe(false);
    expect(memoryContext({ cwd: root, memoryHome })).not.toContain('debugging-notes');
  });

  it('loads only the first 200 lines or 25KB of MEMORY.md', () => {
    const { root, memoryHome } = projectFixture();
    const project = resolveMemoryProject({ cwd: root, memoryHome });
    mkdirSync(project.memoryDir, { recursive: true });
    writeFileSync(
      join(project.memoryDir, 'MEMORY.md'),
      Array.from({ length: 220 }, (_, index) => `line-${index + 1}`).join('\n') + '\n',
    );
    const lineLimited = memoryContext({ cwd: root, memoryHome });
    expect(lineLimited).toContain('line-200');
    expect(lineLimited).not.toContain('line-201');

    writeFileSync(join(project.memoryDir, 'MEMORY.md'), `start\n${'x'.repeat(MEMORY_INDEX_MAX_BYTES)}\nend\n`);
    const byteLimited = memoryContext({ cwd: root, memoryHome });
    expect(Buffer.byteLength(byteLimited, 'utf8')).toBeLessThan(MEMORY_INDEX_MAX_BYTES + 1_000);
    expect(byteLimited).not.toContain('\nend\n');

    writeFileSync(
      join(project.memoryDir, 'MEMORY.md'),
      '---\nprivate: metadata\n---\n<!-- maintainer-only\ncomment -->\nvisible\n```md\n<!-- kept in fence -->\n```\n',
    );
    const filtered = memoryContext({ cwd: root, memoryHome });
    expect(filtered).not.toContain('private: metadata');
    expect(filtered).not.toContain('maintainer-only');
    expect(filtered).toContain('visible');
    expect(filtered).toContain('<!-- kept in fence -->');

    writeFileSync(
      join(project.memoryDir, 'MEMORY.md'),
      Array.from({ length: MEMORY_INDEX_MAX_LINES }, (_, index) => `existing-${index + 1}`).join('\n') + '\n',
    );
    expect(() => remember('Persist even when compaction is required.', {
      cwd: root,
      memoryHome,
      topic: 'overflow',
    })).toThrow(/write succeeded/);
    expect(readFileSync(join(project.memoryDir, 'overflow.md'), 'utf8')).toContain('Persist even');
    expect(readFileSync(join(project.memoryDir, 'MEMORY.md'), 'utf8')).toContain('[overflow]');
  });

  it('defaults on, supports a project toggle, and refuses secret-like writes', () => {
    const { root, memoryHome } = projectFixture();
    expect(isAutoMemoryEnabled({ cwd: root, memoryHome })).toBe(true);
    setAutoMemoryEnabled(false, { cwd: root, memoryHome });
    expect(isAutoMemoryEnabled({ cwd: root, memoryHome })).toBe(false);
    expect(() => remember('durable fact', { cwd: root, memoryHome })).toThrow(/disabled/);
    setAutoMemoryEnabled(true, { cwd: root, memoryHome });
    expect(() => remember('api_key = abcdefghijklmnopqrstuvwxyz', { cwd: root, memoryHome })).toThrow(/secret/);
    const prior = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    try {
      expect(isAutoMemoryEnabled({ cwd: root, memoryHome })).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
      else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = prior;
    }
  });

  it('refuses a pre-planted topic symlink without modifying its target', () => {
    const { root, memoryHome } = projectFixture();
    const project = resolveMemoryProject({ cwd: root, memoryHome });
    mkdirSync(project.memoryDir, { recursive: true });
    const outside = join(tmp('uc-memory-outside-'), 'outside.md');
    writeFileSync(outside, 'untouched\n');
    symlinkSync(outside, join(project.memoryDir, 'general.md'));
    expect(() => remember('safe durable fact', { cwd: root, memoryHome })).toThrow(/non-regular/);
    expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
  });

  it('blocks memory mutation inside workflow workers', () => {
    const { root, memoryHome } = projectFixture();
    const prior = process.env.ULTRACODE_INSIDE_RUN;
    process.env.ULTRACODE_INSIDE_RUN = '1';
    try {
      expect(() => remember('worker observation', { cwd: root, memoryHome })).toThrow(/inside an ultracode worker/);
      expect(() => setAutoMemoryEnabled(false, { cwd: root, memoryHome })).toThrow(/inside an ultracode worker/);
    } finally {
      if (prior === undefined) delete process.env.ULTRACODE_INSIDE_RUN;
      else process.env.ULTRACODE_INSIDE_RUN = prior;
    }
  });
});

describe('Claude-compatible rules', () => {
  it('loads unconditional rules at startup and scoped rules only for matching paths', () => {
    const { root, memoryHome } = projectFixture();
    const project = resolveMemoryProject({ cwd: root, memoryHome });
    mkdirSync(join(project.rulesDir, 'project'), { recursive: true });
    mkdirSync(join(project.globalRulesDir, 'claude'), { recursive: true });
    writeFileSync(join(project.globalRulesDir, 'claude', 'global.md'), '# Global\n\nUse concise output.\n');
    writeFileSync(join(project.rulesDir, 'project', 'always.md'), '# Always\n\nUse pnpm.\n');
    writeFileSync(
      join(project.rulesDir, 'project', 'api.md'),
      '---\npaths: ["src/api/**/*.{ts,tsx}", "scripts/*.mjs"]\n---\n\n# API\n\nValidate every input.\n',
    );
    const startup = unconditionalRulesContext({ cwd: root, memoryHome });
    expect(startup).toContain('Use concise output.');
    expect(startup).toContain('Use pnpm.');
    expect(startup.indexOf('Use concise output.')).toBeLessThan(startup.indexOf('Use pnpm.'));
    expect(startup).not.toContain('Validate every input.');
    expect(startup).toContain('src/api/**/*.{ts,tsx}');
    expect(pathRulesContext('src/api/users/get.ts', { cwd: root, memoryHome })).toContain('Validate every input.');
    expect(pathRulesContext('src/api/users/get.tsx', { cwd: root, memoryHome })).toContain('Validate every input.');
    expect(pathRulesContext('src/ui/app.ts', { cwd: root, memoryHome })).toBe('');
  });
});

describe('Claude Code migration', () => {
  it('plans first, then copies auto memory and user/project rules without changing the source', () => {
    const { root, memoryHome } = projectFixture();
    const claudeHome = tmp('uc-claude-home-');
    const source = join(claudeHome, 'projects', 'fixture', 'memory');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'MEMORY.md'), '# Claude memory\n\n- [debugging](debugging.md): Redis notes\n');
    writeFileSync(join(source, 'debugging.md'), '# Debugging\n\nUse Redis on port 6380.\n');
    mkdirSync(join(claudeHome, 'rules'), { recursive: true });
    writeFileSync(join(claudeHome, 'rules', 'personal.md'), '# Personal\n\nPrefer concise output.\n');
    writeFileSync(join(claudeHome, 'shared.md'), 'Use UTC in examples.\n');
    writeFileSync(join(claudeHome, 'CLAUDE.md'), '# User instructions\n\n@shared.md\n');
    mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(root, '.claude', 'rules', 'tests.md'), '# Tests\n\nRun tests offline.\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# Project instructions\n\nUse npm.\n');
    writeFileSync(join(root, 'CLAUDE.local.md'), '# Local instructions\n\nUse the local mock.\n');
    const sourceBefore = readFileSync(join(source, 'MEMORY.md'), 'utf8');

    const plan = migrateClaudeMemory({ cwd: root, memoryHome, claudeHome, source });
    expect(plan.applied).toBe(false);
    expect(plan.files.map((file) => file.action)).toEqual(['copy', 'copy']);
    expect(existsSync(plan.destinationMemoryDir)).toBe(false);

    const applied = migrateClaudeMemory({ cwd: root, memoryHome, claudeHome, source, apply: true });
    expect(applied.applied).toBe(true);
    expect(readFileSync(join(applied.destinationMemoryDir, 'MEMORY.md'), 'utf8')).toBe(sourceBefore);
    expect(readFileSync(join(applied.destinationMemoryDir, 'debugging.md'), 'utf8')).toContain('6380');
    const project = resolveMemoryProject({ cwd: root, memoryHome });
    expect(readFileSync(join(project.globalRulesDir, 'claude', 'personal.md'), 'utf8')).toContain('concise');
    expect(readFileSync(join(project.rulesDir, 'project', 'tests.md'), 'utf8')).toContain('offline');
    expect(readFileSync(join(project.globalRulesDir, 'claude', 'CLAUDE.md'), 'utf8')).toContain('Use UTC in examples.');
    expect(readFileSync(join(project.rulesDir, 'project', 'CLAUDE.md'), 'utf8')).toContain('Use npm.');
    expect(readFileSync(join(project.rulesDir, 'local', 'CLAUDE.local.md'), 'utf8')).toContain('local mock');
    expect(applied.instructions).toHaveLength(3);
    expect(readFileSync(join(source, 'MEMORY.md'), 'utf8')).toBe(sourceBefore);
  });

  it('preserves conflicting destination files and skips secret-like imports', () => {
    const { root, memoryHome } = projectFixture();
    const source = join(tmp('uc-claude-source-'), 'memory');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'MEMORY.md'), '# Imported\n');
    writeFileSync(join(source, 'credentials.md'), 'api_key = abcdefghijklmnopqrstuvwxyz\n');
    remember('Existing local note.', { cwd: root, memoryHome, topic: 'local' });
    const result = migrateClaudeMemory({ cwd: root, memoryHome, source, apply: true });
    expect(result.files.find((file) => file.source.endsWith('MEMORY.md'))?.action).toBe('conflict-copy');
    expect(result.files.find((file) => file.source.endsWith('credentials.md'))?.action).toBe('skip-sensitive');
    expect(existsSync(join(result.destinationMemoryDir, 'claude-MEMORY.md'))).toBe(true);
    expect(existsSync(join(result.destinationMemoryDir, 'credentials.md'))).toBe(false);
    expect(memoryContext({ cwd: root, memoryHome })).toContain('Existing local note.');
  });
});

describe('Codex memory hook', () => {
  it('injects the same startup context and is silent for an empty store', () => {
    const { root, memoryHome } = projectFixture();
    expect(memoryHookPayload(root, { memoryHome })).toBeUndefined();
    remember('Use port 6380 for local Redis.', { cwd: root, memoryHome, summary: 'Redis uses port 6380.' });
    const payload = memoryHookPayload(root, { memoryHome }) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(payload.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(payload.hookSpecificOutput.additionalContext).toBe(startupMemoryContext({ cwd: root, memoryHome }));
    expect(payload.hookSpecificOutput.additionalContext).toContain('Redis uses port 6380.');
  });
});
