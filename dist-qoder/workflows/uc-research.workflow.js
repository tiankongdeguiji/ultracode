// Portable repository-research workflow: multi-angle exploration, cited synthesis.
export const meta = {
  name: 'uc-research',
  description: 'Parallel repository research: independent multi-angle exploration, then one cited synthesis',
  whenToUse: 'Answering a nontrivial question about a codebase that needs evidence from several places',
  phases: [{ title: 'Explore' }, { title: 'Synthesize' }],
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string' }, budgetTokens: { type: 'number' } },
    required: ['question'],
  },
}

const q = args.question
// budgetTokens is ADVISORY here: the engine enforces budget.total on codex/claude,
// but this template does not self-gate (the dialect can't observe per-agent spend).
const advisoryBudget = (budget && budget.total) || (args && args.budgetTokens) || null
if (advisoryBudget && !(budget && budget.total)) {
  log(`budget: ${advisoryBudget} tokens (ADVISORY — not enforced on this backend)`)
}

phase('Explore')
const angles = [
  'file and directory structure, entry points, and build configuration',
  'implementation details and data flow of the code most relevant to the question',
  'tests, fixtures, and documentation (including comments and READMEs)',
]
const notes = (
  await parallel(
    angles.map((angle) => () =>
      agent(
        `Research this question about the repository you are running in: "${q}". ` +
          `Investigate via ${angle} ONLY — other agents cover the rest. ` +
          `Cite an exact file path for every claim. Work standalone; report dense factual notes, not prose.`,
        { label: angle.split(' ')[0], phase: 'Explore' },
      ),
    ),
  )
).filter(Boolean)

log(`${notes.length}/${angles.length} exploration notes collected`)

phase('Synthesize')
const answer = await agent(
  `Synthesize ONE authoritative answer to: "${q}" from the following independent research notes. ` +
    `Discard any claim lacking a file citation; where notes disagree, say so explicitly.\n\n` +
    notes.map((n, i) => `--- note ${i} ---\n${n}`).join('\n'),
  { label: 'synthesize', phase: 'Synthesize' },
)

return { answer, notesUsed: notes.length }
