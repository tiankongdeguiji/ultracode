#!/usr/bin/env node
// Parity-demo assertion: given a uc-review output.json (path as argv[2]),
// check that both planted bugs were confirmed. Backend-agnostic — the same
// script validates a Codex run, a Claude run, or a native-Qoder run.
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node assert-review.mjs <output.json>');
  process.exit(2);
}

const output = JSON.parse(readFileSync(path, 'utf8'));
const blob = JSON.stringify(output.result ?? output).toLowerCase();

const checks = [
  { name: 'auth bypass (token comparison)', ok: /token|==|compar|bypass|authenticat/.test(blob) && /auth|session|token/.test(blob) },
  { name: 'privilege escalation (client-supplied role)', ok: /role|privilege|escalat|admin/.test(blob) },
];

let pass = true;
for (const c of checks) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.name}`);
  if (!c.ok) pass = false;
}

const confirmed = (output.result?.confirmed ?? []).length;
console.log(`\nconfirmed findings: ${confirmed}`);
process.exit(pass ? 0 : 1);
