/** Opt-in local-daemon parity for frozen SWE-bench Pro HostConfig policy. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBenchPathRoots } from '../../bench/src/shared/paths.js';
import {
  evaluatorContainerPolicy,
  loadSwebenchProContainerPolicy,
  sessionContainerPolicyArgv,
} from '../../bench/src/suites/swebench-pro/container-policy.js';
import {
  reclaimSessionOwnership,
  reclamationContainerName,
  reclamationDockerRunArgv,
} from '../../bench/src/suites/swebench-pro/runner.js';

const enabled = process.env.UC_LIVE_TESTS === '1' && Boolean(process.env.UC_DOCKER_PARITY_IMAGE);
const image = process.env.UC_DOCKER_PARITY_IMAGE ?? '';
const reclamationImage = process.env.UC_DOCKER_RECLAMATION_IMAGE ?? '';
const reclamationEnabled = process.env.UC_LIVE_TESTS === '1' && reclamationImage !== '';
const policy = loadSwebenchProContainerPolicy(createBenchPathRoots(join(process.cwd(), 'bench')));
const resources = { cpus: 0.5, memoryBytes: 64 * 1_024 * 1_024, keepImages: false };

function docker(argv: readonly string[]): string {
  return execFileSync('docker', [...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe.runIf(enabled)('live SWE-bench Pro Docker policy parity', () => {
  it('materializes exact session and evaluator process/capability bounds', () => {
    docker(['image', 'inspect', image]);
    const cases = [
      {
        name: `uc-pro-session-parity-${randomUUID()}`,
        argv: sessionContainerPolicyArgv(policy, resources),
        expectedCaps: ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETPCAP', 'SETUID'],
      },
      {
        name: `uc-pro-evaluator-parity-${randomUUID()}`,
        argv: [
          '--pids-limit', String(evaluatorContainerPolicy(policy, resources).pidsLimit),
          '--security-opt', 'no-new-privileges',
          '--cap-drop', 'ALL',
          '--cpus', String(resources.cpus),
          '--memory', String(resources.memoryBytes),
        ],
        expectedCaps: [],
      },
    ];
    for (const entry of cases) {
      try {
        docker(['create', '--name', entry.name, ...entry.argv, image, 'sh', '-c', 'true']);
        const inspected = JSON.parse(docker(['inspect', entry.name]))[0].HostConfig;
        expect({ ...inspected, CapAdd: inspected.CapAdd ?? [] }).toMatchObject({
          PidsLimit: 1_024,
          SecurityOpt: ['no-new-privileges'],
          CapDrop: ['ALL'],
          CapAdd: entry.expectedCaps,
          NanoCpus: 500_000_000,
          Memory: resources.memoryBytes,
        });
        if (entry.expectedCaps.includes('SETPCAP')) {
          expect(docker([
            'run', '--rm', ...entry.argv, '--entrypoint', 'setpriv', image,
            '--reuid', '65534', '--regid', '65534', '--clear-groups',
            '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--', '/bin/true',
          ])).toBe('');
        }
      } finally {
        try { docker(['rm', '-f', entry.name]); } catch { /* exact test-owned name may not exist */ }
      }
    }
  });
});

describe.runIf(reclamationEnabled)('live SWE-bench Pro reclamation survivor lifecycle', () => {
  it('reconciles an exact running --rm survivor before an idempotent reclamation rerun', async () => {
    const taskDirectory = mkdtempSync(join(tmpdir(), 'uc-pro-reclamation-live-'));
    for (let index = 0; index < 25_000; index += 1) {
      writeFileSync(join(taskDirectory, `owned-${index}`), 'owned');
    }
    const runId = `live-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    const arm = 'a' as const;
    const name = reclamationContainerName(runId, taskId, arm);
    const inspectedImage = JSON.parse(docker(['image', 'inspect', reclamationImage]))[0];
    const imageAttestation = {
      requested: reclamationImage,
      resolvedDigest: reclamationImage,
      baseLocalId: inspectedImage.Id,
      basePlatform: `${inspectedImage.Os}/${inspectedImage.Architecture}`,
      overlayName: reclamationImage,
      overlayLocalId: inspectedImage.Id,
      overlayPlatform: `${inspectedImage.Os}/${inspectedImage.Architecture}`,
    };
    const artifactOwner = {
      uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      gid: typeof process.getgid === 'function' ? process.getgid() : 0,
    };
    const options = {
      runId,
      taskId,
      arm,
      taskDirectory,
      artifactOwner,
      image: imageAttestation,
      docker: resources,
      policy,
    };
    const runArgv = reclamationDockerRunArgv({ ...options, name });
    try {
      docker(['create', '--rm', ...runArgv.slice(2)]);
      docker(['start', name]);
      expect(JSON.parse(docker(['inspect', name]))[0].State.Running).toBe(true);
      await reclaimSessionOwnership(options, {}, async (argv) => docker(argv));
      expect(docker(['ps', '-aq', '--no-trunc', '--filter', `name=^/${name}$`])).toBe('');
      expect(chmodSync(taskDirectory, 0o700)).toBeUndefined();
    } finally {
      try { docker(['rm', '-f', name]); } catch { /* exact test-owned name may not exist */ }
      rmSync(taskDirectory, { recursive: true, force: true });
    }
  });
});
