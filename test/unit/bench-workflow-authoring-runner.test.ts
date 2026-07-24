/** Prompt-only authoring persistence, resume, and tool-use containment. */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { workflowAuthoringAdapter } from '../../bench/src/suites/workflow-authoring/adapter.js';
import {
  generateCommand,
  reportCommand,
  type WorkflowAuthoringDependencies,
} from '../../bench/src/suites/workflow-authoring/runner.js';
import { artifactKey, createBenchPathRoots } from '../../bench/src/shared/paths.js';
import type { CommandContext } from '../../bench/src/shared/contracts.js';

const FAKE_WORKFLOW = `export const meta = {
  name: 'uc-fake-authoring',
  description: 'fake static workflow',
  phases: [{ title: 'Inspect' }, { title: 'Decide' }],
}
phase('Inspect')
const finding = await agent('Inspect the requested task without mutation.', {
  schema: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] },
})
phase('Decide')
if (!finding.ready) await agent('Repair the requested task as the only mutation owner.')
return finding
`;

const FAKE_CLI = `#!/usr/bin/env node
const path = require('node:path')
const host = path.basename(process.argv[1])
if (process.argv.includes('--version')) {
  process.stdout.write(host + '-fake 1.0.0\\n')
  process.exit(0)
}
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { prompt += chunk })
process.stdin.on('end', () => {
  if (host === 'claude' && prompt.includes('TRIGGER_TOOL')) {
    process.stdout.write(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Workflow', input: {} }] },
    }) + '\\n')
    setInterval(() => {}, 1000)
    return
  }
  const workflow = ${JSON.stringify(FAKE_WORKFLOW)}
  if (host === 'codex') {
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: workflow } }) + '\\n')
  } else {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: workflow }] } }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'result', result: workflow }) + '\\n')
  }
})
`;

let priorPath: string | undefined;

afterEach(() => {
  if (priorPath === undefined) delete process.env.PATH;
  else process.env.PATH = priorPath;
});

