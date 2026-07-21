/** Private atomic-write and task-artifact boundary coverage. */
import {
  chmodSync,
  linkSync,
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
import { assertPrivateRuntimeFile } from '../../bench/src/shared/config.js';
import {
  assertArtifactTree,
  readPrivateFile,
  replaceArtifactFile,
  resetArtifactDirectory,
  resolveRegularFileWithinRoot,
  writePrivateFileAtomic,
} from '../../bench/src/shared/paths.js';

const roots: string[] = [];
const temporary = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'uc-bench-private-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('private atomic writes', () => {
  it('accepts only real current-user runtime files with mode 0600', () => {
    const root = temporary();
    const file = join(root, 'pip.conf');
    writeFileSync(file, '[global]\n', { mode: 0o600 });
    expect(assertPrivateRuntimeFile(file, 'private pip config')).toBe(file);
    chmodSync(file, 0o644);
    expect(() => assertPrivateRuntimeFile(file, 'private pip config')).toThrow(/mode 0600/);
  });

  it('atomically replaces content and enforces mode 0600', () => {
    const root = temporary();
    const file = join(root, 'manifest.json');
    writePrivateFileAtomic(root, file, 'first\n');
    chmodSync(file, 0o644);
    writePrivateFileAtomic(root, file, 'second\n');
    expect(readPrivateFile(root, file).toString('utf8')).toBe('second\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces a symlink leaf without writing through it', () => {
    const root = temporary();
    const outside = join(root, 'outside');
    const target = join(root, 'status.json');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, target);
    replaceArtifactFile(target, 'safe');
    expect(readFileSync(outside, 'utf8')).toBe('secret');
    expect(readFileSync(target, 'utf8')).toBe('safe');
  });

  it('rejects symlinked ancestors at the private root boundary', () => {
    const root = temporary();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'linked'));
    expect(() => writePrivateFileAtomic(root, join(root, 'linked', 'manifest.json'), '{}\n')).toThrow(
      /ancestor must be a real directory/,
    );
  });

  it('rejects hard-linked targets and leaves no temporary file on failure', () => {
    const root = temporary();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'x', { mode: 0o600 });
    linkSync(source, target);
    expect(() => replaceArtifactFile(target, 'replacement')).toThrow(/not replaceable/);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readFileSync(source, 'utf8')).toBe('x');
  });

  it('resets a symlinked attempt leaf without deleting its target', () => {
    const root = temporary();
    const parent = join(root, 'run', 'tasks', 'key');
    const outside = join(root, 'outside');
    mkdirSync(parent, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'yes');
    symlinkSync(outside, join(parent, 'a'));
    resetArtifactDirectory(root, join(parent, 'a'));
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('yes');
    expect(() => assertArtifactTree(join(parent, 'a'))).not.toThrow();
  });
});

describe('native artifact reads', () => {
  it('rejects symlinked ancestors and multiply-linked task output', () => {
    const root = temporary();
    const native = join(root, 'native');
    const outside = join(root, 'outside');
    mkdirSync(join(native, 'task'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(native, 'task', 'result.json'), '{}\n');
    symlinkSync(outside, join(native, 'linked'));
    expect(resolveRegularFileWithinRoot(root, 'native/task/result.json')).toBe(
      join(root, 'native', 'task', 'result.json'),
    );
    expect(() => resolveRegularFileWithinRoot(root, 'native/linked/result.json')).toThrow(/symlinked ancestors/);
    rmSync(join(native, 'linked'));
    linkSync(join(native, 'task', 'result.json'), join(native, 'task', 'copy.json'));
    expect(() => assertArtifactTree(native)).toThrow(/multiply-linked/);
  });
});
