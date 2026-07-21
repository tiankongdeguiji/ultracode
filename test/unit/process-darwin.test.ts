/** Bounded macOS worker discovery and identity-signaling behavior. */
import { describe, expect, it } from 'vitest';
import {
  discoverWorkerProcessesForTokens,
  signalTrackedWorkerProcesses,
  workerScopeValue,
} from '../../src/exec/procinfo.js';

const TOKEN = 'a'.repeat(32);
const STARTED = 'Mon Jul 20 12:00:00 2026';
const START_IDENTITY = 'darwin:Mon_Jul_20_12:00:00_2026';

function processLine(pid: number, pgrp: number, command: string, started = STARTED): string {
  return `${pid} ${pgrp} ${started} ${command}`;
}

describe('Darwin worker process discovery', () => {
  it('returns complete empty discovery without ps when candidates are undefined or empty', () => {
    let queries = 0;
    const inspection = {
      platform: 'darwin' as const,
      executePs: () => {
        queries += 1;
        throw new Error('ps must not run');
      },
    };
    expect(discoverWorkerProcessesForTokens([TOKEN], process.cwd(), undefined, inspection))
      .toEqual({ processes: [], complete: true });
    expect(discoverWorkerProcessesForTokens([TOKEN], process.cwd(), [], inspection))
      .toEqual({ processes: [], complete: true });
    expect(queries).toBe(0);
  });

  it('uses only bounded explicit -p queries', () => {
    const calls: string[][] = [];
    const candidates = Array.from({ length: 130 }, (_, index) => 100 + index);
    const discovery = discoverWorkerProcessesForTokens([TOKEN], process.cwd(), candidates, {
      platform: 'darwin',
      executePs: (argv) => {
        calls.push([...argv]);
        return '';
      },
    });
    expect(discovery).toEqual({ processes: [], complete: true });
    expect(calls).toHaveLength(4);
    for (const argv of calls) {
      expect(argv).not.toContain('-ax');
      expect(argv).not.toContain('-A');
      const selected = argv[argv.indexOf('-p') + 1]!;
      expect(selected.split(',').length).toBeLessThanOrEqual(128);
    }
  });

  it('authenticates token, scope, PID, PGID, and start identity', () => {
    const scope = workerScopeValue(process.cwd());
    const command = processLine(202, 303, '/usr/bin/node worker.js');
    const environment = ` ULTRACODE_WORKER_TOKEN=${TOKEN} ULTRACODE_WORKER_SCOPE=${scope}`;
    const calls: string[][] = [];
    const discovery = discoverWorkerProcessesForTokens([TOKEN], process.cwd(), [202], {
      platform: 'darwin',
      executePs: (argv) => {
        calls.push([...argv]);
        return argv.includes('-E') ? `${command}${environment}` : command;
      },
    });
    expect(discovery).toEqual({
      complete: true,
      processes: [{ pid: 202, pgrp: 303, starttime: START_IDENTITY, token: TOKEN }],
    });
    expect(calls.every((argv) => argv.at(-2) === '-p' && argv.at(-1) === '202')).toBe(true);

    const changed = discoverWorkerProcessesForTokens([TOKEN], process.cwd(), [202], {
      platform: 'darwin',
      executePs: (argv) => argv.includes('-E')
        ? `${processLine(202, 303, '/usr/bin/node worker.js', 'Tue Jul 21 12:00:00 2026')}${environment}`
        : command,
    });
    expect(changed).toEqual({ processes: [], complete: false });

    const wrongToken = environment.replace(TOKEN, 'b'.repeat(32));
    expect(discoverWorkerProcessesForTokens([TOKEN], process.cwd(), [202], {
      platform: 'darwin',
      executePs: (argv) => argv.includes('-E') ? `${command}${wrongToken}` : command,
    }).processes).toEqual([]);
    const wrongScope = environment.replace(scope, 'c'.repeat(64));
    expect(discoverWorkerProcessesForTokens([TOKEN], process.cwd(), [202], {
      platform: 'darwin',
      executePs: (argv) => argv.includes('-E') ? `${command}${wrongScope}` : command,
    }).processes).toEqual([]);
    expect(discoverWorkerProcessesForTokens([TOKEN], process.cwd(), [202], {
      platform: 'darwin',
      executePs: (argv) => argv.includes('-E')
        ? `${processLine(202, 304, '/usr/bin/node worker.js')}${environment}`
        : command,
    })).toEqual({ processes: [], complete: false });
    expect(discoverWorkerProcessesForTokens([TOKEN], process.cwd(), [202], {
      platform: 'darwin',
      executePs: (argv) => {
        const other = processLine(203, 303, '/usr/bin/node worker.js');
        return argv.includes('-E') ? `${other}${environment}` : other;
      },
    })).toEqual({ processes: [], complete: false });
  });

  it('distinguishes explicit candidate absence from a ps failure', () => {
    const noSelection = Object.assign(new Error('ps selected no processes'), {
      status: 1,
      stdout: '',
    });
    expect(discoverWorkerProcessesForTokens([TOKEN], process.cwd(), [999], {
      platform: 'darwin',
      executePs: () => { throw noSelection; },
    })).toEqual({ processes: [], complete: true });
    expect(discoverWorkerProcessesForTokens([TOKEN], process.cwd(), [999], {
      platform: 'darwin',
      executePs: () => { throw new Error('ps unavailable'); },
    })).toEqual({ processes: [], complete: false });
  });

  it('never signals a reused PID or PGID', () => {
    const signaled: Array<[number, NodeJS.Signals | 0]> = [];
    const tracked = [{
      pid: 303,
      pgrp: 303,
      starttime: START_IDENTITY,
      token: TOKEN,
    }];
    const result = signalTrackedWorkerProcesses(tracked, 'SIGKILL', {
      platform: 'darwin',
      executePs: () => `303 303 Tue Jul 21 12:00:00 2026`,
      signalProcess: (pid, signal) => { signaled.push([pid, signal]); },
    });
    expect(result.processes).toBe(0);
    expect(signaled).toEqual([]);
  });
});
