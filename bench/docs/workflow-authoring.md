# Static workflow authoring

`workflow-authoring` compares the JavaScript that Codex and Claude Code author
for the same software-engineering tasks. It does not run workflows, workers,
task repositories, tests, or native verifiers, and its report has no score.

## Inputs

The tracked cohort contains 50 SWE-bench Pro tasks selected proportionally
across all 11 repositories, 10 FeatureBench tasks from 10 distinct
repositories, and five SWE-Marathon tasks covering model evaluation,
multi-component rewrite, compiler construction, service emulation, and GPU
kernel work. The deterministic selection seed and exact source revisions are
stored with the task IDs in `cohort.json`.

Prepare the prompt-only inputs without pulling task repositories, Docker
images, execution environments, or verifiers:

```bash
npm run bench -- --suite workflow-authoring prepare
```

Preparation verifies the exact Pro and FeatureBench parquet bytes and downloads
only the five Marathon instruction files from the pinned source commit. It
requires `python3` with `pyarrow` only to extract selected parquet rows. Gold
patches never enter model prompts; patch line/file counts are retained only as
report-side complexity context.

By default both hosts author every task once:

```bash
npm run bench -- --suite workflow-authoring generate \
  --run-id authoring-xhigh \
  --host both \
  --model gpt-5.6-sol \
  --effort xhigh \
  --concurrency 4
```

Use repeatable `--task-id <suite:id>` for a cohort subset. `--resume` accepts
only the exact frozen model, effort, host set, task order, cohort bytes,
prepared input bytes, Codex-guidance bytes, and host binary identities; already
completed artifacts are skipped. `--concurrency` controls only simultaneous
source-authoring processes and may change on resume.

## Non-execution boundary

Each host runs in a newly created empty temporary directory. Codex receives
`--ignore-user-config`, `--ignore-rules`, an ephemeral session, and a read-only
sandbox. Claude Code receives only its native Workflow tool, Plan permission,
an empty strict MCP configuration, and no persisted session.

The prompt explicitly permits source authoring only. The harness observes
JSONL stdout while the process is alive. A command, file change, MCP call,
web action, Claude `tool_use`, or Workflow invocation terminates the owned
process group and records an invalid artifact. No generated source is passed to
`ultracode validate`, `--dry-run`, a mock backend, or any workflow engine.

## Static metrics

The Acorn-based analysis reports:

- conservative minimum/maximum authored agent dispatches and retry-amplified
  attempts;
- phases, parallel barriers, pipelines, conditional branches, and bounded or
  dynamic loops;
- strict schemas on programmatically consumed results;
- conditional repairs, triage/adjudication roles, and fail-closed throws;
- repeated JSON serialization and task-constraint propagation proxies;
- overlapping parallel mutation without explicit ownership or worktree
  isolation.

Unknown dynamic cardinality is represented as a null upper bound, never as a
guessed number. The paired report preserves raw per-task deltas plus whole-cohort
and per-source-suite distributions rather than declaring agent or phase parity.
Agent count, stage count, and resemblance to one host are observations, not
acceptance criteria.

Interpretation should use the full multi-repository cohort, look for recurrent
patterns across different task shapes, and keep one-off structures as examples
rather than doctrine. Static authoring can identify control-flow and ownership
properties, but cannot establish that a workflow solves tasks better; promoting
a pattern into guidance requires a correctness rationale and, when available,
execution-outcome evidence.

```bash
npm run bench -- --suite workflow-authoring report --run-id authoring-xhigh
```

Live authoring consumes model tokens and remains manual. Default tests use fake
host CLIs and never contact a model.
