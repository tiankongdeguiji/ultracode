/** Focused offline coverage for the final SWE-bench Pro adapter boundary. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { swebenchProAdapter } from '../../bench/src/suites/swebench-pro/adapter.js';
import {
  resolveSwebenchProConfig,
  swebenchProOperatorConfigSchema,
  type SwebenchProConfig,
} from '../../bench/src/suites/swebench-pro/config.js';
import { prepareTaskImage, repositoryDigest } from '../../bench/src/suites/swebench-pro/image.js';
import { instanceFromRow, selectInstances } from '../../bench/src/suites/swebench-pro/instances.js';
import type { SwebenchProContainerPolicy } from '../../bench/src/suites/swebench-pro/container-policy.js';
import { classifyOutcome } from '../../bench/src/suites/swebench-pro/state.js';
import {
  hasCompleteProVerifierReceipt,
  cleanupProRuntimeHomes,
  isRunFatalTransportFailure,
  ownedRunContainerIds,
  reclamationContainerName,
  reclamationNamespaceSnapshot,
  retainVerifierBindingsAfterRedo,
} from '../../bench/src/suites/swebench-pro/runner.js';
import {
  ownedEvaluatorContainerIds,
  parseEvaluatorResults,
  runOfficialEvaluator,
} from '../../bench/src/suites/swebench-pro/verifier.js';
import { createBenchPathRoots } from '../../bench/src/shared/paths.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function row(id: string): Record<string, unknown> {
  return {
    instance_id: id,
    repo: 'owner/repo',
    repo_language: 'ts',
    base_commit: 'a'.repeat(40),
    problem_statement: `problem ${id}`,
    requirements: null,
    interface: null,
    fail_to_pass: '[]',
    pass_to_pass: '[]',
    dockerhub_tag: 'owner.repo-task',
    before_repo_set_cmd: '',
    selected_test_files_to_run: '',
    patch: 'gold',
    test_patch: '',
    future_dataset_column: { preserved: true },
  };
}

const config: SwebenchProConfig = {
  model: 'gpt-test',
  requestedEffort: 'high',
  arm: 'both',
  selection: { taskIds: null, count: 1, seed: 7, stratifyBy: 'repo_language' },
  modelTransport: {
    relayIdentity: 'relay-test', relayVersion: 'v1', fixedDestination: 'https://api.openai.com/v1',
  },
  timeouts: { sessionMs: 60_000, verifierMs: 60_000, evaluatorWatchdogMs: 60_000 },
  concurrency: { tasks: 1, verifier: 1 },
  docker: { cpus: 1, memoryBytes: 1_000_000, keepImages: false },
  evaluator: {
    repository: 'https://github.com/scaleapi/SWE-bench_Pro-os',
    revision: 'ca10a60a5fcae51e6948ffe1485d4153d421e6c5',
    pipIndex: 'https://pypi.org/simple',
  },
  sanitizeGitHistory: true,
};

const containerPolicy: SwebenchProContainerPolicy = {
  schemaVersion: 1,
  kind: 'ultracode-swebench-pro-container-policy',
  session: {
    pidsLimit: 1_024,
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    capAdd: ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETPCAP', 'SETUID'],
    resources: 'manifest-docker',
  },
  evaluator: {
    pidsLimit: 1_024,
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    capAdd: [],
    resources: 'manifest-docker',
  },
  reclamation: {
    pidsLimit: 64,
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    capAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
    resources: 'manifest-docker',
    networkMode: 'none',
    user: '0:0',
  },
};

describe('SWE-bench Pro adapter parsing', () => {
  it('declares the exact command set and parses suite-native resume/redo options', () => {
    expect(Object.keys(swebenchProAdapter.commands)).toEqual([
      'fetch', 'prep', 'run', 'eval', 'report', 'status', 'clean',
    ]);
    expect(swebenchProAdapter.commands.run.parse([
      '--run-id', 'pilot1', '--resume', '--redo', 'owner/repo::a', '--task-id', 'owner/repo',
    ])).toMatchObject({
      runId: 'pilot1', resume: true, redo: ['owner/repo::a'], taskIds: ['owner/repo'],
    });
    expect(() => swebenchProAdapter.commands.run.parse(['--run-id', 'pilot1', '--unknown'])).toThrow(/unknown option/);
  });

  it('invalidates every native result in an affected evaluator arm on redo', () => {
    const binding = (taskId: string, arm: 'a' | 'b', role: 'native-result' | 'predictions') => ({
      invocationId: '11111111-1111-4111-8111-111111111111',
      scope: { kind: 'task-arm' as const, taskId, arm },
      role,
      path: `native/${taskId}-${arm}.json`,
      sha256: 'a'.repeat(64),
      nativeRecordKey: taskId,
    });
    const retained = retainVerifierBindingsAfterRedo([
      binding('one', 'a', 'native-result'),
      binding('two', 'a', 'native-result'),
      binding('one', 'b', 'native-result'),
      binding('two', 'a', 'predictions'),
    ] as never, new Set(['one\0a']));
    expect(retained.map((entry) => [entry.scope, entry.role])).toEqual([
      [{ kind: 'task-arm', taskId: 'one', arm: 'b' }, 'native-result'],
      [{ kind: 'task-arm', taskId: 'two', arm: 'a' }, 'predictions'],
    ]);
  });

  it('rejects disabling the mandatory Git history sanitizer', () => {
    expect(() => resolveSwebenchProConfig({
      schemaVersion: 2,
      toolchain: { nodeVersion: '22.0.0', nodeDistribution: 'nodejs', codexBinary: '/bin/false' },
      swebenchPro: config,
    }, { sanitizeGitHistory: false } as never)).toThrow();
  });

  it('rejects legacy direct provider credentials instead of falling back to unrestricted sessions', () => {
    const legacy = structuredClone(config) as unknown as Record<string, unknown>;
    delete legacy.modelTransport;
    legacy.auth = { mechanism: 'api-key', publicIdentity: 'legacy' };
    expect(() => swebenchProOperatorConfigSchema.parse({
      schemaVersion: 2,
      toolchain: { nodeVersion: '22.0.0', nodeDistribution: 'nodejs', codexBinary: '/bin/false' },
      swebenchPro: legacy,
    })).toThrow(/version 2 used direct provider auth.*migrate to version 3 modelTransport/);
    expect(swebenchProOperatorConfigSchema.parse({
      schemaVersion: 3,
      toolchain: { nodeVersion: '22.0.0', nodeDistribution: 'nodejs', codexBinary: '/bin/false' },
      swebenchPro: config,
    }).schemaVersion).toBe(3);
  });

  it.each([
    ['model', 'x" #'],
    ['model', 'x\\y'],
    ['model', 'x#comment'],
    ['requestedEffort', 'high"'],
    ['requestedEffort', 'high\\low'],
    ['requestedEffort', 'high#comment'],
  ] as const)('rejects TOML-unsafe %s values at the public config boundary', (field, value) => {
    expect(() => resolveSwebenchProConfig({
      schemaVersion: 3,
      toolchain: { nodeVersion: '22.0.0', nodeDistribution: 'nodejs', codexBinary: '/bin/false' },
      swebenchPro: { ...config, [field]: value },
    })).toThrow();
  });

  it('requires an exact query-free HTTPS model destination base', () => {
    expect(() => resolveSwebenchProConfig({
      schemaVersion: 2,
      toolchain: { nodeVersion: '22.0.0', nodeDistribution: 'nodejs', codexBinary: '/bin/false' },
      swebenchPro: {
        ...config,
        modelTransport: { ...config.modelTransport, fixedDestination: 'https://api.openai.com/v1?' },
      },
    })).toThrow(/fixed model destination/);
  });

  it('rejects operator-selected evaluator repositories and revisions', () => {
    const operator = {
      schemaVersion: 2,
      toolchain: { nodeVersion: '22.0.0', nodeDistribution: 'nodejs', codexBinary: '/bin/false' },
      swebenchPro: config,
    } as const;
    expect(() => resolveSwebenchProConfig(operator as never, {
      evaluator: { repository: 'https://example.test/evaluator.git' },
    } as never)).toThrow();
    expect(() => resolveSwebenchProConfig(operator as never, {
      evaluator: { revision: 'b'.repeat(40) },
    } as never)).toThrow();
  });

  it('does not treat a partial Pro verifier receipt as complete', () => {
    const invocationId = '11111111-1111-4111-8111-111111111111';
    const bindings = ['raw-samples', 'predictions', 'verifier-invocation', 'native-config'].map((role) => ({
      invocationId,
      scope: { kind: 'suite-check', name: role },
      role,
      path: `native/${role}.json`,
      sha256: 'a'.repeat(64),
      nativeRecordKey: role,
    }));
    expect(hasCompleteProVerifierReceipt(bindings as never, invocationId)).toBe(true);
    expect(hasCompleteProVerifierReceipt(bindings.slice(1) as never, invocationId)).toBe(false);
  });
});

describe('complete row freezing and strict native evidence', () => {
  it('retains complete sampled rows instead of reloading task IDs later', () => {
    const source = row('owner-repo-one');
    const instance = instanceFromRow(source);
    expect(instance.row).toEqual(source);
    expect(instance.row).not.toBe(source);
    expect(instance.row.future_dataset_column).toEqual({ preserved: true });
    const selected = selectInstances({
      schemaVersion: 1,
      kind: 'ultracode-swebench-pro-dataset-descriptor',
      dataset: 'ScaleAI/SWE-bench_Pro',
      config: 'default',
      split: 'test',
      rows: [row('task-b'), row('task-a')],
    }, { taskIds: ['task-a'], count: 1, seed: 0, stratifyBy: 'repo' });
    expect(selected.map((entry) => entry.instanceId)).toEqual(['task-a']);
  });

  it('keeps task-aa/task-az seeded selection stable under en-US and da-DK collation', () => {
    const cohort = ['task-aa', 'task-az'];
    const snapshot = {
      schemaVersion: 1 as const,
      kind: 'ultracode-swebench-pro-dataset-descriptor' as const,
      dataset: 'ScaleAI/SWE-bench_Pro' as const,
      config: 'default' as const,
      split: 'test' as const,
      rows: [row('task-az'), row('task-aa')],
    };
    const localeOrders = ['en-US', 'da-DK'].map((locale) =>
      [...cohort].sort(new Intl.Collator(locale).compare));
    expect(localeOrders).toEqual([
      ['task-aa', 'task-az'],
      ['task-az', 'task-aa'],
    ]);
    const selectUnderLocale = (locale: string, count: number): string[] => {
      const collator = new Intl.Collator(locale);
      const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
        this: string,
        value: string,
      ) {
        return collator.compare(String(this), value);
      });
      try {
        return selectInstances(snapshot, {
          taskIds: null,
          count,
          seed: 7,
          stratifyBy: 'repo',
        }).map((entry) => entry.instanceId);
      } finally {
        localeCompare.mockRestore();
      }
    };

    expect(selectUnderLocale('en-US', 1)).toEqual(['task-az']);
    expect(selectUnderLocale('da-DK', 1)).toEqual(['task-az']);
    expect(selectUnderLocale('en-US', 2)).toEqual(['task-aa', 'task-az']);
    expect(selectUnderLocale('da-DK', 2)).toEqual(['task-aa', 'task-az']);
  });

  it('preserves explicit task caller order', () => {
    const selected = selectInstances({
      schemaVersion: 1,
      kind: 'ultracode-swebench-pro-dataset-descriptor',
      dataset: 'ScaleAI/SWE-bench_Pro',
      config: 'default',
      split: 'test',
      rows: [row('task-aa'), row('task-az')],
    }, { taskIds: ['task-az', 'task-aa'], count: 2, seed: 7, stratifyBy: 'repo' });
    expect(selected.map((entry) => entry.instanceId)).toEqual(['task-az', 'task-aa']);
  });

  it('rejects task IDs that the pinned evaluator could treat as host paths', () => {
    expect(() => instanceFromRow(row('../escape'))).toThrow(/unsafe for the pinned native evaluator/);
    expect(() => instanceFromRow(row('nested/task'))).toThrow(/unsafe for the pinned native evaluator/);
  });

  it('keeps omitted and malformed evaluator records unverified', () => {
    const fixture = JSON.parse(readFileSync(
      join(process.cwd(), 'test/fixtures/bench/swebench-pro/eval_results.json'),
      'utf8',
    )) as unknown;
    expect(parseEvaluatorResults(fixture)).toEqual({
      verdicts: { 'task-fail': false, 'task-pass': true },
      malformedTaskIds: ['task-malformed'],
    });
    expect(() => parseEvaluatorResults([])).toThrow(/object/);
  });

  it('classifies a driver backstop as infrastructure and a native timeout as agent-owned', () => {
    expect(classifyOutcome(null, null).failure).toBe('driver-watchdog');
    expect(classifyOutcome({
      codexExit: 124,
      startedAt: 1,
      endedAt: 2,
      baseSha: 'a',
      expectedBase: 'a',
      patchBytes: 0,
      applyCheck: null,
      ucRuns: [],
      waitedForTerminalMs: 0,
      failure: null,
    }, null).failure).toBe('agent-timeout');
    expect(isRunFatalTransportFailure('broker-failed')).toBe(true);
    expect(isRunFatalTransportFailure('network-policy-failed')).toBe(true);
    expect(isRunFatalTransportFailure('native-runner-failed')).toBe(false);
  });
});

describe('evaluator ownership and empty predictions', () => {
  it('requires exact repository, post-baseline ownership, start time, and output mount', () => {
    const imageIdentities = new Map([['task', {
      localId: `sha256:${'e'.repeat(64)}`,
    }]]);
    const labels = (taskId: string) => ({
      'ultracode.benchmark.schema': '2',
      'ultracode.benchmark.suite': 'swebench-pro',
      'ultracode.benchmark.run': 'pilot1',
      'ultracode.benchmark.arm': 'a',
      'ultracode.benchmark.invocation': 'invocation-1',
      'ultracode.benchmark.task': taskId,
      'ultracode.benchmark.purpose': 'verifier',
      'ultracode.benchmark.ownership': '1',
    });
    const records = [
      { Id: 'a'.repeat(64), Image: `sha256:${'e'.repeat(64)}`, Config: { Image: `sha256:${'e'.repeat(64)}`, Labels: labels('task') }, HostConfig: { NetworkMode: 'none' }, State: { StartedAt: '2026-07-20T12:01:00Z' }, Mounts: [{ Type: 'bind', Source: '/run/output/task/workspace', Destination: '/workspace' }] },
      { Id: 'b'.repeat(64), Image: `sha256:${'e'.repeat(64)}`, Config: { Image: `sha256:${'e'.repeat(64)}`, Labels: labels('task') }, HostConfig: { NetworkMode: 'none' }, State: { StartedAt: '2026-07-20T12:01:00Z' }, Mounts: [{ Type: 'bind', Source: '/run/output/task/workspace', Destination: '/workspace' }] },
      { Id: 'c'.repeat(64), Image: `sha256:${'e'.repeat(64)}`, Config: { Image: `sha256:${'0'.repeat(64)}`, Labels: labels('task') }, HostConfig: { NetworkMode: 'none' }, State: { StartedAt: '2026-07-20T12:01:00Z' }, Mounts: [{ Type: 'bind', Source: '/run/output/task/workspace', Destination: '/workspace' }] },
      { Id: 'd'.repeat(64), Image: `sha256:${'e'.repeat(64)}`, Config: { Image: `sha256:${'e'.repeat(64)}`, Labels: labels('task') }, HostConfig: { NetworkMode: 'none' }, State: { StartedAt: '2026-07-20T12:01:00Z' }, Mounts: [{ Type: 'bind', Source: '/other', Destination: '/workspace' }] },
    ];
    expect(ownedEvaluatorContainerIds(records, {
      outputDirectory: '/run/output',
      baselineIds: new Set(['b'.repeat(64)]),
      runId: 'pilot1',
      armLabel: 'a',
      invocationId: 'invocation-1',
      taskIds: new Set(['task']),
      imageIdentities,
      invocationStartedMs: Date.parse('2026-07-20T12:00:00Z'),
      nowMs: Date.parse('2026-07-20T13:00:00Z'),
      maximumAgeMs: null,
    })).toEqual(['a'.repeat(64)]);
  });

  it('selects only the requested repository digest', () => {
    const digest = `jefzda/sweap-images@sha256:${'a'.repeat(64)}`;
    expect(repositoryDigest({ RepoDigests: [digest, `other/image@sha256:${'b'.repeat(64)}`] })).toBe(digest);
    expect(() => repositoryDigest({ RepoDigests: [`jefzda/sweap-images-evil@sha256:${'a'.repeat(64)}`] })).toThrow();
  });

  it('gives identical task overlays distinct run-owned image identities', async () => {
    const instance = instanceFromRow(row('task'));
    const digest = `jefzda/sweap-images@sha256:${'a'.repeat(64)}`;
    const baseId = `sha256:${'b'.repeat(64)}`;
    const overlayIds = [`sha256:${'c'.repeat(64)}`, `sha256:${'e'.repeat(64)}`];
    const buildArgv: string[][] = [];
    const docker = async (argv: readonly string[]): Promise<string> => {
      if (argv[0] === 'build') {
        buildArgv.push([...argv]);
        return '';
      }
      if (argv[0] === 'image' && argv[1] === 'inspect') {
        const reference = argv[2]!;
        if (reference === `jefzda/sweap-images:${instance.dockerhubTag}`) {
          return JSON.stringify([{
            Id: baseId,
            RepoDigests: [digest],
            Os: 'linux',
            Architecture: 'amd64',
          }]);
        }
        return JSON.stringify([{
          Id: reference === digest
            ? baseId
            : overlayIds[buildArgv.findIndex((entry) => entry[entry.indexOf('-t') + 1] === reference)],
          RepoDigests: reference === digest ? [digest] : [],
          Os: 'linux',
          Architecture: 'amd64',
        }]);
      }
      throw new Error(`unexpected Docker argv: ${argv.join(' ')}`);
    };
    const common = {
      roots: createBenchPathRoots(join(process.cwd(), 'bench')),
      toolchainDirectory: '/cache/toolchain',
      toolchainPayloadSha256: 'd'.repeat(64),
      docker,
    };

    const first = await prepareTaskImage(instance, { ...common, runId: 'run-one' });
    const second = await prepareTaskImage(instance, { ...common, runId: 'run-two' });

    expect(first.overlayName).not.toBe(second.overlayName);
    expect(first.overlayLocalId).not.toBe(second.overlayLocalId);
    expect(buildArgv.map((argv) => argv[argv.indexOf('-t') + 1]))
      .toEqual([first.overlayName, second.overlayName]);
    expect(buildArgv[0]).toContain('ultracode.benchmark.run=run-one');
    expect(buildArgv[1]).toContain('ultracode.benchmark.run=run-two');
  });

  it('cleans only fully labelled containers for manifest-owned tasks', () => {
    const labels = {
      'ultracode.benchmark.schema': '2',
      'ultracode.benchmark.suite': 'swebench-pro',
      'ultracode.benchmark.run': 'pilot1',
      'ultracode.benchmark.task': 'task-a',
      'ultracode.benchmark.arm': 'a',
      'ultracode.benchmark.purpose': 'session',
      'ultracode.benchmark.ownership': '1',
      'ultracode.benchmark.runtime': 'a'.repeat(64),
    };
    expect(ownedRunContainerIds([
      { Id: 'a'.repeat(64), Config: { Labels: labels } },
      { Id: 'b'.repeat(64), Config: { Labels: { ...labels, 'ultracode.benchmark.task': 'task-b' } } },
      { Id: 'c'.repeat(64), Config: { Labels: { ...labels, 'ultracode.benchmark.purpose': 'prep' } } },
      { Id: 'short', Config: { Labels: labels } },
    ], 'pilot1', new Set(['task-a']), new Set())).toEqual(['a'.repeat(64)]);
  });

  it('requires exact verifier image, workspace mount, and invocation start evidence for run cleanup', () => {
    const invocation = '11111111-1111-4111-8111-111111111111';
    const labels = {
      'ultracode.benchmark.schema': '2',
      'ultracode.benchmark.suite': 'swebench-pro',
      'ultracode.benchmark.run': 'pilot1',
      'ultracode.benchmark.task': 'task-a',
      'ultracode.benchmark.arm': 'a',
      'ultracode.benchmark.purpose': 'verifier',
      'ultracode.benchmark.ownership': '1',
      'ultracode.benchmark.invocation': invocation,
    };
    const exact = {
      Id: 'e'.repeat(64),
      Image: `sha256:${'f'.repeat(64)}`,
      Config: { Image: `sha256:${'f'.repeat(64)}`, Labels: labels },
      HostConfig: { NetworkMode: 'none' },
      State: { StartedAt: '2026-07-20T12:01:00Z' },
      Mounts: [{
        Type: 'bind',
        Source: '/run/native/verifier/armA/output/task-a/workspace',
        Destination: '/workspace',
      }],
    };
    const evidence = {
      runDirectory: '/run',
      imageIdentities: new Map([['task-a', {
        localId: `sha256:${'f'.repeat(64)}`,
      }]]),
      invocationStartedMs: new Map([[invocation, Date.parse('2026-07-20T12:00:00Z')]]),
    };
    expect(ownedRunContainerIds(
      [exact],
      'pilot1',
      new Set(['task-a']),
      new Set([invocation]),
      evidence,
    )).toEqual(['e'.repeat(64)]);
    expect(ownedRunContainerIds(
      [{ ...exact, Image: `sha256:${'0'.repeat(64)}` }],
      'pilot1',
      new Set(['task-a']),
      new Set([invocation]),
      evidence,
    )).toEqual([]);
  });

  it('does not launch an evaluator or fabricate eval_results for an empty prediction set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-bench-pro-empty-'));
    temporaryRoots.push(root);
    const roots = createBenchPathRoots(root);
    mkdirSync(roots.resultsRoot, { mode: 0o700 });
    const runDirectory = join(roots.resultsRoot, 'swebench-pro', 'pilot1');
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const result = await runOfficialEvaluator({
      runDirectory,
      evaluatorDirectory: join(root, 'unused-evaluator'),
      evaluatorPythonBinary: join(root, 'unused-python'),
      config,
      invocationId: '11111111-1111-4111-8111-111111111111',
      runId: 'pilot1',
      armLabel: 'a',
      prefix: 'armA',
      predictions: [],
      instances: [instanceFromRow(row('task-a'))],
      containerPolicy,
      imageIdentities: new Map([['task-a', { localId: `sha256:${'c'.repeat(64)}` }]]),
      invocationStartedMs: new Map(),
      docker: async () => { throw new Error('docker must not be called'); },
    });
    expect(result.resultRelativePath).toBeNull();
    expect(result.verdicts).toEqual({});
    expect(existsSync(join(runDirectory, 'native/verifier/armA/output/eval_results.json'))).toBe(false);
  });

  it('sweeps an exact manifest-owned credential runtime even without a container', async () => {
    const runtime = mkdtempSync(join(tmpdir(), 'uc-bench-pro-runtime-'));
    temporaryRoots.push(runtime);
    mkdirSync(join(runtime, 'codex-home'), { mode: 0o700 });
    mkdirSync(join(runtime, 'home'), { mode: 0o700 });
    writeFileSync(join(runtime, 'ownership.json'), `${JSON.stringify({
      schemaVersion: 2,
      kind: 'ultracode-swebench-pro-session-runtime',
      runId: 'pilot1',
      taskId: 'task-a',
      arm: 'a',
      runtimeNonce: 'a'.repeat(64),
    })}\n`, { mode: 0o600 });
    const manifest = {
      runId: 'pilot1',
      artifacts: { executions: [{ taskId: 'task-a', arm: 'a' }] },
    } as never;
    const noContainers = async () => '';
    await expect(cleanupProRuntimeHomes({
      runId: 'other', artifacts: { executions: [{ taskId: 'task-a', arm: 'a' }] },
    } as never, noContainers)).resolves.toBe(0);
    await expect(cleanupProRuntimeHomes(manifest, noContainers)).resolves.toBe(1);
    expect(existsSync(runtime)).toBe(false);
  });

  it('removes a partial exact runtime instead of leaving its credential mount behind', async () => {
    const runtime = mkdtempSync(join(tmpdir(), 'uc-bench-pro-runtime-'));
    temporaryRoots.push(runtime);
    mkdirSync(join(runtime, 'codex-home'), { mode: 0o700 });
    writeFileSync(join(runtime, 'codex-home', 'auth.json'), '{}\n', { mode: 0o600 });
    writeFileSync(join(runtime, 'ownership.json'), `${JSON.stringify({
      schemaVersion: 2,
      kind: 'ultracode-swebench-pro-session-runtime',
      runId: 'pilot1',
      taskId: 'task-a',
      arm: 'a',
      runtimeNonce: 'b'.repeat(64),
    })}\n`, { mode: 0o600 });
    const manifest = {
      runId: 'pilot1',
      artifacts: { executions: [{ taskId: 'task-a', arm: 'a' }] },
    } as never;
    await expect(cleanupProRuntimeHomes(manifest, async () => '')).resolves.toBe(1);
    expect(existsSync(runtime)).toBe(false);
  });

  it('takes a fresh final snapshot and retains runtime if its exact helper name appears', async () => {
    const runtime = mkdtempSync(join(tmpdir(), 'uc-bench-pro-runtime-'));
    temporaryRoots.push(runtime);
    mkdirSync(join(runtime, 'codex-home'), { mode: 0o700 });
    mkdirSync(join(runtime, 'home'), { mode: 0o700 });
    writeFileSync(join(runtime, 'ownership.json'), `${JSON.stringify({
      schemaVersion: 2,
      kind: 'ultracode-swebench-pro-session-runtime',
      runId: 'pilot1',
      taskId: 'task-a',
      arm: 'a',
      runtimeNonce: 'c'.repeat(64),
    })}\n`, { mode: 0o600 });
    const manifest = {
      runId: 'pilot1',
      artifacts: { executions: [{ taskId: 'task-a', arm: 'a' }] },
    } as never;
    const id = 'd'.repeat(64);
    const name = reclamationContainerName('pilot1', 'task-a', 'a');
    let snapshots = 0;
    const executor = async (argv: readonly string[]) => {
      if (argv[0] === 'ps') {
        snapshots += 1;
        return snapshots === 1 ? '' : id;
      }
      return JSON.stringify([{ Id: id, Name: `/${name}`, Config: { Labels: {} } }]);
    };
    await expect(reclamationNamespaceSnapshot(executor, () => 1_000)).resolves.toEqual(new Map());
    await expect(cleanupProRuntimeHomes(manifest, executor))
      .rejects.toThrow(/name remains occupied/);
    expect(snapshots).toBe(2);
    expect(existsSync(runtime)).toBe(true);
  });
});
