/** Canonical Arm B prompt bytes shared by every benchmark suite. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARM_B_PREFIX_FILE = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../suites/shared/arm-b-prefix.txt',
);

/** Read the tracked prefix without newline or Unicode normalization. */
export function armBPrefixBytes(): Buffer {
  return readFileSync(ARM_B_PREFIX_FILE);
}

/** Compose byte-identical Arm B input while leaving Arm A untouched. */
export function composeArmPrompt(taskBody: string, arm: 'a' | 'b'): string {
  return arm === 'a' ? taskBody : Buffer.concat([
    armBPrefixBytes(),
    Buffer.from(taskBody, 'utf8'),
  ]).toString('utf8');
}

export const ARM_B_PREFIX_PATH = ARM_B_PREFIX_FILE;
