/**
 * Sandbox: compiles and runs a workflow script body inside a hardened
 * node:vm context. The body is the export-stripped script (from meta.ts),
 * wrapped in an async IIFE so top-level await and top-level return both work.
 *
 * The `timeout` option only guards the INITIAL synchronous segment of the IIFE.
 * A synchronous loop that runs after an `await` (e.g. `await agent(); while(1){}`)
 * blocks the event loop, so neither this timeout nor the runner's wall-clock
 * timer/SIGTERM handler can fire — the backstop is external: `ultracode stop`
 * SIGKILLs the runner process (node:vm cannot preempt guest code). Per-agent
 * watchdogs bound the subprocess side.
 */
import vm from 'node:vm';
import { HARDENING_BOOTSTRAP } from './determinism.js';

export const SYNC_TIMEOUT_MS = 30_000;

export interface SandboxOptions {
  /** Host functions and values installed as context globals (agent, parallel, args, ...). */
  globals: Record<string, unknown>;
  syncTimeoutMs?: number;
  filename?: string;
}

export interface CompiledSandbox {
  /** Runs the body; resolves with the script's top-level return value. */
  run(): Promise<unknown>;
}

export function wrapBody(body: string): string {
  return `(async () => {\n${body}\n})()`;
}

/** Compile-only check used by `ultracode validate` (never executes the body). */
export function compileCheck(body: string, filename = 'workflow.js'): void {
  new vm.Script(wrapBody(body), { filename });
}

export function createSandbox(body: string, opts: SandboxOptions): CompiledSandbox {
  const filename = opts.filename ?? 'workflow.js';
  const syncTimeoutMs = opts.syncTimeoutMs ?? SYNC_TIMEOUT_MS;

  const sandbox: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(opts.globals)) sandbox[key] = value;

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  new vm.Script(HARDENING_BOOTSTRAP, { filename: 'ultracode-hardening.js' }).runInContext(context);

  const script = new vm.Script(wrapBody(body), { filename });

  return {
    async run(): Promise<unknown> {
      const result = script.runInContext(context, { timeout: syncTimeoutMs });
      return await Promise.resolve(result);
    },
  };
}
