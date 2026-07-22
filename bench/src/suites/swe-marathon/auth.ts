/** Ephemeral SWE-Marathon authentication home and runtime-only bindings. */
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { allowlistedEnvironment } from '../../shared/process.js';
import { readPrivateJson, writePrivateJsonAtomic } from '../../shared/paths.js';
import { canonicalJson } from '../../shared/provenance.js';
import type { SweMarathonConfig } from './config.js';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_AUTH_BYTES = 4 * 1_024 * 1_024;
const RUNTIME_MARKER = 'ownership.json';

export interface MarathonRuntimeHome {
  directory: string;
  environment: NodeJS.ProcessEnv;
  cleanup(): void;
}

function readPrivateAuthFile(path: string): Buffer {
  const resolved = resolve(path);
  const fd = openSync(resolved, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_AUTH_BYTES) {
      throw new Error('SWE-Marathon auth file must be a bounded singly-linked regular file');
    }
    if (uid !== undefined && info.uid !== uid) throw new Error('SWE-Marathon auth file must be owned by the current user');
    if ((info.mode & 0o777) !== 0o600) throw new Error('SWE-Marathon auth file must have mode 0600');
    const output = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < output.length) {
      const count = readSync(fd, output, offset, output.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== output.length) throw new Error('SWE-Marathon auth file changed while being read');
    const after = fstatSync(fd);
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size
      || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.nlink !== 1) {
      throw new Error('SWE-Marathon auth file changed while being read');
    }
    return output;
  } finally {
    closeSync(fd);
  }
}

/** Validate that the selected credential is supplied again without persisting it. */
export function assertMarathonRuntimeBinding(config: SweMarathonConfig, source = process.env): void {
  if (config.auth.mechanism === 'chatgpt') {
    if (!source.CODEX_AUTH_JSON_PATH) throw new Error('SWE-Marathon chatgpt auth requires CODEX_AUTH_JSON_PATH');
    readPrivateAuthFile(source.CODEX_AUTH_JSON_PATH);
    return;
  }
  if (!source.OPENAI_API_KEY || source.OPENAI_API_KEY.includes('\0')) {
    throw new Error('SWE-Marathon api-key auth requires a non-empty OPENAI_API_KEY');
  }
}

