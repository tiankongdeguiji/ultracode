/**
 * Conservative AST metrics for generated workflow source. Bounds describe
 * reachable authored dispatches, not model quality or runtime success.
 */
import * as acorn from 'acorn';
import { lintWorkflowSource, type LintFinding } from '../../../../src/cli/lint.js';
import type { CountBounds, StaticWorkflowMetrics } from './types.js';

type Node = acorn.AnyNode & Record<string, any>;

interface Flow {
  agents: CountBounds;
  attempts: CountBounds;
}

interface AnalysisState {
  bindings: Map<string, Node>;
  activeFunctions: Set<string>;
  unboundedLoops: number;
  boundedLoops: number;
}

export interface WorkflowAnalysisResult {
  metrics: StaticWorkflowMetrics | null;
  diagnostics: string[];
  lintFindings: LintFinding[];
}

const EMPTY_BOUNDS: CountBounds = { min: 0, max: 0 };
const EMPTY_FLOW: Flow = { agents: EMPTY_BOUNDS, attempts: EMPTY_BOUNDS };
const MUTATION_RE = /\b(?:implement|edit|modify|write|patch|repair|fix|refactor|replace|create|delete|migrate)\b/iu;
const OWNERSHIP_RE = /\b(?:exclusive|owns?|ownership|only modify|do not modify outside|disjoint)\b|(?:^|[\s`])(?:src|lib|crates|packages|apps|test|tests)\/[\w./*-]+/iu;
const REPAIR_RE = /\b(?:repair|fix|correct|resolve|remediate)\b/iu;
const TRIAGE_RE = /\b(?:triage|adjudicat|verdict|judge|decide readiness|readiness decision)\b/iu;
const FAIL_CLOSED_RE = /\b(?:fail[- ]closed|unresolved blockers?|must not report success|refuse success|only report success)\b/iu;
const CONSTRAINT_LINE_RE = /^\s*(?:[-*]\s+|requirements?:|must\b|do not\b|keep\b|never\b|cannot\b|shall\b)/iu;
const TOKEN_RE = /[a-zA-Z_][a-zA-Z0-9_.:/-]{4,}/gu;
const CONSTRAINT_STOP_WORDS = new Set([
  'about', 'after', 'before', 'below', 'every', 'existing', 'follow', 'implement',
  'requested', 'requirements', 'should', 'their', 'these', 'those', 'through',
  'using', 'where', 'which', 'working', 'would',
]);

function addMaximum(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

function multiplyMaximum(value: number | null, factor: number | null): number | null {
  return value === 0 || factor === 0 ? 0 : value === null || factor === null ? null : value * factor;
}

function sequenceBounds(left: CountBounds, right: CountBounds): CountBounds {
  return { min: left.min + right.min, max: addMaximum(left.max, right.max) };
}

function choiceBounds(left: CountBounds, right: CountBounds): CountBounds {
  return {
    min: Math.min(left.min, right.min),
    max: left.max === null || right.max === null ? null : Math.max(left.max, right.max),
  };
}

function multiplyBounds(value: CountBounds, minimum: number, maximum: number | null): CountBounds {
  return {
    min: value.min * minimum,
    max: multiplyMaximum(value.max, maximum),
  };
}

function sequence(left: Flow, right: Flow): Flow {
  return {
    agents: sequenceBounds(left.agents, right.agents),
    attempts: sequenceBounds(left.attempts, right.attempts),
  };
}

function choice(left: Flow, right: Flow): Flow {
  return {
    agents: choiceBounds(left.agents, right.agents),
    attempts: choiceBounds(left.attempts, right.attempts),
  };
}

function multiply(value: Flow, minimum: number, maximum: number | null): Flow {
  return {
    agents: multiplyBounds(value.agents, minimum, maximum),
    attempts: multiplyBounds(value.attempts, minimum, maximum),
  };
}

function sequenceAll(values: readonly Flow[]): Flow {
  return values.reduce(sequence, EMPTY_FLOW);
}

function callName(node: Node): string | null {
  return node.type === 'CallExpression' && node.callee?.type === 'Identifier'
    ? node.callee.name as string
    : null;
}

function property(node: Node | undefined, name: string): Node | undefined {
  if (node?.type !== 'ObjectExpression') return undefined;
  for (const candidate of node.properties as Node[]) {
    if (candidate.type !== 'Property' || candidate.computed) continue;
    const key = candidate.key.type === 'Identifier'
      ? candidate.key.name
      : candidate.key.type === 'Literal'
        ? String(candidate.key.value)
        : null;
    if (key === name) return candidate.value as Node;
  }
  return undefined;
}

function agentOptions(node: Node): Node | undefined {
  if (callName(node) !== 'agent') return undefined;
  const first = node.arguments?.[0] as Node | undefined;
  const second = node.arguments?.[1] as Node | undefined;
  return second?.type === 'ObjectExpression'
    ? second
    : first?.type === 'ObjectExpression'
      ? first
      : undefined;
}

function literalNumber(node: Node | undefined): number | null {
  return node?.type === 'Literal' && typeof node.value === 'number' && Number.isSafeInteger(node.value)
    ? node.value
    : null;
}

function declaredRetries(node: Node): number {
  return Math.max(0, Math.min(5, literalNumber(property(agentOptions(node), 'retries')) ?? 0));
}

function staticText(node: Node | undefined): string {
  if (node === undefined) return '';
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    return (node.quasis as Node[]).map((quasi) => String(quasi.value?.cooked ?? quasi.value?.raw ?? '')).join(' ');
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return `${staticText(node.left as Node)} ${staticText(node.right as Node)}`;
  }
  return '';
}

function agentPrompt(node: Node): string {
  const first = node.arguments?.[0] as Node | undefined;
  return staticText(first?.type === 'ObjectExpression' ? property(first, 'prompt') : first);
}

function agentLabel(node: Node): string {
  return staticText(property(agentOptions(node), 'label'));
}

function hasSchema(node: Node): boolean {
  return property(agentOptions(node), 'schema') !== undefined;
}

function hasWorktreeIsolation(node: Node): boolean {
  const isolation = property(agentOptions(node), 'isolation');
  return isolation?.type === 'Literal' && isolation.value === 'worktree';
}

function childNodes(node: Node): Node[] {
  const children: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (['start', 'end', 'loc', 'range'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const candidate of value) {
        if (candidate && typeof candidate === 'object' && typeof (candidate as Node).type === 'string') {
          children.push(candidate as Node);
        }
      }
    } else if (value && typeof value === 'object' && typeof (value as Node).type === 'string') {
      children.push(value as Node);
    }
  }
  return children;
}

function collectBindings(node: Node, bindings: Map<string, Node>): void {
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
    bindings.set(node.id.name as string, node.init as Node);
  }
  if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier') {
    bindings.set(node.id.name as string, node);
  }
  for (const child of childNodes(node)) collectBindings(child, bindings);
}

function resolvedNode(node: Node | undefined, state: AnalysisState, seen = new Set<string>()): Node | undefined {
  if (node?.type !== 'Identifier') return node;
  const name = node.name as string;
  if (seen.has(name)) return node;
  const value = state.bindings.get(name);
  if (value === undefined) return node;
  seen.add(name);
  return resolvedNode(value, state, seen);
}

function collectionCardinality(node: Node | undefined, state: AnalysisState): number | null {
  const resolved = resolvedNode(node, state);
  if (resolved === undefined) return null;
  if (resolved.type === 'ArrayExpression') return (resolved.elements as Array<Node | null>).length;
  if (resolved.type === 'CallExpression' && resolved.callee?.type === 'MemberExpression') {
    const member = resolved.callee as Node;
    if (!member.computed && member.property?.type === 'Identifier'
      && ['map', 'filter', 'slice'].includes(member.property.name as string)) {
      if (member.property.name === 'filter') return null;
      return collectionCardinality(member.object as Node, state);
    }
    if (!member.computed && member.property?.type === 'Identifier' && member.property.name === 'fill') {
      return collectionCardinality(member.object as Node, state);
    }
  }
  if (resolved.type === 'CallExpression' && resolved.callee?.type === 'Identifier') {
    if (resolved.callee.name === 'Array') return literalNumber(resolved.arguments?.[0] as Node | undefined);
  }
  if (resolved.type === 'CallExpression' && resolved.callee?.type === 'MemberExpression') {
    const callee = resolved.callee as Node;
    if (!callee.computed
      && callee.object?.type === 'Identifier'
      && callee.object.name === 'Array'
      && callee.property?.type === 'Identifier'
      && callee.property.name === 'from') {
      return literalNumber(property(resolved.arguments?.[0] as Node | undefined, 'length'));
    }
  }
  return null;
}

function callbackFlow(node: Node | undefined, state: AnalysisState): Flow {
  const resolved = resolvedNode(node, state);
  if (resolved === undefined) return EMPTY_FLOW;
  if (resolved.type === 'ArrowFunctionExpression'
    || resolved.type === 'FunctionExpression'
    || resolved.type === 'FunctionDeclaration') {
    const body = resolved.body as Node;
    return body.type === 'BlockStatement' ? statementFlow(body, state) : expressionFlow(body, state);
  }
  return expressionFlow(resolved, state);
}

function mappedThunkFlow(callback: Node | undefined, state: AnalysisState): Flow {
  const resolved = resolvedNode(callback, state);
  if (resolved === undefined) return EMPTY_FLOW;
  if (resolved.type === 'ArrowFunctionExpression') {
    const body = resolved.body as Node;
    if (body.type === 'ArrowFunctionExpression' || body.type === 'FunctionExpression') {
      return callbackFlow(body, state);
    }
    if (body.type === 'BlockStatement') {
      const returned = (body.body as Node[]).find((entry) => entry.type === 'ReturnStatement')?.argument as Node | undefined;
      if (returned?.type === 'ArrowFunctionExpression' || returned?.type === 'FunctionExpression') {
        return callbackFlow(returned, state);
      }
    }
  }
  return callbackFlow(resolved, state);
}

function parallelFlow(argument: Node | undefined, state: AnalysisState): Flow {
  const resolved = resolvedNode(argument, state);
  if (resolved?.type === 'ArrayExpression') {
    return sequenceAll((resolved.elements as Array<Node | null>).map((entry) =>
      entry === null ? EMPTY_FLOW : callbackFlow(entry, state)));
  }
  if (resolved?.type === 'CallExpression' && resolved.callee?.type === 'MemberExpression') {
    const callee = resolved.callee as Node;
    if (!callee.computed && callee.property?.type === 'Identifier' && callee.property.name === 'map') {
      const count = collectionCardinality(callee.object as Node, state);
      const perItem = mappedThunkFlow(resolved.arguments?.[0] as Node | undefined, state);
      return multiply(perItem, count === null ? 0 : count, count);
    }
    if (!callee.computed
      && callee.object?.type === 'Identifier'
      && callee.object.name === 'Array'
      && callee.property?.type === 'Identifier'
      && callee.property.name === 'from') {
      const count = collectionCardinality(resolved, state);
      const perItem = mappedThunkFlow(resolved.arguments?.[1] as Node | undefined, state);
      return multiply(perItem, count === null ? 0 : count, count);
    }
  }
  const count = collectionCardinality(resolved, state);
  return count === null ? {
    agents: { min: 0, max: null },
    attempts: { min: 0, max: null },
  } : EMPTY_FLOW;
}

function pipelineFlow(node: Node, state: AnalysisState): Flow {
  const count = collectionCardinality(node.arguments?.[0] as Node | undefined, state);
  const stages = (node.arguments as Node[]).slice(1).map((stage) => callbackFlow(stage, state));
  const perItem = sequenceAll(stages);
  return multiply(perItem, count === null ? 0 : count, count);
}

function expressionFlow(node: Node | null | undefined, state: AnalysisState): Flow {
  if (node === null || node === undefined) return EMPTY_FLOW;
  switch (node.type) {
    case 'AwaitExpression':
    case 'ChainExpression':
      return expressionFlow(node.argument as Node, state);
    case 'CallExpression': {
      const name = callName(node);
      if (name === 'agent') {
        const attempts = 1 + declaredRetries(node);
        return {
          agents: { min: 1, max: 1 },
          attempts: { min: attempts, max: attempts },
        };
      }
      if (name === 'parallel') return parallelFlow(node.arguments?.[0] as Node | undefined, state);
      if (name === 'pipeline') return pipelineFlow(node, state);
      if (name !== null) {
        const callable = state.bindings.get(name);
        if (callable !== undefined && [
          'ArrowFunctionExpression',
          'FunctionExpression',
          'FunctionDeclaration',
        ].includes(callable.type)) {
          if (state.activeFunctions.has(name)) {
            return {
              agents: { min: 0, max: null },
              attempts: { min: 0, max: null },
            };
          }
          state.activeFunctions.add(name);
          const invoked = callbackFlow(callable, state);
          state.activeFunctions.delete(name);
          return sequence(
            sequenceAll((node.arguments as Node[]).map((argument) => expressionFlow(argument, state))),
            invoked,
          );
        }
      }
      return sequenceAll([
        expressionFlow(node.callee as Node, state),
        ...(node.arguments as Node[]).map((argument) => expressionFlow(argument, state)),
      ]);
    }
    case 'ConditionalExpression':
      return sequence(
        expressionFlow(node.test as Node, state),
        choice(expressionFlow(node.consequent as Node, state), expressionFlow(node.alternate as Node, state)),
      );
    case 'LogicalExpression':
      return sequence(
        expressionFlow(node.left as Node, state),
        choice(EMPTY_FLOW, expressionFlow(node.right as Node, state)),
      );
    case 'SequenceExpression':
      return sequenceAll((node.expressions as Node[]).map((entry) => expressionFlow(entry, state)));
    case 'AssignmentExpression':
    case 'BinaryExpression':
      return sequence(expressionFlow(node.left as Node, state), expressionFlow(node.right as Node, state));
    case 'UnaryExpression':
    case 'UpdateExpression':
      return expressionFlow(node.argument as Node, state);
    case 'MemberExpression':
      return sequence(
        expressionFlow(node.object as Node, state),
        node.computed ? expressionFlow(node.property as Node, state) : EMPTY_FLOW,
      );
    case 'ArrayExpression':
      return sequenceAll((node.elements as Array<Node | null>).map((entry) => expressionFlow(entry, state)));
    case 'ObjectExpression':
      return sequenceAll((node.properties as Node[]).map((entry) =>
        entry.type === 'Property' ? expressionFlow(entry.value as Node, state) : EMPTY_FLOW));
    case 'TemplateLiteral':
      return sequenceAll((node.expressions as Node[]).map((entry) => expressionFlow(entry, state)));
    case 'TaggedTemplateExpression':
      return sequence(expressionFlow(node.tag as Node, state), expressionFlow(node.quasi as Node, state));
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return EMPTY_FLOW;
    default:
      return EMPTY_FLOW;
  }
}

function containsBreak(node: Node): boolean {
  if (node.type === 'BreakStatement') return true;
  if (node !== null && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
    return false;
  }
  return childNodes(node).some(containsBreak);
}

function forLoopIterations(node: Node, state: AnalysisState): number | null {
  if (node.type !== 'ForStatement' || node.test?.type !== 'BinaryExpression') return null;
  const test = node.test as Node;
  if (!['<', '<='].includes(test.operator as string) || test.left?.type !== 'Identifier') return null;
  const upper = literalNumber(test.right as Node);
  if (upper === null) return null;
  let initial: number | null = null;
  if (node.init?.type === 'VariableDeclaration') {
    const declaration = (node.init.declarations as Node[])[0];
    if (declaration?.id?.type === 'Identifier' && declaration.id.name === test.left.name) {
      initial = literalNumber(declaration.init as Node | undefined);
    }
  } else if (test.left.type === 'Identifier') {
    initial = literalNumber(resolvedNode(test.left as Node, state));
  }
  if (initial === null) return null;
  return Math.max(0, upper - initial + (test.operator === '<=' ? 1 : 0));
}

function statementFlow(node: Node | null | undefined, state: AnalysisState): Flow {
  if (node === null || node === undefined) return EMPTY_FLOW;
  switch (node.type) {
    case 'Program':
    case 'BlockStatement':
      return sequenceAll((node.body as Node[]).map((entry) => statementFlow(entry, state)));
    case 'VariableDeclaration':
      return sequenceAll((node.declarations as Node[]).map((entry) =>
        expressionFlow(entry.init as Node | undefined, state)));
    case 'ExpressionStatement':
      return expressionFlow(node.expression as Node, state);
    case 'ReturnStatement':
    case 'ThrowStatement':
      return expressionFlow(node.argument as Node | undefined, state);
    case 'IfStatement':
      return sequence(
        expressionFlow(node.test as Node, state),
        choice(
          statementFlow(node.consequent as Node, state),
          statementFlow(node.alternate as Node | undefined, state),
        ),
      );
    case 'ForStatement': {
      const iterations = forLoopIterations(node, state);
      if (iterations === null) {
        state.unboundedLoops += 1;
        const body = statementFlow(node.body as Node, state);
        return sequence(expressionFlow(node.init as Node | undefined, state), multiply(body, 0, null));
      }
      state.boundedLoops += 1;
      const body = statementFlow(node.body as Node, state);
      const minimum = iterations === 0 ? 0 : containsBreak(node.body as Node) ? 1 : iterations;
      return sequence(expressionFlow(node.init as Node | undefined, state), multiply(body, minimum, iterations));
    }
    case 'ForOfStatement':
    case 'ForInStatement': {
      const count = node.type === 'ForOfStatement'
        ? collectionCardinality(node.right as Node, state)
        : null;
      if (count === null) state.unboundedLoops += 1;
      else state.boundedLoops += 1;
      const body = statementFlow(node.body as Node, state);
      const minimum = count === 0 ? 0 : containsBreak(node.body as Node) ? 1 : count ?? 0;
      return sequence(expressionFlow(node.right as Node, state), multiply(body, minimum, count));
    }
    case 'WhileStatement':
    case 'DoWhileStatement': {
      state.unboundedLoops += 1;
      const body = statementFlow(node.body as Node, state);
      const minimum = node.type === 'DoWhileStatement' ? 1 : 0;
      return sequence(expressionFlow(node.test as Node, state), multiply(body, minimum, null));
    }
    case 'TryStatement': {
      const attempted = statementFlow(node.block as Node, state);
      const handler = node.handler as Node | null | undefined;
      const recovery = handler === null || handler === undefined
        ? EMPTY_FLOW
        : statementFlow(handler.body as Node, state);
      const recovered = handler === null || handler === undefined
        ? attempted
        : {
            agents: {
              min: attempted.agents.min,
              max: addMaximum(attempted.agents.max, recovery.agents.max),
            },
            attempts: {
              min: attempted.attempts.min,
              max: addMaximum(attempted.attempts.max, recovery.attempts.max),
            },
          };
      return sequence(recovered, statementFlow(node.finalizer as Node | undefined, state));
    }
    case 'SwitchStatement': {
      const cases = (node.cases as Node[]).map((entry) =>
        sequenceAll((entry.consequent as Node[]).map((statement) => statementFlow(statement, state))));
      const alternatives = cases.reduce(choice, EMPTY_FLOW);
      return sequence(expressionFlow(node.discriminant as Node, state), alternatives);
    }
    case 'LabeledStatement':
      return statementFlow(node.body as Node, state);
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'EmptyStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return EMPTY_FLOW;
    default:
      return expressionFlow(node, state);
  }
}

function ancestorsOf(node: Node, parents: WeakMap<Node, Node>): Node[] {
  const ancestors: Node[] = [];
  let current = parents.get(node);
  while (current !== undefined) {
    ancestors.push(current);
    current = parents.get(current);
  }
  return ancestors;
}

function collectTree(root: Node): { nodes: Node[]; parents: WeakMap<Node, Node> } {
  const nodes: Node[] = [];
  const parents = new WeakMap<Node, Node>();
  const visit = (node: Node): void => {
    nodes.push(node);
    for (const child of childNodes(node)) {
      parents.set(child, node);
      visit(child);
    }
  };
  visit(root);
  return { nodes, parents };
}

function programmaticallyConsumedBindings(
  nodes: readonly Node[],
  parents: WeakMap<Node, Node>,
  agentCalls: readonly Node[],
): { consumed: number; covered: number } {
  const bindingSchema = new Map<string, boolean>();
  for (const call of agentCalls) {
    const declaration = ancestorsOf(call, parents).find((ancestor) => ancestor.type === 'VariableDeclarator');
    if (declaration?.id?.type === 'Identifier') bindingSchema.set(declaration.id.name as string, hasSchema(call));
  }
  const consumed = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'Identifier' || !bindingSchema.has(node.name as string)) continue;
    const parent = parents.get(node);
    if (parent?.type === 'VariableDeclarator' && parent.id === node) continue;
    if (parent !== undefined && [
      'MemberExpression',
      'IfStatement',
      'ConditionalExpression',
      'LogicalExpression',
      'BinaryExpression',
      'CallExpression',
      'ForOfStatement',
      'SwitchStatement',
    ].includes(parent.type)) {
      consumed.add(node.name as string);
    }
  }
  return {
    consumed: consumed.size,
    covered: [...consumed].filter((name) => bindingSchema.get(name) === true).length,
  };
}

function constraintTerms(taskBody: string): Set<string> {
  const relevant = taskBody.split(/\r?\n/u).filter((line) => CONSTRAINT_LINE_RE.test(line)).join(' ');
  return new Set((relevant.toLowerCase().match(TOKEN_RE) ?? [])
    .map((token) => token.replace(/[.,:;]+$/u, ''))
    .filter((token) => !CONSTRAINT_STOP_WORDS.has(token)));
}

function isJsonStringify(node: Node): boolean {
  return node.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.object?.type === 'Identifier'
    && node.callee.object.name === 'JSON'
    && node.callee.property?.type === 'Identifier'
    && node.callee.property.name === 'stringify';
}

function workflowDiagnostics(
  metrics: StaticWorkflowMetrics,
  lintFindings: readonly LintFinding[],
): string[] {
  const diagnostics = lintFindings.map((finding) =>
    `${finding.level}${finding.line === undefined ? '' : `:${finding.line}`}: ${finding.message}`);
  if (metrics.unboundedLoops > 0) diagnostics.push('static: workflow contains a dynamic or unbounded loop');
  if (metrics.unsafeParallelMutators > 0) {
    diagnostics.push(`static: ${metrics.unsafeParallelMutators} parallel mutation group(s) lack explicit ownership or worktree isolation`);
  }
  if (metrics.retryDeclarations > 0) {
    diagnostics.push(`static: ${metrics.retryDeclarations} agent call(s) declare engine retries; prefer result-driven semantic recovery`);
  }
  if (metrics.duplicateSerializedBindings.length > 0) {
    diagnostics.push(`static: repeated JSON serialization of ${metrics.duplicateSerializedBindings.join(', ')}`);
  }
  if (metrics.programmaticAgentResults > metrics.schemaCoveredProgrammaticResults) {
    diagnostics.push('static: a programmatically consumed agent result lacks a literal schema');
  }
  return diagnostics;
}

/** Parse one workflow and calculate conservative structural proxy metrics. */
export function analyzeWorkflowSource(source: string, taskBody = ''): WorkflowAnalysisResult {
  let ast: Node;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as Node;
  } catch (error) {
    return {
      metrics: null,
      lintFindings: [],
      diagnostics: [`parse: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const lintFindings = lintWorkflowSource(source);
  const state: AnalysisState = {
    bindings: new Map(),
    activeFunctions: new Set(),
    boundedLoops: 0,
    unboundedLoops: 0,
  };
  collectBindings(ast, state.bindings);
  const flow = statementFlow(ast, state);
  const { nodes, parents } = collectTree(ast);
  const calls = nodes.filter((node) => node.type === 'CallExpression');
  const agentCalls = calls.filter((node) => callName(node) === 'agent');
  const programmatic = programmaticallyConsumedBindings(nodes, parents, agentCalls);
  const stringifyCalls = calls.filter(isJsonStringify);
  const serializedBindings = new Map<string, number>();
  for (const call of stringifyCalls) {
    const argument = call.arguments?.[0] as Node | undefined;
    if (argument?.type === 'Identifier') {
      serializedBindings.set(argument.name as string, (serializedBindings.get(argument.name as string) ?? 0) + 1);
    }
  }

  let unsafeParallelMutators = 0;
  for (const parallel of calls.filter((node) => callName(node) === 'parallel')) {
    const nestedAgents = childNodes(parallel).flatMap(function flatten(node): Node[] {
      return [node, ...childNodes(node).flatMap(flatten)];
    }).filter((node) => callName(node) === 'agent');
    const mutators = nestedAgents.filter((agentCall) => MUTATION_RE.test(agentPrompt(agentCall)));
    if (mutators.length >= 2 && mutators.some((agentCall) =>
      !hasWorktreeIsolation(agentCall) && !OWNERSHIP_RE.test(agentPrompt(agentCall)))) {
      unsafeParallelMutators += 1;
    }
  }

  const terms = constraintTerms(taskBody);
  const mutatingPromptText = agentCalls
    .map(agentPrompt)
    .filter((prompt) => MUTATION_RE.test(prompt))
    .join(' ')
    .toLowerCase();
  const coveredTerms = [...terms].filter((term) => mutatingPromptText.includes(term)).length;
  const conditionalRepairCalls = agentCalls.filter((node) =>
    REPAIR_RE.test(`${agentLabel(node)} ${agentPrompt(node)}`)
    && ancestorsOf(node, parents).some((ancestor) =>
      ['IfStatement', 'ConditionalExpression', 'CatchClause'].includes(ancestor.type))).length;
  const totalRepairCalls = agentCalls.filter((node) =>
    REPAIR_RE.test(`${agentLabel(node)} ${agentPrompt(node)}`)).length;
  const metrics: StaticWorkflowMetrics = {
    parseValid: true,
    sourceBytes: Buffer.byteLength(source, 'utf8'),
    agentCallSites: agentCalls.length,
    agentCalls: flow.agents,
    dispatchAttempts: flow.attempts,
    phaseCalls: calls.filter((node) => callName(node) === 'phase').length,
    parallelCalls: calls.filter((node) => callName(node) === 'parallel').length,
    pipelineCalls: calls.filter((node) => callName(node) === 'pipeline').length,
    conditionalBranches: nodes.filter((node) =>
      ['IfStatement', 'ConditionalExpression', 'SwitchStatement'].includes(node.type)).length,
    boundedLoops: state.boundedLoops,
    unboundedLoops: state.unboundedLoops,
    retryDeclarations: agentCalls.filter((node) => declaredRetries(node) > 0).length,
    maximumDeclaredRetries: agentCalls.reduce((maximum, node) => Math.max(maximum, declaredRetries(node)), 0),
    schemaAgentCallSites: agentCalls.filter(hasSchema).length,
    programmaticAgentResults: programmatic.consumed,
    schemaCoveredProgrammaticResults: programmatic.covered,
    jsonStringifyCalls: stringifyCalls.length,
    duplicateSerializedBindings: [...serializedBindings]
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
      .sort(),
    worktreeIsolations: agentCalls.filter(hasWorktreeIsolation).length,
    unsafeParallelMutators,
    conditionalRepairCalls,
    unconditionalRepairCalls: totalRepairCalls - conditionalRepairCalls,
    triageOrAdjudicationCalls: agentCalls.filter((node) =>
      TRIAGE_RE.test(`${agentLabel(node)} ${agentPrompt(node)}`)).length,
    throwStatements: nodes.filter((node) => node.type === 'ThrowStatement').length,
    failClosedSignals: nodes.filter((node) => node.type === 'ThrowStatement').length
      + agentCalls.filter((node) => FAIL_CLOSED_RE.test(`${agentLabel(node)} ${agentPrompt(node)}`)).length,
    constraintTerms: terms.size,
    mutatingPromptConstraintCoverage: terms.size === 0 ? null : coveredTerms / terms.size,
    lintErrors: lintFindings.filter((finding) => finding.level === 'error').length,
    lintWarnings: lintFindings.filter((finding) => finding.level === 'warning').length,
  };
  return { metrics, lintFindings, diagnostics: workflowDiagnostics(metrics, lintFindings) };
}
