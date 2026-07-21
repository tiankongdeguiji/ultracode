/** Deterministic provenance hashing for immutable source and environment trees. */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pythonEnvironmentSha256, sha256Tree } from '../../bench/src/shared/provenance.js';
import { parsePublishedArchiveChecksum } from '../../bench/src/shared/toolchain.js';

const roots: string[] = [];

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'uc-bench-provenance-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('benchmark provenance trees', () => {
  it('frames file contents separately from following tree-entry metadata', () => {
    const root = temporary();
    const one = join(root, 'one');
    const two = join(root, 'two');
    mkdirSync(one);
    mkdirSync(two);
    writeFileSync(join(two, 'a'), '');
    writeFileSync(join(two, 'b'), 'payload');
    const mode = lstatSync(join(two, 'b')).mode & 0o777;
    writeFileSync(join(one, 'a'), `f\0b\0${mode}\0payload`);
    expect(sha256Tree(one)).not.toBe(sha256Tree(two));
  });

  it('excludes only interpreter cache bytecode when requested', () => {
    const environment = join(temporary(), 'venv');
    mkdirSync(environment);
    writeFileSync(join(environment, 'module.py'), 'value = 1\n');
    writeFileSync(join(environment, 'loose.pyc'), 'tracked bytecode');
    const before = sha256Tree(environment, { excludePythonCacheArtifacts: true });
    const cache = join(environment, '__pycache__');
    mkdirSync(cache);
    writeFileSync(join(cache, 'module.cpython-313.pyc'), 'runtime bytecode');
    expect(sha256Tree(environment, { excludePythonCacheArtifacts: true })).toBe(before);
    expect(sha256Tree(environment)).not.toBe(before);
    writeFileSync(join(environment, 'loose.pyc'), 'changed tracked bytecode');
    expect(sha256Tree(environment, { excludePythonCacheArtifacts: true })).not.toBe(before);
    writeFileSync(join(cache, 'keep.txt'), 'not bytecode');
    expect(sha256Tree(environment, { excludePythonCacheArtifacts: true })).not.toBe(before);
  });

  it('binds the bytes behind a virtual environment interpreter symlink', () => {
    const root = temporary();
    const environment = join(root, 'venv');
    const bin = join(environment, 'bin');
    const interpreter = join(root, 'python');
    mkdirSync(bin, { recursive: true });
    writeFileSync(interpreter, 'python-one');
    symlinkSync(interpreter, join(bin, 'python'));
    const tree = sha256Tree(environment, { excludePythonCacheArtifacts: true });
    const identity = pythonEnvironmentSha256(environment);
    writeFileSync(interpreter, 'python-two');
    expect(sha256Tree(environment, { excludePythonCacheArtifacts: true })).toBe(tree);
    expect(pythonEnvironmentSha256(environment)).not.toBe(identity);
  });
});

describe('published toolchain checksums', () => {
  it('binds one exact archive name and rejects absence or ambiguity', () => {
    const hash = 'a'.repeat(64);
    const manifest = Buffer.from(`${hash}  node-v22.14.0-linux-x64.tar.xz\n`);
    expect(parsePublishedArchiveChecksum(manifest, 'node-v22.14.0-linux-x64.tar.xz'))
      .toMatchObject({ archiveSha256: hash });
    expect(() => parsePublishedArchiveChecksum(manifest, 'other.tar.xz')).toThrow(/uniquely bind/);
    expect(() => parsePublishedArchiveChecksum(Buffer.concat([manifest, manifest]),
      'node-v22.14.0-linux-x64.tar.xz')).toThrow(/uniquely bind/);
  });
});
