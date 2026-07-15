import { readFileSync } from 'node:fs';
import { parseWorkflowScript } from '../engine/meta.js';
import { compileCheck } from '../engine/sandbox.js';
import { MetaValidationError } from '../engine/errors.js';

export interface ValidateReport {
  ok: boolean;
  error?: string;
  name?: string;
  description?: string;
  phaseTitles?: string[];
  callCounts?: Record<string, number>;
  agentCalls?: { line: number; promptHead?: string }[];
}

export function validateScript(source: string): ValidateReport {
  try {
    const parsed = parseWorkflowScript(source);
    compileCheck(parsed.body);
    const callCounts: Record<string, number> = {};
    for (const c of parsed.calls) callCounts[c.fn] = (callCounts[c.fn] ?? 0) + 1;
    return {
      ok: true,
      name: parsed.meta.name,
      description: parsed.meta.description,
      phaseTitles: parsed.phaseTitles,
      callCounts,
      agentCalls: parsed.calls
        .filter((c) => c.fn === 'agent')
        .map((c) => ({ line: c.line, promptHead: c.staticArg?.slice(0, 80) })),
    };
  } catch (err) {
    if (err instanceof MetaValidationError) return { ok: false, error: err.message };
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
}

export function runValidateCommand(file: string, opts: { json?: boolean }): number {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`ultracode: cannot read ${file}: ${(err as Error).message}\n`);
    return 1;
  }
  const report = validateScript(source);
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.ok ? 0 : 1;
  }
  if (!report.ok) {
    process.stderr.write(`✗ invalid workflow: ${report.error}\n`);
    return 1;
  }
  const lines = [
    `✓ ${report.name} — ${report.description}`,
    `  phases: ${report.phaseTitles!.length ? report.phaseTitles!.join(', ') : '(none declared)'}`,
    `  calls:  ${
      Object.entries(report.callCounts!)
        .map(([fn, n]) => `${fn}×${n}`)
        .join(', ') || '(none)'
    }`,
  ];
  for (const a of report.agentCalls!) {
    lines.push(`  agent L${a.line}: ${a.promptHead ?? '(dynamic prompt)'}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
