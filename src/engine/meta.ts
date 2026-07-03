/**
 * Workflow script parsing: acorn-based validation of the `export const meta`
 * pure-literal block, export stripping, and a static call inventory for
 * `ultracode validate` and review-before-run output.
 *
 * Dialect contract (shared with Claude Code and Qoder): the script must begin
 * with `export const meta = { name, description, ... }` as a PURE literal —
 * no variables, function calls, spreads, or template interpolation.
 */
import { createHash } from 'node:crypto';
import * as acorn from 'acorn';
import { MetaValidationError } from './errors.js';

export const MAX_SCRIPT_BYTES = 524_288;

export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  title?: string;
  whenToUse?: string;
  phases?: WorkflowPhaseMeta[];
  inputSchema?: Record<string, unknown>;
}

export interface StaticCall {
  fn: 'agent' | 'parallel' | 'pipeline' | 'workflow' | 'phase' | 'log';
  line: number;
  /** First argument when it is a static string literal (phase title, agent prompt head). */
  staticArg?: string;
}

export interface ParsedWorkflow {
  meta: WorkflowMeta;
  /** Script source with the export statement blanked out (line numbers preserved). */
  body: string;
  /** sha256 hex of the original source. */
  scriptHash: string;
  calls: StaticCall[];
  /** Phase titles: meta.phases first, then phase() string literals not already present. */
  phaseTitles: string[];
}

const NAME_RE = /^[a-zA-Z0-9._:-]+$/;
const HOST_FNS = new Set(['agent', 'parallel', 'pipeline', 'workflow', 'phase', 'log']);

type Node = acorn.Node & Record<string, any>;

/** Recursively evaluate a pure-literal AST node; throws MetaValidationError otherwise. */
function literalToValue(node: Node, src: string): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'TemplateLiteral':
      if (node.expressions.length > 0) {
        throw pureLiteralError(node, src);
      }
      return node.quasis.map((q: Node) => q.value.cooked).join('');
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
        return -node.argument.value;
      }
      throw pureLiteralError(node, src);
    case 'ArrayExpression':
      return node.elements.map((el: Node | null) => {
        if (el === null || el.type === 'SpreadElement') throw pureLiteralError(node, src);
        return literalToValue(el, src);
      });
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties) {
        if (prop.type !== 'Property' || prop.computed || prop.kind !== 'init') {
          throw pureLiteralError(prop, src);
        }
        const key =
          prop.key.type === 'Identifier'
            ? prop.key.name
            : prop.key.type === 'Literal'
              ? String(prop.key.value)
              : null;
        if (key === null) throw pureLiteralError(prop, src);
        out[key] = literalToValue(prop.value, src);
      }
      return out;
    }
    default:
      throw pureLiteralError(node, src);
  }
}

function nodeLoc(node: Node, src: string): { line: number; column: number } {
  const before = src.slice(0, node.start);
  const line = before.split('\n').length;
  const column = node.start - (before.lastIndexOf('\n') + 1);
  return { line, column };
}

function pureLiteralError(node: Node, src: string): MetaValidationError {
  return new MetaValidationError(
    'meta must be a pure literal (no variables, function calls, spreads, or template interpolation)',
    nodeLoc(node, src),
  );
}

function validateMeta(raw: unknown): WorkflowMeta {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MetaValidationError('meta must be an object literal');
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) {
    throw new MetaValidationError('meta.name is required and must match [a-zA-Z0-9._:-]+');
  }
  if (typeof m.description !== 'string' || m.description.length === 0) {
    throw new MetaValidationError('meta.description is required');
  }
  const meta: WorkflowMeta = { name: m.name, description: m.description };
  if (m.title !== undefined) {
    if (typeof m.title !== 'string') throw new MetaValidationError('meta.title must be a string');
    meta.title = m.title;
  }
  if (m.whenToUse !== undefined) {
    if (typeof m.whenToUse !== 'string') throw new MetaValidationError('meta.whenToUse must be a string');
    meta.whenToUse = m.whenToUse;
  }
  if (m.phases !== undefined) {
    if (!Array.isArray(m.phases)) throw new MetaValidationError('meta.phases must be an array');
    meta.phases = m.phases.map((p, i) => {
      if (typeof p !== 'object' || p === null) {
        throw new MetaValidationError(`meta.phases[${i}] must be an object`);
      }
      const ph = p as Record<string, unknown>;
      if (typeof ph.title !== 'string' || ph.title.length === 0) {
        throw new MetaValidationError(`meta.phases[${i}].title is required`);
      }
      const out: WorkflowPhaseMeta = { title: ph.title };
      if (ph.detail !== undefined) {
        if (typeof ph.detail !== 'string') throw new MetaValidationError(`meta.phases[${i}].detail must be a string`);
        out.detail = ph.detail;
      }
      if (ph.model !== undefined) {
        if (typeof ph.model !== 'string') throw new MetaValidationError(`meta.phases[${i}].model must be a string`);
        out.model = ph.model;
      }
      return out;
    });
  }
  if (m.inputSchema !== undefined) {
    if (typeof m.inputSchema !== 'object' || m.inputSchema === null || Array.isArray(m.inputSchema)) {
      throw new MetaValidationError('meta.inputSchema must be a JSON Schema object');
    }
    meta.inputSchema = m.inputSchema as Record<string, unknown>;
  }
  return meta;
}

