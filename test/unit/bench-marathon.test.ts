/** Offline contracts for the suite-owned SWE-Marathon adapter. */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BenchPathRoots } from '../../bench/src/shared/contracts.js';
import { artifactKey } from '../../bench/src/shared/paths.js';
import type { SweMarathonManifest } from '../../bench/src/shared/manifest.js';
import { sha256File } from '../../bench/src/shared/provenance.js';
import { sweMarathonAdapter } from '../../bench/src/suites/swe-marathon/adapter.js';
import {
  assertMarathonRuntimeBinding,
  cleanupMarathonRuntimeHome,
  cleanupMarathonRuntimeHomes,
  createMarathonRuntimeHome,
} from '../../bench/src/suites/swe-marathon/auth.js';
import {
  CONTEXT_PRESSURE_STRESS_TASKS,
  EXCLUDED_CUA_TASKS,
  SWE_MARATHON_HARBOR_VERSION,
  SWE_MARATHON_PYTHON_VERSION,
  SWE_MARATHON_REPOSITORY,
  SWE_MARATHON_SOURCE_REVISION,
  sweMarathonConfigSchema,
  validateMarathonTaskId,
} from '../../bench/src/suites/swe-marathon/config.js';
import {
  planMarathonPreparation,
  preflightMarathonPreparation,
  taskImageReference,
  validateHarborCodexApiKeyContract,
  type PreparedMarathonInputs,
} from '../../bench/src/suites/swe-marathon/prepare.js';
import {
  reattestTasksLinearly,
  type MarathonCommonAttestation,
} from '../../bench/src/suites/swe-marathon/provenance.js';
import {
  harborEvidenceInvocationId,
  hasCompleteHarborReceipt,
  marathonTaskInputs,
  marathonTaskFailure,
  planHarborRun,
  prepCommand,
  shouldResumeHarborJob,
  sweMarathonAnalysisHook,
} from '../../bench/src/suites/swe-marathon/runner.js';
import { indexSweMarathonMetrics } from '../../bench/src/suites/swe-marathon/telemetry.js';
import {
  indexHarborEvidence,
  validateHarborJobConfig,
  type HarborExecutionIdentity,
} from '../../bench/src/suites/swe-marathon/verifier.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'uc-marathon-v2-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function put(path: string, value: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, value);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('SWE-Marathon configuration and preparation', () => {
  it('pins source, Python, Harbor, and suite-owned native assets', () => {
    const root = temporaryDirectory();
    const roots: BenchPathRoots = { benchRoot: root, cacheRoot: join(root, '.cache'), resultsRoot: join(root, 'results') };
    expect(planMarathonPreparation(roots)).toEqual({
      repository: SWE_MARATHON_REPOSITORY,
      revision: SWE_MARATHON_SOURCE_REVISION,
      pythonVersion: SWE_MARATHON_PYTHON_VERSION,
      harborVersion: SWE_MARATHON_HARBOR_VERSION,
      ownershipPatch: join(root, 'suites/swe-marathon/harbor-ownership.patch'),
      bridge: join(root, 'suites/swe-marathon/arm_b_codex.py'),
    });
  });

  it('preflights uv and patch before any Marathon preparation side effect', async () => {
    const calls: Array<{ file: string; argv: readonly string[]; cwd: string }> = [];
    await preflightMarathonPreparation('/bench', '/opt/uv', async (file, argv, cwd) => {
      calls.push({ file, argv, cwd });
      return file === '/opt/uv' ? 'uv 0.8.0' : 'GNU patch 2.7.6';
    });
    expect(calls).toEqual([
      { file: '/opt/uv', argv: ['--version'], cwd: '/bench' },
      { file: 'patch', argv: ['--version'], cwd: '/bench' },
    ]);

    const source = readFileSync(resolve('bench/src/suites/swe-marathon/prepare.ts'), 'utf8');
    const body = source.slice(source.indexOf('export async function prepareMarathonInputs'));
    const preflight = body.indexOf('await preflightMarathonPreparation');
    expect(preflight).toBeGreaterThan(0);
    expect(preflight).toBeLessThan(body.indexOf('ensureRealDirectoryWithin'));
    expect(preflight).toBeLessThan(body.indexOf("command('docker'"));
    expect(preflight).toBeLessThan(body.indexOf('prepareSharedToolchain'));
  });

  it.each(['/opt/uv', 'patch'])('fails the Marathon tool preflight at unavailable %s', async (failedTool) => {
    const calls: string[] = [];
    await expect(preflightMarathonPreparation('/bench', '/opt/uv', async (file) => {
      calls.push(file);
      if (file === failedTool) throw new Error(`${file} unavailable`);
      return 'uv 0.8.0';
    })).rejects.toThrow(failedTool === '/opt/uv' ? /requires uv on PATH/ : /requires GNU patch on PATH/);
    expect(calls).toEqual(failedTool === '/opt/uv' ? ['/opt/uv'] : ['/opt/uv', 'patch']);
  });

  it('documents Marathon-only prep tools and API-key binding', () => {
    const readme = readFileSync(resolve('bench/README.md'), 'utf8');
    const guide = readFileSync(resolve('bench/docs/swe-marathon.md'), 'utf8');
    expect(readme).toContain('plus `uv` and GNU `patch`');
    expect(readme).toContain('API-key mode uses `OPENAI_API_KEY`');
    expect(readme).toContain('CODEX_AUTH_JSON_PATH=/path/to/auth.json');
    expect(guide).toContain('preflights both before\nnetwork access, cache staging');
    expect(guide).toContain('set `OPENAI_API_KEY`');
    expect(guide).toContain('singly-linked\n  regular file no larger than 4 MiB');
    const proPreparation = readFileSync(resolve('bench/src/suites/swebench-pro/toolchain.ts'), 'utf8');
    expect(proPreparation).not.toMatch(/(?:command|runBenchProcess)\(['"]uv['"]/u);
  });

  it('runs the public prep preflight before acquiring cache locks', async () => {
    const root = temporaryDirectory();
    const paths: BenchPathRoots = {
      benchRoot: root,
      cacheRoot: join(root, '.cache'),
      resultsRoot: join(root, 'results'),
    };
    await expect(prepCommand(
      { recoverStaleLock: false } as never,
      {
        paths,
        stdout: { write: () => true },
        stderr: { write: () => true },
        clock: { now: () => new Date(0), monotonicMs: () => 0 },
      } as never,
      async () => { throw new Error('missing preparation tool'); },
    )).rejects.toThrow('missing preparation tool');
    expect(existsSync(paths.cacheRoot)).toBe(false);
  });

  it('accepts only immutable task image declarations', () => {
    const digest = `registry.example/task@sha256:${'a'.repeat(64)}`;
    expect(taskImageReference(`[environment]\ndocker_image = "${digest}"\n`)).toBe(digest);
    expect(() => taskImageReference('docker_image = "registry.example/task:latest"\n')).toThrow(/immutable/);
  });

  it.each(['../zstd-decoder', '/tmp/task', 'zstd/decoder', '--help', 'Zstd-Decoder', 'not-a-real-task'])(
    'rejects unsafe or unknown task %s',
    (taskId) => expect(() => validateMarathonTaskId(taskId)).toThrow(),
  );

  it.each(EXCLUDED_CUA_TASKS)('rejects task %s without authoritative CUA evidence', (taskId) => {
    expect(() => validateMarathonTaskId(taskId)).toThrow(/no authoritative CUA/);
  });

  it('keeps the post-hoc context-pressure cohort explicit', () => {
    expect(CONTEXT_PRESSURE_STRESS_TASKS).toEqual([
      'find-network-alignments',
      'kubernetes-rust-rewrite',
      'nextjs-vite-rewrite',
      'rust-java-lsp',
    ]);
  });

  it('rejects the unsupported Marathon verifier timeout option', () => {
    const config = {
      model: 'gpt-test', requestedEffort: 'high', arm: 'a', taskIds: ['zstd-decoder'],
      auth: { mechanism: 'api-key', publicIdentity: 'test' }, workflowWaitMs: 1_000,
      timeouts: { taskMs: 60_000 },
    };
    expect(sweMarathonConfigSchema.parse(config).timeouts).toEqual({ taskMs: 60_000 });
    expect(() => sweMarathonConfigSchema.parse({
      ...config,
      timeouts: { ...config.timeouts, verifierMs: 1_000 },
    })).toThrow();
  });

  it('guards Harbor API-key auth creation before the Arm-B registration hook', () => {
    const authSetup = [
      'Codex auth: using OPENAI_API_KEY',
      'env["OPENAI_API_KEY"]',
      '"$CODEX_HOME/auth.json"',
      'mcp_command = self._build_register_mcp_servers_command()',
      'command=setup_command',
    ].join('\n');
    expect(() => validateHarborCodexApiKeyContract(authSetup)).not.toThrow();
    expect(() => validateHarborCodexApiKeyContract(authSetup.replace(
      'mcp_command = self._build_register_mcp_servers_command()\ncommand=setup_command',
      'command=setup_command\nmcp_command = self._build_register_mcp_servers_command()',
    ))).toThrow(/before MCP registration/);
    expect(readFileSync(resolve('bench/suites/swe-marathon/arm_b_codex.py'), 'utf8'))
      .toContain('cp -L "$CODEX_HOME/auth.json"');
  });
});

describe('SWE-Marathon command and provenance boundaries', () => {
  it('parses one arm, repeated tasks, resume, and task-at-a-time redo', () => {
    expect(sweMarathonAdapter.commands.run.parse([
      '--run-id', 'marathon-a1', '--arm', 'a', '--task-id', 'wasm-simd', '--task-id', 'zstd-decoder',
      '--resume', '--redo', 'wasm-simd',
    ])).toMatchObject({
      runId: 'marathon-a1',
      arm: 'a',
      taskIds: ['wasm-simd', 'zstd-decoder'],
      resume: true,
      redo: ['wasm-simd'],
    });
    expect(() => sweMarathonAdapter.commands.run.parse(['--run-id', 'r1', '--arm', 'both'])).toThrow(/a or b/);
  });

  it('attests common inputs once and each task once in launch order', async () => {
    const calls: string[] = [];
    const common = { preparedIdentity: 'a'.repeat(64), prepared: {} as PreparedMarathonInputs };
    const results = await reattestTasksLinearly(['wasm-simd', 'zstd-decoder'], {
      attestCommon() { calls.push('common'); return common; },
      async attestTask(_common, taskId) {
        calls.push(`task:${taskId}`);
        return {
          taskId,
          configRelativePath: `tasks/${taskId}/task.toml`,
          configSha256: 'b'.repeat(64),
          imageRequested: `image@sha256:${'c'.repeat(64)}`,
          imageResolvedDigest: `image@sha256:${'c'.repeat(64)}`,
          imageLocalId: 'sha256:image',
          imagePlatform: 'linux/amd64',
        };
      },
    }, async (task) => { calls.push(`launch:${task.taskId}`); return task.taskId; });
    expect(results).toEqual(['wasm-simd', 'zstd-decoder']);
    expect(calls).toEqual([
      'common',
      'task:wasm-simd',
      'launch:wasm-simd',
      'task:zstd-decoder',
      'launch:zstd-decoder',
    ]);
  });

  it('keeps authentication runtime-only in a disposable private home', () => {
    const root = temporaryDirectory();
    const auth = join(root, 'auth.json');
    writeFileSync(auth, '{"tokens":{}}\n', { mode: 0o600 });
    chmodSync(auth, 0o600);
    const config = {
      model: 'gpt-test', requestedEffort: 'high', arm: 'a' as const, taskIds: ['zstd-decoder'],
      auth: { mechanism: 'chatgpt' as const, publicIdentity: 'test' }, workflowWaitMs: 1_000,
      timeouts: { taskMs: 60_000 },
    };
    const source = { PATH: '/usr/bin', CODEX_AUTH_JSON_PATH: auth };
    expect(() => assertMarathonRuntimeBinding(config, source)).not.toThrow();
    const runtime = createMarathonRuntimeHome(config, '/bridge', {
      ULTRACODE_BENCHMARK_SCHEMA: '2',
      ULTRACODE_BENCHMARK_SUITE: 'swe-marathon',
      ULTRACODE_BENCHMARK_RUN: 'pilot1',
      ULTRACODE_BENCHMARK_TASK: 'zstd-decoder',
      ULTRACODE_BENCHMARK_ARM: 'a',
      ULTRACODE_BENCHMARK_PURPOSE: 'session',
      ULTRACODE_BENCHMARK_OWNERSHIP: '1',
      ULTRACODE_BENCHMARK_RUNTIME: 'a'.repeat(64),
    }, source);
    expect(runtime.environment.CODEX_AUTH_JSON_PATH).toBe(join(runtime.directory, 'auth.json'));
    expect(runtime.environment.PYTHONPATH).toBe('/bridge');
    expect(JSON.stringify(runtime.environment)).not.toContain('{"tokens"');
    expect(cleanupMarathonRuntimeHome('pilot1', 'zstd-decoder', 'a', 'b'.repeat(64))).toBe(0);
    expect(existsSync(runtime.directory)).toBe(true);
    expect(cleanupMarathonRuntimeHomes('foreign', 'zstd-decoder', 'a')).toBe(0);
    expect(cleanupMarathonRuntimeHomes('pilot1', 'zstd-decoder', 'a')).toBe(1);
    runtime.cleanup();
    expect(existsSync(runtime.directory)).toBe(false);
  });
});

function nativeFixture(reward = 0.75): {
  root: string;
  identity: HarborExecutionIdentity;
  manifest: SweMarathonManifest;
  trial: string;
} {
  const root = temporaryDirectory();
  const taskId = 'zstd-decoder';
  const key = artifactKey(taskId);
  const jobRelativeRoot = `native/tasks/${key}`;
  const job = join(root, ...jobRelativeRoot.split('/'));
  const trial = join(job, 'trial-1');
  const agent = { name: 'arm_b_codex:ArmBCodex', model_name: 'openai/gpt-test', kwargs: {
    reasoning_effort: 'high', web_search: 'disabled',
  } };
  put(join(job, 'config.json'), `${JSON.stringify({ task: { path: `tasks/${taskId}` }, agent, n_attempts: 1, max_retries: 0 })}\n`);
  put(join(job, 'result.json'), '{"status":"complete"}\n');
  put(join(trial, 'config.json'), `${JSON.stringify({ trial_name: 'trial-1', task: { path: `tasks/${taskId}` }, agent })}\n`);
  put(join(trial, 'result.json'), `${JSON.stringify({
    task_name: taskId,
    trial_name: 'trial-1',
    verifier_result: { rewards: { reward } },
  })}\n`);
  const identity = { taskId, arm: 'b' as const, model: 'openai/gpt-test', requestedEffort: 'high', jobRelativeRoot };
  const manifest = {
    experiment: { model: identity.model, requestedEffort: identity.requestedEffort, arm: 'b', taskIds: [taskId] },
    suiteConfig: { workflowWaitMs: 3_300_000 },
    artifacts: { executions: [{ taskId, arm: 'b', key, nativeRoot: jobRelativeRoot }] },
  } as unknown as SweMarathonManifest;
  return { root, identity, manifest, trial };
}

describe('native Harbor evidence', () => {
  it('accepts the sanitized Harbor 0.17.1 direct-child golden', () => {
    const root = temporaryDirectory();
    const taskId = 'zstd-decoder';
    const jobRelativeRoot = `native/tasks/${artifactKey(taskId)}`;
    cpSync(
      resolve('test/fixtures/bench/swe-marathon/harbor-0.17.1'),
      join(root, ...jobRelativeRoot.split('/')),
      { recursive: true },
    );
    const indexed = indexHarborEvidence(root, {
      taskId,
      arm: 'b',
      model: 'openai/gpt-test',
      requestedEffort: 'high',
      jobRelativeRoot,
    }, '5a9db8e2-7768-4f7e-8dad-cabfa11a48f8');
    expect(indexed.nativeResult).toMatchObject({ verification: 'verified', score: 0.75, resolved: false });
  });

  it('validates exact job fields rather than matching distractor strings', () => {
    const { identity } = nativeFixture();
    const exact = {
      task: { path: 'tasks/zstd-decoder' },
      agent: { name: 'arm_b_codex:ArmBCodex', model_name: 'openai/gpt-test', kwargs: {
        reasoning_effort: 'high', web_search: 'disabled',
      } },
      n_attempts: 1,
      max_retries: 0,
    };
    expect(() => validateHarborJobConfig(exact, identity)).not.toThrow();
    expect(() => validateHarborJobConfig({ ...exact, task: { path: 'tasks/wasm-simd' }, distractor: exact }, identity))
      .toThrow(/task.path mismatch/);
  });

  it('binds job and direct-child trial evidence and preserves the native reward', () => {
    const { root, identity } = nativeFixture(0.75);
    const indexed = indexHarborEvidence(root, identity, '5a9db8e2-7768-4f7e-8dad-cabfa11a48f8');
    expect(indexed.nativeResult).toMatchObject({ verification: 'verified', score: 0.75, resolved: false });
    expect(indexed.bindings.map((binding) => [binding.role, binding.nativeRecordKey])).toEqual([
      ['native-config', 'job-config'],
      ['run-metadata', 'job-result'],
      ['native-config', 'trial-config:trial-1'],
      ['native-result', 'zstd-decoder/trial-1/verifier_result.rewards.reward'],
    ]);
    expect(hasCompleteHarborReceipt(
      indexed.bindings,
      '5a9db8e2-7768-4f7e-8dad-cabfa11a48f8',
      identity.taskId,
      identity.arm,
    )).toBe(true);
    expect(hasCompleteHarborReceipt(
      indexed.bindings.filter((binding) => binding.role !== 'run-metadata'),
      '5a9db8e2-7768-4f7e-8dad-cabfa11a48f8',
      identity.taskId,
      identity.arm,
    )).toBe(false);
  });

  it('recovers an attempt-ahead receipt write under the producing invocation', () => {
    const fixture = nativeFixture();
    const producingInvocation = '11111111-1111-4111-8111-111111111111';
    const noOpInvocation = '22222222-2222-4222-8222-222222222222';
    const state = { attempts: [{
      taskId: fixture.identity.taskId,
      arm: fixture.identity.arm,
      phase: 'session',
      invocationId: producingInvocation,
    }] };
    const bindingInvocation = harborEvidenceInvocationId(
      state as never,
      fixture.identity.taskId,
      fixture.identity.arm,
      noOpInvocation,
    );
    const recovered = indexHarborEvidence(fixture.root, fixture.identity, bindingInvocation);
    expect(bindingInvocation).toBe(producingInvocation);
    expect(new Set(recovered.bindings.map((binding) => binding.invocationId)))
      .toEqual(new Set([producingInvocation]));
    expect(hasCompleteHarborReceipt(
      recovered.bindings,
      producingInvocation,
      fixture.identity.taskId,
      fixture.identity.arm,
    )).toBe(true);
    expect(hasCompleteHarborReceipt(
      recovered.bindings,
      noOpInvocation,
      fixture.identity.taskId,
      fixture.identity.arm,
    )).toBe(false);
    expect(harborEvidenceInvocationId(
      { attempts: [] },
      fixture.identity.taskId,
      fixture.identity.arm,
      noOpInvocation,
    )).toBe(noOpInvocation);
    expect(shouldResumeHarborJob(true, false)).toBe(true);
    expect(shouldResumeHarborJob(true, true)).toBe(false);
    const redoEvidence = indexHarborEvidence(fixture.root, fixture.identity, noOpInvocation);
    expect(new Set(redoEvidence.bindings.map((binding) => binding.invocationId)))
      .toEqual(new Set([noOpInvocation]));

    const source = readFileSync(resolve('bench/src/suites/swe-marathon/runner.ts'), 'utf8');
    const outcomeAt = source.indexOf('const evidence = indexHarborEvidence(directory, identity, invocationId);');
    const outcomeBlock = source.slice(outcomeAt, source.indexOf('output(context,', outcomeAt));
    expect(outcomeAt).toBeGreaterThan(0);
    expect(outcomeBlock.indexOf('await recordAttempt(state,')).toBeGreaterThan(0);
    expect(outcomeBlock.indexOf('await updateReceipt(receipt, identity, evidence.bindings);'))
      .toBeGreaterThan(outcomeBlock.indexOf('await recordAttempt(state,'));
  });

  it('binds exact identity-valid VerifierTimeoutError evidence without a reward', () => {
    const fixture = nativeFixture();
    const invocationId = '11111111-1111-4111-8111-111111111111';
    const resultPath = join(fixture.trial, 'result.json');
    put(resultPath, `${JSON.stringify({
      task_name: fixture.identity.taskId,
      trial_name: 'trial-1',
      verifier_result: null,
      exception_info: { exception_type: 'VerifierTimeoutError', exception_message: 'native deadline' },
    })}\n`);
    const indexed = indexHarborEvidence(fixture.root, fixture.identity, invocationId);
    expect(indexed.nativeResult).toEqual({ verification: 'unverified', score: null, resolved: null, artifact: null });
    expect(indexed.terminalFailure).toBe('verifier-timeout');
    expect(indexed.bindings.at(-1)).toMatchObject({
      role: 'native-result',
      sha256: sha256File(resultPath),
      nativeRecordKey: 'zstd-decoder/trial-1/exception_info.exception_type',
    });
    expect(hasCompleteHarborReceipt(
      indexed.bindings,
      invocationId,
      fixture.identity.taskId,
      fixture.identity.arm,
    )).toBe(true);
    const task = marathonTaskInputs(fixture.manifest, { attempts: [{
      taskId: fixture.identity.taskId,
      arm: fixture.identity.arm,
      phase: 'session',
      invocationId,
      status: 'failed',
      failures: ['native-runner-failed', 'verifier-output-missing'],
    }] } as never, indexed.bindings, fixture.root)[0]!;
    expect(task.invocationId).toBe(invocationId);
    expect(task.nativeVerifier).toEqual({ verification: 'unverified', score: null, resolved: null, artifact: null });
    expect(task.failures.map((failure) => failure.code)).toEqual(['verifier-timeout']);
    expect(marathonTaskFailure('driver-watchdog', indexed)).toBe('driver-watchdog');
    expect(marathonTaskFailure('native-runner-failed', indexed)).toBe('verifier-timeout');
  });

  it('keeps wrong-identity timeouts and generic missing rewards unverified and incomplete', () => {
    const fixture = nativeFixture();
    const invocationId = '11111111-1111-4111-8111-111111111111';
    const resultPath = join(fixture.trial, 'result.json');
    put(resultPath, `${JSON.stringify({
      task_name: 'wasm-simd',
      trial_name: 'trial-1',
      exception_info: { exception_type: 'VerifierTimeoutError' },
    })}\n`);
    const wrongIdentity = indexHarborEvidence(fixture.root, fixture.identity, invocationId);
    expect(wrongIdentity.terminalFailure).toBeNull();
    expect(wrongIdentity.bindings.some((binding) => binding.role === 'native-result')).toBe(false);

    put(resultPath, `${JSON.stringify({
      task_name: fixture.identity.taskId,
      trial_name: 'trial-1',
      verifier_result: { rewards: {} },
      exception_info: null,
    })}\n`);
    const missingReward = indexHarborEvidence(fixture.root, fixture.identity, invocationId);
    expect(missingReward.terminalFailure).toBeNull();
    expect(marathonTaskFailure(null, missingReward)).toBe('verifier-output-missing');
    expect(hasCompleteHarborReceipt(
      missingReward.bindings,
      invocationId,
      fixture.identity.taskId,
      fixture.identity.arm,
    )).toBe(false);
  });

  it('requires explicit one-attempt and zero-retry Harbor policy fields', () => {
    const { identity } = nativeFixture();
    const config = {
      task: { path: `tasks/${identity.taskId}` },
      agent: { name: 'arm_b_codex:ArmBCodex', model_name: identity.model, kwargs: {
        reasoning_effort: identity.requestedEffort, web_search: 'disabled',
      } },
    };
    expect(() => validateHarborJobConfig(config, identity)).toThrow(/one attempt/);
  });

  it('ignores nested lookalikes and accepts resolved only for reward exactly one', () => {
    const fixture = nativeFixture(1);
    put(join(fixture.trial, 'nested', 'result.json'), `${JSON.stringify({
      task_name: fixture.identity.taskId,
      trial_name: 'nested',
      verifier_result: { rewards: { reward: 0 } },
    })}\n`);
    expect(indexHarborEvidence(fixture.root, fixture.identity, '5a9db8e2-7768-4f7e-8dad-cabfa11a48f8').nativeResult)
      .toMatchObject({ score: 1, resolved: true });
  });

  it.each([-0.01, 1.01, Number.NaN])('leaves out-of-range native reward %s unverified', (reward) => {
    const fixture = nativeFixture(reward);
    expect(indexHarborEvidence(fixture.root, fixture.identity, '5a9db8e2-7768-4f7e-8dad-cabfa11a48f8').nativeResult)
      .toEqual({ verification: 'unverified', score: null, resolved: null, artifact: null });
  });
});

describe('Harbor plan, telemetry, and bridge assets', () => {
  it('uses one task per native job and the run native/tasks directory', () => {
    const fixture = nativeFixture();
    const roots = { benchRoot: '/bench', cacheRoot: '/bench/.cache', resultsRoot: '/bench/results' };
    const common = { prepared: {
      harborBinary: '/prepared/environment/bin/harbor',
      sourceDirectory: '/prepared/source',
      toolchain: { directory: '/prepared/toolchain' },
    } } as unknown as MarathonCommonAttestation;
    const plan = planHarborRun(roots, fixture.root, fixture.manifest, common, fixture.identity.taskId, false);
    expect(plan.argv).toContain('arm_b_codex:ArmBCodex');
    expect(plan.argv.slice(plan.argv.indexOf('--jobs-dir'), plan.argv.indexOf('--jobs-dir') + 2))
      .toEqual(['--jobs-dir', join(fixture.root, 'native/tasks')]);
    expect(plan.argv.slice(plan.argv.indexOf('--n-attempts'), plan.argv.indexOf('--n-attempts') + 4))
      .toEqual(['--n-attempts', '1', '--max-retries', '0']);
    expect(plan.argv[plan.argv.indexOf('--job-name') + 1]).toBe(artifactKey(fixture.identity.taskId));
  });

  it('indexes telemetry only beneath the validated trial root', () => {
    const fixture = nativeFixture();
    const host = '11111111-1111-4111-8111-111111111111';
    const worker = '22222222-2222-4222-8222-222222222222';
    put(join(fixture.trial, 'agent', 'arm_b_lifecycle.json'), `${JSON.stringify({ schema_version: 2, host_session_id: host })}\n`);
    put(join(fixture.trial, 'agent', 'sessions', `rollout-${host}.jsonl`), '{}\n');
    put(join(fixture.trial, 'agent', 'sessions', `rollout-${worker}.jsonl`), '{}\n');
    put(join(fixture.trial, 'agent', 'ultracode', 'runs', 'wf-1', 'config.json'), '{"backend":"mock"}\n');
    put(join(fixture.trial, 'agent', 'ultracode', 'runs', 'wf-1', 'manifest.json'), '{"status":"completed"}\n');
    put(join(fixture.trial, 'agent', 'ultracode', 'runs', 'wf-1', 'output.json'), '{"agentCount":1}\n');
    put(join(fixture.trial, 'agent', 'ultracode', 'runs', 'wf-1', 'agents', 'a1', 'result.json'),
      `${JSON.stringify({ sessionId: worker, backend: 'mock' })}\n`);
    put(join(fixture.root, 'lookalike', 'sessions', 'rollout-33333333-3333-4333-8333-333333333333.jsonl'), '{}\n');
    const indexed = indexSweMarathonMetrics(fixture.manifest, fixture.root);
    expect(indexed.rollouts).toHaveLength(2);
    expect(indexed.rollouts.map((rollout) => [rollout.roleHint, rollout.billingClass])).toEqual([
      ['host', 'billable'],
      ['worker', 'mock'],
    ]);
    expect(indexed.workflows).toMatchObject([{ workflowId: 'wf-1', billingClass: 'mock' }]);
  });

  it('keeps native and policy-adjusted reward analysis separately named', () => {
    const fixture = nativeFixture();
    const result = sweMarathonAnalysisHook.analyze({
      suite: 'swe-marathon',
      manifest: fixture.manifest,
      metrics: {} as never,
      taskResults: [{
        taskId: fixture.identity.taskId,
        arm: 'b',
        nativeVerifier: { verification: 'verified', score: 0.75, resolved: false, artifact: null },
        disposition: 'included-native',
        failures: [],
        annotations: [],
      }],
    });
    expect(result).toEqual({
      suite: 'swe-marathon',
      native: { meanReward: 0.75, verifiedTasks: 1, requestedTasks: 1 },
      policyAdjusted: { meanReward: 0.75, includedTasks: 1 },
    });
  });

  it('uses the canonical shared prefix and lifecycle-only bridge metadata', () => {
    const bridge = readFileSync(resolve('bench/suites/swe-marathon/arm_b_codex.py'), 'utf8');
    const prefix = readFileSync(resolve('bench/suites/shared/arm-b-prefix.txt'), 'utf8');
    const ownership = readFileSync(resolve('bench/suites/swe-marathon/harbor-ownership.patch'), 'utf8');
    expect(prefix).toBe('ultracode\n');
    expect(bridge).toContain('ARM_B_PREFIX_PATH = Path(__file__).resolve().parents[1] / "shared" / "arm-b-prefix.txt"');
    expect(bridge).toContain('ARM_B_PREFIX + instruction');
    expect(bridge).toContain('arm_b_lifecycle.json');
    expect(bridge).not.toContain('arm_b_metrics.json');
    expect(bridge).not.toContain('total_token_usage');
    expect(ownership).toContain('ultracode.benchmark.ownership');
  });
});
