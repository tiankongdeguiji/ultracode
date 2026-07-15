/**
 * ultracode doctor: probe backends and report auth topology before any
 * tokens are spent.
 */
import { execFile } from 'node:child_process';
import { detectCodexAuth } from '../backends/codex-auth.js';
import { CodexAdapter } from '../backends/codex.js';

interface DoctorRow {
  backend: string;
  available: boolean;
  version?: string;
  auth: string;
  warnings: string[];
}

function probeBin(bin: string, args: string[] = ['--version']): Promise<{ ok: boolean; version?: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000 }, (err, stdout) => {
      if (err) resolve({ ok: false });
      else resolve({ ok: true, version: String(stdout).trim().split('\n')[0] });
    });
  });
}

export async function collectDoctorRows(): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];

  rows.push({ backend: 'mock', available: true, version: 'builtin', auth: 'n/a', warnings: [] });

  {
    const probe = await new CodexAdapter().probe();
    const mode = detectCodexAuth();
    const warnings = [...(probe.warnings ?? [])];
    rows.push({
      backend: 'codex',
      available: probe.available,
      version: probe.version,
      auth: mode,
      warnings: probe.available ? warnings : [probe.authHint ?? 'not installed'],
    });
  }

  for (const [backend, bin, authEnv] of [
    ['qoder', 'qodercli', 'QODER_PERSONAL_ACCESS_TOKEN'],
    ['claude', 'claude', ''],
    ['gemini', 'gemini', 'GEMINI_API_KEY'],
  ] as const) {
    const probe = await probeBin(bin);
    const auth = authEnv && process.env[authEnv] ? `${authEnv} set` : authEnv ? `${authEnv} unset` : 'cli-managed';
    const warnings: string[] = probe.ok ? [] : ['not installed (adapter will refuse)'];
    if (backend === 'qoder' && probe.ok) {
      // The native Workflow tool sits behind a remote feature gate that can
      // only be probed from a live session ("Workflow feature gate is
      // disabled."). Fallback when off: the ultracode MCP triad.
      warnings.push('native Workflow tool gate is remote — probe in a live session; MCP triad is the fallback');
      if (!process.env.QODER_PERSONAL_ACCESS_TOKEN) {
        warnings.push('a stored /login credential silently overrides env PATs — verify which account headless runs use');
      }
    }
    rows.push({ backend, available: probe.ok, version: probe.version, auth, warnings });
  }
  return rows;
}

export async function doctorCommand(opts: { json?: boolean }): Promise<number> {
  const rows = await collectDoctorRows();
  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  for (const r of rows) {
    const mark = r.available ? '✓' : '✗';
    process.stdout.write(`${mark} ${r.backend.padEnd(7)} ${(r.version ?? '-').padEnd(24)} auth: ${r.auth}\n`);
    for (const w of r.warnings) process.stdout.write(`    ⚠ ${w}\n`);
  }
  return 0;
}
