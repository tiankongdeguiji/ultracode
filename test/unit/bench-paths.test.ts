/** Final benchmark identity and results-layout contract. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactKey,
  createBenchPathRoots,
  createPrivateRunDirectory,
  isSafeRunId,
  manifestFile,
  nativeDir,
  runDir,
  validateRelativeArtifactPath,
  validateRunId,
  validateTaskId,
} from '../../bench/src/shared/paths.js';

const roots: string[] = [];
const temporary = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'uc-bench-paths-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('benchmark identities', () => {
  it('accepts only canonical lowercase portable run ids', () => {
    for (const id of ['r', 'run-2026_07.20', 'a'.repeat(128)]) expect(isSafeRunId(id)).toBe(true);
    for (const id of [
      '', '.', '..', 'R1', '../run', 'a/b', 'a\\b', '-leading', 'trailing.',
      'has space', 'nul', 'COM1.txt', 'é', 'a'.repeat(129),
    ]) expect(isSafeRunId(id)).toBe(false);
    expect(validateRunId('run-1')).toBe('run-1');
    expect(() => validateRunId('../run')).toThrow(/invalid run id/);
  });

  it('keeps task identity out of paths and uses its complete digest for keys', () => {
    const first = artifactKey('Owner/repo: task 1');
    expect(first).toMatch(/^owner-repo-task-1-[a-f0-9]{64}$/);
    expect(artifactKey('a/b')).not.toBe(artifactKey('a b'));
    expect(artifactKey('🔥/../../CON')).toMatch(/^con-[a-f0-9]{64}$/);
    expect(validateTaskId('owner/repo/task')).toBe('owner/repo/task');
    expect(() => validateTaskId('bad\0task')).toThrow();
  });

  it('requires canonical relative artifact bindings', () => {
    expect(validateRelativeArtifactPath('native/tasks/key/a')).toBe('native/tasks/key/a');
    for (const value of [
      '', '.', '../native', 'native/../escape', '/native', 'C:\\native', 'native\\task',
      'native/CON', `native/${'a'.repeat(129)}`,
    ]) {
      expect(() => validateRelativeArtifactPath(value)).toThrow();
    }
  });
});

describe('suite-qualified run layout', () => {
  it('allows the same run id in different suite namespaces', () => {
    const paths = createBenchPathRoots(temporary());
    expect(runDir(paths, 'swebench-pro', 'pilot1')).toBe(join(paths.resultsRoot, 'swebench-pro', 'pilot1'));
    expect(runDir(paths, 'featurebench', 'pilot1')).toBe(join(paths.resultsRoot, 'featurebench', 'pilot1'));
    expect(manifestFile(paths, 'swe-marathon', 'pilot1')).toBe(
      join(paths.resultsRoot, 'swe-marathon', 'pilot1', 'manifest.json'),
    );
    expect(nativeDir(paths, 'featurebench', 'pilot1')).toBe(
      join(paths.resultsRoot, 'featurebench', 'pilot1', 'native'),
    );
  });

  it('preserves the results-root mode and creates suite/run directories as 0700', () => {
    const root = temporary();
    const paths = createBenchPathRoots(root);
    mkdirSync(paths.resultsRoot, { mode: 0o755 });
    chmodSync(paths.resultsRoot, 0o755);
    const directory = createPrivateRunDirectory(paths, 'swebench-pro', 'pilot1');
    expect(statSync(paths.resultsRoot).mode & 0o777).toBe(0o755);
    expect(statSync(join(paths.resultsRoot, 'swebench-pro')).mode & 0o777).toBe(0o700);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(() => createPrivateRunDirectory(paths, 'swebench-pro', 'pilot1')).toThrow();
  });
});
