/** Offline regression coverage for the SWE-bench Pro Git history boundary. */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];
const sanitizer = join(process.cwd(), 'bench/suites/swebench-pro/sanitize-git.sh');
const entrypoint = join(process.cwd(), 'bench/suites/swebench-pro/entrypoint.sh');
const capture = join(process.cwd(), 'bench/suites/swebench-pro/capture-git.sh');

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_INDEX_FILE',
    'GIT_REPLACE_REF_BASE',
    'GIT_NO_REPLACE_OBJECTS',
  ]) delete environment[name];
  return environment;
}

function git(repository: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: cleanGitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initializeRepository(directory: string): void {
  mkdirSync(directory);
  git(directory, ['init', '--quiet']);
  git(directory, ['config', 'user.email', 'bench-test@example.test']);
  git(directory, ['config', 'user.name', 'Bench Test']);
}

describe('SWE-bench Pro Git sanitizer', () => {
  it('replaces packed future history and adversarial namespaces with the exact base closure', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-bench-pro-git-'));
    temporaryRoots.push(root);
    const repository = join(root, 'repository');
    const alternate = join(root, 'alternate');
    const audit = join(root, 'root-private-audit');
    initializeRepository(repository);
    initializeRepository(alternate);
    mkdirSync(audit, { mode: 0o700 });

    writeFileSync(join(repository, 'base.txt'), 'base content\n');
    git(repository, ['add', 'base.txt']);
    git(repository, ['commit', '--quiet', '-m', 'base']);
    git(repository, ['branch', '-M', 'main']);
    const base = git(repository, ['rev-parse', 'HEAD']);

    git(repository, ['checkout', '--quiet', '-b', 'future']);
    writeFileSync(join(repository, 'gold-only.txt'), 'DISTINCTIVE_GOLD_HISTORY_OBJECT\n');
    git(repository, ['add', 'gold-only.txt']);
    git(repository, ['commit', '--quiet', '-m', 'future gold change']);
    const future = git(repository, ['rev-parse', 'HEAD']);
    const goldBlob = git(repository, ['rev-parse', 'HEAD:gold-only.txt']);
    git(repository, ['checkout', '--quiet', 'main']);
    git(repository, ['gc', '--prune=now']);

    const packDirectory = join(repository, '.git/objects/pack');
    expect(readdirSync(packDirectory).some((name) => name.endsWith('.pack'))).toBe(true);
    expect(existsSync(join(repository, '.git/objects', goldBlob.slice(0, 2), goldBlob.slice(2)))).toBe(false);

    writeFileSync(join(alternate, 'alternate-only.txt'), 'ALTERNATE_GOLD_OBJECT\n');
    git(alternate, ['add', 'alternate-only.txt']);
    git(alternate, ['commit', '--quiet', '-m', 'alternate object']);
    mkdirSync(join(repository, '.git/objects/info'), { recursive: true });
    writeFileSync(join(repository, '.git/objects/info/alternates'), `${join(alternate, '.git/objects')}\n`);

    for (const ref of [
      'refs/remotes/origin/future',
      'refs/meta/gold',
      'refs/bisect/gold',
      `refs/replace/${base}`,
    ]) git(repository, ['update-ref', ref, future]);
    git(repository, ['pack-refs', '--all']);
    writeFileSync(join(repository, '.git/ORIG_HEAD'), `${future}\n`);
    writeFileSync(join(repository, '.git/MERGE_HEAD'), `${future}\n`);
    expect(readFileSync(join(repository, '.git/packed-refs'), 'utf8')).toContain(future);
    expect(existsSync(join(repository, '.git/logs'))).toBe(true);

    const result = spawnSync('bash', [sanitizer, repository, base, audit], {
      encoding: 'utf8',
      env: cleanGitEnvironment(),
    });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
    });

    expect(git(repository, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/base');
    expect(git(repository, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(
      `refs/heads/base ${base}`,
    );
    expect(git(repository, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(repository, '.git/objects/info/alternates'))).toBe(false);
    expect(existsSync(join(repository, '.git/logs'))).toBe(false);
    expect(existsSync(join(repository, '.git/packed-refs'))).toBe(false);
    expect(existsSync(join(repository, '.git/ORIG_HEAD'))).toBe(false);
    expect(existsSync(join(repository, '.git/MERGE_HEAD'))).toBe(false);

    for (const object of [future, goldBlob]) {
      expect(spawnSync('git', ['-C', repository, 'cat-file', '-e', `${object}^{object}`], {
        env: cleanGitEnvironment(),
      }).status).not.toBe(0);
    }
    const allObjects = git(repository, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])
      .split('\n').sort();
    const reachableObjects = git(repository, ['rev-list', '--objects', 'HEAD'])
      .split('\n').map((line) => line.split(' ', 1)[0]!).sort();
    expect(allObjects).toEqual(reachableObjects);
    expect(git(repository, ['fsck', '--full', '--no-reflogs', '--unreachable', '--no-progress'])).toBe('');

    const safeAudit = readFileSync(join(audit, 'safe.txt'), 'utf8');
    expect(safeAudit).toContain('status=sanitized');
    expect(safeAudit).toContain('onlyBaseRef=true');
    expect(safeAudit).toContain('auditedObjectsAbsent=true');
    expect(safeAudit).toContain('unreachableObjectsAbsent=true');
    expect(safeAudit).toContain('trackedWorktreeMatchesBase=true');
    expect(Number(safeAudit.match(/^auditedObjectsRemoved=(\d+)$/m)?.[1])).toBeGreaterThan(0);
    expect(safeAudit).not.toMatch(new RegExp([base, future, goldBlob].join('|')));
    expect(safeAudit).not.toMatch(/future|gold|origin|replace|meta/i);
  });

  it('fails closed when a corrupt original index could conceal tracked worktree changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-bench-pro-git-corrupt-index-'));
    temporaryRoots.push(root);
    const repository = join(root, 'repository');
    const audit = join(root, 'root-private-audit');
    initializeRepository(repository);
    mkdirSync(audit, { mode: 0o700 });
    const tracked = join(repository, 'tracked.txt');
    writeFileSync(tracked, 'base content\n');
    git(repository, ['add', 'tracked.txt']);
    git(repository, ['commit', '--quiet', '-m', 'base']);
    const base = git(repository, ['rev-parse', 'HEAD']);
    writeFileSync(tracked, 'modified content concealed by corrupt index\n');
    writeFileSync(join(repository, '.git/index'), 'corrupt index\n');

    const result = spawnSync('bash', [sanitizer, repository, base, audit], {
      encoding: 'utf8',
      env: cleanGitEnvironment(),
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(tracked, 'utf8')).toBe('modified content concealed by corrupt index\n');
    expect(existsSync(join(repository, '.git'))).toBe(true);
    expect(existsSync(join(audit, 'safe.txt'))).toBe(false);
    expect(readdirSync(repository).filter((name) => name.startsWith('.git-sanitize.'))).toEqual([]);
  });

  it('keeps the identifier-free artifact private until the session has ended and fails before launch', () => {
    const source = readFileSync(entrypoint, 'utf8');
    const sanitizeAt = source.indexOf('/opt/bench/sanitize-git.sh');
    const launchAt = source.indexOf('timeout -k 60');
    const endedAt = source.indexOf('CODEX_EXIT=$?');
    const publishAt = source.indexOf('install -m 0644 "$GIT_AUDIT_DIR/safe.txt"');
    expect(sanitizeAt).toBeGreaterThan(0);
    expect(launchAt).toBeGreaterThan(sanitizeAt);
    expect(endedAt).toBeGreaterThan(launchAt);
    expect(publishAt).toBeGreaterThan(endedAt);
    expect(source.slice(0, sanitizeAt)).toContain('[ "${BENCH_SANITIZE:-}" = 1 ]');
    expect(source.slice(sanitizeAt, launchAt)).toContain('META_FAILURE="harness-setup-failed"');
    expect(source.slice(sanitizeAt, launchAt)).toContain('finish');
    expect(source.slice(sanitizeAt, launchAt)).not.toContain('git commit');
    expect(source.slice(0, launchAt)).not.toContain('$BENCH/out/git-audit.txt');
    expect(source).toContain('if ! git status --porcelain > "$BENCH/out/pre-status.txt" 2>&1; then');
    expect(source).toContain('if ! TRACKED_DIRTY=$(git status --porcelain --untracked-files=no');
    expect(source).toContain('if ! git status --porcelain -z 2>/dev/null | "$NODE" -e');
  });

  it('captures an evaluator-faithful patch in the immutable task-uid helper', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-bench-pro-capture-'));
    temporaryRoots.push(root);
    const repository = join(root, 'repository');
    const bench = join(root, 'bench');
    const preDirty = join(root, 'predirty.z');
    initializeRepository(repository);
    mkdirSync(join(bench, 'out'), { recursive: true });
    mkdirSync(join(bench, 'logs'));
    writeFileSync(join(repository, 'tracked.txt'), 'base\n');
    git(repository, ['add', 'tracked.txt']);
    git(repository, ['commit', '--quiet', '-m', 'base']);
    const base = git(repository, ['rev-parse', 'HEAD']);
    writeFileSync(join(repository, 'tracked.txt'), 'changed\n');
    writeFileSync(join(repository, 'pre-existing.txt'), 'image runtime file\n');
    writeFileSync(preDirty, ':(literal)pre-existing.txt\0');

    const result = spawnSync('bash', [capture, repository, base, bench, process.execPath, preDirty], {
      encoding: 'utf8',
      env: cleanGitEnvironment(),
    });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
    });
    const patch = readFileSync(join(bench, 'out/patch.diff'), 'utf8');
    expect(patch).toContain('+changed');
    expect(patch).not.toContain('pre-existing.txt');
    expect(readFileSync(join(bench, 'out/apply-check'), 'utf8')).toBe('ok\n');
    expect(readFileSync(join(bench, 'out/binary-stripped'), 'utf8')).toBe('0');
    expect(git(repository, ['status', '--porcelain'])).toBe('?? pre-existing.txt');
  });
});
