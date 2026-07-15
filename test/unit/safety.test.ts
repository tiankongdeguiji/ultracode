import { describe, it, expect, vi } from 'vitest';
import { parseBudget } from '../../src/budget/parse.js';
import { detectCodexAuth } from '../../src/backends/codex-auth.js';
import { AgentCallExecutor } from '../../src/engine/agentcall.js';
import { usageFromEvents } from '../../src/backends/usage.js';
import { parseJsonLine } from '../../src/backends/ndjson.js';
import type { AgentEvent, AgentRequest, AgentSpec, BackendAdapter, ExitClass, SpawnPlan } from '../../src/backends/types.js';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('parseBudget', () => {
  it('parses absolute and relative forms', () => {
    expect(parseBudget('500k')).toBe(500_000);
    expect(parseBudget('2m')).toBe(2_000_000);
    expect(parseBudget('1.5m')).toBe(1_500_000);
    expect(parseBudget('750000')).toBe(750_000);
    expect(parseBudget('+500k')).toBe(500_000); // no base → absolute
    expect(parseBudget('+500k', 1_000_000)).toBe(1_500_000);
    expect(parseBudget(' 500K ')).toBe(500_000);
  });

  it('rejects junk', () => {
    for (const bad of ['', 'abc', '500x', '-2m', '+']) {
      expect(() => parseBudget(bad)).toThrow(/invalid budget|must be positive/);
    }
  });
});

describe('codex auth detection', () => {
  it('detectCodexAuth prefers env keys', () => {
    const prev = process.env.CODEX_API_KEY;
    try {
      process.env.CODEX_API_KEY = 'sk-test';
      expect(detectCodexAuth('/nonexistent')).toBe('api-key-env');
    } finally {
      if (prev === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = prev;
    }
  });

  it('classifies auth.json contents', () => {
    const home = mkdtempSync(join(tmpdir(), 'uc-codexhome-'));
    expect(detectCodexAuth(home)).toBe('none');
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
    expect(detectCodexAuth(home)).toBe('api-key-file');
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } }));
    expect(detectCodexAuth(home)).toBe('chatgpt-oauth');
  });

  it('detects CODEX_ACCESS_TOKEN and tolerates malformed auth.json', () => {
    const prevKey = process.env.CODEX_API_KEY;
    const prevTok = process.env.CODEX_ACCESS_TOKEN;
    try {
      delete process.env.CODEX_API_KEY;
      process.env.CODEX_ACCESS_TOKEN = 'tok';
      expect(detectCodexAuth('/nonexistent')).toBe('access-token-env');
      delete process.env.CODEX_ACCESS_TOKEN;
      const home = mkdtempSync(join(tmpdir(), 'uc-codexhome-'));
      writeFileSync(join(home, 'auth.json'), '{not json');
      expect(detectCodexAuth(home)).toBe('none');
    } finally {
      if (prevKey === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = prevKey;
      if (prevTok === undefined) delete process.env.CODEX_ACCESS_TOKEN;
      else process.env.CODEX_ACCESS_TOKEN = prevTok;
    }
  });
});

