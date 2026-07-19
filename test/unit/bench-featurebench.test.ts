/** FeatureBench adapter planning, privacy, and patch-preimage contracts. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARM_B_PREFIX } from '../../bench/src/prompt.js';

const { requireFeatureBenchHost } = vi.hoisted(() => ({
  requireFeatureBenchHost: vi.fn(),
}));

vi.mock('../../bench/src/featurebench-host.js', () => ({ requireFeatureBenchHost }));

import {
  FEATUREBENCH_DATASET,
  FEATUREBENCH_DATASET_REVISION,
  FEATUREBENCH_PATCH,
  FEATUREBENCH_SOURCE_REVISION,
  composeFeatureBenchPrompt,
  featureBenchRuntimeConfig,
  planFeatureBenchEval,
  planFeatureBenchRun,
  prepareFeatureBench,
  runFeatureBench,
  validateFeatureBenchRun,
} from '../../bench/src/featurebench.js';
import type {
  FeatureBenchExecOptions,
  FeatureBenchExecutor,
  FeatureBenchRunOptions,
} from '../../bench/src/featurebench.js';

const scratch: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uc-fb-test-'));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  const { rmSync } = await import('node:fs');
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  requireFeatureBenchHost.mockClear();
});

function options(overrides: Partial<FeatureBenchRunOptions> = {}): FeatureBenchRunOptions {
  return {
    sourceDir: '/checkout/featurebench',
    outputDir: '/private/results',
    codexBin: '/host/toolchain/codex',
    credentialBrokerUrl: 'https://broker.example.test/v1',
    restrictedNetwork: 'featurebench-egress',
    arm: 'a',
    runOwner: 'featurebench-test',
    model: 'gpt-5.6-sol',
    effort: 'high',
    taskIds: ['org__repo.abc.test_feature.def.lv1', 'org__other.123.test_more.456.lv1'],
    ...overrides,
  };
}

describe('FeatureBench pure planning', () => {
  it('pins the exact upstream source, dataset, argv, and initial policy', () => {
    expect(FEATUREBENCH_SOURCE_REVISION).toBe('445dcbaec0b2e136061b0acb54e753c0a9f1888e');
    expect(FEATUREBENCH_DATASET_REVISION).toBe('e99d6efdfe511ea832c1b5735c536129561ec96a');
    const plan = planFeatureBenchRun(options(), '/runtime/config.toml');
    expect(plan.infer).toEqual({
      command: '/checkout/featurebench/.venv/bin/fb',
      cwd: '/checkout/featurebench',
      argv: [
        'infer',
        '--config-path', '/runtime/config.toml',
        '--agent', 'codex',
        '--model', 'gpt-5.6-sol',
        '--dataset', FEATUREBENCH_DATASET,
        '--split', 'fast',
        '--task-id',
        'org__repo.abc.test_feature.def.lv1',
        'org__other.123.test_more.456.lv1',
        '--n-attempts', '1',
        '--n-concurrent', '4',
        '--timeout', '43200',
        '--output-dir', '/private/results',
      ],
    });
    expect(plan.config).toContain(`FEATUREBENCH_DATASET_REVISION = "${FEATUREBENCH_DATASET_REVISION}"`);
    expect(plan.config).toContain('FEATUREBENCH_CPU_ONLY = "1"');
    expect(plan.config).toContain('FB_CONTAINER_CPUS = "8"');
    expect(plan.config).toContain('FB_CONTAINER_MEMORY = "24g"');
  });

  it('keeps valid task IDs as literal argv values and rejects path-like IDs', () => {
    const ids = ['repo.name.test_case.hash.lv1'];
    const argv = planFeatureBenchRun(options({ taskIds: ids })).infer.argv;
    const first = argv.indexOf('--task-id') + 1;
    expect(argv.slice(first, first + ids.length)).toEqual(ids);
    expect(argv).not.toContain(resolve(ids[0]!));
    expect(() => planFeatureBenchRun(options({ taskIds: ['../looks/like/a/path.lv1'] })))
      .toThrow('unsafe FeatureBench task ID');
  });

  it('makes Arm B exactly a prompt prefix and a secret-free config distinction', () => {
    const instruction = 'Implement the requested behavior.';
    expect(composeFeatureBenchPrompt(instruction, 'a')).toBe(instruction);
    expect(composeFeatureBenchPrompt(instruction, 'b')).toBe(ARM_B_PREFIX + instruction);

    const armA = featureBenchRuntimeConfig(options());
    const armB = featureBenchRuntimeConfig(options({ arm: 'b', toolchainDir: '/host/toolchain' }));
    expect(armA).toContain('FEATUREBENCH_ARM = "a"');
    expect(armA).not.toContain('FEATUREBENCH_PROMPT_PREFIX');
    expect(armB).toContain('FEATUREBENCH_ARM = "b"');
    expect(armB).toContain('FEATUREBENCH_PROMPT_PREFIX');
    expect(armB).toContain('ultracode');
  });

  it('never serializes secret values or absolute host mount sources', () => {
    const input = options({
      codexBin: '/ABSOLUTE/CODEX_SENTINEL',
      credentialBrokerUrl: 'https://broker.example.test/v1',
      arm: 'b',
      toolchainDir: '/ABSOLUTE/TOOLCHAIN_SENTINEL',
    });
    const config = featureBenchRuntimeConfig(input);
    for (const sentinel of [
      'ABSOLUTE/CODEX_SENTINEL',
      'ABSOLUTE/AUTH_SENTINEL',
      'ABSOLUTE/TOOLCHAIN_SENTINEL',
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'SECRET_VALUE',
    ]) expect(config).not.toContain(sentinel);
  });

  it('rejects every unsupported runtime expansion before planning', () => {
    expect(() => validateFeatureBenchRun(options({ model: '' }))).toThrow('explicit non-empty');
    expect(() => validateFeatureBenchRun(options({ effort: '' }))).toThrow('explicit portable');
    expect(() => validateFeatureBenchRun(options({ split: 'full' }))).toThrow("only 'fast'");
    expect(() => validateFeatureBenchRun(options({ attempts: 2 }))).toThrow('exactly 1');
    expect(() => validateFeatureBenchRun(options({ retries: 1 }))).toThrow('retries are unsupported');
    expect(() => validateFeatureBenchRun(options({ runtime: 'gpu' }))).toThrow('GPU runtime is unsupported');
    expect(() => validateFeatureBenchRun(options({ auth: 'api-key' }))).toThrow('API-key auth is unsupported');
  });

  it('plans evaluation through the official upstream fb eval command', () => {
    expect(planFeatureBenchEval(options(), '/runtime/config.toml', '/runs/one/output.jsonl').argv).toEqual([
      'eval',
      '--config-path', '/runtime/config.toml',
      '--predictions-path', '/runs/one/output.jsonl',
      '--dataset', FEATUREBENCH_DATASET,
      '--split', 'fast',
      '--n-concurrent', '4',
      '--task-id',
      'org__repo.abc.test_feature.def.lv1',
      'org__other.123.test_more.456.lv1',
    ]);
  });
});

describe('FeatureBench preparation', () => {
  it('checks out the pin and checks the tracked patch preimage before applying', async () => {
    const root = tempDir();
    const sourceDir = join(root, 'source');
    const calls: string[][] = [];
    let revisionReads = 0;
    let applied = false;
    const executor: FeatureBenchExecutor = async (command, argv) => {
      calls.push([command, ...argv]);
      if (command === 'docker') return { stdout: 'linux/amd64\n', stderr: '' };
      if (command === 'git' && argv[0] === 'clone') {
        const checkout = argv.at(-1)!;
        mkdirSync(join(checkout, '.git'), { recursive: true });
      }
      if (argv.includes('rev-parse')) {
        revisionReads += 1;
        return { stdout: revisionReads === 1 ? 'main\n' : `${FEATUREBENCH_SOURCE_REVISION}\n`, stderr: '' };
      }
      if (argv.includes('--reverse') && !applied) throw new Error('not applied yet');
      if (argv.at(-2) === 'apply' && argv.at(-1) === FEATUREBENCH_PATCH) applied = true;
      if (argv.includes('diff')) return { stdout: readFileSync(FEATUREBENCH_PATCH, 'utf8'), stderr: '' };
      if (command.endsWith('/.venv/bin/python')) {
        return {
          stdout: `${JSON.stringify({
            dataset: FEATUREBENCH_DATASET,
            revision: FEATUREBENCH_DATASET_REVISION,
            split: 'fast',
            tasks: { 'repo.task.lv1': 'registry/image:tag' },
          })}\n`,
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };

    await prepareFeatureBench({ sourceDir, executor });
    expect(requireFeatureBenchHost).toHaveBeenCalledOnce();
    const clone = calls.find((call) => call[0] === 'git' && call[1] === 'clone');
    expect(clone?.slice(0, 4)).toEqual([
      'git', 'clone', '--no-checkout', 'https://github.com/LiberCoders/FeatureBench.git',
    ]);
    expect(clone?.at(-1)).toMatch(/\.featurebench-prepare-[^/]+\/checkout$/u);
    const check = calls.findIndex((call) => call.includes('--check') && !call.includes('--reverse'));
    const apply = calls.findIndex((call) => call.at(-2) === 'apply' && call.at(-1) === FEATUREBENCH_PATCH);
    expect(check).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(check);
    expect(calls.some((call) => call[0] === 'git'
      && call.includes('checkout')
      && call.at(-1) === FEATUREBENCH_SOURCE_REVISION)).toBe(true);
    expect(JSON.parse(readFileSync(
      join(sourceDir, '.git/ultracode-external-dataset-map.json'),
      'utf8',
    ))).toMatchObject({ revision: FEATUREBENCH_DATASET_REVISION, split: 'fast' });
  });

  it('stops on patch drift and never runs the unchecked apply', async () => {
    const root = tempDir();
    const sourceDir = join(root, 'source');
    const calls: string[][] = [];
    let revisionReads = 0;
    const executor: FeatureBenchExecutor = async (command, argv) => {
      calls.push([command, ...argv]);
      if (command === 'docker') return { stdout: 'linux/amd64\n', stderr: '' };
      if (argv.includes('rev-parse')) {
        revisionReads += 1;
        return { stdout: revisionReads === 1 ? 'main\n' : `${FEATUREBENCH_SOURCE_REVISION}\n`, stderr: '' };
      }
      if (argv.includes('--reverse')) throw new Error('not applied');
      if (argv.includes('--check')) throw new Error('preimage mismatch');
      return { stdout: '', stderr: '' };
    };

    await expect(prepareFeatureBench({ sourceDir, executor, installDependencies: false }))
      .rejects.toThrow('patch preimage check failed');
    expect(calls.some((call) => call.at(-2) === 'apply' && call.at(-1) === FEATUREBENCH_PATCH)).toBe(false);
  });

  it('rejects ignored checkout drift outside the rebuilt virtual environment', async () => {
    const root = tempDir();
    const sourceDir = join(root, 'source');
    mkdirSync(join(sourceDir, '.git'), { recursive: true });
    const executor: FeatureBenchExecutor = async (command, argv) => {
      if (command === 'docker') return { stdout: 'linux/amd64\n', stderr: '' };
      if (argv.includes('rev-parse')) {
        return { stdout: `${FEATUREBENCH_SOURCE_REVISION}\n`, stderr: '' };
      }
      if (argv.includes('diff')) {
        return { stdout: readFileSync(FEATUREBENCH_PATCH, 'utf8'), stderr: '' };
      }
      if (argv.includes('--ignored')) return { stdout: '__pycache__/\0', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    await expect(prepareFeatureBench({ sourceDir, executor, installDependencies: false }))
      .rejects.toThrow('unexpected files: __pycache__/');
  });

  it('tracks lifecycle validation, fail-closed copies, isolation, pins, and limits', () => {
    const patch = readFileSync(FEATUREBENCH_PATCH, 'utf8');
    const fileHeaders = patch.match(/^diff --git /gmu) ?? [];
    const fullIndexes = patch.match(/^index [0-9a-f]{40}\.\.[0-9a-f]{40} 100644$/gmu) ?? [];
    expect(fileHeaders).toHaveLength(5);
    expect(fullIndexes).toHaveLength(fileHeaders.length);
    expect(patch).toContain('/opt/featurebench-host/codex');
    expect(patch).not.toContain('/opt/featurebench-host/auth.json');
    expect(patch).toContain('requires_openai_auth = false');
    expect(patch).toContain('FEATUREBENCH_RESTRICTED_NETWORK');
    expect(patch).toContain('FEATUREBENCH_IMAGE_DIGESTS');
    expect(patch).toMatch(/^\+\s+network_mode=restricted_network,$/mu);
    expect(patch).toContain('nano_cpus=nano_cpus');
    expect(patch).toContain('mem_limit=mem_limit');
    expect(patch).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(patch).toContain('/root/.codex/sessions');
    expect(patch).toContain('codex_sessions');
    expect(patch).toContain('workflow wait expired; stopping');
    expect(patch).toContain('__workflow_scan_failed__');
    expect(patch).toContain('__no_ultracode_runs__');
    expect(patch).toContain('return False');
    expect(patch).not.toContain('sleep 15');
    expect(patch).not.toContain('while pgrep');

    const added = patch.split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n');
    const workflowStart = added.indexOf('    def _wait_for_workflows');
    const copyStart = added.indexOf('    def _copy_outputs');
    const postStart = added.indexOf('        workflows_complete = self._wait_for_workflows', copyStart);
    const failureStart = added.indexOf('        self._wait_for_workflows(container)', postStart);
    const commandStart = added.indexOf('        prompt_prefix = self.env_vars.get', failureStart);
    expect([workflowStart, copyStart, postStart, failureStart, commandStart]
      .every((offset) => offset >= 0)).toBe(true);

    const workflowHook = added.slice(workflowStart, copyStart);
    expect(workflowHook).toContain('if self.env_vars.get("FEATUREBENCH_ARM") != "b":');
    expect(workflowHook).toContain("const terminal = new Set(['completed', 'failed', 'stopped', 'orphaned']);");
    expect(workflowHook).toContain('if (!terminal.has(String(manifest.status))) console.log(runId);');
    expect(workflowHook).toContain('catch { console.log(runId); }');
    expect(workflowHook).toContain('if (!fs.existsSync(runs)) process.exit(3);');
    expect(workflowHook).toContain('if (entries.length === 0) process.exit(3);');
    expect(workflowHook).toContain('stragglers=$(active_runs) || exit 1');
    expect(workflowHook).toContain('remaining=$(active_runs) || exit 1');

    const copyHook = added.slice(copyStart, postStart);
    expect(copyHook).toContain('*, best_effort: bool) -> bool:');
    expect(copyHook).toContain('("/agent-logs/codex_events.jsonl", log_dir / "codex_events.jsonl")');
    expect(copyHook).toContain('("/root/.codex/sessions", log_dir / "codex_sessions")');
    expect(copyHook).toContain('copies.append(("/agent-logs/ultracode", log_dir / "ultracode"))');
    expect(copyHook).toContain('except Exception as e:');
    expect(copyHook).toContain('copied = False');
    expect(copyHook).toContain('return copied');
    expect(copyHook).not.toContain('pass');

    const postHook = added.slice(postStart, failureStart);
    expect(postHook).toContain('self._copy_outputs(container, log_file, best_effort=False)');
    expect(postHook).toContain('if not workflows_complete or not outputs_copied:');
    const failureHook = added.slice(failureStart, commandStart);
    expect(failureHook).toContain('self._copy_outputs(container, log_file, best_effort=True)');
  });
});

describe('FeatureBench runtime privacy', () => {
  it('uses a 0600 config, broker-only auth, allowlisted env, exact reports, and cleanup', async () => {
    const root = tempDir();
    const sourceDir = join(root, 'source');
    const outputDir = join(root, 'results');
    const codexBin = join(root, 'codex');
    mkdirSync(join(sourceDir, '.git'), { recursive: true });
    writeFileSync(codexBin, '#!/bin/sh\n');
    chmodSync(codexBin, 0o755);
    writeFileSync(
      join(sourceDir, '.git/ultracode-external-dataset-map.json'),
      `${JSON.stringify({
        dataset: FEATUREBENCH_DATASET,
        revision: FEATUREBENCH_DATASET_REVISION,
        split: 'fast',
        tasks: Object.fromEntries(options().taskIds.map((taskId) => [taskId, 'registry/image:tag'])),
      })}\n`,
    );

    let configPath = '';
    let childEnv: NodeJS.ProcessEnv | undefined;
    let launchAttestations = 0;
    const calls: string[][] = [];
    const executor: FeatureBenchExecutor = async (command, argv, execOptions?: FeatureBenchExecOptions) => {
      calls.push([command, ...argv]);
      if (command === 'git' && argv.includes('rev-parse')) {
        return { stdout: `${FEATUREBENCH_SOURCE_REVISION}\n`, stderr: '' };
      }
      if (command === 'git' && argv.includes('diff')) {
        return { stdout: readFileSync(FEATUREBENCH_PATCH, 'utf8'), stderr: '' };
      }
      if (command === 'git') return { stdout: '', stderr: '' };
      if (command === 'docker' && argv[0] === 'network') {
        expect(argv).toContain('{{.Internal}}|{{ index .Labels "ultracode.egress-policy" }}|{{len .Containers}}|{{range .Containers}}{{.Name}}{{end}}');
        return { stdout: 'true|openai-via-credential-broker|1|broker.example.test\n', stderr: '' };
      }
      if (command === 'docker' && argv[0] === 'info') {
        return { stdout: 'linux/amd64\n', stderr: '' };
      }
      if (command.endsWith('/.venv/bin/python')) throw new Error('run preflight must not query or populate dataset caches');
      if (command === 'docker' && argv[0] === 'inspect') {
        return { stdout: `true|true|sha256:${'b'.repeat(64)}\n`, stderr: '' };
      }
      if (command === 'docker' && argv[0] === 'image') {
        return { stdout: `registry/image@sha256:${'a'.repeat(64)}\n`, stderr: '' };
      }
      if (argv[0] === 'infer') {
        configPath = argv[argv.indexOf('--config-path') + 1]!;
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
        const serialized = readFileSync(configPath, 'utf8');
        expect(serialized).not.toContain(root);
        expect(serialized).not.toContain('SECRET_VALUE');
        childEnv = execOptions?.env;
        const destination = argv[argv.indexOf('--output-dir') + 1]!;
        const runDir = join(destination, '2026-07-19__13-00-41');
        mkdirSync(runDir);
        writeFileSync(join(runDir, 'run_metadata.json'), '{}\n');
        writeFileSync(join(runDir, 'output.jsonl'), '{}\n');
      }
      if (argv[0] === 'eval') {
        const predictions = argv[argv.indexOf('--predictions-path') + 1]!;
        const runDir = resolve(predictions, '..');
        for (const taskId of options().taskIds) {
          const report = join(runDir, 'eval_outputs', taskId, 'attempt-1', 'report.json');
          mkdirSync(resolve(report, '..'), { recursive: true });
          writeFileSync(report, `${JSON.stringify({
            [taskId]: {
              n_attempt: 1,
              resolved: false,
              pass_rate: 0.5,
              featurebench_eval_completed: true,
            },
          })}\n`);
        }
      }
      return { stdout: '', stderr: '' };
    };

    const oldApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'SECRET_VALUE';
    try {
      const result = await runFeatureBench({
        ...options(), sourceDir, outputDir, codexBin,
      }, executor, async () => {
        launchAttestations += 1;
      });
      expect(result.evaluation?.argv[0]).toBe('eval');
      expect(Object.keys(result.verifierReports)).toEqual(options().taskIds);
      expect(requireFeatureBenchHost).toHaveBeenCalledOnce();
    } finally {
      if (oldApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldApiKey;
    }

    expect(configPath).not.toBe('');
    expect(launchAttestations).toBe(2);
    expect(existsSync(configPath)).toBe(false);
    expect(statSync(outputDir).mode & 0o777).toBe(0o700);
    expect(childEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(childEnv?.GITHUB_TOKEN).toBeUndefined();
    expect(childEnv?.FEATUREBENCH_CODEX_BIN_HOST_PATH).toBe(codexBin);
    expect(childEnv?.FEATUREBENCH_CREDENTIAL_BROKER_URL).toBe('https://broker.example.test/v1');
    expect(calls.filter((call) => call[0] === 'docker'
      && call[1] === 'ps'
      && call.includes('label=ultracode.external-run=featurebench-test'))).toHaveLength(2);
    expect(calls.some((call) => call[0] === 'docker'
      && call[1] === 'inspect'
      && call.some((argument) => argument.includes('configuredMounts={{json .HostConfig.Mounts}}')))).toBe(true);
  });
});
