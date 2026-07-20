# Benchmark harness

This harness compares stock Codex (Arm A) with Codex plus Ultracode (Arm B)
across three pinned software-engineering suites. Each suite keeps its official
native runner and verifier while sharing one strict control plane for manifests,
state, receipts, metrics, failures, and reports.

## Requirements

- Linux or macOS for the CLI; native container suites have stricter host checks
- Node 20 or newer and dependencies installed with `npm ci`
- Git and Docker
- Suite preparation dependencies documented in the suite guides

Copy `bench/bench.example.config.json` to the ignored, operator-owned
`bench/bench.config.json`, set its mode to `0600`, and fill in the requested
models, efforts, task sets, and public authentication identities. Runtime
credentials and endpoint names are supplied through the environment and never
belong in either config file.

## Unified CLI

There is one public entrypoint and the suite selector must come first:

```bash
npm run bench -- --suite <swebench-pro|swe-marathon|featurebench> <command> [options]
npm run bench -- --help
npm run bench -- --suite featurebench --help
npm run bench -- --suite featurebench run --help
```

`--suite=<name>` is also accepted in the same leading position. Commands are
not inferred from run IDs, paths, or existing artifacts, and there are no
alternate suite entrypoints or old-layout readers.

| Suite | Commands | Native authority |
| --- | --- | --- |
| SWE-bench Pro | `fetch`, `prep`, `run`, `eval`, `report`, `status`, `clean` | Pinned official SWE-bench Pro evaluator |
| SWE-Marathon | `prep`, `run`, `report` | Pinned Harbor reward |
| FeatureBench | `prep`, `run`, `report` | Pinned `fb infer` and official `fb eval` |

Every run uses the same persistent envelope:

```text
bench/results/<suite>/<runId>/
  manifest.json
  run-state.json
  verifier-receipt.json
  report.json
  report.md
  native/
```

The manifest is strict schema version 2 and immutable. Resume re-attests the
prepared inputs and control-plane policy hashes, then accepts only that manifest
identity. Native output is authoritative only when its exact path, SHA-256,
scope, invocation, role, and native record key are stored in the host-owned
receipt. Missing or malformed verifier evidence remains unverified; agent
success and file absence never become a score.

Suite preparation publishes immutable content-addressed directories. In
particular, SWE-bench Pro records a complete transitive, artifact-hashed Python
lock, rebuilds the evaluator environment under hash enforcement, and binds the
patched evaluator tree, environment tree, Python executable, and resolved lock
to the prepared identity. A later `prep` changes only the current pointer used
by fresh runs; resume loads the exact identity frozen by its manifest.

## Typical flows

```bash
# SWE-bench Pro
npm run bench -- --suite swebench-pro fetch
npm run bench -- --suite swebench-pro prep
npm run bench -- --suite swebench-pro run --run-id pro-pilot \
  --model <model> --effort <effort> --arm both --count 20 --seed 7
npm run bench -- --suite swebench-pro eval --run-id pro-pilot --resume
npm run bench -- --suite swebench-pro report --run-id pro-pilot

# SWE-Marathon: exactly one arm per run
npm run bench -- --suite swe-marathon prep
npm run bench -- --suite swe-marathon run --run-id marathon-a1 \
  --model <model> --effort <effort> --arm a --task-id zstd-decoder
npm run bench -- --suite swe-marathon report --run-id marathon-a1

# FeatureBench: exactly one arm per run
npm run bench -- --suite featurebench prep
FEATUREBENCH_CREDENTIAL_BROKER_URL=https://broker.internal/v1 \
FEATUREBENCH_RESTRICTED_NETWORK=featurebench-private \
npm run bench -- --suite featurebench run --run-id feature-b1 \
  --model <model> --effort <effort> --arm b --task-id <featurebench-task>
npm run bench -- --suite featurebench report --run-id feature-b1
```

Preparation and native execution can use network access and spend substantial
resources. Unit tests and the default CI suite are offline; live benchmark runs
are always manual.

## Arms and prompt policy

Arm A is the native stock-Codex control. Arm B uses the exact bytes in
`bench/suites/shared/arm-b-prefix.txt` and the prepared Ultracode toolchain.
Every suite manifest binds the prompt policy and tracked native patch/assets.
SWE-Marathon and FeatureBench freeze one arm per run; paired comparisons use
separate run identities. SWE-bench Pro can freeze both arms in one run because
its native layout provides a task-by-arm execution namespace.

## Authentication and isolation

Authentication is resolved only at launch, using an allowlisted child
environment. Manifests store the mechanism and hashes of operator-provided
public identities, never API keys, auth-file paths or contents, broker URLs, or
runtime Docker names.

- SWE-bench Pro and SWE-Marathon support their documented ChatGPT or API-key
  runtime mechanisms. Use narrowly scoped benchmark accounts.
- FeatureBench task containers receive no reusable credential. They attach to
  a dedicated internal Docker network whose only pre-existing endpoint is a
  separately managed, labeled HTTPS credential broker. A host-wide policy lock
  covers network preflight, native execution, official evaluation, and cleanup.

All native containers receive the complete `ultracode.benchmark.*` ownership
label tuple. Cleanup discovers by that tuple, reinspects the full identity, and
refuses to delete ambiguous or unowned resources.

Native host processes receive a high-entropy lifecycle token and run-scope
identity before launch. Run state retains the token, direct-child identity, and
recovery outcome; resume conservatively reaps token-bearing descendants before
closing an interrupted invocation.

## Metrics and reporting

One normalized metrics implementation reads native rollouts and workflow
artifacts declared by each suite adapter. It keeps host and worker sessions,
mock and billable backends, token categories, cost, context pressure,
compactions, timings, failures, and annotations distinct.

Reports keep official/native analysis separate from policy-adjusted analysis:

- SWE-bench Pro reports official arm rates, paired McNemar analysis, and thesis
  strata.
- SWE-Marathon reports the official mean Harbor reward.
- FeatureBench uses official per-task `pass_rate` as the common task score and
  preserves the separate official `resolved` boolean. Its native headline is
  run-level `attempt_1.pass_rate`; `resolved_rate` is exposed separately.

See [SWE-Marathon](docs/swe-marathon.md) and
[FeatureBench](docs/featurebench.md) for their native contracts. The repository
threat model documents the broader worker and workflow trust assumptions.

## Offline checks

```bash
npm run bench:check
npx vitest run test/unit/bench-*.test.ts
npm run typecheck
npm run lint
```

Do not commit `bench/.cache/`, `bench/results/`, `bench/bench.config.json`, native
source clones, runtime homes, credentials, or generated plugin bundles.
