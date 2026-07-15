/**
 * MCP triad E2E: a real SDK client ↔ stdio ↔ the real server, which
 * launches real detached runners on the mock backend. No network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

  it('workflow_start accepts maxConcurrency and persists it into the run config', async () => {
    const start = (await client.callTool({
      name: 'workflow_start',
      arguments: { script: HELLO, backend: 'mock', maxConcurrency: 4 },
    })) as { structuredContent?: { runId?: string; runDir?: string }; isError?: boolean };
    expect(start.isError).toBeFalsy();
    const runDir = start.structuredContent!.runDir!;
    const config = JSON.parse(readFileSync(join(runDir, 'config.json'), 'utf8')) as { maxConcurrency?: number };
    expect(config.maxConcurrency).toBe(4);

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
  }, 30_000);

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
