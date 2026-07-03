/**
 * Child-process plumbing: every agent CLI runs in its OWN process group
 * (detached:true) so stop can kill the whole tree with kill(-pgid) — agent
 * CLIs spawn their own children (shells, tools).
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface SpawnedAgent {
  child: ChildProcess;
  killTree(signal?: NodeJS.Signals): void;
}

export interface SpawnAgentOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  stdinData?: string;
}

export function spawnAgentProcess(bin: string, argv: string[], opts: SpawnAgentOptions): SpawnedAgent {
  const child = spawn(bin, argv, {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv,
    detached: true, // own process group → killable as a tree
    stdio: [opts.stdinData !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  if (opts.stdinData !== undefined && child.stdin) {
    child.stdin.write(opts.stdinData);
    child.stdin.end();
  }

  const killTree = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal); // whole process group
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };

  return { child, killTree };
}

/** Keep only the trailing maxBytes of accumulated text (stderr tails). */
export class TailBuffer {
  private buf = '';

  constructor(private readonly maxBytes = 64 * 1024) {}

  push(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.maxBytes) {
      this.buf = this.buf.slice(this.buf.length - this.maxBytes);
    }
  }

  get text(): string {
    return this.buf;
  }
}
