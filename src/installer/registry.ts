/**
 * Workflow registry resolution for nested workflow() and `ultracode run
 * <name>`. Precedence: project .ultracode/workflows > user
 * ~/.ultracode/workflows > packaged workflows/. A scriptPath is read
 * directly.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function packagedWorkflowsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../../workflows');
}

function candidates(nameOrPath: string, cwd: string): string[] {
  // Explicit path (absolute, or contains a separator / .js extension).
  if (isAbsolute(nameOrPath) || nameOrPath.includes('/') || nameOrPath.endsWith('.js')) {
    return [resolve(cwd, nameOrPath)];
  }
  const bases = [join(cwd, '.ultracode/workflows'), join(homedir(), '.ultracode/workflows'), packagedWorkflowsDir()];
  const files: string[] = [];
  for (const base of bases) {
    files.push(join(base, `${nameOrPath}.workflow.js`), join(base, `${nameOrPath}.js`), join(base, nameOrPath));
  }
  return files;
}

export function resolveWorkflowSource(nameOrPath: string, cwd: string): string {
  for (const file of candidates(nameOrPath, cwd)) {
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  throw new Error(`workflow '${nameOrPath}' not found (looked in .ultracode/workflows, ~/.ultracode/workflows, packaged templates)`);
}

export function workflowExists(nameOrPath: string, cwd: string): boolean {
  return candidates(nameOrPath, cwd).some((f) => existsSync(f));
}
