/** Benchmark process environment, diagnostics, and bounded-output behavior. */
import { describe, expect, it } from 'vitest';
import {
  allowlistedEnvironment,
  cleanupActiveBenchProcesses,
  runBenchProcess,
  sanitizeDiagnostic,
} from '../../bench/src/shared/process.js';

describe('benchmark process boundary', () => {
  it('forwards only base and explicitly selected environment values', () => {
    expect(allowlistedEnvironment({
      PATH: '/bin',
      DOCKER_HOST: 'unix:///run/docker.sock',
      GITHUB_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      OPENAI_API_KEY: 'selected',
    }, ['OPENAI_API_KEY'])).toEqual({
      PATH: '/bin',
      DOCKER_HOST: 'unix:///run/docker.sock',
      OPENAI_API_KEY: 'selected',
    });
  });

  it('redacts credentials, URL userinfo, and terminal control bytes', () => {
    const sanitized = sanitizeDiagnostic(
      'OPENAI_API_KEY=top-secret CODEX_AUTH_JSON_PATH=/private/codex/auth.json '
        + 'FEATUREBENCH_CREDENTIAL_BROKER_URL=https://broker.internal/v1 '
        + 'https://user:password@example.test/v1\u0001',
    );
    expect(sanitized).not.toMatch(/top-secret|private\/codex|broker\.internal|user:password|\u0001/);
    expect(sanitized).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(sanitized).toContain('https://[REDACTED]@example.test/v1?');
  });

  it('retains only bounded stdout and stderr tails', async () => {
    const lifecycle: string[] = [];
    const result = await runBenchProcess('/bin/sh', [
      '-c',
      "printf '%0100dstdout' 0; printf '%0100dstderr' 0 >&2",
    ], {
      cwd: process.cwd(),
      tailBytes: 8,
      drainMs: 100,
      terminationGraceMs: 0,
      onLifecycleToken: (token) => lifecycle.push(`token:${token}`),
      onLifecycleStarted: (token, pid) => lifecycle.push(`started:${token}:${pid ?? 'none'}`),
      onLifecycleRecovered: (token, recovery) => lifecycle.push(`recovered:${token}:${recovery}`),
    });
    expect(result.stdout).toBe('00stdout');
    expect(result.stderr).toBe('00stderr');
    expect(lifecycle).toHaveLength(3);
    const token = lifecycle[0]?.slice('token:'.length);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(lifecycle[1]).toMatch(new RegExp(`^started:${token}:\\d+$`));
    expect(lifecycle[2]).toBe(`recovered:${token}:complete`);
    await expect(cleanupActiveBenchProcesses(0)).resolves.toBe(0);
  });

  it('escalates a timed-out process that ignores SIGTERM', async () => {
    const startedAt = performance.now();
    await expect(runBenchProcess('/bin/sh', [
      '-c',
      "trap '' TERM; while :; do :; done",
    ], {
      cwd: process.cwd(),
      timeoutMs: 25,
      terminationGraceMs: 25,
      drainMs: 25,
    })).rejects.toThrow(/timed out/);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    await expect(cleanupActiveBenchProcesses(0)).resolves.toBe(0);
  });

  it('rejects invalid process supervision intervals', async () => {
    await expect(runBenchProcess('/bin/true', [], {
      cwd: process.cwd(),
      drainMs: -1,
    })).rejects.toThrow(/drainMs/);
    await expect(runBenchProcess('/bin/true', [], {
      cwd: process.cwd(),
      terminationGraceMs: -1,
    })).rejects.toThrow(/terminationGraceMs/);
  });
});