/** Copy auth into a disposable 0700 home and return Harbor's minimal environment. */
export function createMarathonRuntimeHome(
  config: SweMarathonConfig,
  bridgeDirectory: string,
  labels: Readonly<Record<string, string>>,
  source = process.env,
): MarathonRuntimeHome {
  assertMarathonRuntimeBinding(config, source);
  const directory = mkdtempSync(join(tmpdir(), 'uc-bench-marathon-home-'));
  chmodSync(directory, 0o700);
  try {
    const marker = {
      schemaVersion: 2,
      kind: 'ultracode-swe-marathon-runtime',
      rootScope: labels.ULTRACODE_BENCHMARK_ROOT,
      runId: labels.ULTRACODE_BENCHMARK_RUN,
      taskId: labels.ULTRACODE_BENCHMARK_TASK,
      arm: labels.ULTRACODE_BENCHMARK_ARM,
      runtimeNonce: labels.ULTRACODE_BENCHMARK_RUNTIME,
    };
    if (labels.ULTRACODE_BENCHMARK_SCHEMA !== '2'
      || labels.ULTRACODE_BENCHMARK_SUITE !== 'swe-marathon'
      || !/^[a-f0-9]{64}$/.test(marker.rootScope ?? '')
      || labels.ULTRACODE_BENCHMARK_PURPOSE !== 'session'
      || labels.ULTRACODE_BENCHMARK_OWNERSHIP !== '1'
      || Object.values(marker).some((value) => value === undefined)
      || !/^[a-f0-9]{64}$/.test(marker.runtimeNonce ?? '')) {
      throw new Error('SWE-Marathon runtime ownership labels are incomplete');
    }
    writePrivateJsonAtomic(directory, join(directory, RUNTIME_MARKER), marker);
    const environment = allowlistedEnvironment(source);
    environment.HOME = directory;
    environment.XDG_CONFIG_HOME = join(directory, '.config');
    environment.HARBOR_TELEMETRY = 'off';
    environment.PYTHONDONTWRITEBYTECODE = '1';
    environment.PYTHONPATH = bridgeDirectory;
    for (const [name, value] of Object.entries(labels)) environment[name] = value;
    if (config.auth.mechanism === 'chatgpt') {
      const authPath = join(directory, 'auth.json');
      writeFileSync(authPath, readPrivateAuthFile(source.CODEX_AUTH_JSON_PATH!), { mode: 0o600, flag: 'wx' });
      environment.CODEX_AUTH_JSON_PATH = authPath;
    } else {
      environment.OPENAI_API_KEY = source.OPENAI_API_KEY!;
    }
    let cleaned = false;
    return {
      directory,
      environment,
      cleanup() {
        if (cleaned) return;
        cleanupMarathonRuntimeHome(
          marker.rootScope!, marker.runId!, marker.taskId!, marker.arm as 'a' | 'b', marker.runtimeNonce!,
        );
        cleaned = true;
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function marathonRuntimeCandidates(
  rootScope: string,
  runId: string,
  taskId: string,
  arm: 'a' | 'b',
  runtimeNonce?: string,
): Array<{ directory: string; runtimeNonce: string }> {
  if (!/^[a-f0-9]{64}$/.test(rootScope)) throw new Error('invalid SWE-Marathon root scope');
  if (runtimeNonce !== undefined && !/^[a-f0-9]{64}$/.test(runtimeNonce)) {
    throw new Error('invalid SWE-Marathon runtime nonce');
  }
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^uc-bench-marathon-home-[A-Za-z0-9]+$/.test(entry.name))
    .flatMap((entry) => {
      const directory = join(tmpdir(), entry.name);
      try {
        const info = lstatSync(directory);
        const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
        if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700
          || (uid !== undefined && info.uid !== uid)) return [];
        const marker = readPrivateJson(directory, join(directory, RUNTIME_MARKER));
        if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return [];
        const expected = {
          schemaVersion: 2,
          kind: 'ultracode-swe-marathon-runtime',
          rootScope,
          runId,
          taskId,
          arm,
          runtimeNonce: (marker as Record<string, unknown>).runtimeNonce,
        };
        if (canonicalJson(marker) !== canonicalJson(expected)
          || typeof expected.runtimeNonce !== 'string'
          || !/^[a-f0-9]{64}$/.test(expected.runtimeNonce)
          || (runtimeNonce !== undefined && expected.runtimeNonce !== runtimeNonce)) return [];
        return [{ directory, runtimeNonce: expected.runtimeNonce }];
      } catch (error) {
        throw new Error(`unsafe SWE-Marathon runtime namespace entry: ${directory}`, { cause: error });
      }
    });
}

/** Remove the one exact crash-surviving credential home bound to native labels. */
export function cleanupMarathonRuntimeHome(
  rootScope: string,
  runId: string,
  taskId: string,
  arm: 'a' | 'b',
  runtimeNonce: string,
): number {
  const candidates = marathonRuntimeCandidates(rootScope, runId, taskId, arm, runtimeNonce);
  if (candidates.length > 1) throw new Error('SWE-Marathon runtime nonce is not unique');
  if (candidates.length === 0) return 0;
  rmSync(candidates[0]!.directory, { recursive: true });
  return 1;
}

/** Remove every exact orphan for one manifest-owned task after its containers stop. */
export function cleanupMarathonRuntimeHomes(
  rootScope: string,
  runId: string,
  taskId: string,
  arm: 'a' | 'b',
): number {
  const candidates = marathonRuntimeCandidates(rootScope, runId, taskId, arm);
  if (new Set(candidates.map((candidate) => candidate.runtimeNonce)).size !== candidates.length) {
    throw new Error('SWE-Marathon runtime nonce is not unique');
  }
  for (const candidate of candidates) rmSync(candidate.directory, { recursive: true });
  return candidates.length;
}
