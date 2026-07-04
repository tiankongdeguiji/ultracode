import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installForHost, QODER_RULE } from '../../src/installer/install.js';
import { syncProject, adoptCopy, stampedCopy } from '../../src/cli/sync.js';
import { lintWorkflowSource } from '../../src/cli/lint.js';
import { validateScript } from '../../src/cli/validate.js';
import { executeWorkflow } from '../../src/engine/run.js';
import { MockExecutor } from '../../src/backends/mock.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'uc-qoder-'));
}

const REVIEW_SRC = readFileSync(join(__dirname, '../../workflows/uc-review.workflow.js'), 'utf8');
const RESEARCH_SRC = readFileSync(join(__dirname, '../../workflows/uc-research.workflow.js'), 'utf8');

describe('qoder install pack', () => {
  it('user scope: skill, AGENTS.md snippet, uc-* workflows, agent defs under ~/.qoder', () => {
    const home = tmp();
    installForHost('qoder', { userHome: home });
    expect(existsSync(join(home, '.qoder/skills/ultracode/SKILL.md'))).toBe(true);
    expect(readFileSync(join(home, '.qoder/AGENTS.md'), 'utf8')).toContain('STANDING mode');
    expect(existsSync(join(home, '.qoder/workflows/uc-review.workflow.js'))).toBe(true);
    expect(existsSync(join(home, '.qoder/workflows/uc-research.workflow.js'))).toBe(true);
    expect(readFileSync(join(home, '.qoder/agents/uc-verifier.md'), 'utf8')).toContain('Adversarial verifier');
  });

  it('project scope: always_on rule instead of AGENTS.md', () => {
    const project = tmp();
    installForHost('qoder', { project: true, projectRoot: project });
    const rule = readFileSync(join(project, '.qoder/rules/ultracode-mode.md'), 'utf8');
    expect(rule).toMatch(/^---\ntrigger: always_on\n---/);
    expect(rule).toContain('NATIVE Workflow tool');
    expect(rule).toContain('args.budgetTokens');
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(false);
    // rule content is idempotent
    const again = installForHost('qoder', { project: true, projectRoot: project });
    expect(again.find((a) => a.path.endsWith('ultracode-mode.md'))!.changed).toBe(false);
  });

  it('QODER_RULE never names host built-ins as ours', () => {
    expect(QODER_RULE).not.toContain('deep-research');
  });
});

describe('shipped templates', () => {
  it('validate cleanly and lint as portable', () => {
    for (const src of [REVIEW_SRC, RESEARCH_SRC]) {
      const report = validateScript(src);
      expect(report.ok).toBe(true);
      const findings = lintWorkflowSource(src);
      expect(findings.filter((f) => f.level === 'error')).toEqual([]);
      expect(findings.filter((f) => f.level === 'warning')).toEqual([]);
    }
  });

  it('uc-review rehearses end-to-end on the mock engine (schema stubs)', async () => {
    const out = await executeWorkflow(REVIEW_SRC, {
      executor: new MockExecutor(),
      args: { target: 'src/' },
      maxConcurrency: 4,
    });
    expect(out.error).toBeUndefined();
    const result = out.result as { confirmed: unknown[]; report: string };
    // Mock stubs produce findings with real=true verdicts (boolean stub = true).
    expect(Array.isArray(result.confirmed)).toBe(true);
    expect(out.agentCount).toBeGreaterThanOrEqual(3);
  });

  it('uc-review enforces its inputSchema', async () => {
    await expect(
      executeWorkflow(REVIEW_SRC, { executor: new MockExecutor(), args: {} }),
    ).rejects.toThrow(/args do not match uc-review/);
  });

  it('uc-research rehearses end-to-end on the mock engine', async () => {
    const out = await executeWorkflow(RESEARCH_SRC, {
      executor: new MockExecutor(),
      args: { question: 'how does the build work?' },
      maxConcurrency: 4,
    });
    expect(out.error).toBeUndefined();
    expect((out.result as { notesUsed: number }).notesUsed).toBe(3);
  });
});

