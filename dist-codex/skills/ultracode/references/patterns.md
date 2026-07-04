# Quality patterns

These are prompt-level structures, not engine features. They are what makes an orchestrated run *better* than a solo one, not just bigger. Compose freely; invent new shapes when the task calls for it (tournament brackets, staged escalation, self-repair loops).

## Adversarial verify

Spawn N independent skeptics per finding, each prompted to **REFUTE** it. Kill the finding if a majority refutes. Prevents plausible-but-wrong findings from surviving.

```js
const votes = await parallel([1, 2, 3].map((i) => () =>
  agent(`Try to REFUTE this claim about ${repoFacts}: "${claim}". Default to refuted=true if uncertain. You are skeptic #${i}; be independent.`,
    { schema: { type: 'object', properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } }, required: ['refuted', 'reason'] } })))
const survives = votes.filter(Boolean).filter((v) => !v.refuted).length >= 2
```

## Perspective-diverse verify

When a finding can fail in more than one way, give each verifier a distinct lens instead of N identical refuters — diversity catches failure modes redundancy can't.

```js
const lenses = ['correctness', 'security', 'does-it-reproduce']
const verdicts = await parallel(lenses.map((lens) => () =>
  agent(`Judge via the ${lens} lens only: is "${finding}" real? Facts: ${context}`, { schema: VERDICT })))
```

## Judge panel

Generate N independent attempts from different angles (MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.

## Loop-until-dry

For unknown-size discovery (bugs, edge cases, references), keep spawning finders until K consecutive rounds return nothing new. Simple `while (count < N)` misses the tail. **Dedup vs `seen`, not vs `confirmed`** — otherwise judge-rejected findings reappear every round and the loop never converges.

## Multi-modal sweep

Parallel agents each searching a DIFFERENT way (by-file, by-symbol, by-history, by-content, by-convention). Each is blind to the others; one search angle never finds everything.

## Completeness critic

A final agent that asks "what's missing — file not read, claim unverified, modality not run?" What it finds becomes the next round of work. Cheap and catches whole categories of gaps.

## Loop-until-budget

Scale depth to the user's budget directive. Guard on `budget.total` — with no target, `remaining()` is `Infinity` and the loop runs to the agent cap.

```js
const found = []
while (budget.total && budget.remaining() > 50_000) {
  const r = await agent('Find more issues not in: ' + JSON.stringify(found.map((f) => f.key)), { schema: FINDINGS })
  if (!r.items.length) break
  found.push(...r.items)
  log(`${found.length} found, ${Math.round(budget.remaining() / 1000)}k tokens left`)
}
```

## No silent caps

If the workflow bounds coverage (top-N, sampling, early exit), `log()` what was dropped. Silent truncation reads as "covered everything" when it didn't.

## Scale doctrine

| Ask | Shape |
|---|---|
| "find any bugs" | 2–3 finders, single-vote verify |
| "review this change" | dimension-split finders → adversarial verify per finding |
| "thoroughly audit / be comprehensive" | large finder pool, loop-until-dry, 3–5-vote adversarial pass, synthesis + completeness critic |
| "+500k" etc. | loop-until-budget; fleet-size = budget / ~100k per agent |
