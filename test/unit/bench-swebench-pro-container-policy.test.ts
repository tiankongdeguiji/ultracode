/** Exact offline parity checks for session CLI and evaluator Docker SDK policy. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBenchPathRoots } from '../../bench/src/shared/paths.js';
import {
  evaluatorContainerPolicy,
  loadSwebenchProContainerPolicy,
  sessionContainerPolicyArgv,
} from '../../bench/src/suites/swebench-pro/container-policy.js';
import type { SwebenchProConfig } from '../../bench/src/suites/swebench-pro/config.js';
import { sessionDockerRunArgv } from '../../bench/src/suites/swebench-pro/runner.js';
import { evaluatorPolicyDocument } from '../../bench/src/suites/swebench-pro/verifier.js';

const benchRoot = join(process.cwd(), 'bench');
const policy = loadSwebenchProContainerPolicy(createBenchPathRoots(benchRoot));
const docker = { cpus: 1.5, memoryBytes: 2_000_000, keepImages: false };

const config = {
  docker,
  evaluator: {
    repository: 'https://example.test/evaluator.git',
    revision: 'b'.repeat(40),
  },
} as SwebenchProConfig;

describe('SWE-bench Pro container policy', () => {
  it('builds the exact session Docker argv with only the required setup capabilities', () => {
    expect(sessionContainerPolicyArgv(policy, docker)).toEqual([
      '--pids-limit', '1024',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--cap-add', 'CHOWN',
      '--cap-add', 'DAC_OVERRIDE',
      '--cap-add', 'SETGID',
      '--cap-add', 'SETPCAP',
      '--cap-add', 'SETUID',
      '--cpus', '1.5',
      '--memory', '2000000',
    ]);
    expect(sessionDockerRunArgv({
      name: 'session-name',
      runId: 'pilot1',
      taskId: 'task-a',
      arm: 'a',
      runtimeNonce: 'a'.repeat(64),
      envFile: '/runtime/container.env',
      taskDirectory: '/run/task-a',
      runtimeHome: '/runtime/home',
      runtimeCodex: '/runtime/codex-home',
      image: 'ultracode-swebench-pro:image',
      docker,
      policy,
    })).toEqual([
      'run', '-d', '--name', 'session-name',
      '--label', 'ultracode.benchmark.schema=2',
      '--label', 'ultracode.benchmark.suite=swebench-pro',
      '--label', 'ultracode.benchmark.run=pilot1',
      '--label', 'ultracode.benchmark.task=task-a',
      '--label', 'ultracode.benchmark.arm=a',
      '--label', 'ultracode.benchmark.purpose=session',
      '--label', 'ultracode.benchmark.ownership=1',
      '--label', `ultracode.benchmark.runtime=${'a'.repeat(64)}`,
      '--pids-limit', '1024',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--cap-add', 'CHOWN',
      '--cap-add', 'DAC_OVERRIDE',
      '--cap-add', 'SETGID',
      '--cap-add', 'SETPCAP',
      '--cap-add', 'SETUID',
      '--cpus', '1.5',
      '--memory', '2000000',
      '--user', '0:0',
      '--env-file', '/runtime/container.env',
      '--mount', 'type=bind,src=/run/task-a,dst=/bench',
      '--mount', 'type=bind,src=/runtime/home,dst=/runtime/home',
      '--mount', 'type=bind,src=/runtime/codex-home,dst=/runtime/codex-home',
      '--mount', 'type=bind,src=/run/task-a/codex-home/sessions,dst=/runtime/codex-home/sessions',
      '--entrypoint', '/bin/bash',
      'ultracode-swebench-pro:image',
      '/opt/bench/entrypoint.sh',
    ]);
  });

  it('maps the frozen evaluator policy to exact Docker SDK HostConfig inputs', () => {
    const document = evaluatorPolicyDocument(config, policy);
    expect(evaluatorContainerPolicy(policy, docker)).toEqual({
      pidsLimit: 1_024,
      securityOpt: ['no-new-privileges'],
      capDrop: ['ALL'],
      capAdd: [],
      nanoCpus: 1_500_000_000,
      memoryBytes: 2_000_000,
    });
    const helper = join(benchRoot, 'suites/swebench-pro/evaluator-policy.py');
    const result = spawnSync('python3', ['-B', '-c', [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("evaluator_policy", ${JSON.stringify(helper)})`,
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'print(json.dumps(module.docker_run_options(json.loads(sys.argv[1])), sort_keys=True))',
    ].join('; '), JSON.stringify(document)], {
      encoding: 'utf8',
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      pids_limit: 1_024,
      security_opt: ['no-new-privileges'],
      cap_drop: ['ALL'],
      cap_add: [],
      nano_cpus: 1_500_000_000,
      mem_limit: 2_000_000,
    });
    expect(readFileSync(helper, 'utf8')).toContain('"cap_add": policy["capAdd"]');
    const evaluatorPatch = readFileSync(
      join(benchRoot, 'suites/swebench-pro/evaluator-ownership.patch'),
      'utf8',
    );
    expect(evaluatorPatch).toContain('from ultracode_evaluator_policy import docker_run_options');
    expect(evaluatorPatch).toContain('run_kwargs.update(docker_run_options(benchmark_container_options))');
    expect(evaluatorPatch).toContain('parser.add_argument("--benchmark_policy_path", required=True)');
    expect(evaluatorPatch).toContain('docker_run_options(benchmark_container_options)');
    expect(evaluatorPatch).toContain('evaluation_failures.append');
    expect(evaluatorPatch).toContain('raise RuntimeError(f"{len(evaluation_failures)} evaluator tasks failed without a verdict")');
  });

  it('runs post-task Git capture as the task uid with all capability sets cleared', () => {
    const entrypoint = readFileSync(join(benchRoot, 'suites/swebench-pro/entrypoint.sh'), 'utf8');
    const capture = entrypoint.indexOf('/opt/bench/capture-git.sh');
    expect(capture).toBeGreaterThan(entrypoint.indexOf('sleep 2 # settle'));
    expect(entrypoint.slice(capture - 220, capture)).toContain('setpriv --reuid "$TASK_UID" --regid "$TASK_GID"');
    expect(entrypoint.slice(capture - 220, capture)).toContain('--bounding-set=-all --inh-caps=-all --ambient-caps=-all');
    expect(readFileSync(join(benchRoot, 'suites/swebench-pro/Dockerfile'), 'utf8'))
      .toContain('COPY capture-git.sh /opt/bench/capture-git.sh');
  });
});
