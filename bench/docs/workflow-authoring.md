# Static workflow authoring

`workflow-authoring` compares the JavaScript that Codex and Claude Code author
for the same software-engineering tasks. It does not run workflows, workers,
task repositories, tests, or native verifiers, and its report has no score.

## Inputs

The tracked cohort contains the 20 SWE-bench Pro tasks used by the original
`gpt-5.6-sol` / `xhigh` pilot plus the SWE-Marathon
`kubernetes-rust-rewrite` task. Run the normal Pro `fetch` and Marathon `prep`
commands first; authoring reads only their pinned task statements. Gold patches
never enter model prompts. Pro gold patch line/file counts are retained only as
report-side complexity context.

By default both hosts author every task once:

```bash
npm run bench -- --suite workflow-authoring generate \
  --run-id authoring-xhigh \
  --host both \
  --model gpt-5.6-sol \
  --effort xhigh
```

Use repeatable `--task-id <suite:id>` for a cohort subset. `--resume` accepts
only the exact frozen model, effort, host set, task order, cohort bytes,
Codex-doctrine bytes, and host binary identities; already completed artifacts
are skipped.

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
guessed number. The paired report considers minimum and maximum agent counts
matched when Codex is within `max(2, 20%)` of Claude, and phase calls matched
within one. These are descriptive structural proxies, not quality or success
claims.

```bash
npm run bench -- --suite workflow-authoring report --run-id authoring-xhigh
```

Live authoring consumes model tokens and remains manual. Default tests use fake
host CLIs and never contact a model.
