# FeatureBench

FeatureBench is a suite-owned adapter around pinned upstream `fb infer` and
`fb eval`. The official evaluator remains the sole score authority; the common
benchmark control plane binds its exact native outputs and does not substitute
another grader.

## Pinned inputs and runtime

| Component | Pin |
| --- | --- |
| FeatureBench source | `445dcbaec0b2e136061b0acb54e753c0a9f1888e` |
| `LiberCoders/FeatureBench` dataset | `e99d6efdfe511ea832c1b5735c536129561ec96a` |
| Split | `fast` |
| Python | `3.13.5` |
| Attempts / adapter retries | `1` / `0` |
| Runtime | Linux x64, CPU only |

`prep` checks out the exact source revision, verifies and applies
`bench/suites/featurebench/codex-chatgpt.patch`, performs a frozen,
configuration-isolated `uv sync` with copied packages and managed Python,
pulls the pinned split, and writes the complete task-to-image map inside Git
metadata. Preparation verifies the exact pinned parquet bytes, retains that
artifact in the content-addressed input, and both inference and evaluation load
only the retained local copy. Every image is resolved to one repository digest
and local image ID.
The prepared source, environment, patch, dataset map, task inventory, images,
and common toolchain are content-addressed and re-attested before native work.
Python bytecode caches are removed and forbidden in published inputs. The
external managed-Python base runtime is hashed in full, and environment links
may resolve only within the publication or that re-attested runtime.

The patch preserves upstream inference and evaluation while adding the
experiment controls: digest-pinned images, CPU and memory limits, CPU-only
rejection, the credential-broker network, copied Codex telemetry, benchmark
ownership labels, and the canonical Arm B prompt prefix and toolchain mount.
Arm A receives the upstream task text verbatim.

## Credential and network boundary

The operator provisions a broker container and dedicated Docker network before
`run`. The adapter neither creates the broker nor stores its credential.

- `FEATUREBENCH_CREDENTIAL_BROKER_URL` is an absolute HTTPS URL without
  userinfo, query, or fragment. Its hostname is the broker container name.
- `FEATUREBENCH_RESTRICTED_NETWORK` names a Docker `--internal` network labeled
  `ultracode.egress-policy=openai-via-credential-broker`.
- Before each native phase, the network must have exactly one endpoint: the
  named, running broker container. The broker must have immutable image identity
  and these exact labels: `ultracode.credential-broker=true`,
  `ultracode.credential-broker.identity=<featureBench.broker.publicIdentity>`,
  and `ultracode.credential-broker.version=<featureBench.broker.publicVersion>`.
- Official evaluator containers use Docker's `none` network and attest that
  mode immediately after creation; they receive the same pinned image, CPU,
  memory, PID-limit, CPU-only, and ownership policy as inference containers.
- Reusable host credentials and auth files are never mounted or forwarded to
  repository-controlled task containers. The broker is responsible for its
  own upstream egress, credential injection, scoping, and request validation.

Only hashes of the public broker identity, public version, runtime
configuration, and restricted-network policy enter host-owned manifests and
receipts. Runtime URL and Docker names also enter a private `0600` temporary
config that is removed after execution. Copied native Codex and Ultracode
telemetry is untrusted, potentially retains those runtime identifiers, and
must be handled as sensitive. The containing `0700` runtime home has an exact
run/arm/nonce marker; the next run removes matching hard-crash orphans before
writing a new runtime config and refuses malformed lookalikes.

One UID-scoped policy lock below `/tmp/ultracode-bench-<uid>/.locks/` covers
preflight, inference, evaluation, and cleanup across separate worktrees. This
prevents concurrent FeatureBench runs from invalidating the broker-only
host-wide network assertion. Cleanup discovers
containers using the complete `ultracode.benchmark.*` ownership tuple,
reinspects every label including task and purpose, and refuses ambiguous or
unowned targets.

## Lifecycle and artifacts

```bash
npm run bench -- --suite featurebench prep

FEATUREBENCH_CREDENTIAL_BROKER_URL=https://broker.internal/v1 \
FEATUREBENCH_RESTRICTED_NETWORK=featurebench-private \
npm run bench -- --suite featurebench run --run-id feature-a1 \
  --model <model> --effort <effort> --arm a \
  --task-id <task> [--task-id <task> ...]

npm run bench -- --suite featurebench report --run-id feature-a1
```