/** Adapter whose process hangs silently (for the stall watchdog). */
class HangingAdapter implements BackendAdapter {
  readonly id = 'mock' as const;
  readonly structuredOutput = 'emulated' as const;
  spawns = 0;
  probe() {
    return Promise.resolve({ available: true });
  }
  buildSpawn(_req: AgentRequest): SpawnPlan {
    this.spawns++;
    // prints one line then sleeps silently for 10s
    return {
      bin: process.execPath,
      argv: ['-e', 'console.log(JSON.stringify({text:"started"})); setTimeout(()=>{}, 10000)'],
      env: {},
    };
  }
  buildResume() {
    return null;
  }
  createParser() {
    return {
      push(line: string): AgentEvent[] {
        const obj = parseJsonLine(line) as { text?: string } | undefined;
        return obj?.text ? [{ kind: 'message', text: obj.text }] : [];
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

/** Adapter emitting declined tool actions but exiting 0 (silent no-op trap). */
class DecliningAdapter extends HangingAdapter {
  override buildSpawn(_req: AgentRequest): SpawnPlan {
    return {
      bin: process.execPath,
      argv: [
        '-e',
        'console.log(JSON.stringify({tool:"bash:rm",status:"declined"}));console.log(JSON.stringify({tool:"bash:edit",status:"declined"}));console.log(JSON.stringify({text:"I did the thing (not really)"}));console.log(JSON.stringify({done:1}))',
      ],
      env: {},
    };
  }
  override createParser() {
    return {
      push(line: string): AgentEvent[] {
        const obj = parseJsonLine(line) as Record<string, unknown> | undefined;
        if (!obj) return [];
        if (typeof obj.tool === 'string') {
          return [{ kind: 'tool', name: obj.tool, status: obj.status as 'declined' }];
        }
        if (typeof obj.text === 'string') return [{ kind: 'message', text: obj.text }];
        if (obj.done) return [{ kind: 'result', isError: false }];
        return [];
      },
      end: (): AgentEvent[] => [],
    };
  }
}

const SIGNAL = new AbortController().signal;

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return { seq: 0, prompt: 'task', label: 't', backend: 'mock', cwd: process.cwd(), retries: 0, ...overrides };
}

describe('watchdogs', () => {
  it('stall watchdog kills a silent process and classifies stalled (retryable)', async () => {
    const adapter = new HangingAdapter();
    const ex = new AgentCallExecutor(adapter);
    const started = Date.now();
    const outcome = await ex.execute(spec({ stallMs: 300 }), SIGNAL);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('stall watchdog');
    expect(adapter.spawns).toBe(1); // retries: 0 → no respawn
  });

  it('stall watchdog + retries respawns', async () => {
    const adapter = new HangingAdapter();
    const ex = new AgentCallExecutor(adapter);
    const outcome = await ex.execute(spec({ stallMs: 250, retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(false);
    expect(adapter.spawns).toBe(2);
  }, 15_000);

  it('attempt timeout kills and reports', async () => {
    const adapter = new HangingAdapter();
    const ex = new AgentCallExecutor(adapter, { attemptTimeoutMs: 400 });
    const outcome = await ex.execute(spec(), SIGNAL);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('timed out');
  });
});

describe('silent no-op detector', () => {
  it('surfaces declined actions as warnings on an otherwise-ok outcome', async () => {
    const ex = new AgentCallExecutor(new DecliningAdapter());
    const outcome = await ex.execute(spec(), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings![0]).toContain('2 action(s) auto-rejected');
  });
});

describe('CLI --max-concurrency fail-fast', () => {
  const SCRIPT = `export const meta = { name: 't', description: 'd' }\nreturn 1`;
  const BAD_VALUES = ['0', '-1', '2.5', 'abc', ''];

  function captureStderr() {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    return { chunks, spy };
  }

  it('run rejects non-positive-integer values before creating any run state', async () => {
    const { runCommand } = await import('../../src/cli/run.js');
    const dir = mkdtempSync(join(tmpdir(), 'uc-mcguard-'));
    const file = join(dir, 't.workflow.js');
    writeFileSync(file, SCRIPT);
    const home = join(dir, 'store');
    const { chunks, spy } = captureStderr();
    try {
      for (const bad of BAD_VALUES) {
        chunks.length = 0;
        expect(await runCommand(file, { yes: true, backend: 'mock', home, maxConcurrency: bad })).toBe(1);
        expect(chunks.join('')).toContain('--max-concurrency must be a positive integer');
      }
      expect(existsSync(home)).toBe(false); // no run store, no orphanable run dir
    } finally {
      spy.mockRestore();
    }
  });

  it('run persists a valid --max-concurrency into the new run config', async () => {
    const { runCommand } = await import('../../src/cli/run.js');
    const { readRunConfig } = await import('../../src/store/runstore.js');
    const { readManifest, isTerminal } = await import('../../src/store/manifest.js');
    const dir = mkdtempSync(join(tmpdir(), 'uc-mcaccept-'));
    const file = join(dir, 't.workflow.js');
    writeFileSync(file, SCRIPT);
    const home = join(dir, 'store');
    const outs: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      outs.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runCommand(file, { yes: true, backend: 'mock', home, maxConcurrency: '4', detach: true })).toBe(0);
      const runId = outs.join('').trim().split('\n')[0]!;
      const runDir = join(home, 'runs', runId);
      expect(readRunConfig(runDir).maxConcurrency).toBe(4);
      // Let the detached runner reach terminal so it can't outlive the test.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const m = readManifest(runDir);
        if (m && isTerminal(m.status)) break;
        if (Date.now() > deadline) throw new Error(`run not terminal: ${m?.status}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  }, 30_000);

  it('ULTRACODE_MAX_CONCURRENCY seeds a fresh run config; an explicit flag beats the env', async () => {
    const { runCommand } = await import('../../src/cli/run.js');
    const { readRunConfig } = await import('../../src/store/runstore.js');
    const { readManifest, isTerminal } = await import('../../src/store/manifest.js');
    const dir = mkdtempSync(join(tmpdir(), 'uc-mcenv-'));
    const file = join(dir, 't.workflow.js');
    writeFileSync(file, SCRIPT);
    const prevEnv = process.env.ULTRACODE_MAX_CONCURRENCY;
    const outs: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      outs.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const runAndReadMc = async (home: string, flag?: string) => {
      outs.length = 0;
      expect(
        await runCommand(file, { yes: true, backend: 'mock', home, detach: true, maxConcurrency: flag }),
      ).toBe(0);
      const runDir = join(home, 'runs', outs.join('').trim().split('\n')[0]!);
      const deadline = Date.now() + 15_000;
      for (;;) {
        const m = readManifest(runDir);
        if (m && isTerminal(m.status)) break;
        if (Date.now() > deadline) throw new Error(`run not terminal: ${m?.status}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      return readRunConfig(runDir).maxConcurrency;
    };
    try {
      process.env.ULTRACODE_MAX_CONCURRENCY = '7';
      expect(await runAndReadMc(join(dir, 's1'))).toBe(7); // env seeds the frozen config
      expect(await runAndReadMc(join(dir, 's2'), '4')).toBe(4); // explicit flag beats env
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (prevEnv === undefined) delete process.env.ULTRACODE_MAX_CONCURRENCY;
      else process.env.ULTRACODE_MAX_CONCURRENCY = prevEnv;
    }
  }, 40_000);

  it('resume validates --max-concurrency before touching the store', async () => {
    const { resumeCommand } = await import('../../src/cli/resume.js');
    const home = join(mkdtempSync(join(tmpdir(), 'uc-mcguard-')), 'store');
    const { chunks, spy } = captureStderr();
    try {
      // Guard fires before the run lookup: the bad value — not the unknown
      // runId — must be the reported error.
      expect(await resumeCommand('wf_zzzzzzzzzzzz', { home, maxConcurrency: '2.5' })).toBe(1);
      expect(chunks.join('')).toContain('--max-concurrency must be a positive integer');
      expect(existsSync(home)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('wall-clock config plumbing', () => {
  it('RunConfig accepts wallClockMs', async () => {
    const { createRunDir, readRunConfig } = await import('../../src/store/runstore.js');
    const root = mkdtempSync(join(tmpdir(), 'uc-wc-'));
    mkdirSync(root, { recursive: true });
    const dir = createRunDir(root, {
      runId: 'wf_aaaaaaaaaaaa',
      name: 'x',
      source: 's',
      args: null,
      config: { backend: 'mock', cwd: '/p', wallClockMs: 1234 },
    });
    expect(readRunConfig(dir).wallClockMs).toBe(1234);
  });
});
