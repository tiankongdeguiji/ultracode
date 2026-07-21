/** Pure argv planning for immutable Git checkouts. */

export type Argv = [executable: string, ...args: string[]];

export interface PinnedCheckoutPlanOptions {
  repository: string;
  pin: string;
  directory: string;
  existing?: boolean;
}

const GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function validatePin(pin: string): void {
  if (!GIT_OBJECT_ID_RE.test(pin)) {
    throw new Error(`git pin must be a full 40- or 64-character object id, got '${pin}'`);
  }
}

function validateArg(name: string, value: string): void {
  if (value.length === 0 || value.includes('\0')) throw new Error(`${name} must be non-empty and contain no NUL bytes`);
}

export function planPinnedClone(repository: string, pin: string, directory: string): Argv[] {
  validateArg('repository', repository);
  validateArg('checkout directory', directory);
  validatePin(pin);
  return [
    ['git', 'clone', '--filter=blob:none', '--no-checkout', '--no-tags', '--', repository, directory],
    ...planPinnedUpdate(directory, pin),
  ];
}

export function planPinnedUpdate(directory: string, pin: string): Argv[] {
  validateArg('checkout directory', directory);
  validatePin(pin);
  return [
    ['git', '-C', directory, 'fetch', '--filter=blob:none', '--depth=1', '--no-tags', 'origin', pin],
    ['git', '-C', directory, 'checkout', '--detach', pin],
  ];
}

export function planPinnedCheckout(options: PinnedCheckoutPlanOptions): Argv[] {
  return options.existing
    ? planPinnedUpdate(options.directory, options.pin)
    : planPinnedClone(options.repository, options.pin, options.directory);
}
