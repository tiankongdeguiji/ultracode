import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../src/backends/claude.js';
import { QoderAdapter } from '../../src/backends/qoder.js';
import { GeminiAdapter } from '../../src/backends/gemini.js';
import type { AgentEvent, AgentRequest, BackendAdapter } from '../../src/backends/types.js';

const FIX = join(__dirname, '../fixtures');

function replay(adapter: BackendAdapter, fixture: string): AgentEvent[] {
  const parser = adapter.createParser();
  const events: AgentEvent[] = [];
  for (const line of readFileSync(join(FIX, fixture), 'utf8').split('\n')) {
    if (line.trim()) events.push(...parser.push(line));
  }
  events.push(...parser.end());
  return events;
}

function req(o: Partial<AgentRequest> = {}): AgentRequest {
  return { prompt: 'p', cwd: '/w', permission: 'auto', env: {}, ...o };
}

describe('ClaudeAdapter', () => {
  const a = new ClaudeAdapter();

  it('parses the live success-hello fixture: session, message, usage, ok', () => {
    const events = replay(a, 'claude/success-hello.jsonl');
    expect(events.find((e) => e.kind === 'session')).toMatchObject({ sessionId: 'be150d68-39d3-429d-851b-f15f48fbdf10', model: 'claude-opus-4-8[1m]' });
    expect(events.filter((e) => e.kind === 'message').at(-1)).toMatchObject({ text: 'hello' });
    // The assistant line's per-API-call usage surfaces as one interim tick…
    const interim = events.filter((e) => e.kind === 'usage' && e.interim);
    expect(interim).toHaveLength(1);
    expect(interim[0]).toMatchObject({ usage: { inputTokens: 5530, outputTokens: 1, cachedInputTokens: 15084 } });
    // …and stays out of accounting: extractUsage totals are unchanged.
    const usage = a.extractUsage(events);
    expect(usage.inputTokens).toBe(5530); // 3454 input + 2076 cache_creation (write-through; previously dropped)
    expect(usage.outputTokens).toBe(4);
    expect(usage.cachedInputTokens).toBe(15084);
    expect(usage.costUSD).toBeCloseTo(0.046255, 5);
    expect(a.classifyExit(0, null, events, '')).toMatchObject({ ok: true });
  });

  it('emits an interim usage tick per assistant message; accounting stays terminal-only', () => {
    const events = replay(a, 'claude/streaming-usage.jsonl');
    const interim = events.filter((e): e is Extract<AgentEvent, { kind: 'usage' }> => e.kind === 'usage' && e.interim === true);
    expect(interim.map((e) => e.usage)).toEqual([
      expect.objectContaining({ inputTokens: 150, outputTokens: 20, cachedInputTokens: 1000 }), // 100 + 50 cache_creation
      expect.objectContaining({ inputTokens: 200, outputTokens: 40, cachedInputTokens: 1200 }),
    ]);
    expect(interim.every((e) => e.usage.costUSD === undefined)).toBe(true); // cost only exists on the result line
    const usage = a.extractUsage(events);
    expect(usage).toMatchObject({ inputTokens: 350, outputTokens: 60, cachedInputTokens: 2200, totalTokens: 630 });
    expect(usage.costUSD).toBeCloseTo(0.0123, 5);
  });

  it('dedupes interim usage across per-content-block assistant lines of one API call', () => {
    const events = replay(a, 'claude/multiblock-usage.jsonl');
    const interim = events.filter((e): e is Extract<AgentEvent, { kind: 'usage' }> => e.kind === 'usage' && e.interim === true);
    // msg_01 spans two lines (text + tool_use, identical usage) → ONE tick; msg_02 → one more.
    expect(interim.map((e) => e.usage)).toEqual([
      expect.objectContaining({ inputTokens: 100, outputTokens: 30, cachedInputTokens: 500 }),
      expect.objectContaining({ inputTokens: 180, outputTokens: 55, cachedInputTokens: 700 }),
    ]);
    expect(a.extractUsage(events)).toMatchObject({ inputTokens: 280, outputTokens: 85, cachedInputTokens: 1200 });
  });

  it('builds --json-schema and stdin prompt; resume targets the session', () => {
    const plan = a.buildSpawn(req({ schema: { type: 'object' }, model: 'sonnet' }));
    expect(plan.argv).toContain('--json-schema');
    expect(plan.argv).toContain('{"type":"object"}');
    expect(plan.argv).toContain('stream-json');
    expect(plan.stdinData).toBe('p');
    expect(a.buildResume('sid', 'fix it', req())!.argv).toContain('sid');
  });

  it('permission maps to permission-mode', () => {
    expect(a.buildSpawn(req({ permission: 'safe' })).argv).toContain('default');
    expect(a.buildSpawn(req({ permission: 'danger' })).argv).toContain('bypassPermissions');
  });

  it('resume pins the SAME permission-mode as spawn (settings defaults must not govern the retry leg)', () => {
    const argv = a.buildResume('sid', 'continue', req({ permission: 'safe' }))!.argv;
    expect(argv).toEqual(expect.arrayContaining(['--permission-mode', 'default']));
    expect(a.buildResume('sid', 'continue', req({ permission: 'danger' }))!.argv).toContain('bypassPermissions');
  });
});

