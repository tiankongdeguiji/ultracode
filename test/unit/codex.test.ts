import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter, classifyFailureMessage, codexConfigHasUltracodeMcp } from '../../src/backends/codex.js';
import { NdjsonSplitter } from '../../src/backends/ndjson.js';
import type { AgentEvent, AgentRequest } from '../../src/backends/types.js';

const FIXTURES = join(__dirname, '../fixtures/codex');

function replay(fixture: string): AgentEvent[] {
  const adapter = new CodexAdapter();
  const parser = adapter.createParser();
  const events: AgentEvent[] = [];
  for (const line of readFileSync(join(FIXTURES, fixture), 'utf8').split('\n')) {
    if (line.trim()) events.push(...parser.push(line));
  }
  events.push(...parser.end());
  return events;
}

function req(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return { prompt: 'p', cwd: '/w', permission: 'auto', env: {}, ...overrides };
}

describe('CodexAdapter.buildSpawn', () => {
  it('builds the canonical argv: --json, --skip-git-repo-check, --cd, sandbox mapping, stdin prompt', () => {
    const plan = new CodexAdapter().buildSpawn(req());
    expect(plan.argv).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      '/w',
      '--sandbox',
      'workspace-write',
      '-',
    ]);
    expect(plan.stdinData).toBe('p');
    expect(plan.argv).not.toContain('-o'); // stale-file trap: never -o
    expect(plan.argv).not.toContain('--output-last-message');
    expect(plan.argv).not.toContain('--ephemeral'); // resume needs sessions
  });

  it('maps permissions: safe→read-only, danger→danger-full-access, never --yolo', () => {
    expect(new CodexAdapter().buildSpawn(req({ permission: 'safe' })).argv).toContain('read-only');
    const danger = new CodexAdapter().buildSpawn(req({ permission: 'danger' })).argv;
    expect(danger).toContain('danger-full-access');
    expect(danger.join(' ')).not.toContain('dangerously-bypass');
  });

  it('adds model and reasoning-effort overrides', () => {
    const plan = new CodexAdapter().buildSpawn(req({ model: 'gpt-5.3-codex-spark', effort: 'low' }));
    expect(plan.argv).toContain('-m');
    expect(plan.argv).toContain('gpt-5.3-codex-spark');
    expect(plan.argv.join(' ')).toContain('model_reasoning_effort="low"');
  });

  it('requests a schema temp file for structured output', () => {
    const plan = new CodexAdapter().buildSpawn(req({ schema: { type: 'object' } }));
    expect(plan.schemaTempFile?.content).toBe('{"type":"object"}');
  });

  it('buildResume re-attaches cwd/sandbox and targets the thread id', () => {
    const plan = new CodexAdapter().buildResume('thread-123', 'fix the JSON', req())!;
    expect(plan.argv.slice(0, 3)).toEqual(['exec', 'resume', 'thread-123']);
    expect(plan.stdinData).toBe('fix the JSON');
  });

  it('hideUltracodeMcp appends the MCP kill-switch on spawn AND resume; default stays clean', () => {
    const KILL = ['-c', 'mcp_servers.ultracode.enabled=false'];
    for (const plan of [
      new CodexAdapter(undefined, true).buildSpawn(req()),
      new CodexAdapter(undefined, true).buildResume('thread-123', 'fix', req())!,
    ]) {
      const at = plan.argv.indexOf(KILL[0]!);
      expect(plan.argv.slice(at, at + 2)).toEqual(KILL);
      expect(plan.argv.at(-1)).toBe('-'); // stdin positional stays last
    }
    // Unconditional emission would hard-fail codex startup ("invalid transport")
    // on machines without [mcp_servers.ultracode] in config.toml.
    expect(new CodexAdapter().buildSpawn(req()).argv.join(' ')).not.toContain('mcp_servers');
    expect(new CodexAdapter().buildResume('t', 'f', req())!.argv.join(' ')).not.toContain('mcp_servers');
  });
});

