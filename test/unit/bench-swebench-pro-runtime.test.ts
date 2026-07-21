/** Offline runtime-boundary tests for SWE-bench Pro deadlines and patch evidence. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactUnsafeError } from '../../bench/src/suites/swebench-pro/cleanup.js';
import { sessionTaskIdentity } from '../../bench/src/suites/swebench-pro/container-policy.js';
import { reattestTaskImage } from '../../bench/src/suites/swebench-pro/image.js';
import {
  remainingSessionOperationTimeout,
  waitForSessionExit,
} from '../../bench/src/suites/swebench-pro/runner.js';
import {
  PATCH_FAIL_BYTES,
  classifyPatchArtifact,
  classifyOutcome,
  readPatchArtifact,
} from '../../bench/src/suites/swebench-pro/state.js';
import { collectPredictions } from '../../bench/src/suites/swebench-pro/verifier.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function taskDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'uc-bench-pro-patch-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'out'), { mode: 0o700 });
  return root;
}

describe('SWE-bench Pro attempt deadlines', () => {
  it('bounds every image identity query', async () => {
    const timeouts: number[] = [];
    const attestation = {
      requested: 'jefzda/sweap-images:task',
      resolvedDigest: `jefzda/sweap-images@sha256:${'a'.repeat(64)}`,
      baseLocalId: `sha256:${'b'.repeat(64)}`,
      basePlatform: 'linux/amd64',
      overlayName: 'ultracode-swebench-pro:task',
      overlayLocalId: `sha256:${'c'.repeat(64)}`,
      overlayPlatform: 'linux/amd64',
    };
    await reattestTaskImage(attestation, async (argv, timeoutMs) => {
      timeouts.push(timeoutMs!);
      const localId = argv.at(-1) === attestation.resolvedDigest
        ? attestation.baseLocalId
        : attestation.overlayLocalId;
      return JSON.stringify([{ Id: localId, Os: 'linux', Architecture: 'amd64' }]);
    });
    expect(timeouts).toEqual([60_000, 60_000]);
  });

  it('computes an exact positive timeout after reserving cleanup time', () => {
    expect(remainingSessionOperationTimeout(10_000, 2_000, 1_000)).toBe(7_000);
    expect(remainingSessionOperationTimeout(10_000, 2_000, 7_999.5)).toBe(1);
    expect(() => remainingSessionOperationTimeout(10_000, 2_000, 8_000)).toThrow(/exhausted/);
  });

  it('clears the backstop timer when Docker wait rejects', async () => {
    vi.useFakeTimers();
    const waited = Promise.reject(new Error('Docker wait failed'));
    await expect(waitForSessionExit(waited, 60_000)).rejects.toThrow('Docker wait failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the backstop timer after the backstop wins', async () => {
    vi.useFakeTimers();
    const result = waitForSessionExit(new Promise(() => {}), 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBe('backstop');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('SWE-bench Pro task identity', () => {
  it('keeps a dynamic nonzero task identity separate from host artifact ownership', () => {
    const entrypoint = readFileSync(join(process.cwd(), 'bench/suites/swebench-pro/entrypoint.sh'), 'utf8');
    const dockerfile = readFileSync(join(process.cwd(), 'bench/suites/swebench-pro/Dockerfile'), 'utf8');
    expect(entrypoint).toContain('TASK_UID=$BENCH_TASK_UID');
    expect(entrypoint).toContain('TASK_GID=$BENCH_TASK_GID');
    expect(entrypoint).toContain('valid_nonzero_id "${BENCH_TASK_UID:-}"');
    expect(entrypoint).toContain('[ "$BENCH_TASK_UID" = "$ARTIFACT_UID" ]');
    expect(entrypoint).toContain('[ "$REPO_DIR" = /app ]');
    expect(entrypoint).toContain(
      'trusted_busybox chown -R "$TASK_UID:$TASK_GID"',
    );
    expect(entrypoint).toContain('as_task "$CODEX" --version');
    expect(entrypoint).not.toContain('/bin/bash');
    expect(entrypoint).not.toContain('BENCH_CHOWN');
    expect(dockerfile.match(/^COPY .*$/gm)?.every((line) =>
      line.includes('--chown=0:0') && line.includes('--chmod=0555'))).toBe(true);
    expect(sessionTaskIdentity({ uid: 1_000, gid: 1_000 })).toEqual({ uid: 1_001, gid: 1_001 });
  });
});

describe('SWE-bench Pro bounded patch reads', () => {
  it('keeps the exact size boundary readable and classifies the next byte as too large', () => {
    const task = taskDirectory();
    const patchFile = join(task, 'out', 'patch.diff');
    writeFileSync(patchFile, Buffer.alloc(PATCH_FAIL_BYTES, 0x61));
    const boundary = readPatchArtifact(task);
    expect(boundary).toMatchObject({ kind: 'patch', patchBytes: PATCH_FAIL_BYTES });
    expect(classifyPatchArtifact(boundary)).toMatchObject({
      phase: 'patched',
      patchBytes: PATCH_FAIL_BYTES,
      validation: { failure: null, annotations: ['large-patch'] },
    });

    writeFileSync(patchFile, Buffer.alloc(PATCH_FAIL_BYTES + 1, 0x61));
    const oversized = readPatchArtifact(task);
    expect(oversized).toEqual({ kind: 'too-large', patchBytes: PATCH_FAIL_BYTES + 1 });
    expect(classifyPatchArtifact(oversized)).toEqual({
      phase: 'patched',
      patchBytes: PATCH_FAIL_BYTES + 1,
      validation: { failure: 'patch-too-large', annotations: ['large-patch'] },
    });
    expect(classifyOutcome({
      codexExit: 124,
      startedAt: 0,
      endedAt: 1,
      baseSha: 'a',
      expectedBase: 'a',
      patchBytes: PATCH_FAIL_BYTES + 1,
      applyCheck: null,
      ucRuns: [],
      waitedForTerminalMs: 0,
      failure: null,
    }, classifyPatchArtifact(oversized).validation)).toMatchObject({
      failure: 'patch-too-large',
      annotations: ['large-patch'],
    });
  });

  it('reserves empty-patch for missing and zero-byte files and propagates unsafe artifacts', () => {
    const task = taskDirectory();
    expect(classifyPatchArtifact(readPatchArtifact(task))).toMatchObject({
      phase: 'session-done', patchBytes: 0, validation: { failure: 'empty-patch' },
    });
    writeFileSync(join(task, 'out', 'patch.diff'), '');
    expect(classifyPatchArtifact(readPatchArtifact(task))).toMatchObject({
      phase: 'session-done', patchBytes: 0, validation: { failure: 'empty-patch' },
    });
    rmSync(join(task, 'out', 'patch.diff'));
    symlinkSync('/dev/null', join(task, 'out', 'patch.diff'));
    const unsafe = readPatchArtifact(task);
    expect(unsafe.kind).toBe('unsafe');
    expect(classifyPatchArtifact(unsafe).validation.failure).toBe('artifact-unsafe');
  });

  it('uses the same distinctions while collecting predictions', () => {
    const runDirectory = mkdtempSync(join(tmpdir(), 'uc-bench-pro-predictions-'));
    temporaryRoots.push(runDirectory);
    const nativeRoot = 'native/tasks/task-a/a';
    const task = join(runDirectory, nativeRoot);
    mkdirSync(join(task, 'out'), { recursive: true, mode: 0o700 });
    const manifest = {
      artifacts: { executions: [{ taskId: 'task-a', arm: 'a', nativeRoot }] },
    } as never;
    const instances = [{ instanceId: 'task-a' }] as never;

    expect(collectPredictions(manifest, runDirectory, 'a', instances)).toEqual([]);
    writeFileSync(join(task, 'out', 'patch.diff'), ' \n');
    expect(collectPredictions(manifest, runDirectory, 'a', instances)).toEqual([{
      instance_id: 'task-a', patch: ' \n', prefix: 'armA',
    }]);
    writeFileSync(join(task, 'out', 'patch.diff'), Buffer.alloc(PATCH_FAIL_BYTES + 1, 0x61));
    expect(collectPredictions(manifest, runDirectory, 'a', instances)).toEqual([]);

    rmSync(join(task, 'out', 'patch.diff'));
    symlinkSync('/dev/null', join(task, 'out', 'patch.diff'));
    expect(() => collectPredictions(manifest, runDirectory, 'a', instances))
      .toThrow(ArtifactUnsafeError);
  });
});