describe('QoderAdapter', () => {
  const a = new QoderAdapter();

  it('parses structured_output from the terminal result line', () => {
    const events = replay(a, 'qoder/success-structured.jsonl');
    const result = events.find((e) => e.kind === 'result');
    expect(result).toMatchObject({ isError: false, structured: { count: 5 } });
    expect(a.extractUsage(events)).toMatchObject({ inputTokens: 800, outputTokens: 12, cachedInputTokens: 100 });
    // qoder's assistant lines omit usage → no interim ticks (graceful degradation)
    expect(events.some((e) => e.kind === 'usage' && e.interim)).toBe(false);
    expect(a.classifyExit(0, null, events, '')).toMatchObject({ ok: true });
  });

  it('maps error_max_turns and exit 41 auth', () => {
    const events = replay(a, 'qoder/error-max-turns.jsonl');
    expect(a.classifyExit(0, null, events, '')).toMatchObject({ ok: false, errorKind: 'max-turns' });
    expect(a.classifyExit(41, null, [], 'auth failed')).toMatchObject({ ok: false, errorKind: 'auth', retryable: false });
  });

  it('builds --print --json-schema, agent routing, and -w cwd', () => {
    const plan = a.buildSpawn(req({ schema: { type: 'object' }, agentType: 'uc-xhigh' }));
    expect(plan.argv).toContain('--print');
    expect(plan.argv).toContain('--json-schema');
    expect(plan.argv).toEqual(expect.arrayContaining(['--agent', 'uc-xhigh', '-w', '/w']));
  });

  it('resume pins the SAME permission-mode/model/agent as spawn', () => {
    const argv = a.buildResume('sid', 'continue', req({ permission: 'safe', model: 'm1', agentType: 'uc-xhigh' }))!.argv;
    expect(argv).toEqual(expect.arrayContaining(['-r', 'sid', '--permission-mode', 'dont_ask', '--model', 'm1', '--agent', 'uc-xhigh']));
  });
});

describe('GeminiAdapter (emulated)', () => {
  const a = new GeminiAdapter();

  it('is an emulated backend with no resume', () => {
    expect(a.structuredOutput).toBe('emulated');
    expect(a.buildResume()).toBeNull();
  });

  it('parses response text, tool lifecycle, and stats usage', () => {
    const events = replay(a, 'gemini/success-json.jsonl');
    expect(events.find((e) => e.kind === 'session')).toMatchObject({ sessionId: 'gem-1', model: 'gemini' });
    const result = events.find((e) => e.kind === 'result');
    expect(result).toMatchObject({ isError: false, text: 'Here is the JSON: {"count": 7}' });
    const tools = events.filter((e) => e.kind === 'tool');
    expect(tools.map((t) => t.kind === 'tool' && t.status)).toEqual(['started', 'completed']);
    expect(a.extractUsage(events)).toMatchObject({ inputTokens: 1200, outputTokens: 30 });
  });

  it('prompt in argv (no stdin); permission maps to least privilege (--yolo only at danger)', () => {
    const plan = a.buildSpawn(req({ prompt: 'do X' })); // default permission = auto
    expect(plan.argv).toEqual(expect.arrayContaining(['-p', 'do X', '--output-format', 'stream-json', '--approval-mode', 'auto_edit']));
    expect(plan.argv).not.toContain('--yolo');
    expect(plan.stdinData).toBeUndefined();
    expect(a.buildSpawn(req({ permission: 'safe' })).argv).not.toContain('--yolo');
    expect(a.buildSpawn(req({ permission: 'safe' })).argv).not.toContain('--approval-mode');
    expect(a.buildSpawn(req({ permission: 'danger' })).argv).toContain('--yolo');
  });

  it('exit codes: 42 → schema-rejected, 53 → max-turns, other → retryable infra; exit 0 requires a terminal non-error result', () => {
    expect(a.classifyExit(42, null, [], 'bad input')).toMatchObject({ errorKind: 'schema-rejected', retryable: false });
    expect(a.classifyExit(53, null, [], '')).toMatchObject({ errorKind: 'max-turns', retryable: false });
    expect(a.classifyExit(1, null, [], 'oops')).toMatchObject({ errorKind: 'infra', retryable: true });
    // Exit 0 alone is NOT success: a truncated stream (no result) is retryable infra.
    expect(a.classifyExit(0, null, [], '')).toMatchObject({ ok: false, errorKind: 'infra', retryable: true });
    // Exit 0 with a terminal non-error result → ok.
    expect(a.classifyExit(0, null, [{ kind: 'result', isError: false, text: 'done' }], '')).toMatchObject({ ok: true });
    // Exit 0 with an in-band error result → not ok.
    expect(a.classifyExit(0, null, [{ kind: 'result', isError: true }], '')).toMatchObject({ ok: false });
  });
});

describe('backend factory', () => {
  it('creates an executor for every implemented backend', async () => {
    const { createExecutorForBackend } = await import('../../src/engine/agentcall.js');
    for (const b of ['codex', 'qoder', 'claude', 'gemini']) {
      expect(createExecutorForBackend(b)).not.toBeNull();
    }
    expect(createExecutorForBackend('nonesuch')).toBeNull();
  });

  it('wires the codex MCP kill-switch through createExecutorForBackend (the fork-bomb defense)', async () => {
    // Pins the load-bearing wiring: if a refactor drops the adapter's kill-switch
    // from the factory's codex path, worker isolation vanishes silently.
    const { createExecutorForBackend } = await import('../../src/engine/agentcall.js');
    const ex = createExecutorForBackend('codex') as unknown as { adapter: BackendAdapter };
    const argv = ex.adapter.buildSpawn({ prompt: 'p', cwd: '/w', permission: 'auto', env: {} }).argv;
    expect(argv.join(' ')).toContain('mcp_servers.ultracode={command="true",enabled=false}');
  });
});
