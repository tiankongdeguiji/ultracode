/** SWE-bench Pro task prompt with a byte-identical shared Arm B prefix. */
import { composeArmPrompt } from '../../shared/prompt.js';
import type { Arm } from '../../shared/contracts.js';
import type { SwebenchProInstance } from './types.js';

export function composeTaskBody(instance: SwebenchProInstance): string {
  const sections = [
    instance.problemStatement.trim(),
    instance.requirements?.trim() ? `\nRequirements:\n${instance.requirements.trim()}` : '',
    instance.interface?.trim() ? `\nInterface notes:\n${instance.interface.trim()}` : '',
    '\nWork in the existing repository. Implement the requested fix, run relevant tests, and leave the working tree with the final solution.',
  ];
  return `${sections.join('')}\n`;
}

export function composePrompt(instance: SwebenchProInstance, arm: Arm): string {
  return composeArmPrompt(composeTaskBody(instance), arm);
}
