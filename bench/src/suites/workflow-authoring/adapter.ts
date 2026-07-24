/** Static workflow-authoring command declarations; model CLIs stay lazy. */
import type { SuiteAdapter, SuiteCommandSpec } from '../../shared/contracts.js';
import { parseStrictOptions, type OptionDefinition } from '../../shared/options.js';

export type AuthoringHost = 'codex' | 'claude';
export type AuthoringHostSelection = AuthoringHost | 'both';

export interface GenerateOptions {
  runId: string;
  host: AuthoringHostSelection;
  model: string;
  requestedEffort: string;
  resume: boolean;
  taskIds?: readonly string[];
}

export interface ReportOptions {
  runId: string;
}

const boolean = (name: string, summary: string): OptionDefinition => ({ name, summary, kind: 'boolean' });
const string = (name: string, valueName: string, summary: string, repeatable = false): OptionDefinition => ({
  name, valueName, summary, repeatable, kind: 'string',
});

function scalar(values: Record<string, boolean | string | readonly string[]>, name: string): string | undefined {
  const observed = values[name];
  return typeof observed === 'string' ? observed : undefined;
}

function repeated(values: Record<string, boolean | string | readonly string[]>, name: string): readonly string[] {
  const observed = values[name];
  return Array.isArray(observed) ? observed : [];
}

function required(values: Record<string, boolean | string | readonly string[]>, name: string): string {
  const observed = scalar(values, name);
  if (observed === undefined) throw new Error(`--${name} is required`);
  return observed;
}

const GENERATE_OPTIONS = [
  string('run-id', 'id', 'lowercase run identity'),
  string('host', 'codex|claude|both', 'authoring host'),
  string('model', 'model', 'requested model'),
  string('effort', 'effort', 'requested reasoning effort'),
  string('task-id', 'suite:id', 'fixed authoring-cohort task', true),
  boolean('resume', 'resume the exact immutable authoring run'),
] as const;

const generateSpec: SuiteCommandSpec<unknown> = {
  summary: 'author workflow.js files without executing any workflow',
  usage: '--run-id <id> [options]',
  options: GENERATE_OPTIONS,
  parse(argv): GenerateOptions {
    const parsed = parseStrictOptions(argv, GENERATE_OPTIONS);
    const host = scalar(parsed.values, 'host') ?? 'both';
    if (!['codex', 'claude', 'both'].includes(host)) {
      throw new Error('--host must be codex, claude, or both');
    }
    const taskIds = repeated(parsed.values, 'task-id');
    return {
      runId: required(parsed.values, 'run-id'),
      host: host as AuthoringHostSelection,
      model: scalar(parsed.values, 'model') ?? 'gpt-5.6-sol',
      requestedEffort: scalar(parsed.values, 'effort') ?? 'xhigh',
      resume: parsed.values.resume === true,
      ...(taskIds.length === 0 ? {} : { taskIds }),
    };
  },
  async run(options, context) {
    const runner = await import('./runner.js');
    await runner.generateCommand(options as GenerateOptions, context);
  },
};

const REPORT_OPTIONS = [string('run-id', 'id', 'lowercase run identity')] as const;
const reportSpec: SuiteCommandSpec<unknown> = {
  summary: 'write paired static workflow metrics without a benchmark score',
  usage: '--run-id <id>',
  options: REPORT_OPTIONS,
  parse(argv): ReportOptions {
    const parsed = parseStrictOptions(argv, REPORT_OPTIONS);
    return { runId: required(parsed.values, 'run-id') };
  },
  async run(options, context) {
    const runner = await import('./runner.js');
    await runner.reportCommand(options as ReportOptions, context);
  },
};

export const workflowAuthoringAdapter: SuiteAdapter<'workflow-authoring'> = {
  suite: 'workflow-authoring',
  displayName: 'Workflow authoring',
  description: 'Static Codex/Claude workflow generation and structural comparison',
  async cleanup() {
    const runner = await import('./runner.js');
    await runner.cleanupWorkflowAuthoringRuntime();
  },
  commands: { generate: generateSpec, report: reportSpec },
};
