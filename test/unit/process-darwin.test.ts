/** Deterministic macOS process-discovery and identity-signaling seams. */
import { describe, expect, it } from 'vitest';
import {
  discoverWorkerProcessesForTokens,
  MAX_DARWIN_CANDIDATE_PROCESSES,
  readProcessIdentitySnapshot,
  signalTrackedWorkerProcesses,
  workerScopeValue,
} from '../../src/exec/procinfo.js';

const TOKEN = 'a'.repeat(32);
const STARTED = 'Mon Jul 20 12:00:00 2026';
const START_IDENTITY = 'darwin:Mon_Jul_20_12:00:00_2026';

function processLine(pid: number, pgrp: number, command: string): string {
  return `${pid} ${pgrp} ${STARTED} ${command}`;
}

describe('Darwin worker process discovery', () => {
  it('authenticates a fixed host inventory containing a setsid descendant', () => {
    const scope = workerScopeValue(process.cwd());
    const commands = [
      processLine(101, 101, '/usr/bin/node worker.js'),
      processLine(202, 202, '/usr/bin/node escaped.js'),
    ].join('\n');
    const environment = ` ULTRACODE_WORKER_TOKEN=${TOKEN} ULTRACODE_WORKER_SCOPE=${scope}`;
    const discovery = discoverWorkerProcessesForTokens(
      [TOKEN],
      process.cwd(),
      undefined,
      {
        platform: 'darwin',
        executePs: (argv) => {
          if (argv.join(' ') === '-ax -o pid=') return '101\n202\n';
          return argv.includes('-E')
            ? commands.split('\n').map((line) => `${line}${environment}`).join('\n')
            : commands;
        },
      },
    );
    expect(discovery).toEqual({
      complete: true,
      processes: [
        { pid: 101, pgrp: 101, starttime: START_IDENTITY, token: TOKEN },
        { pid: 202, pgrp: 202, starttime: START_IDENTITY, token: TOKEN },
      ],
    });
  });

  it('does not compare transient pids from separate host-wide ps processes', () => {
    const scope = workerScopeValue(process.cwd());
    const command = processLine(101, 101, '/usr/bin/node worker.js');
    const marker = ` ULTRACODE_WORKER_TOKEN=${TOKEN} ULTRACODE_WORKER_SCOPE=${scope}`;
    const discovery = discoverWorkerProcessesForTokens([TOKEN], process.cwd(), undefined, {
      platform: 'darwin',
      executePs: (argv) => {
        if (argv.join(' ') === '-ax -o pid=') return '1\n101\n999\n';
        expect(argv.includes('-ax')).toBe(false);
        expect(argv.at(-1)).toBe('101,999');
        return argv.includes('-E') ? `${command}${marker}` : command;
      },
    });
    expect(discovery).toEqual({
      complete: true,
      processes: [{ pid: 101, pgrp: 101, starttime: START_IDENTITY, token: TOKEN }],
    });
  });

  it('distinguishes verified candidate absence from a ps failure', () => {
    const absent = discoverWorkerProcessesForTokens(
      [TOKEN],
      process.cwd(),
      [999],
      { platform: 'darwin', executePs: () => '' },
    );
    expect(absent).toEqual({ processes: [], complete: true });

    const noSelection = Object.assign(new Error('ps selected no processes'), {
      status: 1,
      stdout: '',
    });
    expect(discoverWorkerProcessesForTokens(
      [TOKEN],
      process.cwd(),
      [999],
      { platform: 'darwin', executePs: () => { throw noSelection; } },
    )).toEqual({ processes: [], complete: true });
    expect(readProcessIdentitySnapshot([999], {
      platform: 'darwin',
      executePs: () => { throw noSelection; },
    })).toEqual({ identities: new Map(), complete: true });

    const failed = discoverWorkerProcessesForTokens(
      [TOKEN],
      process.cwd(),
      [999],
      {
        platform: 'darwin',
        executePs: () => { throw new Error('ps unavailable'); },
      },
    );
    expect(failed).toEqual({ processes: [], complete: false });
  });

  it('splits an overflowing host-inventory batch', () => {
    const scope = workerScopeValue(process.cwd());
    const commands = [
      processLine(101, 101, '/usr/bin/node worker.js'),
      processLine(202, 202, '/usr/bin/node escaped.js'),
    ].join('\n');
    const marker = ` ULTRACODE_WORKER_TOKEN=${TOKEN} ULTRACODE_WORKER_SCOPE=${scope}`;
    const discovery = discoverWorkerProcessesForTokens([TOKEN], process.cwd(), undefined, {
      platform: 'darwin',
      executePs: (argv) => {
        if (argv.join(' ') === '-ax -o pid=') return '101\n202\n';
        const selected = argv.at(-1);
        if (selected === '101,202') throw new Error('stdout maxBuffer length exceeded');
        const command = selected === '101' ? commands.split('\n')[0]! : commands.split('\n')[1]!;
        return argv.includes('-E') ? `${command}${marker}` : command;
      },
    });
    expect(discovery).toEqual({
      complete: true,
      processes: [
        { pid: 101, pgrp: 101, starttime: START_IDENTITY, token: TOKEN },
        { pid: 202, pgrp: 202, starttime: START_IDENTITY, token: TOKEN },
      ],
    });
  });

  it('ignores non-actionable system pids in a host inventory', () => {
    const scope = workerScopeValue(process.cwd());
    const command = processLine(101, 101, '/usr/bin/node worker.js');
    const marker = ` ULTRACODE_WORKER_TOKEN=${TOKEN} ULTRACODE_WORKER_SCOPE=${scope}`;
    const discovery = discoverWorkerProcessesForTokens([TOKEN], process.cwd(), undefined, {
      platform: 'darwin',
      executePs: (argv) => {
        if (argv.join(' ') === '-ax -o pid=') return '0\n1\n101\n';
        expect(argv.at(-1)).toBe('101');
        return argv.includes('-E') ? `${command}${marker}` : command;
      },
    });
    expect(discovery).toEqual({
      complete: true,
      processes: [{ pid: 101, pgrp: 101, starttime: START_IDENTITY, token: TOKEN }],
    });
  });

  it('fails closed when an authenticated host inventory exceeds its bound', () => {
    const pids = Array.from(
      { length: MAX_DARWIN_CANDIDATE_PROCESSES + 1 },
      (_, index) => String(10_000 + index),
    );
    const discovery = discoverWorkerProcessesForTokens(
      [TOKEN],
      process.cwd(),
      undefined,
      {
        platform: 'darwin',
        executePs: (argv) => {
          expect(argv.join(' ')).toBe('-ax -o pid=');
          return pids.join('\n');
        },
      },
    );
    expect(discovery).toEqual({ processes: [], complete: false });
  });

  it('splits bounded candidate batches but keeps an unsplittable ps overflow incomplete', () => {
    let queries = 0;
    const discovery = discoverWorkerProcessesForTokens(
      [TOKEN],
      process.cwd(),
      [101, 202],
      {
        platform: 'darwin',
        executePs: () => {
          queries++;
          throw new Error('stdout maxBuffer length exceeded');
        },
      },
    );
    expect(discovery).toEqual({ processes: [], complete: false });
    expect(queries).toBe(6);
  });

  it('does not signal a reused PID and group-signals an exact session leader', () => {
    const signaled: Array<[number, NodeJS.Signals | 0]> = [];
    const tracked = [{
      pid: 303,
      pgrp: 303,
      starttime: START_IDENTITY,
      token: TOKEN,
    }];
    const reused = signalTrackedWorkerProcesses(tracked, 'SIGKILL', {
      platform: 'darwin',
      executePs: () => `303 303 Tue Jul 21 12:00:00 2026`,
      signalProcess: (pid, signal) => { signaled.push([pid, signal]); },
    });
    expect(reused.processes).toBe(0);
    expect(signaled).toEqual([]);

    const matched = signalTrackedWorkerProcesses(tracked, 'SIGTERM', {
      platform: 'darwin',
      executePs: () => `303 303 ${STARTED}`,
      signalProcess: (pid, signal) => { signaled.push([pid, signal]); },
    });
    expect(matched.processes).toBe(1);
    expect(signaled).toEqual([[-303, 'SIGTERM']]);
  });
});
