/**
 * Prepare only immutable task text for authoring evaluation. This deliberately
 * avoids task repositories, runtime environments, Docker images, and verifiers.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import type { CommandContext } from '../../shared/contracts.js';
import {
  ensureRealDirectoryWithin,
  writePrivateFileAtomic,
  writePrivateJsonAtomic,
} from '../../shared/paths.js';
import { runBenchProcess } from '../../shared/process.js';
import { sha256File } from '../../shared/provenance.js';
import { instanceFromRow } from '../swebench-pro/instances.js';
import { composeTaskBody } from '../swebench-pro/prompt.js';
import {
  authoringCacheDirectory,
  authoringFeatureParquetFile,
  authoringInputsFile,
  authoringProParquetFile,
  loadAuthoringCohort,
  type PreparedAuthoringInputs,
} from './inputs.js';
import type { AuthoringSourceSuite, GoldPatchStats } from './types.js';

const MAX_DATASET_BYTES = 64 * 1_024 * 1_024;
const MAX_EXTRACT_BYTES = 64 * 1_024 * 1_024;
const MAX_MARATHON_TASK_BYTES = 2 * 1_024 * 1_024;

const EXTRACT_ROWS_SCRIPT = `import json
import sys
import pyarrow.parquet as pq

def selected(path, task_ids):
    rows = pq.read_table(path).to_pylist()
    by_id = {row["instance_id"]: row for row in rows}
    missing = [task_id for task_id in task_ids if task_id not in by_id]
    if missing:
        raise ValueError("selected authoring tasks are absent from parquet: " + ", ".join(missing))
    return [by_id[task_id] for task_id in task_ids]

print(json.dumps({
    "pro": selected(sys.argv[1], json.loads(sys.argv[3])),
    "feature": selected(sys.argv[2], json.loads(sys.argv[4])),
}, ensure_ascii=False))`;

const featureRowSchema = z.object({
  instance_id: z.string().min(1),
  problem_statement: z.string().min(1),
  patch: z.string(),
}).passthrough();

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function patchStats(patch: string): GoldPatchStats {
  const lines = patch.split(/\r?\n/u);
  const diffFiles = lines.filter((line) => line.startsWith('diff --git ')).length;
  const fallbackFiles = lines.filter((line) => line.startsWith('+++ ') && line !== '+++ /dev/null').length;
  return {
    files: diffFiles || fallbackFiles,
    additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
  };
}

async function pinnedDownload(
  url: string,
  file: string,
  expectedSha256: string,
  cacheDirectory: string,
): Promise<void> {
  if (existsSync(file) && sha256File(file) === expectedSha256) return;
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`authoring input download failed: HTTP ${response.status} ${url}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_DATASET_BYTES) throw new Error(`authoring input exceeds ${MAX_DATASET_BYTES} bytes`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DATASET_BYTES) throw new Error(`authoring input exceeds ${MAX_DATASET_BYTES} bytes`);
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(`authoring input hash mismatch for ${basename(file)}`);
  }
  writePrivateFileAtomic(cacheDirectory, file, bytes);
}

async function marathonInstruction(
  repositoryRevision: string,
  taskId: string,
): Promise<string> {
  const url = `https://raw.githubusercontent.com/abundant-ai/swe-marathon/${repositoryRevision}/tasks/${taskId}/instruction.md`;
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Marathon authoring instruction download failed: HTTP ${response.status} ${taskId}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_MARATHON_TASK_BYTES) throw new Error(`Marathon instruction is oversized: ${taskId}`);
  const text = await response.text();
  if (!text.trim() || Buffer.byteLength(text) > MAX_MARATHON_TASK_BYTES) {
    throw new Error(`Marathon instruction is empty or oversized: ${taskId}`);
  }
  return text;
}

async function extractRows(
  proFile: string,
  featureFile: string,
  proTaskIds: readonly string[],
  featureTaskIds: readonly string[],
  cwd: string,
): Promise<{ pro: Record<string, unknown>[]; feature: z.infer<typeof featureRowSchema>[] }> {
  const result = await runBenchProcess('python3', [
    '-c',
    EXTRACT_ROWS_SCRIPT,
    proFile,
    featureFile,
    JSON.stringify(proTaskIds),
    JSON.stringify(featureTaskIds),
  ], {
    cwd,
    tailBytes: MAX_EXTRACT_BYTES,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error('workflow-authoring parquet extractor returned malformed JSON', { cause: error });
  }
  const value = z.strictObject({
    pro: z.array(z.record(z.string(), z.unknown())),
    feature: z.array(featureRowSchema),
  }).parse(parsed);
  return { pro: value.pro, feature: value.feature };
}

/** Download and freeze the 65 source-only task statements used by generation. */
export async function prepareCommand(context: CommandContext): Promise<void> {
  const cohort = loadAuthoringCohort(context.paths);
  const cacheDirectory = ensureRealDirectoryWithin(
    context.paths.cacheRoot,
    authoringCacheDirectory(context.paths),
  );
  const proFile = authoringProParquetFile(context.paths);
  const featureFile = authoringFeatureParquetFile(context.paths);
  await pinnedDownload(
    `https://huggingface.co/datasets/${cohort.sources.swebenchPro.dataset}/resolve/${cohort.sources.swebenchPro.revision}/data/test-00000-of-00001.parquet?download=true`,
    proFile,
    cohort.sources.swebenchPro.parquetSha256,
    cacheDirectory,
  );
  await pinnedDownload(
    `https://huggingface.co/datasets/${cohort.sources.featureBench.dataset}/resolve/${cohort.sources.featureBench.revision}/data/fast-00000-of-00001.parquet?download=true`,
    featureFile,
    cohort.sources.featureBench.parquetSha256,
    cacheDirectory,
  );

  const proTaskIds = cohort.tasks.filter((task) => task.suite === 'swebench-pro').map((task) => task.taskId);
  const featureTaskIds = cohort.tasks.filter((task) => task.suite === 'featurebench').map((task) => task.taskId);
  const rows = await extractRows(proFile, featureFile, proTaskIds, featureTaskIds, cacheDirectory);
  const preparedById = new Map<string, PreparedAuthoringInputs['tasks'][number]>();
  for (const row of rows.pro) {
    const instance = instanceFromRow(row);
    preparedById.set(`swebench-pro:${instance.instanceId}`, {
      sourceSuite: 'swebench-pro',
      taskId: instance.instanceId,
      taskBody: composeTaskBody(instance),
      goldPatchStats: patchStats(instance.goldPatch),
    });
  }
  for (const row of rows.feature) {
    preparedById.set(`featurebench:${row.instance_id}`, {
      sourceSuite: 'featurebench',
      taskId: row.instance_id,
      taskBody: row.problem_statement,
      goldPatchStats: patchStats(row.patch),
    });
  }
  const marathonTasks = cohort.tasks.filter((task) => task.suite === 'swe-marathon');
  const marathonBodies = await Promise.all(marathonTasks.map(async (task) => ({
    task,
    body: await marathonInstruction(cohort.sources.sweMarathon.revision, task.taskId),
  })));
  for (const { task, body } of marathonBodies) {
    preparedById.set(`swe-marathon:${task.taskId}`, {
      sourceSuite: 'swe-marathon',
      taskId: task.taskId,
      taskBody: body,
      goldPatchStats: null,
    });
  }

  const tasks = cohort.tasks.map((task) => {
    const qualified = `${task.suite}:${task.taskId}`;
    const prepared = preparedById.get(qualified);
    if (prepared === undefined) throw new Error(`workflow-authoring preparation omitted ${qualified}`);
    return prepared;
  });
  const output: PreparedAuthoringInputs = {
    schemaVersion: 2,
    kind: 'ultracode-workflow-authoring-inputs',
    cohortSha256: cohort.sha256,
    sources: cohort.sources,
    tasks,
  };
  writePrivateJsonAtomic(cacheDirectory, authoringInputsFile(context.paths), output);
  const counts = new Map<AuthoringSourceSuite, number>();
  tasks.forEach((task) => counts.set(task.sourceSuite, (counts.get(task.sourceSuite) ?? 0) + 1));
  context.stdout.write(
    `workflow-authoring inputs: pro=${counts.get('swebench-pro') ?? 0} feature=${counts.get('featurebench') ?? 0} marathon=${counts.get('swe-marathon') ?? 0}\n`,
  );
}
