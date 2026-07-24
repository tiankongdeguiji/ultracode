# Coding workflow doctrine

Coding workflows optimize for exhaustive correctness. Scale is part of the contract: when Ultracode mode is armed, a substantive localized fix uses the same gated multi-stage shape as Claude Code native rather than collapsing to a solo implementation.

## Localized change: 12–18 agents

Use this exact bounded backbone for a local bug fix or small coherent change:

1. **Explore — 3 parallel, read-only agents.** Give them distinct lenses: implementation/data flow, tests/reproduction, and repository conventions/regression surface.
2. **Design — 1 agent.** Reconcile the three reports into one implementation contract, retaining every task requirement and naming the files/tests that are the source of truth.
3. **Implement — 1 mutation owner.** This agent owns every overlapping file. If it fails, catch the failure and dispatch **at most one** takeover agent that inspects the current working tree and completes the same contract. Do not set blanket `retries`.
4. **Review — up to 2 rounds.** Each round runs 3 independent, read-only reviewers in parallel: correctness/tests, requirements/interfaces, and regressions/maintainability. A separate triage agent consumes strict structured verdicts and returns `{ ready, blockingIssues }`.
5. **Repair — at most 1 agent.** Only after the first triage returns `ready: false`, dispatch one sequential repair owner with the concrete blocking issues, then perform the second review round. After a failed second triage, preserve the unresolved blockers for final fail-closed adjudication; do not start an unbounded loop.
6. **Final verification — 3 agents.** Run two read-only validators in parallel (targeted behavior and broader regression/constraint audit), then one final adjudicator. It may report success only when both validators pass and no second-round blockers remain.

The shortest successful path is `3 + 1 + 1 + 4 + 3 = 12` agents. The bounded recovery path adds one implementation takeover, a second four-agent review round, and one repair: `12 + 1 + 4 + 1 = 18`. Keep these bounds visible in the code; no dynamic or budget-driven loop belongs in this template.

Every result used for branching (`ready`, test status, blocking issues) gets a strict schema. Narrative reports that are only forwarded or returned do not need ceremonial schemas.

## Cross-module change

Retain the localized backbone and add domain lanes only for genuinely independent subsystems:

- survey agents identify boundaries and shared prerequisites;
- one sequential foundation owner establishes shared types/contracts first;
- each disjoint component gets an explicit path owner;
- component work uses `pipeline(components, implement, verify, conformance)` so a fast component advances without waiting for every sibling;
- integration mutation remains sequential after all component pipelines settle.

Never ask parallel agents to modify the same file set. If paths cannot be made disjoint, use one mutation owner; use worktree isolation only when independent patches will later be reconciled deliberately.

## Marathon-scale change

For a large rewrite, use:

1. global survey and dependency map;
2. sequential common/storage/public-contract foundation;
3. per-component `implement → verify → conformance` pipelines with exclusive directory ownership;
4. sequential integration and compile/test repair;
5. black-box conformance validators plus a completeness critic;
6. final adjudication that fails closed on missing components, altered protected interfaces, or unresolved tests.

Do not replace the component pipelines with one global sequence or with barrier-heavy parallel batches. Include all protected files, dependency restrictions, public interfaces, and verifier commands in every mutation-owner prompt that needs them.

## Retry and handoff discipline

- An engine `retries` option is reserved for a specifically identified transient backend failure. Code/test failure is semantic evidence and must flow through triage and conditional repair.
- A failed implementation takeover continues from the current tree; it does not blindly repeat the original prompt.
- Handoffs name source files and concise findings. Avoid repeatedly serializing the same full report into later prompts.
- Every early exit, omitted component, or unresolved validation is logged and included in the final result.
