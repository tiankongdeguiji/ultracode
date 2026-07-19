/** Offline contracts for the SWE-Marathon planner and tracked Arm B bridge. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_PRESSURE_STRESS_TASKS,
  EXCLUDED_CUA_TASKS,
  SWE_MARATHON_HARBOR,
  SWE_MARATHON_PIN,
  SWE_MARATHON_PYTHON,
  SWE_MARATHON_REPO,
  marathonChildEnvironment,
  planMarathonPrep,
  planMarathonRun,
  validateHarborResumeConfig,
  validateMarathonTaskName,
} from '../../bench/src/marathon.js';

const PATHS = {
  repoDir: '/tmp/marathon-repo',
  resultsDir: '/tmp/marathon-results',
  toolchainDir: '/tmp/marathon-toolchain',
  bridgeDir: '/tmp/marathon-bridge',
  skillDir: '/tmp/marathon-skill',
};

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'uc-marathon-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SWE-Marathon prep planning', () => {
  it('pins the upstream checkout, Harbor, and Python with argv-only commands', () => {
    const plan = planMarathonPrep({ ...PATHS, uvBin: '/opt/uv' });

    expect(plan).toEqual({
      repo: SWE_MARATHON_REPO,
      pin: SWE_MARATHON_PIN,
      python: SWE_MARATHON_PYTHON,
      harbor: SWE_MARATHON_HARBOR,
      paths: PATHS,
      clone: {
        file: 'git',
        argv: ['clone', '--filter=blob:none', '--no-checkout', SWE_MARATHON_REPO, PATHS.repoDir],
      },
      fetch: {
        file: 'git',
        argv: ['-C', PATHS.repoDir, 'fetch', '--depth=1', 'origin', SWE_MARATHON_PIN],
      },
      checkout: {
        file: 'git',
        argv: ['-C', PATHS.repoDir, 'checkout', '--detach', SWE_MARATHON_PIN],
      },
      sync: {
        file: '/opt/uv',
        argv: ['sync', '--python', '3.13.5', '--frozen'],
        cwd: PATHS.repoDir,
      },
      verifyPin: { file: 'git', argv: ['-C', PATHS.repoDir, 'rev-parse', 'HEAD'] },
      verifyPython: { file: `${PATHS.repoDir}/.venv/bin/python`, argv: ['--version'] },
      verifyHarbor: { file: `${PATHS.repoDir}/.venv/bin/harbor`, argv: ['--version'] },
      prepareBenchToolchain: true,
    });
  });
});

describe('SWE-Marathon run planning', () => {
  it('builds the exact conservative Arm A Harbor plan', () => {
    const plan = planMarathonRun({
      ...PATHS,
      taskName: 'zstd-decoder',
      arm: 'a',
      model: 'model-from-argument',
      effort: 'high',
      jobName: 'trial-a',
    });

    expect(plan.mounts).toEqual([
      {
        type: 'bind',
        source: `${PATHS.toolchainDir}/codex`,
        target: '/usr/local/bin/codex',
        read_only: true,
      },
    ]);
    expect(plan.command).toEqual({
      file: `${PATHS.repoDir}/.venv/bin/harbor`,
      cwd: PATHS.repoDir,
      argv: [
        'run',
        '--path', 'tasks',
        '--include-task-name', 'zstd-decoder',
        '--agent', 'codex',
        '--model', 'model-from-argument',
        '--agent-kwarg', 'reasoning_effort=high',
        '--agent-kwarg', 'web_search=disabled',
        '--allow-agent-host', 'api.openai.com',
        '--allow-agent-host', 'chatgpt.com',
        '--allow-agent-host', 'auth.openai.com',
        '--env', 'docker',
        '--mounts', JSON.stringify(plan.mounts),
        '--n-concurrent', '1',
        '--n-concurrent-agents', '1',
        '--n-attempts', '1',
        '--max-retries', '0',
        '--jobs-dir', PATHS.resultsDir,
        '--job-name', 'trial-a',
        '--yes',
      ],
    });
    expect(plan).toMatchObject({
      officialVerification: true,
      attempts: 1,
      retries: 0,
      concurrentTrials: 1,
    });
  });

  it('changes only the adapter inputs and required read-only mounts for Arm B', () => {
    const common = {
      ...PATHS,
      taskName: 'kubernetes-rust-rewrite',
      model: 'model-from-argument',
      effort: 'xhigh',
      jobName: 'trial',
    };
    const armA = planMarathonRun({ ...common, arm: 'a' });
    const armB = planMarathonRun({ ...common, arm: 'b', workflowWaitSeconds: 900 });

    expect(armB.command.argv).toContain('arm_b_codex:ArmBCodex');
    expect(armB.command.argv).toContain('workflow_wait_seconds=900');
    expect(armB.command.argv).toContain(PATHS.skillDir);
    expect(armB.mounts.map((entry) => entry.target)).toEqual([
      '/usr/local/bin/codex',
      '/opt/bench/node-sel',
      '/opt/bench/node',
      '/opt/bench/node-musl',
      '/opt/bench/node-musl-runtime',
      '/opt/bench/ultracode',
    ]);
    expect(armB.mounts.every((entry) => entry.read_only)).toBe(true);
    expect(armA.command.argv).not.toContain('arm_b_codex:ArmBCodex');
    expect(armA.mounts).toHaveLength(1);
  });

  it('resolves model, effort, and paths from an explicit environment', () => {
    const plan = planMarathonRun(
      { taskName: 'wasm-simd', arm: 'a' },
      {
        SWE_MARATHON_MODEL: 'model-from-environment',
        SWE_MARATHON_EFFORT: 'medium',
        SWE_MARATHON_REPO_DIR: PATHS.repoDir,
        SWE_MARATHON_RESULTS_DIR: PATHS.resultsDir,
        SWE_MARATHON_TOOLCHAIN_DIR: PATHS.toolchainDir,
      },
    );
    expect(plan).toMatchObject({
      model: 'model-from-environment',
      effort: 'medium',
      paths: {
        repoDir: PATHS.repoDir,
        resultsDir: PATHS.resultsDir,
        toolchainDir: PATHS.toolchainDir,
      },
    });
  });

  it('never serializes child authentication into a plan or argv', () => {
    const sensitiveValue = 'sensitive-value';
    const sensitivePath = '/private/runtime-auth';
    const plan = planMarathonRun(
      { ...PATHS, taskName: 'wasm-simd', arm: 'b' },
      {
        SWE_MARATHON_MODEL: 'model-from-environment',
        SWE_MARATHON_EFFORT: 'high',
        OPENAI_API_KEY: sensitiveValue,
        CODEX_AUTH_JSON_PATH: sensitivePath,
      },
    );
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(sensitiveValue);
    expect(serialized).not.toContain(sensitivePath);
    expect(plan.command.argv).not.toContain('--agent-env');
  });

  it('rejects path-like job names and plans Harbor native resume', () => {
    expect(() => planMarathonRun({
      ...PATHS,
      taskName: 'wasm-simd',
      arm: 'a',
      model: 'gpt-test',
      effort: 'high',
      jobName: '../escape',
    })).toThrow('portable filesystem component');
    expect(planMarathonRun({
      ...PATHS,
      taskName: 'wasm-simd',
      arm: 'a',
      model: 'gpt-test',
      effort: 'high',
      jobName: 'trial-a',
      resume: true,
    }).command.argv).toEqual([
      'job', 'resume', '--path', `${PATHS.resultsDir}/trial-a`,
    ]);
  });
});

describe('SWE-Marathon task policy', () => {
  it.each(['../zstd-decoder', '/tmp/task', 'zstd/decoder', '--help', 'Zstd-Decoder', 'not-a-real-task'])(
    'rejects unsafe or unknown id %s',
    (taskName) => {
      expect(() => validateMarathonTaskName(taskName)).toThrow();
    },
  );

  it.each(EXCLUDED_CUA_TASKS)('excludes unverified CUA task %s', (taskName) => {
    expect(() => validateMarathonTaskName(taskName)).toThrow('CUA result is unverified');
  });

  it('labels the four post-hoc context-pressure tasks explicitly', () => {
    expect(CONTEXT_PRESSURE_STRESS_TASKS).toEqual([
      'find-network-alignments',
      'kubernetes-rust-rewrite',
      'nextjs-vite-rewrite',
      'rust-java-lsp',
    ]);
  });
});

describe('SWE-Marathon resume and child environment', () => {
  const plan = planMarathonRun({
    ...PATHS,
    taskName: 'wasm-simd',
    arm: 'b',
    model: 'openai/gpt-test',
    effort: 'high',
    jobName: 'trial-b',
  });

  function resumeConfig(overrides: {
    taskPath?: string;
    agentName?: string;
    modelName?: string;
    effort?: string;
  } = {}): Record<string, unknown> {
    return {
      task: {
        path: overrides.taskPath ?? 'tasks/wasm-simd',
        git_url: null,
        source: 'tasks',
      },
      agent: {
        name: overrides.agentName ?? 'arm_b_codex:ArmBCodex',
        model_name: overrides.modelName ?? 'openai/gpt-test',
        kwargs: {
          reasoning_effort: overrides.effort ?? 'high',
          web_search: 'disabled',
        },
      },
      unrelated_distractors: [
        'tasks/wasm-simd',
        'arm_b_codex:ArmBCodex',
        'openai/gpt-test',
        'high',
      ],
    };
  }

  function writeResumeConfig(config: Record<string, unknown>): string {
    const jobRoot = temporaryDirectory();
    writeFileSync(join(jobRoot, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    return jobRoot;
  }

  it('accepts the exact Harbor 0.17.1 task and agent fields', () => {
    const jobRoot = writeResumeConfig(resumeConfig());
    expect(() => validateHarborResumeConfig(jobRoot, plan)).not.toThrow();
  });

  it.each([
    ['task.path', { taskPath: 'tasks/zstd-decoder' }],
    ['agent.name', { agentName: 'codex' }],
    ['agent.model_name', { modelName: 'openai/wrong-model' }],
    ['agent.kwargs.reasoning_effort', { effort: 'medium' }],
  ])('rejects an exact %s mismatch even when expected strings occur elsewhere', (field, overrides) => {
    const jobRoot = writeResumeConfig(resumeConfig(overrides));
    expect(() => validateHarborResumeConfig(jobRoot, plan)).toThrow(`field ${field}`);
  });

  it('canonicalizes validated auth paths and disables Python bytecode writes', () => {
    const root = temporaryDirectory();
    const authDirectory = join(root, 'auth');
    const authPath = join(authDirectory, 'auth.json');
    mkdirSync(authDirectory);
    writeFileSync(authPath, '{"tokens":{}}\n', { mode: 0o600 });
    const sourcePath = relative(process.cwd(), authPath);

    const env = marathonChildEnvironment(
      { PATH: '/usr/bin', CODEX_AUTH_JSON_PATH: sourcePath },
      '/opt/bridge',
      'b',
      '/tmp/runtime-home',
    );

    expect(env).toMatchObject({
      CODEX_AUTH_JSON_PATH: resolve(sourcePath),
      HOME: '/tmp/runtime-home',
      XDG_CONFIG_HOME: '/tmp/runtime-home/.config',
      HARBOR_TELEMETRY: 'off',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: '/opt/bridge',
    });
  });

  it('retains API-key auth and rejects a non-file auth path', () => {
    expect(marathonChildEnvironment(
      { OPENAI_API_KEY: 'test-api-key' },
      '/opt/bridge',
      'a',
      '/tmp/runtime-home',
    )).toMatchObject({
      OPENAI_API_KEY: 'test-api-key',
      PYTHONDONTWRITEBYTECODE: '1',
    });

    const directory = temporaryDirectory();
    expect(() => marathonChildEnvironment(
      { CODEX_AUTH_JSON_PATH: directory },
      '/opt/bridge',
      'a',
      '/tmp/runtime-home',
    )).toThrow('must be a regular file');
  });
});

describe('tracked Arm B bridge', () => {
  it('propagates model selection dynamically and marks mock workflows non-billable', () => {
    const source = readFileSync(
      resolve('bench/external/swe-marathon/arm_b_codex.py'),
      'utf8',
    );
    expect(source).toContain('ARM_B_PREFIX + instruction');
    expect(source).toContain('arm_b_metrics.json');
    expect(source).toContain('backend != "mock"');
    expect(source).toContain('self.model_name.split');
    expect(source).toContain('self._resolved_flags.get("reasoning_effort")');
    expect(source).toContain('workflow wait expired; stopping');
    expect(source).toContain('Arm B did not start an ultracode run');
    expect(source).toContain("ultracode run\\\\n');");
    expect(source).toContain('process.exitCode = 1');
    expect(source.match(/result\.return_code != 0/g)).toHaveLength(2);
    expect(source).toContain('test -d {self._WORKER_CODEX_HOME}/sessions');
    expect(source).toContain('test -d {self._ULTRACODE_HOME}/runs');
    expect(source).toContain('raise RuntimeError');
    expect(source).toContain('max(event_compactions, record_compactions)');
  });
});
