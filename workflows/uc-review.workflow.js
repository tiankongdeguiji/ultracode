// Portable across Claude Code (.claude/workflows), Qoder native (.qoder/workflows),
// and the ultracode engine. Budget shim: Qoder's `budget` global is stubbed —
// pass args.budgetTokens there.
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
const budgetTokens = (budget && budget.total) || (args && args.budgetTokens) || null

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
if (budgetTokens) log(`budget: ${budgetTokens} tokens`)

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