describe('codexConfigHasUltracodeMcp', () => {
  function homeWith(config?: string): string {
    const home = mkdtempSync(join(tmpdir(), 'uc-codexhome-'));
    if (config !== undefined) writeFileSync(join(home, 'config.toml'), config);
    return home;
  }

  it('detects the installer-registered server; false without it or without a config', () => {
    expect(codexConfigHasUltracodeMcp({ CODEX_HOME: homeWith() })).toBe(false); // no config.toml
    expect(
      codexConfigHasUltracodeMcp({ CODEX_HOME: homeWith('model = "gpt-5"\n[mcp_servers.other]\ncommand = "x"\n') }),
    ).toBe(false);
    expect(
      codexConfigHasUltracodeMcp({
        CODEX_HOME: homeWith('model = "gpt-5"\n\n[mcp_servers.ultracode]\ncommand = "node"\nargs = ["main.js", "mcp"]\n'),
      }),
    ).toBe(true);
  });

  it('detects hand-edited TOML spellings (a missed one silently drops the kill-switch)', () => {
    for (const config of [
      '[ mcp_servers . ultracode ]\ncommand = "node"\n', // whitespace in header
      '[mcp_servers."ultracode"]\ncommand = "node"\n', // quoted key
      '[mcp_servers.ultracode.env]\nFOO = "1"\n', // subtable only
      'mcp_servers.ultracode.command = "node"\n', // root dotted keys
      'mcp_servers.ultracode = { command = "node" }\n', // root inline table
      '[mcp_servers]\nother = { command = "x", args = ["y"] }\nultracode = { command = "node" }\n', // member
      '[mcp_servers]\nultracode.command = "node"\n', // dotted member
    ]) {
      expect(codexConfigHasUltracodeMcp({ CODEX_HOME: homeWith(config) })).toBe(true);
    }
    for (const config of [
      '[mcp_servers.ultracoded]\ncommand = "x"\n', // name is a prefix, not ours
      '[other_table]\nultracode = { command = "x" }\n', // right key, wrong table
      '# [mcp_servers.ultracode] mentioned in a comment only\n',
    ]) {
      expect(codexConfigHasUltracodeMcp({ CODEX_HOME: homeWith(config) })).toBe(false);
    }
  });

  it('treats empty CODEX_HOME as unset — never reads a cwd-relative config.toml', () => {
    // A repo-planted ./config.toml registering the name would otherwise force
    // the kill-switch against an UNREGISTERED server and hard-fail every worker.
    const dir = homeWith('[mcp_servers.ultracode]\ncommand = "planted"\n');
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      // '' must behave exactly like unset (resolve to the real ~/.codex),
      // regardless of what the current directory contains.
      expect(codexConfigHasUltracodeMcp({ CODEX_HOME: '' })).toBe(codexConfigHasUltracodeMcp({}));
    } finally {
      process.chdir(prevCwd);
    }
  });
});

