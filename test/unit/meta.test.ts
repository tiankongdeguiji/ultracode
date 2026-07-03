import { describe, it, expect } from 'vitest';
import { parseWorkflowScript, MAX_SCRIPT_BYTES } from '../../src/engine/meta.js';
import { MetaValidationError } from '../../src/engine/errors.js';

const VALID = `export const meta = {
  name: 'audit-routes',
  description: 'Audit route handlers',
  phases: [{ title: 'Find' }, { title: 'Audit', detail: 'one agent per file' }],
}
phase('Find')
const found = await agent('List every route file.', { label: 'lister' })
phase('Audit')
const audits = await pipeline(found.files, f => agent(\`Audit \${f}\`, { label: f }))
log('done')
return { audits: audits.filter(Boolean) }
`;

describe('parseWorkflowScript', () => {
  it('parses a valid script', () => {
    const p = parseWorkflowScript(VALID);
    expect(p.meta.name).toBe('audit-routes');
    expect(p.meta.description).toBe('Audit route handlers');
    expect(p.meta.phases).toHaveLength(2);
    expect(p.meta.phases![1]).toEqual({ title: 'Audit', detail: 'one agent per file' });
    expect(p.scriptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('strips the export while preserving line numbers', () => {
    const p = parseWorkflowScript(VALID);
    expect(p.body).not.toContain('export');
    expect(p.body.split('\n').length).toBe(VALID.split('\n').length);
    expect(p.body).toContain("phase('Find')");
  });

  it('collects the static call inventory', () => {
    const p = parseWorkflowScript(VALID);
    const counts = p.calls.reduce<Record<string, number>>((acc, c) => {
      acc[c.fn] = (acc[c.fn] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ phase: 2, agent: 2, pipeline: 1, log: 1 });
    expect(p.calls.find((c) => c.fn === 'agent')!.staticArg).toBe('List every route file.');
  });

  it('merges phase() literals into phaseTitles after meta.phases', () => {
    const src = `export const meta = { name: 'x', description: 'y', phases: [{ title: 'A' }] }
phase('A')
phase('B')
`;
    expect(parseWorkflowScript(src).phaseTitles).toEqual(['A', 'B']);
  });

  it('rejects a script without meta', () => {
    expect(() => parseWorkflowScript(`const x = 1`)).toThrow(
      'Workflow script must begin with `export const meta = { ... }`',
    );
  });

  it('rejects meta that is not the first statement', () => {
    const src = `const a = 1
export const meta = { name: 'x', description: 'y' }
`;
    expect(() => parseWorkflowScript(src)).toThrow('must begin with');
  });

  it('rejects non-literal meta: identifier value', () => {
    const src = `export const meta = { name: NAME, description: 'y' }`;
    expect(() => parseWorkflowScript(src)).toThrow(/pure literal/);
  });

  it('rejects non-literal meta: call expression', () => {
    const src = `export const meta = { name: mk(), description: 'y' }`;
    expect(() => parseWorkflowScript(src)).toThrow(/pure literal/);
  });

  it('rejects non-literal meta: spread', () => {
    const src = `export const meta = { ...base, name: 'x', description: 'y' }`;
    expect(() => parseWorkflowScript(src)).toThrow(/pure literal/);
  });

  it('rejects non-literal meta: template interpolation', () => {
    const src = 'export const meta = { name: `a${1}`, description: "y" }';
    expect(() => parseWorkflowScript(src)).toThrow(/pure literal/);
  });

  it('allows template literals without expressions', () => {
    const src = 'export const meta = { name: "x", description: `plain template` }';
    expect(parseWorkflowScript(src).meta.description).toBe('plain template');
  });

  it('rejects imports', () => {
    const src = `import fs from 'node:fs'
export const meta = { name: 'x', description: 'y' }`;
    expect(() => parseWorkflowScript(src)).toThrow('workflow scripts cannot import modules');
  });

  it('rejects extra exports', () => {
    const src = `export const meta = { name: 'x', description: 'y' }
export const other = 1`;
    expect(() => parseWorkflowScript(src)).toThrow('may only export `const meta`');
  });

  it('rejects bad names', () => {
    for (const bad of ['has space', 'emoji💥', '']) {
      const src = `export const meta = { name: ${JSON.stringify(bad)}, description: 'y' }`;
      expect(() => parseWorkflowScript(src)).toThrow('meta.name is required and must match');
    }
  });

  it('rejects missing description', () => {
    const src = `export const meta = { name: 'x' }`;
    expect(() => parseWorkflowScript(src)).toThrow('meta.description is required');
  });

  it('rejects phases without title', () => {
    const src = `export const meta = { name: 'x', description: 'y', phases: [{ detail: 'd' }] }`;
    expect(() => parseWorkflowScript(src)).toThrow('phases[0].title is required');
  });

  it('accepts inputSchema object and negative-number literals', () => {
    const src = `export const meta = { name: 'x', description: 'y', inputSchema: { type: 'object', minProperties: -0 } }`;
    const p = parseWorkflowScript(src);
    expect(p.meta.inputSchema).toEqual({ type: 'object', minProperties: -0 });
  });

  it('rejects oversized scripts with the exact cap in the message', () => {
    const big = `export const meta = { name: 'x', description: 'y' }\n// ${'a'.repeat(MAX_SCRIPT_BYTES)}`;
    expect(() => parseWorkflowScript(big)).toThrow(`Workflow script exceeds ${MAX_SCRIPT_BYTES} bytes`);
  });

  it('reports syntax errors as MetaValidationError with location', () => {
    try {
      parseWorkflowScript(`export const meta = { name: 'x', description: 'y' }\nconst = broken`);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MetaValidationError);
      expect((err as Error).message).toContain('syntax error');
    }
  });

  it('allows top-level await and top-level return', () => {
    const src = `export const meta = { name: 'x', description: 'y' }
const v = await Promise.resolve(1)
return v`;
    expect(parseWorkflowScript(src).meta.name).toBe('x');
  });
});
