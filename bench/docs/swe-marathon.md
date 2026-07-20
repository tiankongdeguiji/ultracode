# SWE-Marathon

SWE-Marathon is a suite-owned adapter around the upstream Harbor verifier. Its
native verifier is the only score authority; the benchmark control plane binds
the exact Harbor config and result bytes but never recomputes a reward.

## Pinned inputs

| Component | Pin |
| --- | --- |
| `abundant-ai/swe-marathon` | `6d6855af390226f6eca607d63818fe076e57ea8c` |
| Harbor | `0.17.1` |
| Python | `3.13.5` |

`prep` creates content-addressed inputs below `bench/.cache/swe-marathon/`.
It prepares the shared Codex/Node/Ultracode toolchain, checks out the exact
source revision, performs the frozen `uv` sync, applies the tracked Harbor
ownership-label patch, and pulls every runnable digest-pinned task image.

Runs use the common suite-qualified namespace (with `suite` equal to
`swe-marathon`):

```text
bench/results/<suite>/<runId>/
  manifest.json
  run-state.json
  verifier-receipt.json
  report.json
  report.md
  native/tasks/<artifactKey>/
```

One run contains one arm. Every selected task is one sequential native Harbor
job with one attempt and zero retries. `<runDir>/native/tasks` is passed as
Harbor's `--jobs-dir`; the collision-resistant artifact key is its job name.
Resume validates exact job fields before using Harbor's native `job resume`.
Redo invalidates that task's receipt bindings before resetting its job tree.

Before execution, common prepared inputs are re-attested once. Each task TOML
and Docker image identity is then re-attested immediately before that task is
launched, making the work linear in the number of tasks. Native agent and
verifier deadlines come from those attested task TOMLs and Harbor. The configured
`timeouts.taskMs` is only the outer Harbor process watchdog; an expiry is recorded
as `driver-watchdog`, not as a native verifier timeout.

## Arms and evidence

Arm A uses Harbor's built-in `codex` agent. Arm B uses
`bench/suites/swe-marathon/arm_b_codex.py`, the same exact prefix asset used by
other suites, and the read-only shared toolchain. The bridge chooses neither
model nor effort. It waits for detached workflows, preserves worker rollouts
and the run store, and writes only `arm_b_lifecycle.json`. Shared TypeScript
metrics code is the sole public token aggregator.

Reporting indexes only the manifest-declared job and its single direct-child
trial. It validates task, job, trial, arm, model, effort, one-attempt/no-retry
policy, and a finite reward in `[0,1]`. Identity-valid trial results whose exact
`exception_info.exception_type` is `VerifierTimeoutError` are bound as terminal
verifier-timeout evidence without synthesizing a reward. Nested lookalikes are
ignored. A task is resolved only when the native reward is exactly `1`.

The four CUA tasks without authoritative verifier results are not runnable:
`excel-clone`, `mastodon-clone`, `s3-clone`, and `slack-clone`. The
`find-network-alignments`, `kubernetes-rust-rewrite`, `nextjs-vite-rewrite`, and
`rust-java-lsp` cohort is post-hoc stress evidence, not a representative sample.

## Authentication and lifecycle

Choose the configured authentication mechanism on every run:

- `chatgpt`: set `CODEX_AUTH_JSON_PATH` to a current-user-owned regular file
  with mode `0600`.
- `api-key`: set `OPENAI_API_KEY`.

Credentials are copied or forwarded only into an ephemeral `0700` runtime home
and never enter argv, manifests, reports, or the persistent run directory.
Task code shares the credential's security domain, so use a disposable,
narrowly scoped account with restricted egress.

Harbor containers receive the complete benchmark ownership label tuple from
the pinned patch. Cleanup discovers containers by all labels, reinspects the
full tuple, and refuses to remove anything that does not match exactly.

```bash
npm run bench -- --suite swe-marathon prep

npm run bench -- --suite swe-marathon run --run-id marathon-a1 \
  --model <model> --effort <effort> --arm a \
  --task-id zstd-decoder

npm run bench -- --suite swe-marathon run --run-id marathon-a1 --resume
npm run bench -- --suite swe-marathon report --run-id marathon-a1
```

Arm A and Arm B comparisons use separate run IDs. Preparation and execution
require Linux x64 and a Linux amd64 Docker daemon. Native/live runs are manual
and are never part of the offline test suite.
