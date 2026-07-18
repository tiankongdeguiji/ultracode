import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyOutcome, readStatus, validatePatch, writeStatus } from '../../bench/src/state.js';
import type { ArmStatus, SessionMeta } from '../../bench/src/types.js';

const SMALL_DIFF = `diff --git a/src/app.js b/src/app.js
index 1111111..2222222 100644
--- a/src/app.js
+++ b/src/app.js
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 module.exports = a;
`;

const LEAK_DIFF = `diff --git a/.ultracode/runs/x b/.ultracode/runs/x
index 1111111..2222222 100644
--- a/.ultracode/runs/x
+++ b/.ultracode/runs/x
@@ -1 +1 @@
-old
+new
`;

const BODY_MENTION_DIFF = `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,3 @@
 hello
+state lives in .ultracode/runs and .codex/config.toml
+diff --git a/.ultracode/x b/.ultracode/x is quoted here as text
`;

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    codexExit: 0,
    startedAt: 1_000,
    endedAt: 2_000,
    baseSha: 'abc123',
    expectedBase: 'abc123',
    patchBytes: 100,
    applyCheck: true,
    ucRuns: [],
    waitedForTerminalMs: 0,
    failure: null,
    ...over,
  };
}

describe('validatePatch', () => {
  it('flags empty and whitespace-only patches as empty-patch', () => {
    expect(validatePatch('')).toEqual({ failure: 'empty-patch', flags: [] });
    expect(validatePatch('  \n\t\n')).toEqual({ failure: 'empty-patch', flags: [] });
  });

  it('accepts a small real-looking diff with no flags', () => {
    expect(validatePatch(SMALL_DIFF)).toEqual({ failure: null, flags: [] });
  });

  it('flags a >2MB diff as large-patch but not as a failure', () => {
    const bigHunk = `+${'x'.repeat(80)}\n`.repeat(30_000);
    const res = validatePatch(SMALL_DIFF + bigHunk);
    expect(res.failure).toBeNull();
    expect(res.flags).toContain('large-patch');
  });

  it('fails a >10MB diff as patch-too-large and keeps the large-patch flag', () => {
    const hugeHunk = `+${'x'.repeat(99)}\n`.repeat(110_000);
    const res = validatePatch(SMALL_DIFF + hugeHunk);
    expect(res.failure).toBe('patch-too-large');
    expect(res.flags).toContain('large-patch');
  });

  it('flags excluded paths referenced in diff --git headers', () => {
    expect(validatePatch(LEAK_DIFF).flags).toContain('excluded-path-leak');
    const wf = SMALL_DIFF.replaceAll('src/app.js', 'flows/audit.workflow.js');
    expect(validatePatch(wf).flags).toContain('excluded-path-leak');
  });

  it('ignores excluded-path text inside hunk bodies', () => {
    expect(validatePatch(BODY_MENTION_DIFF)).toEqual({ failure: null, flags: [] });
  });
});

describe('classifyOutcome', () => {
  it('treats missing meta as a backstop-killed timeout', () => {
    expect(classifyOutcome(null, null)).toEqual({ failure: 'timeout', annotations: ['backstop-kill'] });
  });

  it('survives the entrypoint fallback meta shape (no ucRuns and friends)', () => {
    const fallback = { failure: 'harness-error', codexExit: -1 } as unknown as Parameters<typeof classifyOutcome>[0];
    expect(classifyOutcome(fallback, null)).toEqual({ failure: 'harness-error', annotations: [] });
  });

  it('lets the entrypoint failure verdict win over exit codes', () => {
    const res = classifyOutcome(meta({ failure: 'no-app-dir', codexExit: 124 }), null);
    expect(res.failure).toBe('no-app-dir');
  });

  it('maps exit 124 and 137 to timeout', () => {
    expect(classifyOutcome(meta({ codexExit: 124 }), null).failure).toBe('timeout');
    expect(classifyOutcome(meta({ codexExit: 137 }), null).failure).toBe('timeout');
  });

  it('maps other non-zero exits to agent-crash', () => {
    expect(classifyOutcome(meta({ codexExit: 1 }), null).failure).toBe('agent-crash');
  });

  it('surfaces the patch validation failure on a clean session', () => {
    const res = classifyOutcome(meta(), { failure: 'empty-patch', flags: [] });
    expect(res.failure).toBe('empty-patch');
  });

  it('maps a failed apply check to unapplyable-diff', () => {
    const res = classifyOutcome(meta({ applyCheck: false }), { failure: null, flags: [] });
    expect(res.failure).toBe('unapplyable-diff');
  });

  it('returns null failure for a fully clean session', () => {
    expect(classifyOutcome(meta(), { failure: null, flags: [] })).toEqual({ failure: null, annotations: [] });
  });

  it('collects annotations independently of the failure', () => {
    const res = classifyOutcome(
      meta({
        codexExit: 124,
        baseSha: 'def456',
        patchBytes: 0,
        ucRuns: [
          { runId: 'r1', status: 'completed' },
          { runId: 'r2', status: 'failed' },
        ],
      }),
      { failure: null, flags: ['large-patch'] },
    );
    expect(res.failure).toBe('timeout');
    expect(res.annotations).toEqual(['large-patch', 'base-sha-mismatch', 'unmerged-workspace', 'uc-run-failed']);
  });

  it('skips base-sha-mismatch when expectedBase is empty', () => {
    const res = classifyOutcome(meta({ baseSha: 'def456', expectedBase: '' }), null);
    expect(res.annotations).toEqual([]);
  });
});

describe('readStatus / writeStatus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-bench-state-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to pending when status.json is missing', () => {
    expect(readStatus(join(dir, 'nope'))).toEqual({ phase: 'pending', failure: null, annotations: [] });
  });

  it('roundtrips through an atomic write, creating parents', () => {
    const armDir = join(dir, 'iid-1', 'a');
    const s: ArmStatus = {
      phase: 'session-done',
      failure: null,
      annotations: ['mock-backend'],
      codexExit: 0,
      wallClockMs: 12_345,
    };
    writeStatus(armDir, s);
    expect(readStatus(armDir)).toEqual(s);
    expect(readdirSync(armDir)).toEqual(['status.json']);
  });

  it('degrades to pending on unparseable content', () => {
    const armDir = join(dir, 'iid-2', 'b');
    writeStatus(armDir, { phase: 'patched', failure: null, annotations: [] });
    writeFileSync(join(armDir, 'status.json'), '{not json');
    expect(readStatus(armDir)).toEqual({ phase: 'pending', failure: null, annotations: [] });
    writeFileSync(join(armDir, 'status.json'), '"a string"');
    expect(readStatus(armDir)).toEqual({ phase: 'pending', failure: null, annotations: [] });
  });
});
