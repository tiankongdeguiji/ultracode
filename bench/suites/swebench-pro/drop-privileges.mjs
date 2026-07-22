/** Drop the trusted bootstrap identity before executing any task-image program. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [uidText, gidText, command, ...args] = process.argv.slice(2);
const parseIdentity = (value, name) => {
  if (!/^[1-9][0-9]*$/u.test(value ?? '')) throw new Error(`invalid task ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new Error(`invalid task ${name}`);
  }
  return parsed;
};

const uid = parseIdentity(uidText, 'uid');
const gid = parseIdentity(gidText, 'gid');
if (command === undefined || process.getuid?.() !== 0 || process.getgid?.() !== 0) {
  throw new Error('privilege drop requires a root bootstrap and one command');
}

process.setgroups([]);
process.setgid(gid);
process.setuid(uid);
const groups = process.getgroups();
if (process.getuid() !== uid || process.geteuid() !== uid
  || process.getgid() !== gid || process.getegid() !== gid
  || groups.some((group) => group !== gid)) {
  throw new Error('task identity did not drop exactly');
}

const status = readFileSync('/proc/self/status', 'utf8');
for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) {
  if (!new RegExp(`^${field}:\\s+0+$`, 'mu').test(status)) {
    throw new Error(`task identity retained ${field}`);
  }
}
if (!/^NoNewPrivs:\s+1$/mu.test(status)) {
  throw new Error('task identity lacks no-new-privileges');
}

const environment = { ...process.env };
delete environment.LD_LIBRARY_PATH;
const child = spawn(command, args, { stdio: 'inherit', env: environment });
child.on('error', (error) => {
  process.stderr.write(`task command failed to start: ${error.message}\n`);
  process.exitCode = 127;
});
child.on('close', (code, signal) => {
  if (process.exitCode === 127) return;
  process.exitCode = code ?? (signal === null ? 1 : 128);
});
