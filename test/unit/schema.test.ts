import { describe, it, expect } from 'vitest';
import { checkCodexStrictSchema } from '../../src/backends/schema-strict.js';
import { extractJsonCandidate, schemaPromptSuffix, freshRepairPrompt } from '../../src/backends/structured.js';
import { validateWithSchema } from '../../src/engine/ajv.js';
import { AgentCallExecutor } from '../../src/engine/agentcall.js';
import { executeWorkflow } from '../../src/engine/run.js';
import { MockExecutor } from '../../src/backends/mock.js';
import type {
  AgentEvent,
  AgentRequest,
  AgentSpec,
  BackendAdapter,
  ExitClass,
  JsonSchema,
  SpawnPlan,
} from '../../src/backends/types.js';
import { usageFromEvents } from '../../src/backends/usage.js';
import { parseJsonLine } from '../../src/backends/ndjson.js';

describe('checkCodexStrictSchema', () => {
  it('rejects non-object roots naming the path', () => {
    const r = checkCodexStrictSchema({ type: 'array', items: { type: 'string' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('root');
  });

  it('rejects oneOf/allOf/patternProperties with the offending path', () => {
    for (const [kw, schema] of [
      ['oneOf', { type: 'object', properties: { x: { oneOf: [{ type: 'string' }] } } }],
      ['allOf', { type: 'object', properties: { x: { allOf: [{ type: 'string' }] } } }],
      ['patternProperties', { type: 'object', patternProperties: { '^a': { type: 'string' } } }],
    ] as const) {
      const r = checkCodexStrictSchema(schema as JsonSchema);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(kw);
    }
  });

  it('rejects map-style additionalProperties (data-lossy narrowing)', () => {
    const r = checkCodexStrictSchema({
      type: 'object',
      properties: { m: { type: 'object', additionalProperties: { type: 'number' } } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('additionalProperties');
  });

  it('normalizes the wire copy (required + additionalProperties:false at every level) without touching the original', () => {
    const original: JsonSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        nested: { type: 'object', properties: { a: { type: 'number' } } },
        list: { type: 'array', items: { type: 'object', properties: { b: { type: 'boolean' } } } },
      },
      required: ['name'],
    };
    const before = JSON.stringify(original);
    const r = checkCodexStrictSchema(original);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const wire = r.wireSchema as any;
      expect(wire.required).toEqual(['name', 'nested', 'list']);
      expect(wire.additionalProperties).toBe(false);
      expect(wire.properties.nested.required).toEqual(['a']);
      expect(wire.properties.nested.additionalProperties).toBe(false);
      expect(wire.properties.list.items.required).toEqual(['b']);
    }
    expect(JSON.stringify(original)).toBe(before); // original untouched

    // Narrowing property: anything valid under the wire schema validates under the original.
    const value = { name: 'x', nested: { a: 1 }, list: [{ b: true }] };
    expect(validateWithSchema(original, value).ok).toBe(true);
  });

  it('accepts the expanded strict keywords (pattern, minimum, minItems...)', () => {
    const r = checkCodexStrictSchema({
      type: 'object',
      properties: {
        n: { type: 'integer', minimum: 0, maximum: 10 },
        s: { type: 'string', pattern: '^a', minLength: 1, maxLength: 5 },
        arr: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
        u: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    });
    expect(r.ok).toBe(true);
  });
});

describe('structured helpers', () => {
  it('extractJsonCandidate: raw JSON, fenced JSON, embedded JSON, garbage', () => {
    expect(extractJsonCandidate('{"a":1}')!.value).toEqual({ a: 1 });
    expect(extractJsonCandidate('```json\n{"a":1}\n```')!.value).toEqual({ a: 1 });
    expect(extractJsonCandidate('Sure! Here is the data: {"a":1} hope that helps')!.value).toEqual({ a: 1 });
    expect(extractJsonCandidate('[1,2]')!.value).toEqual([1, 2]);
    expect(extractJsonCandidate('no json here')).toBeNull();
  });

  it('prompt suffix and repair prompt embed the schema and errors', () => {
    const schema: JsonSchema = { type: 'object', properties: { x: { type: 'number' } } };
    expect(schemaPromptSuffix(schema)).toContain('"type":"object"');
    const repair = freshRepairPrompt('do the task', '{"x":"str"}', ['/x must be number'], schema);
    expect(repair).toContain('do the task');
    expect(repair).toContain('/x must be number');
    expect(repair).toContain('{"x":"str"}');
  });
});

/**
 * Scripted fake adapter: each spawn "runs" `node -e` printing pre-scripted
 * NDJSON — real subprocesses, hermetic, no network.
 */
class FakeAdapter implements BackendAdapter {
  readonly id = 'mock' as const;
  spawnCount = 0;
  resumeCount = 0;
  inputPrompts: string[] = [];

  constructor(
    readonly structuredOutput: 'native' | 'emulated',
    private readonly scripts: string[][], // per-spawn stdout lines
    private readonly withSession = true,
  ) {}

  probe() {
    return Promise.resolve({ available: true });
  }

  checkSchema(schema: JsonSchema) {
    if (schema['x-reject']) return { ok: false as const, reason: '$.x-reject: rejected by fake' };
    return { ok: true as const, wireSchema: schema };
  }

  private planFor(lines: string[], prompt: string): SpawnPlan {
    const script = lines.map((l) => `console.log(${JSON.stringify(l)})`).join(';');
    this.inputPrompts.push(prompt);
    return { bin: process.execPath, argv: ['-e', script], env: {}, stdinData: prompt };
  }

  buildSpawn(req: AgentRequest): SpawnPlan {
    const lines = this.scripts[Math.min(this.spawnCount, this.scripts.length - 1)]!;
    this.spawnCount++;
    return this.planFor(lines, req.prompt);
  }

  buildResume(_sessionId: string, prompt: string, _req: AgentRequest): SpawnPlan | null {
    if (!this.withSession) return null;
    this.resumeCount++;
    const lines = this.scripts[Math.min(this.spawnCount, this.scripts.length - 1)]!;
    this.spawnCount++;
    return this.planFor(lines, prompt);
  }

  createParser() {
    return {
      push(line: string): AgentEvent[] {
        const obj = parseJsonLine(line) as Record<string, unknown> | undefined;
        if (!obj) return [];
        if (typeof obj.session === 'string') return [{ kind: 'session', sessionId: obj.session }];
        if (typeof obj.text === 'string') return [{ kind: 'message', text: obj.text }];
        if (obj.done) return [{ kind: 'result', isError: false }];
        return [];
      },
      end: (): AgentEvent[] => [],
    };
  }

  classifyExit(code: number | null): ExitClass {
    return code === 0
      ? { ok: true, retryable: false, message: 'ok' }
      : { ok: false, errorKind: 'infra', retryable: false, message: `exit ${code}` };
  }

  extractUsage(events: AgentEvent[]) {
    return usageFromEvents(events);
  }
}

function spec(schema?: JsonSchema): AgentSpec {
  return { seq: 0, prompt: 'task', label: 't', backend: 'mock', cwd: process.cwd(), retries: 0, schema };
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: { count: { type: 'number' } },
  required: ['count'],
  additionalProperties: false,
};

const signal = new AbortController().signal;

describe('AgentCallExecutor structured-output pipeline', () => {
  it('rejects incompatible schemas with ZERO spawns (fail fast)', async () => {
    const adapter = new FakeAdapter('native', [[]]);
    const ex = new AgentCallExecutor(adapter);
    const outcome = await ex.execute(spec({ 'x-reject': true } as JsonSchema), signal);
    expect(outcome).toMatchObject({ ok: false, errorKind: 'schema-rejected', attempts: 0 });
    expect(adapter.spawnCount).toBe(0);
  });

  it('valid first answer: returns the parsed object, ajv-verified', async () => {
    const adapter = new FakeAdapter('native', [
      [JSON.stringify({ session: 's1' }), JSON.stringify({ text: '{"count": 3}' }), JSON.stringify({ done: 1 })],
    ]);
    const ex = new AgentCallExecutor(adapter);
    const outcome = await ex.execute(spec(SCHEMA), signal);
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toEqual({ count: 3 });
    expect(adapter.spawnCount).toBe(1);
  });

  it('invalid answer repaired via resume: buildResume used once, validated object returned', async () => {
    const firstOutput = '{"count": "three"}';
    const adapter = new FakeAdapter('native', [
      [JSON.stringify({ session: 's1' }), JSON.stringify({ text: firstOutput }), JSON.stringify({ done: 1 })],
      [JSON.stringify({ text: '{"count": 3}' }), JSON.stringify({ done: 1 })],
    ]);
    const ex = new AgentCallExecutor(adapter);
    const outcome = await ex.execute(spec(SCHEMA), signal);
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toEqual({ count: 3 });
    expect(adapter.resumeCount).toBe(1);
    expect(adapter.spawnCount).toBe(2);
    expect(outcome.usage.inputTokens).toBe(
      Math.ceil('task'.length / 4) +
      Math.ceil(('task'.length + firstOutput.length + adapter.inputPrompts[1]!.length) / 4),
    );
  });

  it('persistently invalid: fails after exactly 2 repairs with structured-output-retries', async () => {
    const bad = [JSON.stringify({ session: 's1' }), JSON.stringify({ text: '{"count": "no"}' }), JSON.stringify({ done: 1 })];
    const adapter = new FakeAdapter('native', [bad, bad, bad, bad]);
    const ex = new AgentCallExecutor(adapter);
    const outcome = await ex.execute(spec(SCHEMA), signal);
    expect(outcome).toMatchObject({ ok: false, errorKind: 'structured-output-retries' });
    expect(outcome.error).toContain('after 2 repair attempts');
    expect(adapter.spawnCount).toBe(3); // 1 original + 2 repairs
  });

  it('emulated backends get the prompt contract and fresh-spawn repairs', async () => {
    const adapter = new FakeAdapter(
      'emulated',
      [
        [JSON.stringify({ text: 'Here you go: ```json\n{"count": "NaN"}\n```' }), JSON.stringify({ done: 1 })],
        [JSON.stringify({ text: '{"count": 7}' }), JSON.stringify({ done: 1 })],
      ],
      false, // no session → fresh-spawn repair path
    );
    const ex = new AgentCallExecutor(adapter);
    const outcome = await ex.execute(spec(SCHEMA), signal);
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toEqual({ count: 7 });
    expect(adapter.resumeCount).toBe(0);
    expect(adapter.spawnCount).toBe(2);
    expect(outcome.usage.inputTokens).toBe(
      adapter.inputPrompts.reduce((sum, prompt) => sum + Math.ceil(prompt.length / 4), 0),
    );
    expect(adapter.inputPrompts[0]).toContain('Respond with ONLY a single JSON value');
    expect(adapter.inputPrompts[1]).toContain('failed JSON Schema validation');
  });

  it('schema failures do not consume task retries (retries:5 still fails after 2 repairs)', async () => {
    const bad = [JSON.stringify({ text: '{"count": false}' }), JSON.stringify({ done: 1 })];
    const adapter = new FakeAdapter('native', [bad, bad, bad, bad, bad, bad, bad], false);
    const ex = new AgentCallExecutor(adapter);
    const outcome = await ex.execute({ ...spec(SCHEMA), retries: 5 }, signal);
    expect(outcome.ok).toBe(false);
    expect(adapter.spawnCount).toBe(3); // never re-enters the task-retry loop
  });
});

describe('mock backend schema contract (dry-run substrate)', () => {
  const META = `export const meta = { name: 's', description: 'd' }\n`;

  it('agent({schema}) returns the validated object on mock', async () => {
    const out = await executeWorkflow(META + `return agent('MOCK:ok {"count": 5}', { schema: ${JSON.stringify(SCHEMA)} })`, {
      executor: new MockExecutor(),
    });
    expect(out.result).toEqual({ count: 5 });
  });

  it('schema-invalid mock output fails with the pipeline error shape', async () => {
    const out = await executeWorkflow(META + `return agent('MOCK:badjson', { schema: ${JSON.stringify(SCHEMA)} })`, {
      executor: new MockExecutor(),
    });
    expect(out.error).toContain('structured output failed validation');
    expect(out.failures[0]).toContain('agent[0]');
  });
});