The operator config in `bench/bench.config.json` supplies the complete run
configuration. On a fresh run, the only configuration values that the CLI can
override are `--model`, `--effort`, `--arm`, and repeatable `--task-id`. Public
broker identity/version, inference and evaluation concurrency, timeouts, CPU,
memory, and PID resources, and optional model pricing are config-only; the CLI has
no flags for them.

The fresh run resolves config plus those four optional overrides, validates the
result, and freezes it in the immutable manifest. Concurrency, timeouts, and
resources are frozen directly; broker identity/version and pricing are frozen
as public hashes or a pricing snapshot. Resume reconstructs the effective run
configuration from that manifest and rejects conflicting CLI overrides. The
operator's current public broker identity/version must still match the frozen
hashes, while runtime broker URL and network names are resolved anew from the
environment and re-attested on every launch. `--redo <task-id>` requires
`--resume` plus a non-null state-bound inference baseline. The baseline check
precedes receipt/report invalidation. The native inference timeout remains a
per-task limit, while the host watchdog scales it by the number of concurrency
waves and adds Arm B workflow-drain plus cleanup grace.
Ordinary resume targets the first
non-null inference root with native `--resume`; null-only history retries the
complete immutable task set fresh only while `native/` has no timestamp root.
Any timestamp root absent from inference state is ambiguous and rejected. Redo
runs a new timestamped native inference while preserving that first baseline,
then evaluates a complete prediction set whose selected tasks must come from
the new root and whose untouched tasks come only from immutable, receipt-bound
prediction snapshots accepted by an earlier successful evaluation. A redo
invalidation removes task evidence only for its selected tasks and removes the
run aggregate. Untouched bindings remain valid until complete replacement
evidence is published, including after an evaluator timeout or crash. If
inference or evaluation preparation fails before the evaluator child launches,
no verifier attempt is recorded and accepted task evidence for untouched tasks
remains eligible for task-level reporting.
Each consolidated snapshot has an invocation-unique filename inside the
current timestamp root. This keeps accepted inputs immutable while preserving
the upstream evaluator's contract that reports are emitted beside its
predictions file.

Every run uses the common suite-qualified layout (with `suite` equal to
`featurebench`):

```text
bench/results/<suite>/<runId>/
  manifest.json
  run-state.json
  verifier-receipt.json
  report.json
  report.md
  native/
    <YYYY-MM-DD__HH-MM-SS>/
      run_metadata.json
      output.jsonl
      consolidated-output-<invocation-id>.jsonl
      eval_outputs/<task>/attempt-1/report.json
      report.json
    invocations/<invocation-id>/
      fb-eval.json
      prior-eval/...
```

The upstream timestamp directory is discovered only after `fb infer` creates
exactly one new native directory, then recorded in host-owned run state. Resume,
telemetry, verification, and reporting use only state-bound timestamp roots;
they do not recursively discover lookalike output elsewhere.

The verifier receipt binds the timestamped `run_metadata.json`, prediction
JSONL, each task report, each official completion marker, the exact `fb eval`
input and invocation record, and the run-level `attempt_1` aggregate. Missing,
malformed, symlinked, escaped, or later-mutated evidence remains unverified.
Task disposition requires the complete receipt chain for that task and its
evaluation invocation, but does not require the run aggregate. The aggregate
headline is published only when its invocation has a complete, same-root
receipt for every immutable task. Accepted snapshots and report evidence are
re-hashed before reuse, so changed prediction inputs, evaluation invocations,
metadata, rollout output, or reports fail closed.

## Score semantics

FeatureBench has two distinct official quantities:

- A task's common-envelope `score` is its official `pass_rate`; its `resolved`
  field preserves the separate official boolean.
- The native run headline is `attempt_1.pass_rate`. `attempt_1.resolved_rate`
  is reported separately. The mean of bound task pass rates is only a
  consistency check, and policy-adjusted values have separate names.

The common normalized metrics implementation reads copied Codex rollouts and
Ultracode workflow artifacts from manifest tasks under state-bound native
attempt roots. Host/worker roles, billability, tokens, cost, context pressure,
timings, failures, and annotations therefore use the same schema as the other
suites.
