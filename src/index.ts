// Public API surface. Filled in milestone by milestone.
export const VERSION = '0.1.0';

export { parseWorkflowScript, MAX_SCRIPT_BYTES } from './engine/meta.js';
export type { WorkflowMeta, ParsedWorkflow } from './engine/meta.js';
export { executeWorkflow } from './engine/run.js';
export type { RunOutput, ExecuteOptions } from './engine/run.js';
export {
  HARD_AGENT_CAP,
  MAX_ITEMS_PER_CALL,
  DEFAULT_SOFT_AGENT_CAP,
} from './engine/hostapi.js';
export type { RunEvent } from './engine/hostapi.js';
export { MockExecutor } from './backends/mock.js';
export type {
  AgentExecutor,
  AgentSpec,
  AgentOutcome,
  BackendAdapter,
  NormalizedUsage,
} from './backends/types.js';
export { BudgetAccount } from './budget/account.js';
export * from './engine/errors.js';
