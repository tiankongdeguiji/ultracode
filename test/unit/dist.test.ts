import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateScript } from '../../src/cli/validate.js';
import { lintWorkflowSource } from '../../src/cli/lint.js';
import { VERSION } from '../../src/version.js';

const root = join(__dirname, '../..');

describe('plugin bundles', () => {
  // The bundles are gitignored build outputs — rebuild from the canonical
  // sources so the assertions run against fresh, never stale, copies. The
  // sentinels prove the rebuild wipes prior outputs rather than copying over them.
  beforeAll(() => {
    for (const d of ['dist-codex', 'dist-qoder']) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, 'STALE.txt'), 'stale');
    }
    execFileSync('node', [join(root, 'scripts/build-plugins.mjs')], { stdio: 'pipe' });
  });

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  it('codex bundle: valid manifest + README + skill present', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'dist-codex/.codex-plugin/plugin.json'), 'utf8'));
    expect(manifest.name).toBe('ultracode');
    expect(manifest.version).toBe(pkg.version);
    expect(existsSync(join(root, 'dist-codex/README.md'))).toBe(true);
    expect(existsSync(join(root, 'dist-codex/skills/ultracode/SKILL.md'))).toBe(true);
  });

  it('qoder bundle: manifest + README + skill + templates + agent defs', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'dist-qoder/.qoder-plugin/plugin.json'), 'utf8'));
    expect(manifest.name).toBe('ultracode');
    expect(manifest.version).toBe(pkg.version);
    for (const f of [
      'dist-qoder/README.md',
      'dist-qoder/skills/ultracode/SKILL.md',
      'dist-qoder/workflows/uc-review.workflow.js',
      'dist-qoder/workflows/uc-research.workflow.js',
      'dist-qoder/agents/uc-xhigh.md',
      'dist-qoder/agents/uc-verifier.md',
    ]) {
      expect(existsSync(join(root, f)), f).toBe(true);
    }
  });

  it('engine VERSION constant matches package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('rebuild wipes stale files from prior outputs', () => {
    expect(existsSync(join(root, 'dist-codex/STALE.txt'))).toBe(false);
    expect(existsSync(join(root, 'dist-qoder/STALE.txt'))).toBe(false);
  });

  it('build-plugins rejects a missing or non-SemVer package.json version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc-badver-'));
    // Assert the guard's own message: the bare temp dir would make the script
    // throw ENOENT at the copy step even without the guard, so toThrow() alone
    // could green-pass with the guard deleted.
    const badVersions = [
      {},
      { version: '' },
      { version: null },
      { version: '1.2.3junk' },
      { version: ['1.2.3'] },
      { version: '01.2.3' },
      { version: '1.2.3-01' },
      { version: '1.2.3-alpha..1' },
    ];
    for (const bad of badVersions) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify(bad));
      let stderr = '';
      try {
        execFileSync('node', [join(root, 'scripts/build-plugins.mjs'), dir], { stdio: 'pipe' });
      } catch (e) {
        stderr = String((e as { stderr?: unknown }).stderr ?? '');
      }
      expect(stderr, JSON.stringify(bad)).toMatch(/version missing or invalid/);
    }
  });

  it('build-plugins accepts prerelease and build-metadata versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc-goodver-'));
    for (const version of ['10.20.30', '1.2.3-alpha.1', '1.2.3-alpha.1+build.9']) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
      let stderr = '';
      try {
        execFileSync('node', [join(root, 'scripts/build-plugins.mjs'), dir], { stdio: 'pipe' });
      } catch (e) {
        stderr = String((e as { stderr?: unknown }).stderr ?? '');
      }
      // The bare temp root later fails at the copy step (ENOENT); all that
      // matters here is that an over-strict guard did not reject the version.
      expect(stderr, version).not.toMatch(/version missing or invalid/);
    }
  });

  it('bundled workflow copies are valid and portable', () => {
    for (const f of ['dist-qoder/workflows/uc-review.workflow.js', 'dist-qoder/workflows/uc-research.workflow.js']) {
      const src = readFileSync(join(root, f), 'utf8');
      expect(validateScript(src).ok).toBe(true);
      expect(lintWorkflowSource(src).filter((x) => x.level === 'error')).toEqual([]);
    }
  });
});

describe('parity demo assets', () => {
  it('sample repo has the planted-bug source and ground-truth doc', () => {
    expect(existsSync(join(root, 'examples/sample-repo/src/auth.js'))).toBe(true);
    expect(readFileSync(join(root, 'examples/sample-repo/PLANTED_BUGS.md'), 'utf8')).toMatch(/auth bypass/i);
  });

  it('committed parity output confirms both planted bugs (from a real Codex run)', () => {
    const output = JSON.parse(readFileSync(join(root, 'examples/parity-demo-output.json'), 'utf8'));
    expect(output.result.confirmed.length).toBeGreaterThanOrEqual(2);
    expect(output.agentCount).toBeGreaterThan(1);
  });

  it('assert-review.mjs passes on the committed parity output and fails on empty', () => {
    const script = join(root, 'examples/assert-review.mjs');
    // passes on the real output
    execFileSync('node', [script, join(root, 'examples/parity-demo-output.json')], { stdio: 'pipe' });

    // fails on an empty result
    const empty = join(mkdtempSync(join(tmpdir(), 'uc-assert-')), 'out.json');
    writeFileSync(empty, JSON.stringify({ result: { confirmed: [], report: 'nothing found' } }));
    expect(() => execFileSync('node', [script, empty], { stdio: 'pipe' })).toThrow();
  });
});
