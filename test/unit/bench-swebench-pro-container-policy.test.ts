/** Exact offline parity checks for session CLI and evaluator Docker SDK policy. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBenchPathRoots } from '../../bench/src/shared/paths.js';
import { sha256CanonicalJson } from '../../bench/src/shared/provenance.js';
import {
  containerPolicySha256,
  evaluatorContainerPolicy,
  loadSwebenchProContainerPolicy,
  reclamationContainerPolicyArgv,
  sessionContainerPolicyArgv,
  sessionTaskIdentity,
  SWEBENCH_PRO_CONTAINER_POLICY_SHA256,
} from '../../bench/src/suites/swebench-pro/container-policy.js';
import type { SwebenchProConfig } from '../../bench/src/suites/swebench-pro/config.js';
import {
  reclamationContainerName,
  reclamationDockerRunArgv,
  sessionDockerRunArgv,
} from '../../bench/src/suites/swebench-pro/runner.js';
import {
  evaluatorPolicyDocument,
  evaluatorPolicyDocumentSha256,
} from '../../bench/src/suites/swebench-pro/verifier.js';

const benchRoot = join(process.cwd(), 'bench');
const policy = loadSwebenchProContainerPolicy(createBenchPathRoots(benchRoot));
const docker = { cpus: 1.5, memoryBytes: 2_000_000, keepImages: false };

const config = {
  docker,
  evaluator: {
    repository: 'https://github.com/scaleapi/SWE-bench_Pro-os',
    revision: 'ca10a60a5fcae51e6948ffe1485d4153d421e6c5',
  },
} as SwebenchProConfig;

const evaluatorPolicyHelper = join(benchRoot, 'suites/swebench-pro/evaluator-policy.py');

function runPythonPolicy(document: unknown, expectedSha256 = sha256CanonicalJson(document)) {
  return spawnSync('python3', ['-B', '-c', [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("evaluator_policy", ${JSON.stringify(evaluatorPolicyHelper)})`,
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(json.dumps(module.docker_run_options(json.loads(sys.argv[1]), sys.argv[2]), sort_keys=True))',
  ].join('; '), JSON.stringify(document), expectedSha256], {
    encoding: 'utf8',
  });
}

function changedDocument(mutator: (document: Record<string, unknown>) => void): Record<string, unknown> {
  const document = structuredClone(evaluatorPolicyDocument(config, policy)) as unknown as Record<string, unknown>;
  mutator(document);
  return document;
}

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
      restrictedNetwork: 'swebench-pro-private',
      artifactOwner: { uid: 2_001, gid: 2_002 },
      imageId: `sha256:${'c'.repeat(64)}`,
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
      '--label', 'ultracode.benchmark.task-uid=1000',
      '--label', 'ultracode.benchmark.task-gid=1000',
      '--label', 'ultracode.benchmark.artifact-uid=2001',
      '--label', 'ultracode.benchmark.artifact-gid=2002',
      '--no-healthcheck',
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
      '--network', 'swebench-pro-private',
      '--user', '0:0',
      '--env', 'BASH_ENV=',
      '--env', 'ENV=',
      '--env', 'LD_PRELOAD=',
      '--env', 'LD_AUDIT=',
      '--env-file', '/runtime/container.env',
      '--mount', 'type=bind,src=/run/task-a,dst=/bench',
      '--mount', 'type=bind,src=/runtime/home,dst=/runtime/home',
      '--mount', 'type=bind,src=/runtime/codex-home,dst=/runtime/codex-home',
      '--mount', 'type=bind,src=/run/task-a/codex-home/sessions,dst=/runtime/codex-home/sessions',
      '--entrypoint', '/bin/bash',
      `sha256:${'c'.repeat(64)}`,
      '/opt/bench/entrypoint.sh',
    ]);
    expect(reclamationContainerPolicyArgv(policy, docker)).toEqual([
      '--network', 'none',
      '--pids-limit', '64',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--cap-add', 'CHOWN',
      '--cap-add', 'DAC_OVERRIDE',
      '--cap-add', 'FOWNER',
      '--cpus', '1.5',
      '--memory', '2000000',
      '--user', '0:0',
    ]);
    const reclamationName = reclamationContainerName('pilot1', 'task-a', 'a');
    expect(reclamationDockerRunArgv({
      name: reclamationName,
      runId: 'pilot1',
      taskId: 'task-a',
      arm: 'a',
      taskDirectory: '/run/task-a',
      runtimeDirectory: '/runtime/owned',
      runtimeNonce: 'a'.repeat(64),
      artifactOwner: { uid: 2_001, gid: 2_002 },
      image: { overlayLocalId: `sha256:${'c'.repeat(64)}` } as never,
      docker,
      policy,
    })).toEqual([
      'run', '--rm', '--name', reclamationName,
      '--label', 'ultracode.benchmark.schema=2',
      '--label', 'ultracode.benchmark.suite=swebench-pro',
      '--label', 'ultracode.benchmark.run=pilot1',
      '--label', 'ultracode.benchmark.task=task-a',
      '--label', 'ultracode.benchmark.arm=a',
      '--label', 'ultracode.benchmark.purpose=reclamation',
      '--label', 'ultracode.benchmark.ownership=1',
      '--label', 'ultracode.benchmark.artifact-uid=2001',
      '--label', 'ultracode.benchmark.artifact-gid=2002',
      '--label', `ultracode.benchmark.runtime=${'a'.repeat(64)}`,
      '--network', 'none',
      '--pids-limit', '64',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--cap-add', 'CHOWN',
      '--cap-add', 'DAC_OVERRIDE',
      '--cap-add', 'FOWNER',
      '--cpus', '1.5',
      '--memory', '2000000',
      '--user', '0:0',
      '--mount', 'type=bind,src=/run/task-a,dst=/bench',
      '--mount', 'type=bind,src=/runtime/owned/home,dst=/runtime/home',
      '--mount', 'type=bind,src=/runtime/owned/codex-home,dst=/runtime/codex-home',
      '--entrypoint', '/bin/bash',
      `sha256:${'c'.repeat(64)}`,
      '-c', '/bin/chown -R -- "$1" "${@:2}" && /bin/chmod 0700 "${@:2}"',
      'ultracode-reclaim', '2001:2002', '/bench', '/runtime/home', '/runtime/codex-home',
    ]);
  });

  it('maps the frozen evaluator policy to exact Docker SDK HostConfig inputs', () => {
    const document = evaluatorPolicyDocument(config, policy);
    expect(containerPolicySha256(policy)).toBe(SWEBENCH_PRO_CONTAINER_POLICY_SHA256);
    expect(document.containerPolicySha256).toBe(SWEBENCH_PRO_CONTAINER_POLICY_SHA256);
    expect(evaluatorContainerPolicy(policy, docker)).toEqual({
      pidsLimit: 1_024,
      securityOpt: ['no-new-privileges'],
      capDrop: ['ALL'],
      capAdd: [],
      nanoCpus: 1_500_000_000,
      memoryBytes: 2_000_000,
    });
    const result = runPythonPolicy(document, evaluatorPolicyDocumentSha256(document));
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      pids_limit: 1_024,
      security_opt: ['no-new-privileges'],
      cap_drop: ['ALL'],
      cap_add: [],
      nano_cpus: 1_500_000_000,
      mem_limit: 2_000_000,
    });
    expect(readFileSync(evaluatorPolicyHelper, 'utf8')).toContain('"cap_add": policy["capAdd"]');
    const evaluatorPatch = readFileSync(
      join(benchRoot, 'suites/swebench-pro/evaluator-ownership.patch'),
      'utf8',
    );
    expect(evaluatorPatch).toContain('from ultracode_evaluator_policy import docker_run_options');
    expect(evaluatorPatch).toContain(
      'run_kwargs.update(docker_run_options(benchmark_container_options, benchmark_policy_sha256))',
    );
    expect(evaluatorPatch).toContain('parser.add_argument("--benchmark_policy_path", required=True)');
    expect(evaluatorPatch).toContain('parser.add_argument("--benchmark_policy_sha256", required=True)');
    expect(evaluatorPatch).toContain(
      'docker_run_options(benchmark_container_options, args.benchmark_policy_sha256)',
    );
    expect(evaluatorPatch).toContain('evaluation_failures.append');
    expect(evaluatorPatch).toContain('raise RuntimeError(f"{len(evaluation_failures)} evaluator tasks failed without a verdict")');
  });

  it.each([
    { cpus: 0.25, memoryBytes: 67_108_864, nanoCpus: 250_000_000 },
    { cpus: 8, memoryBytes: 24 * 1_024 * 1_024 * 1_024, nanoCpus: 8_000_000_000 },
  ])('preserves valid manifest resources $cpus CPU/$memoryBytes bytes', ({ cpus, memoryBytes, nanoCpus }) => {
    const variant = { ...config, docker: { ...docker, cpus, memoryBytes } };
    const document = evaluatorPolicyDocument(variant, policy);
    const result = runPythonPolicy(document, evaluatorPolicyDocumentSha256(document));
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({ nano_cpus: nanoCpus, mem_limit: memoryBytes });
  });

  it('requires one exact nanocore representation and a host-distinct task identity', () => {
    expect(() => evaluatorContainerPolicy(policy, {
      ...docker,
      cpus: 0.1234567895,
    })).toThrow(/exact positive number of nanocores/);
    expect(sessionTaskIdentity({ uid: 1_000, gid: 1_000 })).toEqual({ uid: 1_001, gid: 1_001 });
    expect(sessionTaskIdentity({ uid: 0, gid: 2_001 })).toEqual({ uid: 1_000, gid: 1_000 });
  });

  it.each([
    ['missing top-level field', (document: Record<string, unknown>) => { delete document.kind; }],
    ['extra top-level field', (document: Record<string, unknown>) => { document.untrusted = true; }],
    ['missing nested field', (document: Record<string, unknown>) => {
      delete (document.containerPolicy as Record<string, unknown>).capAdd;
    }],
    ['extra nested field', (document: Record<string, unknown>) => {
      (document.containerPolicy as Record<string, unknown>).networkMode = 'none';
    }],
    ['mutated pid bound', (document: Record<string, unknown>) => {
      (document.containerPolicy as Record<string, unknown>).pidsLimit = 2_048;
    }],
    ['mutated capability policy', (document: Record<string, unknown>) => {
      (document.containerPolicy as Record<string, unknown>).capAdd = ['NET_ADMIN'];
    }],
    ['mutated static policy hash', (document: Record<string, unknown>) => {
      document.containerPolicySha256 = '0'.repeat(64);
    }],
    ['boolean pid bound', (document: Record<string, unknown>) => {
      (document.containerPolicy as Record<string, unknown>).pidsLimit = true;
    }],
    ['boolean CPU bound', (document: Record<string, unknown>) => {
      (document.containerPolicy as Record<string, unknown>).nanoCpus = true;
    }],
    ['boolean memory bound', (document: Record<string, unknown>) => {
      (document.containerPolicy as Record<string, unknown>).memoryBytes = true;
    }],
  ] as const)('rejects %s', (_name, mutate) => {
    const document = changedDocument(mutate);
    const result = runPythonPolicy(document);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ValueError:');
  });

  it('rejects a policy file that does not match the trusted host digest', () => {
    const document = evaluatorPolicyDocument(config, policy);
    const result = runPythonPolicy(document, '0'.repeat(64));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('trusted host binding');
  });

  it('rejects static policy drift in host-side bindings', () => {
    const mutated = structuredClone(policy) as unknown as Record<string, unknown>;
    (mutated.evaluator as Record<string, unknown>).pidsLimit = 2_048;
    expect(() => containerPolicySha256(mutated as never)).toThrow(/reviewed canonical hash/);
    expect(() => evaluatorContainerPolicy(mutated as never, docker)).toThrow(/reviewed canonical hash/);
  });

  it.each([
    { cpus: true, memoryBytes: docker.memoryBytes },
    { cpus: docker.cpus, memoryBytes: true },
  ])('rejects boolean manifest resources before constructing Docker arguments', (invalid) => {
    expect(() => evaluatorContainerPolicy(policy, invalid as never)).toThrow(/manifest (CPU|memory) limit/);
    expect(() => sessionContainerPolicyArgv(policy, invalid as never)).toThrow(/manifest (CPU|memory) limit/);
  });

  it('documents suite-scoped Pro prerequisites, relay isolation, and manifest resources', () => {
    const readme = readFileSync(join(benchRoot, 'README.md'), 'utf8');
    const guide = readFileSync(join(benchRoot, 'docs/swebench-pro.md'), 'utf8');
    expect(readme).toContain('it does not require `uv` or GNU `patch`');
    expect(readme).toContain('SWE-bench Pro has no direct ChatGPT/API-key mode');
    expect(guide).toContain('no direct `chatgpt` or `api-key` session mode');
    expect(guide).toContain('affected task is recorded and the whole run invocation');
    expect(guide).toContain('Legacy Pro schema version 2 described direct provider auth');
    expect(guide).toContain('manifest-bound immutable local image ID');
    expect(guide).toMatch(/does not inspect\s+an operator firewall/u);
    expect(guide).toContain('CPU and memory values are instead derived from\nthe immutable run manifest');
  });

  it('runs post-task Git capture as the task uid with all capability sets cleared', () => {
    const entrypoint = readFileSync(join(benchRoot, 'suites/swebench-pro/entrypoint.sh'), 'utf8');
    const capture = entrypoint.indexOf('/opt/bench/capture-git.sh');
    expect(capture).toBeGreaterThan(entrypoint.indexOf('sleep 2 # settle'));
    expect(entrypoint.slice(capture - 220, capture)).toContain('setpriv --reuid "$TASK_UID" --regid "$TASK_GID"');
    expect(entrypoint.slice(capture - 220, capture)).toContain('--bounding-set=-all --inh-caps=-all --ambient-caps=-all');
    expect(readFileSync(join(benchRoot, 'suites/swebench-pro/Dockerfile'), 'utf8'))
      .toContain('COPY --chown=0:0 --chmod=0555 capture-git.sh /opt/bench/capture-git.sh');
  });
});
