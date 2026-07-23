/**
 * ultracode lint: portable-subset checks so one script text runs on
 * Claude Code native, Qoder native, AND the ultracode engine.
 */
import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';
import { parseWorkflowScript } from '../engine/meta.js';
import { checkCodexStrictSchema } from '../backends/schema-strict.js';
import type { JsonSchema } from '../backends/types.js';

export interface LintFinding {
  level: 'error' | 'warning';
  line?: number;
  message: string;
}

type Node = acorn.Node & Record<string, any>;

function lineOf(src: string, pos: number): number {
  return src.slice(0, pos).split('\n').length;
}

/** Best-effort literal evaluation of an options object property. */
function literalValue(node: Node): unknown {
  try {
    if (node.type === 'Literal') return node.value;
    if (node.type === 'ObjectExpression') {
      const out: Record<string, unknown> = {};
      for (const p of node.properties) {
        if (p.type !== 'Property' || p.computed) return undefined;
        const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : undefined;
        if (key === undefined) return undefined;
        const v = literalValue(p.value);
        if (v === undefined && p.value.type !== 'Literal') return undefined;
        out[key] = v;
      }
      return out;
    }
    if (node.type === 'ArrayExpression') {
      return node.elements.map((e: Node | null) => (e ? literalValue(e) : undefined));
    }
  } catch {
    /* non-literal */
  }
  return undefined;
}

export function lintWorkflowSource(source: string): LintFinding[] {
  const findings: LintFinding[] = [];

  let name: string;
  try {
    name = parseWorkflowScript(source).meta.name;
  } catch (err) {
    return [{ level: 'error', message: (err as Error).message }];
  }

  if (!name.startsWith('uc-')) {
    findings.push({
      level: 'warning',
      message: `meta.name "${name}" lacks the uc- prefix — risks colliding with host built-ins (never shadow deep-research/Workflow)`,
    });
  }

  const ast = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  }) as Node;

  const walk = (node: Node | null): void => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'agent') {
      const optsNode: Node | undefined =
        node.arguments?.[1]?.type === 'ObjectExpression'
          ? node.arguments[1]
          : node.arguments?.[0]?.type === 'ObjectExpression'
            ? node.arguments[0]
            : undefined;
      if (optsNode) {
        for (const prop of optsNode.properties as Node[]) {
          if (prop.type !== 'Property' || prop.key?.type !== 'Identifier') continue;
          const key = prop.key.name;
          const line = lineOf(source, prop.start);
          if (key === 'backend') {
            findings.push({ level: 'warning', line, message: `agent option 'backend' is ultracode-engine-only (not portable to Claude Code / Qoder native)` });
          }
          if (key === 'effort') {
            findings.push({ level: 'warning', line, message: `agent option 'effort' is not portable to Qoder native — route effort via an agentType definition` });
          }
          if (key === 'contextWindow') {
            findings.push({ level: 'warning', line, message: `agent option 'contextWindow' is ultracode-engine-only (not portable to Claude Code / Qoder native)` });
          }
          if (key === 'schema') {
            const schema = literalValue(prop.value);
            if (schema && typeof schema === 'object') {
              const check = checkCodexStrictSchema(schema as JsonSchema);
              if (!check.ok) {
                findings.push({ level: 'warning', line, message: `schema outside the codex strict subset (fails on the codex backend): ${check.reason}` });
              }
            }
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c === 'object' && 'type' in c) walk(c as Node);
      } else if (child && typeof child === 'object' && 'type' in child) {
        walk(child as Node);
      }
    }
  };
  walk(ast);

  if (/\bbudget\s*\.\s*(total|remaining|spent)/.test(source) && !source.includes('budgetTokens')) {
    findings.push({
      level: 'warning',
      message: `script reads budget.* without an args.budgetTokens fallback — Qoder native stubs budget as {total:null}; use: (budget && budget.total) || (args && args.budgetTokens) || null`,
    });
  }

  return findings;
}

export function lintCommand(file: string, opts: { json?: boolean }): number {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`ultracode: cannot read ${file}: ${(err as Error).message}\n`);
    return 1;
  }
  const findings = lintWorkflowSource(source);
  if (opts.json) {
    process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
  } else if (findings.length === 0) {
    process.stdout.write(`✓ ${file}: portable\n`);
  } else {
    for (const f of findings) {
      process.stdout.write(`${f.level === 'error' ? '✗' : '⚠'} ${file}${f.line ? `:${f.line}` : ''} ${f.message}\n`);
    }
  }
  return findings.some((f) => f.level === 'error') ? 1 : 0;
}
