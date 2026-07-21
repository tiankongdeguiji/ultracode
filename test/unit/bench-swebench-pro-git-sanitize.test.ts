/** Offline regression coverage for the SWE-bench Pro Git history boundary. */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBenchPathRoots } from '../../bench/src/shared/paths.js';
import { prepareTaskBuildContext } from '../../bench/src/suites/swebench-pro/image.js';

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
  it('extracts without starting task code and sanitizes one host build context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-bench-pro-host-sanitize-'));
    temporaryRoots.push(root);
    const source = join(root, 'source');
    const toolchain = join(root, 'toolchain');
    const context = join(root, 'context');
    initializeRepository(source);
    mkdirSync(toolchain);
    writeFileSync(join(source, 'base.txt'), 'base content\n');
    git(source, ['add', 'base.txt']);
    git(source, ['commit', '--quiet', '-m', 'base']);
    git(source, ['branch', '-M', 'main']);
    const base = git(source, ['rev-parse', 'HEAD']);
    git(source, ['checkout', '--quiet', '-b', 'future']);
    writeFileSync(join(source, 'gold.txt'), 'gold history\n');
    git(source, ['add', 'gold.txt']);
    git(source, ['commit', '--quiet', '-m', 'future']);
    const future = git(source, ['rev-parse', 'HEAD']);
    git(source, ['checkout', '--quiet', 'main']);
    writeFileSync(join(source, 'runtime.tmp'), 'pre-existing untracked file\n');

    const id = 'd'.repeat(64);
    const baseLocalId = `sha256:${'b'.repeat(64)}`;
    let present = false;
    let name = '';
    let labels: Record<string, string> = {};
    const calls: string[][] = [];
    const docker = async (argv: readonly string[]): Promise<string> => {
      calls.push([...argv]);
      if (argv[0] === 'ps') return present ? id : '';
      if (argv[0] === 'create') {
        present = true;
        name = argv[argv.indexOf('--name') + 1]!;
        labels = {};
        for (let index = 0; index < argv.length; index += 1) {
          if (argv[index] !== '--label') continue;
          const [key, ...value] = argv[index + 1]!.split('=');
          labels[key!] = value.join('=');
        }
        return id;
      }
      if (argv[0] === 'inspect') {
        return JSON.stringify([{
          Id: id, Name: `/${name}`, Image: baseLocalId,
          Config: { Labels: labels }, State: { Running: false },
        }]);
      }
      if (argv[0] === 'cp') {
        cpSync(source, argv[2]!, { recursive: true });
        return '';
      }
      if (argv[0] === 'rm') {
        present = false;
        return '';
      }
      throw new Error(`unexpected Docker argv: ${argv.join(' ')}`);
    };
    await prepareTaskBuildContext({
      roots: createBenchPathRoots(join(process.cwd(), 'bench')),
      contextDirectory: context,
      toolchainDirectory: toolchain,
      runId: 'pilot1',
      instance: { instanceId: 'task-one', baseCommit: base } as never,
      resolvedDigest: `repo@sha256:${'a'.repeat(64)}`,
      baseLocalId,
      docker,
    });

    const repository = join(context, 'sanitized-repository');
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(base);
    expect(spawnSync('git', ['-C', repository, 'cat-file', '-e', future], {
      env: cleanGitEnvironment(),
    }).status).not.toBe(0);
    expect(readFileSync(join(context, 'git-audit.txt'), 'utf8')).toContain('status=sanitized');
    expect(readFileSync(join(context, 'predirty.z'), 'utf8')).toContain(':(literal)runtime.tmp');
    expect(existsSync(join(context, '.git-audit'))).toBe(false);
    expect(calls.some((argv) => argv[0] === 'start' || argv[0] === 'run')).toBe(false);
    expect(present).toBe(false);
  });

  it('accepts a repository whose parent path resolves through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-bench-pro-git-symlink-parent-'));
    temporaryRoots.push(root);
    const realRoot = join(root, 'real');
    const aliasRoot = join(root, 'alias');
    const repository = join(aliasRoot, 'repository');
    const audit = join(root, 'root-private-audit');
    mkdirSync(realRoot);
    symlinkSync(realRoot, aliasRoot);
    initializeRepository(repository);
    mkdirSync(audit, { mode: 0o700 });
    writeFileSync(join(repository, 'base.txt'), 'base content\n');
    git(repository, ['add', 'base.txt']);
    git(repository, ['commit', '--quiet', '-m', 'base']);
    const base = git(repository, ['rev-parse', 'HEAD']);

    const result = spawnSync('bash', [sanitizer, repository, base, audit], {
      encoding: 'utf8',
      env: cleanGitEnvironment(),
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
    });
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(base);
    expect(readFileSync(join(audit, 'safe.txt'), 'utf8')).toContain('status=sanitized');
  });

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

  it('installs the host-sanitized repository before task code and publishes only the safe audit after it ends', () => {
    const source = readFileSync(entrypoint, 'utf8');
    const installAt = source.indexOf('trusted_busybox mv /opt/bench/sanitized-repository');
    const launchAt = source.indexOf('as_task_busybox timeout -k 60');
    const endedAt = source.indexOf('CODEX_EXIT=$?');
    const publishAt = source.indexOf('trusted_busybox cp /opt/bench/git-audit.txt');
    expect(installAt).toBeGreaterThan(0);
    expect(launchAt).toBeGreaterThan(installAt);
    expect(endedAt).toBeGreaterThan(launchAt);
    expect(publishAt).toBeGreaterThan(endedAt);
    expect(source).not.toContain('/opt/bench/sanitize-git.sh');
    expect(source.slice(installAt, launchAt)).not.toMatch(/as_task git/u);
    expect(source.slice(0, launchAt)).not.toContain('$BENCH/out/git-audit.txt');
    expect(source).toContain('trusted_busybox cp /opt/bench/predirty.z /tmp/predirty.z');
    expect(source).toContain('trusted_busybox cp /opt/bench/pre-status.txt "$BENCH/out/pre-status.txt"');
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
    writeFileSync(join(repository, 'binary.bin'), Buffer.from([0, 1]));
    git(repository, ['add', 'tracked.txt', 'binary.bin']);
    git(repository, ['commit', '--quiet', '-m', 'base']);
    const base = git(repository, ['rev-parse', 'HEAD']);
    const fsmonitorMarker = join(root, 'fsmonitor-ran');
    const fsmonitor = join(root, 'fsmonitor.sh');
    writeFileSync(fsmonitor, `#!/bin/sh\n: > '${fsmonitorMarker}'\nprintf '\\n'\n`);
    chmodSync(fsmonitor, 0o700);
    git(repository, ['config', 'core.fsmonitor', fsmonitor]);
    git(repository, ['status', '--porcelain']);
    expect(existsSync(fsmonitorMarker)).toBe(true);
    rmSync(fsmonitorMarker);
    writeFileSync(join(repository, 'tracked.txt'), 'changed\n');
    writeFileSync(join(repository, 'binary.bin'), Buffer.from([0, 2]));
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
    expect(patch).not.toContain('binary.bin');
    expect(patch).not.toContain('pre-existing.txt');
    expect(readFileSync(join(bench, 'out/apply-check'), 'utf8')).toBe('ok\n');
    expect(readFileSync(join(bench, 'out/binary-stripped'), 'utf8')).toBe('1');
    expect(existsSync(fsmonitorMarker)).toBe(false);
    expect(git(repository, ['status', '--porcelain'])).toBe('?? pre-existing.txt');
  });

  it('bounds patch capture before a large text diff can exhaust memory or output space', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-bench-pro-capture-large-'));
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
    writeFileSync(join(repository, 'large.txt'), Buffer.alloc(10_100_000, 0x61));
    writeFileSync(preDirty, '');

    const result = spawnSync('bash', [capture, repository, base, bench, process.execPath, preDirty], {
      encoding: 'utf8',
      env: cleanGitEnvironment(),
    });

    expect(result.status).toBe(0);
    expect(statSync(join(bench, 'out/patch.diff')).size).toBe(10_000_001);
    expect(existsSync(join(bench, 'out/patch.full.diff'))).toBe(false);
    expect(existsSync(join(bench, 'out/apply-check'))).toBe(false);
  });
});