describe('sync', () => {
  function seedProject(): { root: string; canonical: string } {
    const root = tmp();
    const canonical = join(root, '.ultracode/workflows');
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, 'uc-demo.workflow.js'), REVIEW_SRC, 'utf8');
    return { root, canonical };
  }

  it('creates stamped copies in both host dirs; idempotent', () => {
    const { root } = seedProject();
    const first = syncProject(root, { write: true });
    expect(first.map((e) => e.state)).toEqual(['created', 'created']);
    const copy = readFileSync(join(root, '.claude/workflows/uc-demo.workflow.js'), 'utf8');
    expect(copy).toMatch(/^\/\/ ultracode:sync sha256=[0-9a-f]{64} src=\.ultracode\/workflows\/uc-demo\.workflow\.js/);
    expect(validateScript(copy).ok).toBe(true); // stamp does not break the dialect

    const second = syncProject(root, { write: true });
    expect(second.map((e) => e.state)).toEqual(['current', 'current']);
  });

  it('refreshes clean stale copies after the canonical changes', () => {
    const { root, canonical } = seedProject();
    syncProject(root, { write: true });
    writeFileSync(join(canonical, 'uc-demo.workflow.js'), RESEARCH_SRC, 'utf8');
    const entries = syncProject(root, { write: true });
    expect(entries.map((e) => e.state)).toEqual(['updated', 'updated']);
    expect(readFileSync(join(root, '.qoder/workflows/uc-demo.workflow.js'), 'utf8')).toContain('uc-research');
  });

  it('protects hand-edited copies; --adopt reclaims them', () => {
    const { root } = seedProject();
    syncProject(root, { write: true });
    const target = join(root, '.qoder/workflows/uc-demo.workflow.js');
    const edited = readFileSync(target, 'utf8').replace('Multi-perspective', 'HAND EDITED Multi-perspective');
    writeFileSync(target, edited, 'utf8');

    const entries = syncProject(root, { write: true });
    expect(entries.find((e) => e.target === target)!.state).toBe('hand-edited');
    expect(readFileSync(target, 'utf8')).toContain('HAND EDITED'); // not clobbered

    const dest = adoptCopy(root, target);
    const adopted = readFileSync(dest, 'utf8');
    expect(adopted).toContain('HAND EDITED');
    expect(adopted).not.toContain('ultracode:sync'); // stamp stripped
  });

  it('never touches foreign (unstamped) files', () => {
    const { root } = seedProject();
    mkdirSync(join(root, '.claude/workflows'), { recursive: true });
    writeFileSync(join(root, '.claude/workflows/uc-demo.workflow.js'), '// user file\n', 'utf8');
    const entries = syncProject(root, { write: true });
    expect(entries.find((e) => e.target.includes('.claude'))!.state).toBe('foreign');
    expect(readFileSync(join(root, '.claude/workflows/uc-demo.workflow.js'), 'utf8')).toBe('// user file\n');
  });

  it('stampedCopy round-trips through the validator', () => {
    expect(validateScript(stampedCopy('x.js', REVIEW_SRC)).ok).toBe(true);
  });
});

describe('lint portability findings', () => {
  const BASE = `export const meta = { name: 'NAME', description: 'd' }\n`;

  it('warns on missing uc- prefix', () => {
    const f = lintWorkflowSource(BASE.replace('NAME', 'myflow') + 'return 1');
    expect(f.some((x) => x.message.includes('uc- prefix'))).toBe(true);
  });

  it('warns on engine-only agent options with line numbers', () => {
    const src = BASE.replace('NAME', 'uc-x') + `return agent('p', { backend: 'codex', effort: 'high' })`;
    const f = lintWorkflowSource(src);
    expect(f.find((x) => x.message.includes("'backend'"))!.line).toBe(2);
    expect(f.some((x) => x.message.includes("'effort'"))).toBe(true);
  });

  it('warns on non-strict schemas', () => {
    const src = BASE.replace('NAME', 'uc-x') + `return agent('p', { schema: { type: 'object', properties: { v: { oneOf: [{ type: 'string' }] } } } })`;
    const f = lintWorkflowSource(src);
    expect(f.some((x) => x.message.includes('strict subset') && x.message.includes('oneOf'))).toBe(true);
  });

  it('warns on budget.* without the args.budgetTokens shim', () => {
    const src = BASE.replace('NAME', 'uc-x') + `if (budget.remaining() < 10) { log('low') }\nreturn 1`;
    const f = lintWorkflowSource(src);
    expect(f.some((x) => x.message.includes('budgetTokens'))).toBe(true);
  });

  it('parse failures are errors', () => {
    expect(lintWorkflowSource('const x = 1')[0]!.level).toBe('error');
  });
});
