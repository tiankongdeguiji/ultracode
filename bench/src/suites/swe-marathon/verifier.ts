/** Exact Harbor 0.17.1 job/trial indexing; native rewards remain the sole verdict authority. */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Arm } from '../../shared/contracts.js';
import {
  readRegularFileWithinRoot,
  resolveRegularFileWithinRoot,
  validateRelativeArtifactPath,
} from '../../shared/paths.js';
import {
  createVerifierBinding,
  UNVERIFIED_NATIVE_RESULT,
  type NativeVerifierResult,
  type VerifierBinding,
} from '../../shared/verifier.js';
import { sha256Buffer } from '../../shared/provenance.js';

export interface HarborExecutionIdentity {
  taskId: string;
  arm: Arm;
  model: string;
  requestedEffort: string;
  jobRelativeRoot: string;
}

export interface IndexedHarborEvidence {
  bindings: VerifierBinding[];
  nativeResult: NativeVerifierResult;
  terminalFailure: 'verifier-timeout' | null;
  trialName: string | null;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Harbor ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function json(
  runDirectory: string,
  path: string,
  name: string,
): { value: Record<string, unknown>; sha256: string } {
  try {
    const bytes = readRegularFileWithinRoot(runDirectory, path);
    return {
      value: object(JSON.parse(bytes.toString('utf8')) as unknown, name),
      sha256: sha256Buffer(bytes),
    };
  } catch (error) {
    throw new Error(`Harbor ${name} is malformed: ${path}`, { cause: error });
  }
}

function portable(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** Validate exact native job configuration fields, never string occurrence. */
export function validateHarborJobConfig(config: unknown, identity: HarborExecutionIdentity): void {
  const row = object(config, 'job config');
  const task = object(row.task, 'job config task');
  const agent = object(row.agent, 'job config agent');
  const kwargs = object(agent.kwargs, 'job config agent kwargs');
  const expectedAgent = identity.arm === 'a' ? 'codex' : 'arm_b_codex:ArmBCodex';
  const fields: Array<[string, unknown, unknown]> = [
    ['task.path', task.path, `tasks/${identity.taskId}`],
    ['agent.name', agent.name, expectedAgent],
    ['agent.model_name', agent.model_name, identity.model],
    ['agent.kwargs.reasoning_effort', kwargs.reasoning_effort, identity.requestedEffort],
    ['agent.kwargs.web_search', kwargs.web_search, 'disabled'],
  ];
  for (const [name, actual, expected] of fields) {
    if (actual !== expected) {
      throw new Error(`Harbor job config ${name} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  const expectedJobName = identity.jobRelativeRoot.split('/').at(-1)!;
  if (row.job_name !== undefined && row.job_name !== expectedJobName) {
    throw new Error(`Harbor job config job_name mismatch: expected ${expectedJobName}`);
  }
  if (row.n_attempts !== 1) throw new Error('Harbor job config must use one attempt');
  if (row.max_retries !== 0) throw new Error('Harbor job config must disable retries');
}

export function locateExactHarborTrial(
  runDirectory: string,
  jobRoot: string,
): { name: string; config: string; result: string; root: string } {
  const directory = join(runDirectory, ...jobRoot.split('/'));
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const config = join(directory, entry.name, 'config.json');
      const result = join(directory, entry.name, 'result.json');
      return existsSync(config) && existsSync(result)
        ? [{
            name: entry.name,
            config: portable(runDirectory, config),
            result: portable(runDirectory, result),
            root: portable(runDirectory, join(directory, entry.name)),
          }]
        : [];
    });
  if (candidates.length !== 1) {
    throw new Error(`expected one direct-child Harbor trial under ${jobRoot}, found ${candidates.length}`);
  }
  return candidates[0]!;
}

function validateTrialConfig(
  config: Record<string, unknown>,
  trialName: string,
  identity: HarborExecutionIdentity,
): void {
  const task = object(config.task, 'trial config task');
  if (config.trial_name !== trialName || task.path !== `tasks/${identity.taskId}`) {
    throw new Error('Harbor trial config identity mismatch');
  }
  if (config.task_name !== undefined && config.task_name !== identity.taskId) {
    throw new Error('Harbor trial config task name mismatch');
  }
  validateHarborJobConfig({ ...config, n_attempts: 1, max_retries: 0 }, identity);
}

function validateTrialResultIdentity(
  result: Record<string, unknown>,
  trialName: string,
  taskId: string,
): void {
  if (result.task_name !== taskId || result.trial_name !== trialName) {
    throw new Error('Harbor trial result identity is invalid');
  }
}

function hasVerifierTimeout(result: Record<string, unknown>): boolean {
  if (result.exception_info === null || result.exception_info === undefined) return false;
  return object(result.exception_info, 'trial exception_info').exception_type === 'VerifierTimeoutError';
}

function rewardFrom(result: Record<string, unknown>): number {
  const verifierResult = object(result.verifier_result, 'trial verifier_result');
  const rewards = object(verifierResult.rewards, 'trial verifier rewards');
  const reward = rewards.reward;
  if (typeof reward !== 'number' || !Number.isFinite(reward) || reward < 0 || reward > 1) {
    throw new Error('Harbor trial bounded reward is invalid');
  }
  return reward;
}

/** Bind every exact valid config/result artifact, preserving valid partial evidence. */
export function indexHarborEvidence(
  runDirectory: string,
  identity: HarborExecutionIdentity,
  invocationId: string,
): IndexedHarborEvidence {
  const bindings: VerifierBinding[] = [];
  let nativeResult = UNVERIFIED_NATIVE_RESULT;
  let terminalFailure: IndexedHarborEvidence['terminalFailure'] = null;
  let trialName: string | null = null;
  const jobConfigPath = `${identity.jobRelativeRoot}/config.json`;
  try {
    const jobConfig = json(runDirectory, jobConfigPath, 'job config');
    validateHarborJobConfig(jobConfig.value, identity);
    bindings.push(createVerifierBinding(runDirectory, {
      invocationId,
      scope: { kind: 'task-arm', taskId: identity.taskId, arm: identity.arm },
      role: 'native-config',
      path: validateRelativeArtifactPath(jobConfigPath),
      nativeRecordKey: 'job-config',
    }, jobConfig.sha256));
  } catch {
    return { bindings, nativeResult, terminalFailure, trialName };
  }

  const jobResultPath = `${identity.jobRelativeRoot}/result.json`;
  if (!existsSync(join(runDirectory, ...jobResultPath.split('/')))) {
    return { bindings, nativeResult, terminalFailure, trialName };
  }
  try {
    const jobResult = json(runDirectory, jobResultPath, 'job result');
    bindings.push(createVerifierBinding(runDirectory, {
      invocationId,
      scope: { kind: 'task-arm', taskId: identity.taskId, arm: identity.arm },
      role: 'run-metadata',
      path: validateRelativeArtifactPath(jobResultPath),
      nativeRecordKey: 'job-result',
    }, jobResult.sha256));
  } catch {
    return { bindings, nativeResult, terminalFailure, trialName };
  }

  try {
    const trial = locateExactHarborTrial(runDirectory, identity.jobRelativeRoot);
    const trialConfig = json(runDirectory, trial.config, 'trial config');
    validateTrialConfig(trialConfig.value, trial.name, identity);
    trialName = trial.name;
    bindings.push(createVerifierBinding(runDirectory, {
      invocationId,
      scope: { kind: 'task-arm', taskId: identity.taskId, arm: identity.arm },
      role: 'native-config',
      path: validateRelativeArtifactPath(trial.config),
      nativeRecordKey: `trial-config:${trial.name}`,
    }, trialConfig.sha256));
    const result = json(runDirectory, trial.result, 'trial result');
    validateTrialResultIdentity(result.value, trial.name, identity.taskId);
    if (hasVerifierTimeout(result.value)) {
      bindings.push(createVerifierBinding(runDirectory, {
        invocationId,
        scope: { kind: 'task-arm', taskId: identity.taskId, arm: identity.arm },
        role: 'native-result',
        path: validateRelativeArtifactPath(trial.result),
        nativeRecordKey: `${identity.taskId}/${trial.name}/exception_info.exception_type`,
      }, result.sha256));
      terminalFailure = 'verifier-timeout';
      return { bindings, nativeResult, terminalFailure, trialName };
    }
    const reward = rewardFrom(result.value);
    const binding = createVerifierBinding(runDirectory, {
      invocationId,
      scope: { kind: 'task-arm', taskId: identity.taskId, arm: identity.arm },
      role: 'native-result',
      path: validateRelativeArtifactPath(trial.result),
      nativeRecordKey: `${identity.taskId}/${trial.name}/verifier_result.rewards.reward`,
    }, result.sha256);
    bindings.push(binding);
    nativeResult = {
      verification: 'verified',
      score: reward,
      resolved: reward === 1,
      artifact: { path: binding.path, sha256: binding.sha256, nativeRecordKey: binding.nativeRecordKey },
    };
  } catch { /* incomplete or malformed native evidence remains unverified */ }
  return { bindings, nativeResult, terminalFailure, trialName };
}

/** Validate an immutable native resume before invoking Harbor. */
export function validateHarborResume(
  runDirectory: string,
  identity: HarborExecutionIdentity,
): void {
  const path = `${identity.jobRelativeRoot}/config.json`;
  resolveRegularFileWithinRoot(runDirectory, path, 'Harbor resume config');
  validateHarborJobConfig(json(runDirectory, path, 'resume config').value, identity);
}
