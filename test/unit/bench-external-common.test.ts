/** Unit coverage for pure external-adapter identifiers, paths, and git plans. */
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  artifactKey,
  allowlistedEnvironment,
  isSafeRunId,
  joinWithinRoot,
  planPinnedCheckout,
  planPinnedClone,
  planPinnedUpdate,
  resolveRegularFileWithinRoot,
  runOwnedProcess,
  sha256Tree,
  validateRunId,
  validateFeatureBenchTaskId,
  validatePortableComponent,
} from '../../bench/src/external-common.js';

const PIN = '0123456789abcdef0123456789abcdef01234567';

describe('external adapter identifiers', () => {
  it('accepts portable run ids and rejects traversal, separators, reserved names, and bad edges', () => {
    for (const id of ['run-2026_07.19', 'R1', 'a'.repeat(128)]) expect(isSafeRunId(id)).toBe(true);
    for (const id of [
      '',
      '.',
      '..',
      '../escape',
      'a/b',
      'a\\b',
      '-leading',
      'trailing.',
      'has space',
      'nul',
      'COM1.txt',
      'a'.repeat(129),
    ]) expect(isSafeRunId(id)).toBe(false);
    expect(validateRunId('run-1')).toBe('run-1');
    expect(() => validateRunId('../run-1')).toThrow(/invalid run id/);
  });

  it('makes deterministic bounded keys without collisions after slug normalization', () => {
    const first = artifactKey('owner/repo: task 1');
    expect(artifactKey('owner/repo: task 1')).toBe(first);
    expect(first).toMatch(/^owner-repo-task-1-[0-9a-f]{64}$/);
    expect(first.length).toBeLessThan(128);
    expect(artifactKey('a/b')).not.toBe(artifactKey('a b'));
    expect(artifactKey('🔥/../../CON')).toMatch(/^con-[0-9a-f]{64}$/);
    expect(artifactKey('')).toMatch(/^task-[0-9a-f]{64}$/);
  });

  it('shares strict task/job validation and strips unrelated credentials from child environments', () => {
    expect(validateFeatureBenchTaskId('org__repo.task.lv1')).toBe('org__repo.task.lv1');
    expect(() => validateFeatureBenchTaskId('../escape.lv1')).toThrow('unsafe FeatureBench');
    expect(validatePortableComponent('trial-a.1', 'job')).toBe('trial-a.1');
    expect(() => validatePortableComponent('../trial', 'job')).toThrow('portable filesystem component');
    expect(allowlistedEnvironment({
      PATH: '/bin',
      DOCKER_HOST: 'unix:///run/docker.sock',
      GITHUB_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      OPENAI_API_KEY: 'selected',
    }, ['OPENAI_API_KEY'])).toEqual({
      PATH: '/bin',
      DOCKER_HOST: 'unix:///run/docker.sock',
      OPENAI_API_KEY: 'selected',
    });
  });
});

describe('owned external processes', () => {
  it('retains only bounded diagnostic tails', async () => {
    const result = await runOwnedProcess('/bin/sh', [
      '-c',
      "printf '%0100dstdout' 0; printf '%0100dstderr' 0 >&2",
    ], { tailBytes: 8 });
    expect(result.stdout).toBe('00stdout');
    expect(result.stderr).toBe('00stderr');
  });
});

