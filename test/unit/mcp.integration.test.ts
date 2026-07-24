/**
 * MCP triad E2E: a real SDK client ↔ stdio ↔ the real server, which
 * launches real detached runners on the mock backend. No network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readProcStat } from '../../src/exec/procinfo.js';
import { INSTRUCTIONS, effectiveWaitMs } from '../../src/mcp/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const mainTs = join(here, '../../src/cli/main.ts');
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

// Spawned MCP servers must resolve their store from cwd, not an inherited
// $ULTRACODE_HOME (ultracodeRoot prefers the override) — else the isolated-store
// and restart tests would read a different store than they wrote.
function childEnv(home?: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.ULTRACODE_HOME;
  if (home) env.HOME = home;
  return env;
}

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
      env: childEnv(projectDir),
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it('server instructions fit codex 512-unit injection under the stricter byte reading', () => {
    expect(Buffer.byteLength(INSTRUCTIONS, 'utf8')).toBeLessThanOrEqual(512);
  });

  it('deadline arithmetic honors explicit waits to 3600s — the 50s clamp stays dead', () => {
    // The integration suite cannot wait out a >50s hold, so the arithmetic
    // seam is pinned directly: reinstating Math.min(wait, 50) fails here.
    expect(effectiveWaitMs(3600)).toBe(3_600_000);
    expect(effectiveWaitMs(3300)).toBe(3_300_000);
    expect(effectiveWaitMs(60)).toBe(60_000);
    expect(effectiveWaitMs(undefined)).toBe(25_000); // omitted → safe default
    expect(effectiveWaitMs(9999)).toBe(3_600_000); // defensive ceiling = schema max
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
    const start = tools.tools.find((t) => t.name === 'workflow_start')!;
    expect(start.description).toContain(
      'if either exists, omit backend/model/effort/contextWindow so config wins',
    );
    expect(start.description).toContain(
      'only if both are absent, infer the current Codex/Qoder/Gemini host and pass backend alone',
    );
    expect(start.description).toContain('Never infer model/effort/contextWindow');
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
    for (let i = 0; i < 90; i++) {
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
  }, 180_000);

  it('uses layered config when backend is omitted, but still rejects an unconfigured fresh start', async () => {
    const missing = (await client.callTool({
      name: 'workflow_start',
      arguments: { script: HELLO },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('explicit backend or subagent.backend');

    const configPath = join(projectDir, '.ultracode', 'config.json');
    writeFileSync(configPath, JSON.stringify({
      subagent: { backend: 'mock', model: 'configured-model', effort: 'high' },
    }));
    let runId: string | undefined;
    let terminal = false;
    try {
      const start = (await client.callTool({
        name: 'workflow_start',
        arguments: { script: HELLO },
      })) as {
        structuredContent?: {
          runId?: string;
          runDir?: string;
          backend?: string;
          model?: string;
          effort?: string;
        };
        isError?: boolean;
      };
      runId = start.structuredContent?.runId;
      expect(start.isError).toBeFalsy();
      expect(start.structuredContent).toMatchObject({
        backend: 'mock',
        model: 'configured-model',
        effort: 'high',
      });
      expect(JSON.parse(readFileSync(join(start.structuredContent!.runDir!, 'config.json'), 'utf8'))).toMatchObject({
        backend: 'mock',
        model: 'configured-model',
        effort: 'high',
      });

      let offset = 0;
      for (let i = 0; i < 20; i++) {
        const status = (await client.callTool({
          name: 'workflow_status',
          arguments: { runId, waitSeconds: 2, sinceEventOffset: offset },
        })) as { structuredContent?: { terminal?: boolean; nextEventOffset?: number } };
        offset = status.structuredContent!.nextEventOffset ?? offset;
        terminal = status.structuredContent!.terminal ?? false;
        if (terminal) break;
      }
      expect(terminal).toBe(true);
    } finally {
      rmSync(configPath, { force: true });
      if (runId && !terminal) {
        try {
          await client.callTool({ name: 'workflow_stop', arguments: { runId } });
        } catch {
          /* cleanup is best-effort after a failed assertion */
        }
      }
    }
  }, 45_000);

  it('does not inherit configured controls when workflow_start switches backends', async () => {
    const configPath = join(projectDir, '.ultracode', 'config.json');
    writeFileSync(configPath, JSON.stringify({
      subagent: {
        backend: 'qoder',
        model: 'Qwen3.8-Max-Preview',
        effort: 'xhigh',
        context_window: 1_000_000,
      },
    }));
    const runIds: string[] = [];
    try {
      const switched = (await client.callTool({
        name: 'workflow_start',
        arguments: { script: HELLO, backend: 'mock' },
      })) as {
        structuredContent?: {
          runId?: string;
          runDir?: string;
          backend?: string;
          model?: string;
          effort?: string;
          contextWindow?: number;
          warnings?: string[];
        };
        isError?: boolean;
      };
      expect(switched.isError).toBeFalsy();
      runIds.push(switched.structuredContent!.runId!);
      expect(switched.structuredContent).toMatchObject({
        backend: 'mock',
        warnings: [
          "backend override 'mock' differs from configured backend 'qoder'; " +
          'not inheriting configured model, effort, contextWindow',
        ],
      });
      expect(switched.structuredContent).not.toHaveProperty('model');
      expect(switched.structuredContent).not.toHaveProperty('effort');
      expect(switched.structuredContent).not.toHaveProperty('contextWindow');
      const switchedConfig = JSON.parse(readFileSync(join(switched.structuredContent!.runDir!, 'config.json'), 'utf8'));
      expect(switchedConfig.backend).toBe('mock');
      expect(switchedConfig).not.toHaveProperty('model');
      expect(switchedConfig).not.toHaveProperty('effort');
      expect(switchedConfig).not.toHaveProperty('contextWindow');

      const explicit = (await client.callTool({
        name: 'workflow_start',
        arguments: {
          script: HELLO,
          backend: 'mock',
          model: 'explicit-model',
          effort: 'low',
        },
      })) as {
        structuredContent?: {
          runId?: string;
          runDir?: string;
          warnings?: string[];
        };
        isError?: boolean;
      };
      expect(explicit.isError).toBeFalsy();
      runIds.push(explicit.structuredContent!.runId!);
      expect(JSON.parse(readFileSync(join(explicit.structuredContent!.runDir!, 'config.json'), 'utf8'))).toMatchObject({
        backend: 'mock',
        model: 'explicit-model',
        effort: 'low',
      });
      expect(explicit.structuredContent!.warnings).toEqual([
        "backend override 'mock' differs from configured backend 'qoder'; not inheriting configured contextWindow",
      ]);

      const incompatible = (await client.callTool({
        name: 'workflow_start',
        arguments: { script: HELLO, backend: 'mock', contextWindow: 200_000 },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(incompatible.isError).toBe(true);
      expect(incompatible.content[0]!.text).toContain(
        'contextWindow is supported only by the qoder backend',
      );

      for (const runId of runIds) {
        let terminal = false;
        let offset = 0;
        for (let i = 0; i < 20; i++) {
          const status = (await client.callTool({
            name: 'workflow_status',
            arguments: { runId, waitSeconds: 2, sinceEventOffset: offset },
          })) as { structuredContent?: { terminal?: boolean; nextEventOffset?: number } };
          offset = status.structuredContent!.nextEventOffset ?? offset;
          terminal = status.structuredContent!.terminal ?? false;
          if (terminal) break;
        }
        expect(terminal).toBe(true);
      }
    } finally {
      rmSync(configPath, { force: true });
      for (const runId of runIds) {
        try {
          await client.callTool({ name: 'workflow_stop', arguments: { runId } });
        } catch {
          /* cleanup is best-effort after a failed assertion */
        }
      }
    }
  }, 60_000);

  it('returns warnings when project config switches the user backend profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-mcp-config-layers-'));
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(join(home, '.ultracode'), { recursive: true });
    mkdirSync(join(project, '.ultracode'), { recursive: true });
    writeFileSync(join(home, '.ultracode', 'config.json'), JSON.stringify({
      subagent: {
        backend: 'qoder',
        model: 'Qwen3.8-Max-Preview',
        effort: 'xhigh',
        context_window: 1_000_000,
      },
    }));
    writeFileSync(join(project, '.ultracode', 'config.json'), JSON.stringify({
      subagent: { backend: 'mock' },
    }));

    const layeredClient = new Client({ name: 'layered-config-client', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', tsxLoader, mainTs, 'mcp'],
      cwd: project,
      env: childEnv(home),
    });
    let runId: string | undefined;
    try {
      await layeredClient.connect(transport);
      const start = (await layeredClient.callTool({
        name: 'workflow_start',
        arguments: { script: HELLO },
      })) as {
        structuredContent?: {
          runId?: string;
          runDir?: string;
          backend?: string;
          warnings?: string[];
        };
        isError?: boolean;
      };
      expect(start.isError).toBeFalsy();
      runId = start.structuredContent!.runId!;
      expect(start.structuredContent).toMatchObject({
        backend: 'mock',
        warnings: [
          "backend override 'mock' differs from configured backend 'qoder'; " +
          'not inheriting configured model, effort, contextWindow',
        ],
      });
      expect(start.structuredContent).not.toHaveProperty('model');
      expect(start.structuredContent).not.toHaveProperty('effort');
      expect(start.structuredContent).not.toHaveProperty('contextWindow');
      const stored = JSON.parse(readFileSync(join(start.structuredContent!.runDir!, 'config.json'), 'utf8'));
      expect(stored.backend).toBe('mock');
      expect(stored).not.toHaveProperty('model');
    } finally {
      if (runId !== undefined) {
        try {
          await layeredClient.callTool({ name: 'workflow_stop', arguments: { runId } });
        } catch {
          /* cleanup is best-effort after a failed assertion */
        }
      }
      await layeredClient.close();
    }
  }, 45_000);

  it('workflow_start passes wallClockMs/attemptTimeoutMs through unclamped; omitting them leaves config bare', async () => {
    const start = (await client.callTool({
      name: 'workflow_start',
      // 2^31 ms exceeds Node's single-setTimeout range — the runner must arm a
      // chained deadline (no overflow insta-stop, no silent disarm)
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
    for (let i = 0; i < 90; i++) {
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
    // the oversized cap is armed (chained), not fired and not disarmed-with-a-log
    expect(eventLog).not.toContain('wall-clock cap');
    // pins the runner→executor plumbing, not just config.json persistence
    expect(eventLog).toContain('attempt timeout 90000ms (run-level override)');

    // Timeouts are opt-in: with no params the stored config carries neither key
    // and the runner arms NO wall-clock cap (unlimited by default).
    const plain = (await client.callTool({
      name: 'workflow_start',
      arguments: { script: HELLO, backend: 'mock' },
    })) as { structuredContent?: { runId?: string; runDir?: string } };
    const plainConfig = JSON.parse(readFileSync(join(plain.structuredContent!.runDir!, 'config.json'), 'utf8'));
    expect('wallClockMs' in plainConfig).toBe(false);
    expect('attemptTimeoutMs' in plainConfig).toBe(false);
    let plainStatus: Record<string, any> = {};
    // Chain the cursor: an unchained activity poll re-reads the backlog from 0
    // and returns instantly every time, so the loop can never actually WAIT —
    // under CI contention it exhausts before the run completes (live flake).
    let plainOffset = 0;
    for (let i = 0; i < 90; i++) {
      const s = (await client.callTool({
        name: 'workflow_status',
        arguments: { runId: plain.structuredContent!.runId!, waitSeconds: 2, sinceEventOffset: plainOffset },
      })) as { structuredContent?: Record<string, any> };
      plainStatus = s.structuredContent!;
      plainOffset = plainStatus.nextEventOffset;
      if (plainStatus.terminal) break;
    }
    expect(plainStatus.status).toBe('completed');
    expect(readFileSync(join(plain.structuredContent!.runDir!, 'events.jsonl'), 'utf8')).not.toContain('wall-clock cap');

    // Resume inherits stored caps; 0 explicitly clears them back to unlimited.
    const cleared = (await client.callTool({
      name: 'workflow_start',
      arguments: { resumeFromRunId: runId, wallClockMs: 0, attemptTimeoutMs: 0 },
    })) as { structuredContent?: { runDir?: string }; isError?: boolean };
    expect(cleared.isError).toBeFalsy();
    const clearedConfig = JSON.parse(readFileSync(join(cleared.structuredContent!.runDir!, 'config.json'), 'utf8'));
    expect('wallClockMs' in clearedConfig).toBe(false);
    expect('attemptTimeoutMs' in clearedConfig).toBe(false);
  }, 180_000);

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
        '{"ts":2,"type":"agent_usage","seq":0,"totalTokens":200,"estimated":false}\n' +
        '{"ts":3,"type":"agent_tool","seq":0,"name":"bash:ls","status":"started"}\n' +
        '{"ts":4,"type":"agent_tool","seq":0,"name":"bash:ls","status":"completed"}\n',
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

  // Fabricated live run (same pattern as the ticks-only test): manifest pid
  // points at an alive process (this one unless overridden) so liveStatus
  // stays 'running' until the test flips status or the pid dies.
  function fabricateRun(
    runId: string,
    events: string,
    proc: { pid: number; pidStart?: number } = { pid: process.pid, pidStart: readProcStat(process.pid)?.starttime },
  ): { dir: string; manifest: Record<string, unknown> } {
    const dir = join(projectDir, '.ultracode', 'runs', runId);
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const manifest = {
      runId,
      name: 'fabricated',
      status: 'running',
      pid: proc.pid,
      pidStart: proc.pidStart,
      startedAt: now,
      heartbeatAt: now,
      phases: [],
      agentCount: 0,
      budget: { total: null, spent: 0 },
      backendDefault: 'mock',
      engineVersion: '0.0.0',
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'events.jsonl'), events);
    return { dir, manifest };
  }

  // The server re-reads manifest.json every tick — flips must be atomic
  // (tmp+rename, like the real writeManifest) or a read can land mid-truncate.
  function flipStatus(dir: string, manifest: Record<string, unknown>, status: string): void {
    writeFileSync(join(dir, 'manifest.json.tmp'), JSON.stringify({ ...manifest, status, endedAt: new Date().toISOString() }));
    renameSync(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'));
  }

  const logLines = (n: number, prefix = 'line'): string =>
    Array.from({ length: n }, (_, i) => JSON.stringify({ ts: i + 1, type: 'workflow_log', message: `${prefix}${i + 1}` }) + '\n').join('');

  it("quiet monitor (until='terminal') is not woken by renderable log lines; the deadline response rolls them up", async () => {
    const runId = 'wf_quietlines01';
    fabricateRun(runId, logLines(2, 'quiet-'));

    const t0 = Date.now();
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'terminal', waitSeconds: 1, sinceEventOffset: 0 },
    })) as { structuredContent?: Record<string, any> };
    const elapsed = Date.now() - t0;
    const status = s.structuredContent!;
    expect(elapsed).toBeGreaterThanOrEqual(900); // renderable lines exist, but only terminal wakes it
    expect(status.terminal).toBe(false);
    expect(status.logTail).toEqual(['   log: quiet-1', '   log: quiet-2']); // rolled up, not woken on
    expect(status.nextEventOffset).toBeGreaterThan(0); // cursor advance == content delivered
    expect(status.hint).toContain('waitSeconds'); // sub-240s quiet holds get the in-band nudge
    expect(status.next).toContain('silently'); // in-band counter to host commentary mandates
    expect(status.next).toContain(`sinceEventOffset: ${status.nextEventOffset}`); // concrete cursor to re-issue with
  }, 20_000);

  it("until='phase' ignores log lines but wakes on a phase boundary appended mid-hold", async () => {
    const runId = 'wf_phasewake001';
    const { dir } = fabricateRun(runId, logLines(2, 'pre-'));

    const t0 = Date.now();
    const s1 = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'phase', waitSeconds: 1, sinceEventOffset: 0 },
    })) as { structuredContent?: Record<string, any> };
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900); // log lines alone don't wake phase mode
    expect(s1.structuredContent!.terminal).toBe(false);

    const pending = client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'phase', waitSeconds: 15, sinceEventOffset: s1.structuredContent!.nextEventOffset },
    }) as Promise<{ structuredContent?: Record<string, any> }>;
    const t1 = Date.now();
    await new Promise((r) => setTimeout(r, 700));
    appendFileSync(join(dir, 'events.jsonl'), '{"ts":9,"type":"phase_started","title":"Analyze"}\n');

    const s2 = (await pending).structuredContent!;
    expect(Date.now() - t1).toBeLessThan(10_000); // woke on the phase boundary, not the 15s deadline
    expect(s2.terminal).toBe(false);
    expect(s2.logTail).toContain('── phase: Analyze');
    expect(s2.next).toContain('silently');
  }, 20_000);

  it("activity mode (default) still wakes on renderable lines", async () => {
    const runId = 'wf_activewake01';
    fabricateRun(runId, logLines(2, 'active-'));

    const t0 = Date.now();
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, waitSeconds: 10, sinceEventOffset: 0 },
    })) as { structuredContent?: Record<string, any> };
    const status = s.structuredContent!;
    expect(Date.now() - t0).toBeLessThan(5_000); // woke on the lines, not the 10s deadline
    expect(status.terminal).toBe(false);
    expect(status.logTail).toEqual(['   log: active-1', '   log: active-2']);
  }, 20_000);

  it('quiet monitor wakes mid-hold on the terminal flip and delivers the rolled-up 40-line tail', async () => {
    const runId = 'wf_quietwake001';
    const { dir, manifest } = fabricateRun(runId, logLines(45));

    const pending = client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'terminal', waitSeconds: 15, sinceEventOffset: 0 },
    }) as Promise<{ structuredContent?: Record<string, any> }>;
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 700));
    flipStatus(dir, manifest, 'completed');

    const status = (await pending).structuredContent!;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(10_000); // woke on the flip, not the 15s deadline
    expect(status.terminal).toBe(true);
    expect(status.status).toBe('completed');
    expect(status.next).toContain('workflow_result');
    expect(status.logTail).toHaveLength(40); // rolling cap
    expect(status.logTail[39]).toBe('   log: line45'); // the tail is the newest lines, oldest rolled off
  }, 20_000);

  it('quiet monitor wakes when the runner process dies mid-hold (orphan detection)', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 800)'], { stdio: 'ignore' });
    const runId = 'wf_quietorphan1';
    fabricateRun(runId, '', { pid: child.pid!, pidStart: readProcStat(child.pid!)?.starttime });

    const t0 = Date.now();
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'terminal', waitSeconds: 15 },
    })) as { structuredContent?: Record<string, any> };
    const status = s.structuredContent!;
    expect(Date.now() - t0).toBeLessThan(10_000); // dead pid flips the run terminal within a tick
    expect(status.status).toBe('orphaned');
    expect(status.terminal).toBe(true);
  }, 20_000);

  it('activity waits emit exactly one throttled progress ping; quiet parks emit none', async () => {
    // Both holds must OUTLIVE the 10s throttle window or neither branch is
    // ever eligible and the test passes with the !quiet gate deleted.
    const runId = 'wf_quietprog001';
    fabricateRun(runId, '');
    let active = 0;
    let quiet = 0;
    await Promise.all([
      client.callTool(
        { name: 'workflow_status', arguments: { runId, waitSeconds: 12, sinceEventOffset: 0 } },
        undefined,
        { onprogress: () => void active++ },
      ),
      client.callTool(
        { name: 'workflow_status', arguments: { runId, until: 'terminal', waitSeconds: 12 } },
        undefined,
        { onprogress: () => void quiet++ },
      ),
    ]);
    expect(active).toBe(1); // fired (Qoder/Gemini liveness UX intact) AND throttled (300ms cadence would give ~40)
    expect(quiet).toBe(0); // silent-park contract
  }, 30_000);

  it("until='terminal' rolls a phase boundary into the tail without waking", async () => {
    const runId = 'wf_termphase001';
    fabricateRun(runId, '{"ts":1,"type":"phase_started","title":"Analyze"}\n' + logLines(1, 'after-'));
    const t0 = Date.now();
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'terminal', waitSeconds: 1, sinceEventOffset: 0 },
    })) as { structuredContent?: Record<string, any> };
    // The regression this pins: phaseHit written as until !== 'activity' would
    // wake terminal holds at every phase boundary — back to a turn per phase.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(s.structuredContent!.terminal).toBe(false);
    expect(s.structuredContent!.logTail).toContain('── phase: Analyze');
  }, 20_000);

  it('a stale runner heartbeat wakes a quiet hold with stale: true (wedged-but-alive runner)', async () => {
    const runId = 'wf_staleheart01';
    const { dir, manifest } = fabricateRun(runId, '');
    writeFileSync(join(dir, 'manifest.json.tmp'), JSON.stringify({ ...manifest, heartbeatAt: new Date(Date.now() - 60_000).toISOString() }));
    renameSync(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'));

    const t0 = Date.now();
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'terminal', waitSeconds: 15 },
    })) as { structuredContent?: Record<string, any> };
    const status = s.structuredContent!;
    expect(Date.now() - t0).toBeLessThan(10_000); // woke on staleness, not the 15s deadline
    expect(status.terminal).toBe(false);
    expect(status.stale).toBe(true);
    expect(status.next).toContain('wedged'); // diagnose, don't re-park
  }, 20_000);

  it('terminal quiet park from offset 0 over a >8 MiB backlog jumps to the real tail, cursor at EOF', async () => {
    const runId = 'wf_quietbig0001';
    // >8 MiB matters: the final-window jump only fires when end − 4 MiB
    // exceeds the first page's nextOffset (~4 MiB), so a smaller fixture
    // would silently test plain paging instead of the jump + tail reset.
    const { dir, manifest } = fabricateRun(runId, logLines(200_000)); // ~11 MiB
    flipStatus(dir, manifest, 'completed');

    const t0 = Date.now();
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'terminal', waitSeconds: 3300, sinceEventOffset: 0 },
    })) as { structuredContent?: Record<string, any> };
    const status = s.structuredContent!;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(status.terminal).toBe(true);
    expect(status.logTail).toHaveLength(40);
    expect(status.logTail[39]).toBe('   log: line200000'); // the run's REAL tail through the jump, not its head
    const { statSync } = await import('node:fs');
    expect(status.nextEventOffset).toBe(statSync(join(dir, 'events.jsonl')).size); // cursor at EOF
  }, 20_000);

  it('tail lines are capped per line so a huge log() message cannot flood logTail', async () => {
    const runId = 'wf_hugelogline1';
    fabricateRun(runId, JSON.stringify({ ts: 1, type: 'workflow_log', message: 'x'.repeat(10_000) }) + '\n');
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, waitSeconds: 5, sinceEventOffset: 0 },
    })) as { structuredContent?: Record<string, any> };
    const line = s.structuredContent!.logTail[0] as string;
    expect(line.length).toBeLessThanOrEqual(401); // 400 chars + ellipsis
    expect(line.endsWith('…')).toBe(true);
  }, 20_000);

  it('a waitSeconds:0 terminal call still finalizes to the real tail (deadline never skips the jump)', async () => {
    const runId = 'wf_zerowait0001';
    const { dir, manifest } = fabricateRun(runId, logLines(200_000, 'zero')); // ~11 MiB
    flipStatus(dir, manifest, 'completed');
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'terminal', waitSeconds: 0, sinceEventOffset: 0 },
    })) as { structuredContent?: Record<string, any> };
    const status = s.structuredContent!;
    expect(status.terminal).toBe(true);
    expect(status.logTail[39]).toBe('   log: zero200000'); // an expired deadline must not serve the HEAD as the tail
    const { statSync } = await import('node:fs');
    expect(status.nextEventOffset).toBe(statSync(join(dir, 'events.jsonl')).size);
  }, 20_000);

  it('a phase wake keeps its newest boundary visible in logTail through a dense batch', async () => {
    const runId = 'wf_densephase01';
    fabricateRun(runId, '{"ts":1,"type":"phase_started","title":"Buried"}\n' + logLines(50, 'noise'));
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'phase', waitSeconds: 10, sinceEventOffset: 0 },
    })) as { structuredContent?: Record<string, any> };
    const status = s.structuredContent!;
    expect(status.terminal).toBe(false);
    expect(status.logTail).toHaveLength(40);
    expect(status.logTail).toContain('── phase: Buried'); // 50 renderables after the boundary must not roll the milestone off
  }, 20_000);

  it('the rolling tail evicts oldest-first across ticks (multi-tick accumulation)', async () => {
    const runId = 'wf_tailroll0001';
    const { dir, manifest } = fabricateRun(runId, '');
    const batch = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => JSON.stringify({ ts: from + i, type: 'workflow_log', message: `line${from + i}` }) + '\n').join('');

    const pending = client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'terminal', waitSeconds: 15, sinceEventOffset: 0 },
    }) as Promise<{ structuredContent?: Record<string, any> }>;
    // Two sub-cap batches on separate 1s quiet ticks: neither alone trims, so
    // only the cross-tick eviction path can hold the 40-line bound.
    await new Promise((r) => setTimeout(r, 500));
    appendFileSync(join(dir, 'events.jsonl'), batch(1, 30));
    await new Promise((r) => setTimeout(r, 2_000));
    appendFileSync(join(dir, 'events.jsonl'), batch(31, 30));
    await new Promise((r) => setTimeout(r, 1_500));
    flipStatus(dir, manifest, 'completed');

    const status = (await pending).structuredContent!;
    expect(status.terminal).toBe(true);
    expect(status.logTail).toHaveLength(40); // 60 accrued → oldest 20 evicted
    expect(status.logTail[0]).toBe('   log: line21');
    expect(status.logTail[39]).toBe('   log: line60');
  }, 30_000);

  it('a fifth concurrent hold preempts the oldest; live holds keep parking', async () => {
    const runId = 'wf_holdcap00001';
    const { dir, manifest } = fabricateRun(runId, '');
    const settled: number[] = [];
    const holds = Array.from({ length: 5 }, (_, i) => {
      const p = client
        .callTool({ name: 'workflow_status', arguments: { runId, until: 'terminal', waitSeconds: 15 } })
        .then((s) => {
          settled.push(i);
          return s as { structuredContent?: Record<string, any> };
        });
      return p;
    });
    await new Promise((r) => setTimeout(r, 3_000));
    // Admission control: 5 holds on one run preempt exactly the oldest —
    // abandoned holds must not tick for their full waitSeconds.
    expect(settled).toEqual([0]);
    const preempted = await holds[0]!;
    expect(preempted.structuredContent!.terminal).toBe(false); // a normal still-running payload — just an early re-poll for a live client

    flipStatus(dir, manifest, 'completed');
    const rest = await Promise.all(holds.slice(1));
    for (const s of rest) expect(s.structuredContent!.terminal).toBe(true);
  }, 30_000);

  it("a late until='terminal' attach to a RUNNING run jumps the backlog instead of parsing it", async () => {
    const runId = 'wf_latebig00001';
    const { dir } = fabricateRun(runId, logLines(200_000, 'live')); // ~11 MiB, run stays running
    const t0 = Date.now();
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'terminal', waitSeconds: 1, sinceEventOffset: 0 },
    })) as { structuredContent?: Record<string, any> };
    const status = s.structuredContent!;
    expect(status.terminal).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const { statSync } = await import('node:fs');
    const size = statSync(join(dir, 'events.jsonl')).size;
    expect(status.nextEventOffset).toBe(size); // caught up to EOF without walking the full history
    expect(status.logTail[status.logTail.length - 1]).toBe('   log: live200000');
  }, 20_000);

  it("until='phase' without sinceEventOffset wakes instantly on a historical phase boundary (documented footgun)", async () => {
    const runId = 'wf_phasehist001';
    fabricateRun(runId, '{"ts":1,"type":"phase_started","title":"Old"}\n');
    const t0 = Date.now();
    const s = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'phase', waitSeconds: 10 },
    })) as { structuredContent?: Record<string, any> };
    expect(Date.now() - t0).toBeLessThan(5_000); // woke on the backlog boundary, not the deadline
    expect(s.structuredContent!.terminal).toBe(false);
    expect(s.structuredContent!.next).toContain('sinceEventOffset'); // the nudge that teaches chaining
  }, 20_000);

  // NOTE: this pins schema bounds only — a reinstated sub-schema runtime clamp
  // (the original bug's shape) is not observable inside the 20s suite budget,
  // since proving a >50s hold held would take >50s of wall clock.
  it('waitSeconds schema: 3600 accepted, 3601 rejected', async () => {
    const runId = 'wf_quietsched01';
    const { dir, manifest } = fabricateRun(runId, '');
    flipStatus(dir, manifest, 'completed');

    const t0 = Date.now();
    const ok = (await client.callTool({
      name: 'workflow_status',
      arguments: { runId, until: 'terminal', waitSeconds: 3600 },
    })) as { structuredContent?: Record<string, any>; isError?: boolean };
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent!.terminal).toBe(true); // terminal returns immediately regardless of hold size
    expect(Date.now() - t0).toBeLessThan(5_000);

    // Depending on SDK version the schema violation surfaces as a tool error
    // result or a protocol-level rejection (see the count:0 precedent below).
    let rejected = false;
    try {
      const over = (await client.callTool({
        name: 'workflow_status',
        arguments: { runId, waitSeconds: 3601 },
      })) as { isError?: boolean };
      rejected = Boolean(over.isError);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
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
  }, 180_000);

  it('workflow_list caps to the 10 most recent by default and honors count, reporting hidden', async () => {
    // Isolated store (via the cwd input) so accumulated runs from other tests
    // don't perturb the exact cap/hidden counts.
    const isolated = mkdtempSync(join(tmpdir(), 'uc-mcp-list-'));
    const runsBase = join(isolated, '.ultracode', 'runs');
    const base = Date.now();
    for (let i = 0; i < 12; i++) {
      const runId = 'wf_cap' + String(i).padStart(4, '0');
      const dir = join(runsBase, runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({
          runId,
          name: 'cap',
          status: 'running',
          pid: process.pid,
          pidStart: readProcStat(process.pid)?.starttime,
          startedAt: new Date(base - i * 60_000).toISOString(),
          heartbeatAt: new Date().toISOString(),
          phases: [],
          agentCount: 0,
          budget: { total: null, spent: 0 },
          backendDefault: 'mock',
          engineVersion: '0.0.0',
        }),
      );
    }
    const def = (await client.callTool({ name: 'workflow_list', arguments: { cwd: isolated } })) as {
      structuredContent?: { runs: unknown[]; hidden: number };
    };
    expect(def.structuredContent!.runs).toHaveLength(10);
    expect(def.structuredContent!.hidden).toBe(2);

    const capped = (await client.callTool({ name: 'workflow_list', arguments: { cwd: isolated, count: 2 } })) as {
      structuredContent?: { runs: unknown[]; hidden: number };
    };
    expect(capped.structuredContent!.runs).toHaveLength(2);
    expect(capped.structuredContent!.hidden).toBe(10);

    // count's zod guard (z.number().int().positive()) must reject non-positive input.
    let rejected = false;
    try {
      const bad = (await client.callTool({ name: 'workflow_list', arguments: { cwd: isolated, count: 0 } })) as { isError?: boolean };
      rejected = bad.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  }, 20_000);

  it('refuses workflow_start and workflow_stop from inside a run (recursion / confused-deputy guard)', async () => {
    // A worker that inherited the MCP server has ULTRACODE_INSIDE_RUN set: it
    // must not launch fresh runs, nor make this unsandboxed process signal an
    // arbitrary PID via a forged run manifest.
    const inside = new Client({ name: 'inside-client', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', tsxLoader, mainTs, 'mcp'],
      cwd: projectDir,
      env: { ...childEnv(projectDir), ULTRACODE_INSIDE_RUN: '1' },
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
    // so the MCP path needs its own override/inherit assertions. Chain the
    // cursor or every poll wakes instantly on the backlog and never waits;
    // 20 × 2s stays under this test's 45s budget.
    let driveOffset = 0;
    for (let i = 0; i < 20; i++) {
      const s = (await client.callTool({
        name: 'workflow_status',
        arguments: { runId, waitSeconds: 2, sinceEventOffset: driveOffset },
      })) as { structuredContent?: { terminal?: boolean; nextEventOffset?: number } };
      driveOffset = s.structuredContent!.nextEventOffset ?? driveOffset;
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
      env: childEnv(projectDir),
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
