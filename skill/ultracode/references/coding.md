# Coding workflow guidance

These are decision principles, not a workflow template or acceptance checklist.
Do not target an agent count, phase count, task-category shape, or another
host's workflow. Derive the workflow from the task's unknowns, dependency edges,
mutation domains, and acceptance evidence. Add an agent only when it contributes
independent information, owns genuinely disjoint work, or validates a distinct
failure mode.

1. **Map work before assigning roles.** Separate genuinely different unknowns,
   mutation domains, shared prerequisites, integration points, and acceptance
   risks. A coherent local change may need only focused investigation, one
   mutation owner, and targeted verification. A partitionable rewrite may grow
   lanes with its components and dependencies. Task labels and prompt length
   alone do not justify either shape.
2. **Parallelize independence, not activity.** Read-only investigations may
   overlap freely when they seek different evidence. Give overlapping files or
   behavior one mutation owner; disjoint mutation lanes must name their paths
   and shared contracts, or use isolated worktrees when patches will be
   reconciled deliberately. Add barriers only for real dependencies. Use a
   pipeline only when several independent items share a repeated lifecycle and
   benefit from advancing at different rates. Make integration explicit when
   independent mutations must meet.
3. **Adapt from evidence within a finite frontier.** Review lenses should test
   credible, distinct failure hypotheses. Merge compatible findings directly;
   add adjudication only when evidence conflicts, crosses ownership boundaries,
   or controls a consequential decision. Dispatch repair only for confirmed
   blockers, scope it to an owner, and revalidate the affected contracts. Every
   data-dependent dispatch cycle needs a statically visible bound or finite
   worklist. Reserve engine retries for identified transient backend failures
   and fail closed on unresolved critical evidence.
4. **Keep constraints and handoffs decision-sized.** Pass requirements,
   protected boundaries, and source-of-truth locations to the agents that act
   on them. Use strict schemas for results consumed by control flow, not as
   ceremony for forwarded prose. Carry concise findings, evidence locations,
   coverage gaps, and unresolved failures forward instead of repeatedly
   serializing full reports. Preserve those gaps in the final result.

Static authoring comparisons can reveal recurring structures, but they do not
establish which structure solves tasks better. Treat another authored workflow
as a hypothesis, not a target. Promote a pattern into this guidance only when it
recurs across diverse task shapes, has a clear correctness rationale, and is
consistent with execution outcomes when they are available.
