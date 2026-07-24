# Coding workflow guidance

This guidance is deliberately not a template or an acceptance checklist. Do not
target an agent count, phase count, or another host's workflow shape. Start from
the task's work graph: unresolved questions, dependency order, mutation
ownership, and the evidence needed to accept the result. Add an agent only when
it contributes independent evidence, owns genuinely disjoint work, or validates
a meaningfully different failure mode.

1. **Follow the task's topology.** Explore only genuinely different unknowns,
   synthesize only when findings or requirements interact, and place barriers
   where dependencies require them. A coherent local change may need only
   focused investigation, one mutation owner, and targeted verification; a
   partitionable rewrite may benefit from a shared foundation, component
   pipelines, and explicit integration.
2. **Make ownership and data flow explicit.** Give overlapping files or
   behavior to one mutation owner. Parallelize disjoint components when their
   ownership is clear, or isolate patches when reconciliation is deliberate.
   Keep the integration step visible whenever independent mutations must meet.
3. **Spend redundancy on independent evidence.** Use distinct search or review
   lenses for credible failure modes instead of repeating interchangeable
   roles. Let findings trigger scoped repair and revalidation. Keep semantic
   recovery evidence-driven and bounded; reserve engine retries for identified
   transient backend failures and fail closed on unresolved critical evidence.
4. **Preserve constraints without bloating handoffs.** Pass requirements and
   source-of-truth locations to the agents responsible for them, use strict
   schemas only when control flow consumes a result, and forward concise
   findings rather than full repeated reports. Surface coverage cuts, failures,
   and unresolved validation in the final result.

Static authoring comparisons can reveal recurring structures, but they do not
establish which structure solves tasks better. Promote a pattern into this
guidance only when it recurs across diverse task shapes and has a clear
correctness rationale; use execution outcomes when they are available.
