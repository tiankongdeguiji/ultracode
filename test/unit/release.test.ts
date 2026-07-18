import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stage = join(root, 'dist-release', `ultracode-${pkg.version}`);
const mainJs = join(stage, 'dist/cli/main.js');

describe('release artifact', () => {
  // dist-release/ is a gitignored build output — rebuild so the assertions run
  // against a fresh copy. The sentinel proves the rebuild wipes prior outputs
  // rather than copying over them. (Only this file uses the default outDir; the
  // integration file builds into a temp dir, so parallel workers never race.)
  beforeAll(() => {
    mkdirSync(join(root, 'dist-release'), { recursive: true });
    writeFileSync(join(root, 'dist-release/STALE.txt'), 'stale');
    execFileSync(process.execPath, [join(root, 'scripts/build-release.mjs')], { stdio: 'pipe' });
  }, 120_000);

  it('rebuild wipes stale files from prior outputs', () => {
    expect(existsSync(join(root, 'dist-release/STALE.txt'))).toBe(false);
  });

  it('stage tree carries the bundle and every runtime asset', () => {
    for (const f of [
      'dist/cli/main.js',
      'skill/ultracode/SKILL.md',
      'workflows/uc-review.workflow.js',
      'workflows/uc-research.workflow.js',
      'hostpacks/qoder/agents/uc-xhigh.md',
    ]) {
      expect(existsSync(join(stage, f)), f).toBe(true);
    }
    // Byte-identical to the root LICENSE — a truncated copy must fail.
    expect(readFileSync(join(stage, 'LICENSE'), 'utf8')).toBe(readFileSync(join(root, 'LICENSE'), 'utf8'));
  });

  it('stage package.json is exactly the minimal manifest', () => {
    expect(JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'))).toEqual({
      name: 'ultracode',
      version: pkg.version,
      type: 'module',
      license: 'Apache-2.0',
      engines: { node: '>=20' },
      bin: { ultracode: 'dist/cli/main.js' },
    });
  });

  it('bundle starts with the shebang, carries the banner shim, and is executable', () => {
    const src = readFileSync(mainJs, 'utf8');
    expect(src.split('\n')[0]).toBe('#!/usr/bin/env node');
    expect(src).toContain('__ucCreateRequire');
    expect(statSync(mainJs).mode & 0o111).toBeTruthy();
  });

  it('tarball + sha256 sidecar exist and the checksum matches (sha256sum -c format)', () => {
    const tarball = join(root, 'dist-release', `ultracode-${pkg.version}.tar.gz`);
    expect(existsSync(tarball)).toBe(true);
    const hex = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    // Two spaces between hash and name — the format `sha256sum -c` expects.
    expect(readFileSync(`${tarball}.sha256`, 'utf8')).toBe(`${hex}  ultracode-${pkg.version}.tar.gz\n`);
  });

  it('bundle --version reports the package.json version', () => {
    const out = execFileSync(process.execPath, [mainJs, '--version'], { encoding: 'utf8' });
    expect(out.trim()).toBe(pkg.version);
  });

  it('build-release rejects a non-SemVer package.json version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc-relbadver-'));
    // Assert the guard's own message: the bare temp root would make the script
    // throw ENOENT at the esbuild step even without the guard, so a nonzero
    // exit alone could green-pass with the guard deleted.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: 'nope' }));
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [join(root, 'scripts/build-release.mjs'), dir], { stdio: 'pipe' });
    } catch (e) {
      status = (e as { status?: number }).status ?? -1;
      stderr = String((e as { stderr?: unknown }).stderr ?? '');
    }
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/version missing or invalid/);
  });

  it('build-release refuses an outDir that equals or contains the source root', () => {
    // The script wipes outDir before staging — pointing it at the repo (or an
    // ancestor) must abort before rmSync, with the tree left intact.
    for (const outDir of [root, join(root, '..')]) {
      let status = 0;
      let stderr = '';
      try {
        execFileSync(process.execPath, [join(root, 'scripts/build-release.mjs'), root, outDir], { stdio: 'pipe' });
      } catch (e) {
        status = (e as { status?: number }).status ?? -1;
        stderr = String((e as { stderr?: unknown }).stderr ?? '');
      }
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/refusing outDir/);
    }
    expect(existsSync(join(root, 'package.json'))).toBe(true);
  });
});
