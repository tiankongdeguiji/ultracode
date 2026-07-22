/** Verify Arm-B workflow process absence through the engine's hardened stop path. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readProcStat } from '/opt/bench/ultracode/dist/exec/procinfo.js';
import { isRunnerAlive, listRuns } from '/opt/bench/ultracode/dist/store/runstore.js';
import { isResumableStatus } from '/opt/bench/ultracode/dist/store/manifest.js';

const home = process.env.ULTRACODE_HOME;
const waitSeconds = Number(process.env.MARATHON_WAIT_SECONDS);
const runnerEntry = '/opt/bench/ultracode/dist/cli/main.js';
if (!home || !Number.isSafeInteger(waitSeconds) || waitSeconds < 1) {
  process.stderr.write('Arm B settlement environment is invalid\n');
  process.exit(1);
}

const waitDeadline = Date.now() + waitSeconds * 1_000;
const stopDeadline = () => Date.now() + 120_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function runIds() {
  const runs = join(home, 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function observed() {
  const summaries = new Map(listRuns(home).map((run) => [run.runId, run]));
  return runIds().map((runId) => summaries.get(runId) ?? { runId, effectiveStatus: 'invalid' });
}

function runnerProcesses() {
  const expectedDirectories = new Set(runIds().map((runId) => join(home, 'runs', runId)));
  return readdirSync('/proc', { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) return [];
    const pid = Number(entry.name);
    try {
      const argv = readFileSync(`/proc/${entry.name}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      const runner = argv.indexOf('__runner');
      const option = argv.indexOf('--run-dir', runner + 1);
      const stat = readProcStat(pid);
      return argv.includes(runnerEntry) && runner !== -1 && option !== -1
        && expectedDirectories.has(argv[option + 1] ?? '') && stat
        ? [{ pid, starttime: stat.starttime }]
        : [];
    } catch {
      return [];
    }
  });
}

function runnerAlive(runner) {
  return readProcStat(runner.pid)?.starttime === runner.starttime;
}

async function terminateRunners(deadline) {
  while (Date.now() < deadline) {
    const runners = runnerProcesses();
    if (runners.length === 0) return true;
    for (const runner of runners) {
      if (runnerAlive(runner)) {
        try { process.kill(runner.pid, 'SIGTERM'); } catch { /* raced */ }
      }
    }
    const gracefulDeadline = Math.min(deadline, Date.now() + 7_000);
    while (runners.some(runnerAlive) && Date.now() < gracefulDeadline) await sleep(100);
    for (const runner of runners) {
      if (runnerAlive(runner)) {
        try { process.kill(runner.pid, 'SIGKILL'); } catch { /* raced */ }
      }
    }
    await sleep(100);
  }
  return runnerProcesses().length === 0;
}

function naturallySettled(runs) {
  return runs.length > 0 && runs.every((run) => run.manifest !== undefined
    && isResumableStatus(run.effectiveStatus) && !isRunnerAlive(run.manifest));
}

function requiresImmediateStop(runs) {
  return runs.some((run) => run.manifest === undefined
    || ['orphaned', 'cleanup-failed'].includes(run.effectiveStatus)
    || (isResumableStatus(run.effectiveStatus) && isRunnerAlive(run.manifest)));
}

function stop(runId, deadline) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ runId, ok });
    };
    const child = spawn(
      '/opt/bench/node-sel',
      ['/opt/bench/ultracode/dist/cli/main.js', 'stop', runId],
      { stdio: 'inherit', env: { ...process.env, ULTRACODE_HOME: home } },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, Math.max(1, Math.min(30_000, deadline - Date.now())));
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}

let runs = observed();
if (runs.length === 0) {
  process.stderr.write('Arm B did not start an ultracode run\n');
  process.exit(1);
}

let clean = naturallySettled(runs);
while (!clean && !requiresImmediateStop(runs) && Date.now() < waitDeadline) {
  await sleep(5_000);
  runs = observed();
  clean = naturallySettled(runs);
}

const deadline = stopDeadline();
if (runnerProcesses().length > 0) clean = false;
if (!await terminateRunners(deadline)) {
  process.stderr.write('Arm B could not terminate authenticated workflow runners\n');
  process.exit(1);
}
const verified = new Set();
while (Date.now() < deadline) {
  const ids = runIds();
  const pending = ids.filter((runId) => !verified.has(runId));
  if (pending.length === 0) {
    await sleep(100);
    if (runIds().every((runId) => verified.has(runId))) break;
    continue;
  }
  const results = await Promise.all(pending.map((runId) => stop(runId, deadline)));
  if (results.some((result) => !result.ok)) {
    process.stderr.write('Arm B could not verify workflow worker-group cleanup\n');
    process.exit(1);
  }
  for (const result of results) verified.add(result.runId);
}

runs = observed();
const absenceVerified = runs.length > 0
  && runs.every((run) => verified.has(run.runId) && run.manifest !== undefined
    && isResumableStatus(run.effectiveStatus) && !isRunnerAlive(run.manifest))
  && runnerProcesses().length === 0;
if (!absenceVerified || runIds().some((runId) => !verified.has(runId))) {
  process.stderr.write('Arm B could not verify workflow process absence\n');
  process.exit(1);
}

process.exit(clean ? 0 : 2);