describe('external provenance hashes', () => {
  it('separates file contents from following tree-entry headers', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-external-hash-'));
    const one = join(root, 'one');
    const two = join(root, 'two');
    mkdirSync(one);
    mkdirSync(two);
    writeFileSync(join(two, 'a'), '');
    writeFileSync(join(two, 'b'), 'payload');
    const mode = lstatSync(join(two, 'b')).mode & 0o777;
    writeFileSync(join(one, 'a'), `f\0b\0${mode}\0payload`);
    try {
      expect(sha256Tree(one)).not.toBe(sha256Tree(two));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores only runtime Python cache bytecode in environment attestations', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-external-python-hash-'));
    const environment = join(root, 'venv');
    mkdirSync(environment);
    writeFileSync(join(environment, 'module.py'), 'value = 1\n');
    writeFileSync(join(environment, 'loose.pyc'), 'tracked bytecode');
    const before = sha256Tree(environment, { excludePythonCacheArtifacts: true });
    const cache = join(environment, '__pycache__');
    mkdirSync(cache);
    writeFileSync(join(cache, 'module.cpython-313.pyc'), 'runtime bytecode');
    try {
      expect(sha256Tree(environment, { excludePythonCacheArtifacts: true })).toBe(before);
      expect(sha256Tree(environment)).not.toBe(before);
      writeFileSync(join(environment, 'loose.pyc'), 'changed tracked bytecode');
      expect(sha256Tree(environment, { excludePythonCacheArtifacts: true })).not.toBe(before);
      writeFileSync(join(cache, 'keep.txt'), 'not bytecode');
      expect(sha256Tree(environment, { excludePythonCacheArtifacts: true })).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('joinWithinRoot', () => {
  it('resolves nested relative paths and permits the root itself', () => {
    const root = join(process.cwd(), 'artifacts');
    expect(joinWithinRoot(root, 'tasks', 'one.json')).toBe(join(root, 'tasks', 'one.json'));
    expect(joinWithinRoot(root)).toBe(root);
    expect(joinWithinRoot(root, 'tasks/../one.json')).toBe(join(root, 'one.json'));
  });

  it('rejects POSIX, Windows, NUL, and lexical escapes', () => {
    const root = join(process.cwd(), 'artifacts');
    for (const unsafe of ['../escape', '/tmp/escape', 'C:\\escape', '..\\escape', '\\\\server\\share', 'bad\0name']) {
      expect(() => joinWithinRoot(root, unsafe)).toThrow();
    }
    expect(() => joinWithinRoot(root, 'inside', '../../escape')).toThrow(/escapes root/);
  });

  it('resolves regular files without accepting symlinked ancestors or escaped targets', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'uc-external-contained-'));
    const root = join(temporary, 'run');
    const outside = join(temporary, 'outside');
    mkdirSync(join(root, 'native'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'native', 'report.json'), '{}\n');
    writeFileSync(join(outside, 'report.json'), '{}\n');
    symlinkSync(outside, join(root, 'linked'));
    try {
      expect(resolveRegularFileWithinRoot(root, 'native/report.json')).toBe(join(root, 'native', 'report.json'));
      expect(() => resolveRegularFileWithinRoot(root, 'linked/report.json')).toThrow(/symlinked ancestors/);
      expect(() => resolveRegularFileWithinRoot(root, '../outside/report.json')).toThrow(/escapes root/);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe('pinned checkout plans', () => {
  it('builds argv arrays for a new clone without a shell command string', () => {
    expect(planPinnedClone('https://example.test/repo.git', PIN, '/tmp/checkout')).toEqual([
      ['git', 'clone', '--filter=blob:none', '--no-checkout', '--no-tags', '--', 'https://example.test/repo.git', '/tmp/checkout'],
      ['git', '-C', '/tmp/checkout', 'fetch', '--filter=blob:none', '--depth=1', '--no-tags', 'origin', PIN],
      ['git', '-C', '/tmp/checkout', 'checkout', '--detach', PIN],
    ]);
  });

  it('plans only fetch and checkout for an existing clone', () => {
    const update = planPinnedUpdate('/tmp/repo with spaces', PIN);
    expect(planPinnedCheckout({
      repository: 'unused',
      pin: PIN,
      directory: '/tmp/repo with spaces',
      existing: true,
    })).toEqual(update);
    expect(update.every((argv) => Array.isArray(argv) && argv[0] === 'git')).toBe(true);
  });

  it('requires a full immutable object id and valid process arguments', () => {
    expect(() => planPinnedUpdate('/tmp/repo', 'main')).toThrow(/full 40- or 64-character/);
    expect(() => planPinnedClone('', PIN, '/tmp/repo')).toThrow(/repository/);
    expect(() => planPinnedClone('repo', PIN, 'bad\0dir')).toThrow(/checkout directory/);
  });
});
