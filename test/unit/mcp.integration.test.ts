/**
 * MCP triad E2E: a real SDK client ↔ stdio ↔ the real server, which
 * launches real detached runners on the mock backend. No network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readProcStat } from '../../src/exec/procinfo.js';

const here = dirname(fileURLToPath(import.meta.url));
const mainTs = join(here, '../../src/cli/main.ts');
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

const HELLO = `export const meta = { name: 'mcp-hello', description: 'd', phases: [{ title: 'Greet' }] }
phase('Greet')
const g = await agent('MOCK:ok hi-from-mcp', { label: 'greeter' })
log('done')
return { g }`;

const SLOW = `export const meta = { name: 'mcp-slow', description: 'd' }
await agent('MOCK:delay 30000 MOCK:ok never', { label: 'sleeper' })
return 1`;

describe('MCP triad', () => {
  let client: Client;
  let projectDir: string;

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'uc-mcp-'));
    client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', tsxLoader, mainTs, 'mcp'],
      cwd: projectDir,
      env: process.env as Record<string, string>,
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it('lists exactly the triad tools; taskSupport never required/optional (required breaks Qoder)', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(['workflow_list', 'workflow_result', 'workflow_start', 'workflow_status', 'workflow_stop']);
    for (const t of tools.tools) {
      const support = (t as { execution?: { taskSupport?: string } }).execution?.taskSupport;
      // SDK stamps the spec-default 'forbidden' (plain calls only) — fine.
      // 'required' throws client-side in Qoder; 'optional' invites task-
      // augmented calls no host makes. Neither may ever appear.
      expect(support === undefined || support === 'forbidden').toBe(true);
    }
  });

  it('start → status(poll) → result: full round trip on the mock backend', async () => {
    const start = (await client.callTool({
      name: 'workflow_start',
      arguments: { script: HELLO, backend: 'mock' },
    })) as { structuredContent?: { runId?: string }; isError?: boolean };
    expect(start.isError).toBeFalsy();
    const runId = start.structuredContent!.runId!;
    expect(runId).toMatch(/^wf_/);

    let status: Record<string, any> = {};
    let offset = 0;
    for (let i = 0; i < 40; i++) {
      const s = (await client.callTool({
        name: 'workflow_status',
        arguments: { runId, waitSeconds: 2, sinceEventOffset: offset },
      })) as { structuredContent?: Record<string, any> };
      status = s.structuredContent!;
      offset = status.nextEventOffset;
      if (status.terminal) break;
    }
    expect(status.status).toBe('completed');
    expect(status.phases).toEqual([{ title: 'Greet', agentsDone: 1 }]);

    const result = (await client.callTool({ name: 'workflow_result', arguments: { runId } })) as {
      structuredContent?: Record<string, any>;
    };
    expect(result.structuredContent!.result).toEqual({ g: 'hi-from-mcp' });
    expect(result.structuredContent!.logs).toEqual(['done']);
    expect(result.structuredContent!.artifacts.runDir).toContain(runId);
  }, 60_000);

  it('workflow_start passes wallClockMs/attemptTimeoutMs through unclamped; omitting them leaves config bare', async () => {
    const start = (await client.callTool({
      name: 'workflow_start',
      // 2^31 ms exceeds Node's timer range — the runner must run uncapped, not insta-stop
      arguments: { script: HELLO, backend: 'mock', wallClockMs: 2 ** 31, attemptTimeoutMs: 90_000 },
    })) as { structuredContent?: { runId?: string; runDir?: string }; isError?: boolean };
    expect(start.isError).toBeFalsy();
    const runId = start.structuredContent!.runId!;
    const runDir = start.structuredContent!.runDir!;
    const config = JSON.parse(readFileSync(join(runDir, 'config.json'), 'utf8'));
    expect(config.wallClockMs).toBe(2 ** 31);
    expect(config.attemptTimeoutMs).toBe(90_000);

    let status: Record<string, any> = {};
    let offset = 0;
    for (let i = 0; i < 40; i++) {
      const s = (await client.callTool({
        name: 'workflow_status',
        arguments: { runId, waitSeconds: 2, sinceEventOffset: offset },
      })) as { structuredContent?: Record<string, any> };
      status = s.structuredContent!;
      offset = status.nextEventOffset;
      if (status.terminal) break;
    }
    expect(status.status).toBe('completed');
    const eventLog = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
    expect(eventLog).toContain('outside timer range — running uncapped');
    // pins the runner→executor plumbing, not just config.json persistence
    expect(eventLog).toContain('attempt timeout 90000ms (run-level override)');

    // Timeouts are opt-in: with no params the stored config carries neither key.
    const plain = (await client.callTool({
      name: 'workflow_start',
      arguments: { script: HELLO, backend: 'mock' },
    })) as { structuredContent?: { runDir?: string } };
    const plainConfig = JSON.parse(readFileSync(join(plain.structuredContent!.runDir!, 'config.json'), 'utf8'));
    expect('wallClockMs' in plainConfig).toBe(false);
    expect('attemptTimeoutMs' in plainConfig).toBe(false);
  }, 60_000);

  it('long-poll is not woken by agent_usage ticks (renderable lines only)', async () => {
    // Fabricated live run: manifest points at THIS (alive) process so
    // liveStatus stays 'running'; events.jsonl holds only null-rendered ticks.
    const runId = 'wf_ticksonly001';
    const dir = join(projectDir, '.ultracode', 'runs', runId);
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        runId,
        name: 'ticks',
        status: 'running',
        pid: process.pid,
        pidStart: readProcStat(process.pid)?.starttime,
        startedAt: now,
        heartbeatAt: now,
        phases: [],
        agentCount: 0,
        budget: { total: null, spent: 0 },
        backendDefault: 'mock',
        engineVersion: '0.0.0',
      }),
    );
    writeFileSync(
      join(dir, 'events.jsonl'),
      '{"ts":1,"type":"agent_usage","seq":0,"totalTokens":100,"estimated":false}\n' +
        '{"ts":2,"type":"agent_usage","seq":0,"totalTokens":200,"estimated":false}\n',
    );

    const t0 = Date.now();
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, waitSeconds: 1, sinceEventOffset: 0 },
    })) as { structuredContent?: Record<string, any> };
    const elapsed = Date.now() - t0;
    const status = s.structuredContent!;
    expect(status.terminal).toBe(false);
    expect(status.logTail).toEqual([]);
    expect(status.nextEventOffset).toBeGreaterThan(0); // ticks consumed, never re-served
    expect(elapsed).toBeGreaterThanOrEqual(900); // waited to deadline instead of waking on ticks
  }, 20_000);

  it('workflow_result on a running workflow errors with guidance; stop terminates it', async () => {
    const start = (await client.callTool({
      name: 'workflow_start',
      arguments: { script: SLOW, backend: 'mock' },
    })) as { structuredContent?: { runId?: string } };
    const runId = start.structuredContent!.runId!;

    const early = (await client.callTool({ name: 'workflow_result', arguments: { runId } })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    expect(early.isError).toBe(true);
    expect(early.content[0]!.text).toContain('keep polling');

    const stop = (await client.callTool({ name: 'workflow_stop', arguments: { runId } })) as {
      structuredContent?: { status?: string };
    };
    expect(['stopped', 'failed']).toContain(stop.structuredContent!.status);

    const list = (await client.callTool({ name: 'workflow_list', arguments: { all: true } })) as {
      structuredContent?: { runs: { runId: string; status: string }[] };
    };
    const entry = list.structuredContent!.runs.find((r) => r.runId === runId);
    expect(entry).toBeDefined();
  }, 60_000);

  it('refuses workflow_start and workflow_stop from inside a run (recursion / confused-deputy guard)', async () => {
    // A worker that inherited the MCP server has ULTRACODE_INSIDE_RUN set: it
    // must not launch fresh runs, nor make this unsandboxed process signal an
    // arbitrary PID via a forged run manifest.
    const inside = new Client({ name: 'inside-client', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', tsxLoader, mainTs, 'mcp'],
      cwd: projectDir,
      env: { ...(process.env as Record<string, string>), ULTRACODE_INSIDE_RUN: '1' },
    });
    await inside.connect(transport);
    try {
      const start = (await inside.callTool({
        name: 'workflow_start',
        arguments: { script: HELLO, backend: 'mock' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(start.isError).toBe(true);
      expect(start.content[0]!.text).toContain('recursion guard');

      const stop = (await inside.callTool({
        name: 'workflow_stop',
        arguments: { runId: 'wf_zzzzzzzzzzzz' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(stop.isError).toBe(true);
      expect(stop.content[0]!.text).toContain('recursion guard');
    } finally {
      await inside.close();
    }
  }, 30_000);

  it('workflow_start accepts maxConcurrency; MCP resume overrides or inherits it', async () => {
    const start = (await client.callTool({
      name: 'workflow_start',
      arguments: { script: HELLO, backend: 'mock', maxConcurrency: 4 },
    })) as { structuredContent?: { runId?: string; runDir?: string }; isError?: boolean };
    expect(start.isError).toBeFalsy();
    const runId = start.structuredContent!.runId!;
    const runDir = start.structuredContent!.runDir!;
    const readMc = (dir: string) =>
      (JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { maxConcurrency?: number }).maxConcurrency;
    expect(readMc(runDir)).toBe(4);

    // Non-positive values must be rejected at the zod gate (the CLI mirrors
    // this with its own fail-fast check) — SDK surfaces it as either an
    // isError result or a protocol-level rejection depending on version.
    let rejected = false;
    try {
      const bad = (await client.callTool({
        name: 'workflow_start',
        arguments: { script: HELLO, backend: 'mock', maxConcurrency: 0 },
      })) as { isError?: boolean };
      rejected = bad.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    // Drive the run terminal so it can be resumed. startDetachedRun's resume
    // config-merge is a separate implementation from the CLI's resumeCommand,
    // so the MCP path needs its own override/inherit assertions.
    for (let i = 0; i < 40; i++) {
      const s = (await client.callTool({
        name: 'workflow_status',
        arguments: { runId, waitSeconds: 2 },
      })) as { structuredContent?: { terminal?: boolean } };
      if (s.structuredContent!.terminal) break;
    }

    // (1) explicit maxConcurrency on an MCP resume wins over the stored value
    const override = (await client.callTool({
      name: 'workflow_start',
      arguments: { resumeFromRunId: runId, maxConcurrency: 6 },
    })) as { structuredContent?: { runDir?: string }; isError?: boolean };
    expect(override.isError).toBeFalsy();
    expect(readMc(override.structuredContent!.runDir!)).toBe(6);

    // (2) omission inherits the value frozen at the original run's creation
    const inherit = (await client.callTool({
      name: 'workflow_start',
      arguments: { resumeFromRunId: runId },
    })) as { structuredContent?: { runDir?: string }; isError?: boolean };
    expect(inherit.isError).toBeFalsy();
    expect(readMc(inherit.structuredContent!.runDir!)).toBe(4);
  }, 45_000);

  it('bad script errors cleanly through workflow_start', async () => {
    const start = (await client.callTool({
      name: 'workflow_start',
      arguments: { script: 'const nope = 1', backend: 'mock' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(start.isError).toBe(true);
    expect(start.content[0]!.text).toContain('must begin with');
  });

  it('server restart loses nothing: a fresh client sees prior runs', async () => {
    const second = new Client({ name: 'test-client-2', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', tsxLoader, mainTs, 'mcp'],
      cwd: projectDir,
      env: process.env as Record<string, string>,
    });
    await second.connect(transport);
    try {
      const list = (await second.callTool({ name: 'workflow_list', arguments: { all: true } })) as {
        structuredContent?: { runs: unknown[] };
      };
      expect(list.structuredContent!.runs.length).toBeGreaterThanOrEqual(2);
    } finally {
      await second.close();
    }
  }, 30_000);
});