describe('CodexAdapter parser + classifyExit on golden fixtures', () => {
  it('success-hello (LIVE fixture): session, last message, usage, ok exit', () => {
    const adapter = new CodexAdapter();
    const events = replay('success-hello.jsonl');

    expect(events.find((e) => e.kind === 'session')).toEqual({
      kind: 'session',
      sessionId: '019f2a5c-17ea-7321-a74e-e60c4623650f',
    });
    const messages = events.filter((e) => e.kind === 'message');
    expect(messages.at(-1)).toMatchObject({ text: 'hello' });

    // turn.completed reports the SESSION total — flagged so the executor
    // never sums a resumed attempt on top of its own prefix.
    expect(events.find((e) => e.kind === 'usage')).toMatchObject({ threadCumulative: true });

    const usage = adapter.extractUsage(events);
    // codex reports cached ⊂ input and reasoning ⊂ output: the adapter emits
    // uncached input (12090-9600) and drops reasoning (already in output) so
    // finalizeUsage doesn't double-count.
    expect(usage).toMatchObject({
      inputTokens: 12090 - 9600,
      cachedInputTokens: 9600,
      outputTokens: 17,
      reasoningTokens: 0,
    });
    expect(usage.totalTokens).toBe(12090 - 9600 + 17 + Math.round(0.1 * 9600));

    const exit = adapter.classifyExit(0, null, events, '');
    expect(exit).toMatchObject({ ok: true });
  });

  it('intermediate-messages (#19816): the LAST agent_message wins', () => {
    const events = replay('intermediate-messages.jsonl');
    const messages = events.filter((e) => e.kind === 'message');
    expect(messages).toHaveLength(2);
    expect(messages.at(-1)).toMatchObject({ text: '{"final":"the real answer"}' });
  });

  it('reconnect-then-success: error events are notices, run is ok', () => {
    const adapter = new CodexAdapter();
    const events = replay('reconnect-then-success.jsonl');
    const notices = events.filter((e) => e.kind === 'notice');
    expect(notices.length).toBe(2);
    expect(adapter.classifyExit(0, null, events, '')).toMatchObject({ ok: true });
  });

  it('schema-rejected: non-retryable schema-rejected classification on exit 1', () => {
    const adapter = new CodexAdapter();
    const events = replay('schema-rejected.jsonl');
    const exit = adapter.classifyExit(1, null, events, '');
    expect(exit).toMatchObject({ ok: false, errorKind: 'schema-rejected', retryable: false });
  });

  it('usage-limit turn failure: rate-limit, non-retryable', () => {
    const adapter = new CodexAdapter();
    const events = replay('turn-failed-usage-limit.jsonl');
    const exit = adapter.classifyExit(1, null, events, '');
    expect(exit).toMatchObject({ ok: false, errorKind: 'rate-limit', retryable: false });
  });

  it('tool-usage: tool lifecycle events with failed detection', () => {
    const events = replay('tool-usage.jsonl');
    const tools = events.filter((e) => e.kind === 'tool');
    expect(tools.map((t) => t.kind === 'tool' && t.status)).toEqual(['started', 'completed', 'started', 'completed', 'failed']);
  });

  it('exit 0 without turn.completed is a retryable infra failure', () => {
    const adapter = new CodexAdapter();
    const parser = adapter.createParser();
    const events = parser.push('{"type":"thread.started","thread_id":"t"}');
    const exit = adapter.classifyExit(0, null, events, '');
    expect(exit).toMatchObject({ ok: false, errorKind: 'infra', retryable: true });
  });

  it('signal kill classifies as interrupted', () => {
    const adapter = new CodexAdapter();
    expect(adapter.classifyExit(null, 'SIGTERM', [], '')).toMatchObject({
      ok: false,
      errorKind: 'interrupted',
      retryable: false,
    });
  });
});

describe('classifyFailureMessage', () => {
  it('maps the documented failure signatures', () => {
    expect(classifyFailureMessage("Invalid schema for response_format 'codex_output_schema': ...")).toBe('schema-rejected');
    expect(classifyFailureMessage('invalid_json_schema at text.format.schema')).toBe('schema-rejected');
    expect(classifyFailureMessage("You've hit your usage limit ... 429 usage_limit_reached")).toBe('rate-limit');
    expect(classifyFailureMessage('quota exceeded for org')).toBe('rate-limit');
    expect(classifyFailureMessage('conversation exceeds context window')).toBe('max-turns');
    expect(classifyFailureMessage('Your refresh token was already used')).toBe('auth');
    expect(classifyFailureMessage('stream disconnected before completion')).toBe('infra');
  });
});

describe('NdjsonSplitter', () => {
  it('handles partial lines across chunks and CRLF', () => {
    const s = new NdjsonSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\r\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(s.push(':3}')).toEqual([]);
    expect(s.end()).toEqual(['{"c":3}']);
    expect(s.end()).toEqual([]);
  });

  it('skips blank lines', () => {
    const s = new NdjsonSplitter();
    expect(s.push('\n\n{"x":1}\n\n')).toEqual(['{"x":1}']);
  });
});
