// Portable across Claude Code (.claude/workflows), Qoder native (.qoder/workflows),
// and the ultracode engine. Budget note: the engine enforces budget.total at the
// dispatch gate on codex/claude; on Qoder native `budget` is stubbed, so
// args.budgetTokens is ADVISORY (logged, not enforced — the dialect can't observe
// per-agent spend here).
export const meta = {
  name: 'uc-review',
  description: 'Multi-perspective code review: parallel finders per dimension, adversarial verification per finding, synthesized report',
  whenToUse: 'Reviewing a diff, branch, or subsystem for real bugs with low false-positive tolerance',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Synthesize' }],
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'what to review: a path, diff spec, or subsystem description' },
      focus: { type: 'string' },
      budgetTokens: { type: 'number' },
    },
    required: ['target'],
  },
}

const target = args.target
const focus = (args && args.focus) || 'correctness bugs, security issues, and broken edge cases'
// On codex/claude the engine sets budget.total and ENFORCES it at the dispatch
// gate. On Qoder native the `budget` global is stubbed, so args.budgetTokens is
// ADVISORY only — this template can't observe per-agent spend to self-gate.
const engineBudget = (budget && budget.total) || null
const advisoryBudget = (args && args.budgetTokens) || null

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          detail: { type: 'string', description: 'what is wrong and the concrete failure scenario' },
        },
        required: ['title', 'file', 'detail'],
      },
    },
  },
  required: ['findings'],
}
const VERDICT = {
  type: 'object',
  properties: { real: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['real', 'reason'],
}

phase('Find')
const dimensions = [
  'logic and correctness',
  'security and input validation',
  'error handling and edge cases',
]
const found = await parallel(
  dimensions.map((dim) => () =>
    agent(
      `You are one code reviewer among several working independently; be fully self-contained. ` +
        `Review ${target} in the repository you are running in, focusing ONLY on ${dim} ` +
        `(overall focus: ${focus}). Read the relevant code with your tools before claiming anything. ` +
        `Report only concrete, evidenced findings with exact file paths — no style nits, no speculation.`,
      { label: 'find:' + dim.split(' ')[0], schema: FINDINGS, phase: 'Find' },
    ),
  ),
)

const findings = found.filter(Boolean).flatMap((r) => r.findings)
log(`${findings.length} candidate finding(s) across ${dimensions.length} dimensions`)
if (engineBudget) log(`budget: ${engineBudget} tokens (engine-enforced)`)
else if (advisoryBudget) log(`budget: ${advisoryBudget} tokens (ADVISORY — not enforced on this backend)`)

phase('Verify')
const verified = await pipeline(
  findings,
  (f, item, i) =>
    agent(
      `Adversarially verify this code-review finding — actively try to REFUTE it. ` +
        `Read ${f.file} yourself with your tools. Default to real=false when uncertain. ` +
        `Finding: ${JSON.stringify(f)}`,
      { label: 'verify:' + i, schema: VERDICT, phase: 'Verify' },
    ),
  (verdict, f) => (verdict && verdict.real ? { title: f.title, file: f.file, detail: f.detail, verifierReason: verdict.reason } : null),
)

const confirmed = verified.filter(Boolean)
log(`${confirmed.length}/${findings.length} finding(s) survived adversarial verification`)

phase('Synthesize')
const report =
  confirmed.length === 0
    ? 'No findings survived adversarial verification.'
    : await agent(
        `Write a concise markdown review report from these CONFIRMED findings (already independently verified): ` +
          `${JSON.stringify(confirmed)}. Group by file. State each finding plainly with its evidence. No hedging.`,
        { label: 'report', phase: 'Synthesize' },
      )

return { confirmed, candidates: findings.length, report }
