# Invoking workflows per host

## Dispatch order

1. **Qoder native Workflow tool** (qodercli / Qoder IDE with the tool registered): invoke it directly, or install the script to `.qoder/workflows/<name>.js` and run by name. Native resume: `resumeFromRunId: "wf_..."`. Caveats: `budget` global is stubbed (`{total:null}`) — pass `args.budgetTokens` and gate manually; no per-call `effort` (define a subagent in `.qoder/agents/` with frontmatter `effort:` and use `agentType`); never name anything `Workflow`, `workflows`, or `deep-research`.
2. **ultracode MCP tools** (`workflow_start` / `workflow_status` / `workflow_result` / `workflow_stop` / `workflow_list`):
   - `workflow_start {script | scriptPath, backend, args?, budget?, resumeFromRunId?}` → returns `{runId}` in <1s. Fire-and-forget: the run survives you. **`backend` is required for a fresh start** (mock|codex|qoder|claude|gemini); `mock` returns fabricated stubs for rehearsal only, so always pass a real backend for real work. (Resume inherits the prior run's backend.)
   - Poll `workflow_status {runId, waitSeconds: 25, sinceEventOffset}` — long-poll; returns fresh log tail + `nextEventOffset`. **A timed-out poll is harmless: re-poll with the same runId.**
   - `workflow_result {runId}` when status is terminal → full output (result, failures, usage, artifact paths).
3. **Shell CLI**:
   ```bash
   ultracode validate my.workflow.js          # meta + dialect + compile check
   ultracode run my.workflow.js --dry-run     # free rehearsal on the mock backend
   ultracode run my.workflow.js --backend codex --yes [--budget <ONLY if the user specified one>] [--detach]
   ultracode status <runId> --watch | logs <runId> --follow | stop <runId>
   ultracode resume <runId> [--script edited.js]
   ultracode doctor                           # backend availability + auth safety table
   ```

## Backend notes (ultracode engine workers)

| backend | worker CLI | structured output | parallel-safe auth |
|---|---|---|---|
| codex | `codex exec --json` | native `--output-schema` (strict subset) | `CODEX_API_KEY` (ChatGPT OAuth → concurrency 1) |
| qoder | `qodercli --print` | native `--json-schema` (+ engine revalidation) | `QODER_PERSONAL_ACCESS_TOKEN` (beware stored /login creds) |
| claude | `claude -p` | native `--json-schema` | CLI-managed |
| gemini | `gemini -p` | emulated (prompt contract + validate/retry) | `GEMINI_API_KEY` |
| mock | built-in | schema-aware stubs | n/a — free, use for --dry-run |

## Workflow lifecycle discipline

- Always `validate` then `--dry-run` before spending tokens: dialect errors, cap misconfigurations, and schema mistakes surface for free.
- Long runs: `--detach`, then poll `status`. The run store (`.ultracode/runs/<runId>/`) holds `output.json`, `journal.jsonl`, `events.jsonl`, and per-agent `agents/<seq>-<label>/{prompt.md, result.json, transcript.jsonl}` — cite these paths when reporting. The dir name zero-pads seq to 4 and slugifies the label, e.g. `agents/0003-audit-src-foo-ts/`.
- On failure: read `output.json` `failures[]` first (every cap trip, declined action, and agent error lands there), then `resume` — completed agents replay free.
- Report faithfully: surface `failures[]` and warnings to the user even when the run "succeeded".
