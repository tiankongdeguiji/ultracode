import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateScript } from '../../src/cli/validate.js';
import { lintWorkflowSource } from '../../src/cli/lint.js';

const root = join(__dirname, '../..');

describe('plugin bundles', () => {
  it('codex bundle: valid manifest + skill present', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'dist-codex/.codex-plugin/plugin.json'), 'utf8'));
    expect(manifest.name).toBe('ultracode');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(join(root, 'dist-codex/skills/ultracode/SKILL.md'))).toBe(true);
  });

  it('qoder bundle: manifest + skill + templates + agent defs', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'dist-qoder/.qoder-plugin/plugin.json'), 'utf8'));
    expect(manifest.name).toBe('ultracode');
    for (const f of [
      'dist-qoder/skills/ultracode/SKILL.md',
      'dist-qoder/workflows/uc-review.workflow.js',
      'dist-qoder/workflows/uc-research.workflow.js',
      'dist-qoder/agents/uc-xhigh.md',
      'dist-qoder/agents/uc-verifier.md',
    ]) {
      expect(existsSync(join(root, f)), f).toBe(true);
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