/** Blank a source range with spaces, preserving newlines so line numbers survive. */
function blankRange(src: string, start: number, end: number): string {
  const blanked = src.slice(start, end).replace(/[^\n]/g, ' ');
  return src.slice(0, start) + blanked + src.slice(end);
}

function collectCalls(ast: Node, src: string): StaticCall[] {
  const calls: StaticCall[] = [];
  const walk = (node: Node | null): void => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && HOST_FNS.has(node.callee.name)) {
      const call: StaticCall = { fn: node.callee.name, line: nodeLoc(node, src).line };
      const first = node.arguments?.[0];
      if (first?.type === 'Literal' && typeof first.value === 'string') {
        call.staticArg = first.value;
      } else if (first?.type === 'TemplateLiteral' && first.quasis.length === 1) {
        call.staticArg = first.quasis[0].value.cooked ?? undefined;
      }
      calls.push(call);
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
  return calls;
}

export function parseWorkflowScript(source: string): ParsedWorkflow {
  if (Buffer.byteLength(source, 'utf8') > MAX_SCRIPT_BYTES) {
    throw new MetaValidationError(`Workflow script exceeds ${MAX_SCRIPT_BYTES} bytes`);
  }

  let ast: Node;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as Node;
  } catch (err: any) {
    const loc = err?.loc ? { line: err.loc.line, column: err.loc.column } : undefined;
    throw new MetaValidationError(`Workflow script has a syntax error: ${err?.message ?? err}`, loc);
  }

  let body = source;
  let metaNode: Node | undefined;

  for (const stmt of ast.body as Node[]) {
    if (stmt.type === 'ImportDeclaration') {
      throw new MetaValidationError('workflow scripts cannot import modules', nodeLoc(stmt, source));
    }
    if (
      stmt.type === 'ExportNamedDeclaration' ||
      stmt.type === 'ExportDefaultDeclaration' ||
      stmt.type === 'ExportAllDeclaration'
    ) {
      const decl = stmt.declaration as Node | undefined;
      const isMetaExport =
        stmt.type === 'ExportNamedDeclaration' &&
        decl?.type === 'VariableDeclaration' &&
        decl.kind === 'const' &&
        decl.declarations.length === 1 &&
        decl.declarations[0].id?.type === 'Identifier' &&
        decl.declarations[0].id.name === 'meta';
      if (!isMetaExport || metaNode) {
        throw new MetaValidationError('workflow scripts may only export `const meta`', nodeLoc(stmt, source));
      }
      metaNode = decl!.declarations[0].init as Node | undefined;
      if (!metaNode) {
        throw new MetaValidationError('meta must be initialized with an object literal', nodeLoc(stmt, source));
      }
      body = blankRange(body, stmt.start, stmt.end);
    }
  }

  if (!metaNode) {
    throw new MetaValidationError('Workflow script must begin with `export const meta = { ... }`');
  }
  const firstStmt = (ast.body as Node[])[0];
  if (firstStmt?.type !== 'ExportNamedDeclaration') {
    throw new MetaValidationError('Workflow script must begin with `export const meta = { ... }`');
  }

  const meta = validateMeta(literalToValue(metaNode, source));
  const calls = collectCalls(ast, source);

  const phaseTitles = (meta.phases ?? []).map((p) => p.title);
  for (const c of calls) {
    if (c.fn === 'phase' && c.staticArg && !phaseTitles.includes(c.staticArg)) {
      phaseTitles.push(c.staticArg);
    }
  }

  return {
    meta,
    body,
    scriptHash: createHash('sha256').update(source).digest('hex'),
    calls,
    phaseTitles,
  };
}