function fixture(taskBody = 'Requirements:\n- Keep public interfaces stable.'): {
  context: CommandContext;
  dependencies: WorkflowAuthoringDependencies;
  output: PassThrough;
  runRoot: string;
  key: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'uc-authoring-test-'));
  const benchRoot = join(root, 'bench');
  const bin = join(root, 'bin');
  mkdirSync(benchRoot, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  for (const host of ['codex', 'claude']) {
    const file = join(bin, host);
    writeFileSync(file, FAKE_CLI, { mode: 0o700 });
    chmodSync(file, 0o700);
  }
  priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath ?? ''}`;
  const paths = createBenchPathRoots(benchRoot);
  const output = new PassThrough();
  const qualifiedTaskId = 'swebench-pro:fixture-task';
  const key = artifactKey(qualifiedTaskId);
  const dependencies: WorkflowAuthoringDependencies = {
    loadInputs: () => ({
      inputsSha256: 'c'.repeat(64),
      cohort: {
        bytes: Buffer.from('fixture cohort'),
        sha256: createHash('sha256').update('fixture cohort').digest('hex'),
        sources: {
          swebenchPro: {
            dataset: 'ScaleAI/SWE-bench_Pro',
            revision: '7ab5114912baf22bb098818e604c02fe7ad2c11f',
            parquetSha256: 'c8cd7115496ad4e9a8b21d088cef576a65bf821bb542b24336f13f714cef13f8',
          },
          featureBench: {
            dataset: 'LiberCoders/FeatureBench',
            revision: 'e99d6efdfe511ea832c1b5735c536129561ec96a',
            parquetSha256: 'e8a704f83d673e1cc78086eefb76bd56461ead8a65ca06fd6972f7363be8a775',
          },
          sweMarathon: {
            repository: 'https://github.com/abundant-ai/swe-marathon.git',
            revision: '6d6855af390226f6eca607d63818fe076e57ea8c',
          },
        },
        tasks: [{ suite: 'swebench-pro', taskId: 'fixture-task' }],
      },
      tasks: [{
        sourceSuite: 'swebench-pro',
        taskId: 'fixture-task',
        qualifiedTaskId,
        key,
        taskBody,
        taskBodySha256: createHash('sha256').update(taskBody).digest('hex'),
        goldPatchStats: { files: 1, additions: 2, deletions: 1 },
      }],
    }),
    loadDoctrine: () => ({ text: 'tracked static doctrine', sha256: 'b'.repeat(64) }),
  };
  return {
    context: {
      stdout: output,
      stderr: new PassThrough(),
      paths,
      clock: { now: () => new Date('2026-07-24T00:00:00.000Z'), monotonicMs: () => 0 },
    },
    dependencies,
    output,
    runRoot: join(paths.resultsRoot, 'workflow-authoring', 'static1'),
    key,
  };
}

function outputText(output: PassThrough): string {
  return output.read()?.toString('utf8') ?? '';
}

describe('workflow-authoring runner', () => {
  it('generates paired static artifacts, freezes provenance, resumes, and reports', async () => {
    const test = fixture();
    const options = {
      runId: 'static1',
      host: 'both' as const,
      model: 'gpt-5.6-sol',
      requestedEffort: 'xhigh',
      resume: false,
    };
    await generateCommand(options, test.context, test.dependencies);
    expect(outputText(test.output)).toMatch(/generated=2 skipped=0 invalid=0/);

    const manifest = JSON.parse(readFileSync(join(test.runRoot, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      model: 'gpt-5.6-sol',
      requestedEffort: 'xhigh',
      hosts: ['codex', 'claude'],
      inputsSha256: 'c'.repeat(64),
      codexDoctrineSha256: 'b'.repeat(64),
    });
    expect(manifest.binaries.map((entry: { host: string }) => entry.host)).toEqual(['codex', 'claude']);
    expect(manifest.binaries.every((entry: { binarySha256: string }) =>
      /^[a-f0-9]{64}$/u.test(entry.binarySha256))).toBe(true);

    const artifacts = ['codex', 'claude'].map((host) => JSON.parse(readFileSync(
      join(test.runRoot, 'tasks', test.key, host, 'artifact.json'),
      'utf8',
    )));
    expect(artifacts.map((artifact) => artifact.status)).toEqual(['valid', 'valid']);
    expect(artifacts.map((artifact) => artifact.toolUseDetected)).toEqual([false, false]);
    expect(artifacts[0].promptSha256).not.toBe(artifacts[1].promptSha256);
    expect(artifacts[0].workflowSha256).toBe(artifacts[1].workflowSha256);

    await generateCommand({ ...options, resume: true }, test.context, test.dependencies);
    expect(outputText(test.output)).toMatch(/generated=0 skipped=2 invalid=0/);

    await reportCommand({ runId: 'static1' }, test.context);
    const report = JSON.parse(readFileSync(join(test.runRoot, 'report.json'), 'utf8'));
    expect(report.summary).toMatchObject({
      requestedArtifacts: 2,
      storedArtifacts: 2,
      validArtifacts: 2,
      pairedTasks: 1,
      toolUseViolations: 0,
    });
    expect(report.comparisons[0].goldPatchStats).toEqual({ files: 1, additions: 2, deletions: 1 });
    expect(report.aggregates.codex).toMatchObject({
      storedArtifacts: 1,
      validArtifacts: 1,
      dynamicAgentUpperBounds: 0,
    });
    expect(report.aggregates.claude.agentMinimum).toEqual(report.aggregates.codex.agentMinimum);
    expect(report.aggregatesBySourceSuite['swebench-pro'].codex).toMatchObject({
      storedArtifacts: 1,
      validArtifacts: 1,
    });
    expect(report.aggregatesBySourceSuite.featurebench.codex.storedArtifacts).toBe(0);
    expect(readFileSync(join(test.runRoot, 'report.md'), 'utf8')).toContain(
      'No workflow was executed and no benchmark score was produced.',
    );
    expect(readFileSync(join(test.runRoot, 'report.md'), 'utf8')).toContain(
      '| swebench-pro | codex | 1/1 |',
    );
    expect(readFileSync(join(test.runRoot, 'report.md'), 'utf8')).not.toContain('Scale match');
  });

  it('terminates and invalidates a Claude Workflow tool-use event', async () => {
    const test = fixture('TRIGGER_TOOL\nRequirements:\n- Keep public interfaces stable.');
    await generateCommand({
      runId: 'static1',
      host: 'claude',
      model: 'gpt-5.6-sol',
      requestedEffort: 'xhigh',
      resume: false,
    }, test.context, test.dependencies);
    const artifact = JSON.parse(readFileSync(
      join(test.runRoot, 'tasks', test.key, 'claude', 'artifact.json'),
      'utf8',
    ));
    expect(artifact.status).toBe('invalid');
    expect(artifact.toolUseDetected).toBe(true);
    expect(artifact.workflowSha256).toBeNull();
    expect(artifact.diagnostics.join('\n')).toMatch(/forbidden tool invocation/);
  });

  it('rejects resume drift and validates the public option grammar', async () => {
    const test = fixture();
    const options = {
      runId: 'static1',
      host: 'codex' as const,
      model: 'gpt-5.6-sol',
      requestedEffort: 'xhigh',
      resume: false,
    };
    await generateCommand(options, test.context, test.dependencies);
    await expect(generateCommand({
      ...options,
      model: 'different-model',
      resume: true,
    }, test.context, test.dependencies)).rejects.toThrow(/resume inputs do not match/);

    const parse = workflowAuthoringAdapter.commands.generate.parse;
    expect(parse([
      '--run-id', 'r1',
      '--host', 'both',
      '--task-id', 'swebench-pro:a',
      '--task-id=swe-marathon:kubernetes-rust-rewrite',
      '--resume',
    ])).toEqual({
      runId: 'r1',
      host: 'both',
      model: 'gpt-5.6-sol',
      requestedEffort: 'xhigh',
      concurrency: 4,
      taskIds: ['swebench-pro:a', 'swe-marathon:kubernetes-rust-rewrite'],
      resume: true,
    });
    expect(() => parse(['--run-id', 'r1', '--host', 'other'])).toThrow(/--host/);
  });
});
