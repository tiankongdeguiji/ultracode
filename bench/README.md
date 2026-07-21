# Benchmark harness

This harness compares stock Codex (Arm A) with Codex plus Ultracode (Arm B)
across three pinned software-engineering suites. Each suite keeps its official
native runner and verifier while sharing one strict control plane for manifests,
state, receipts, metrics, failures, and reports.

## Requirements

- Node 20 or newer and dependencies installed with `npm ci`
- Git, Docker, and the configured Codex binary for shared toolchain preparation

Preparation prerequisites are suite-scoped:

| Suite | Host and preparation tools |
| --- | --- |
| SWE-bench Pro | CPython 3.11 with pip 24.2 and `venv` on reviewed Linux/glibc or macOS targets; it does not require `uv` or GNU `patch` |
| SWE-Marathon | Linux x64 with a Linux amd64 Docker daemon, plus `uv` and GNU `patch` |
| FeatureBench | Linux x64 with a Linux amd64 Docker daemon, plus `uv` |

Where `uv` or `patch` is listed, preparation preflights that suite-only tool
before network access or environment construction. Network access is still
required later to fetch pinned sources, dependencies, toolchains, and images.

Copy `bench/bench.example.config.json` to the ignored, operator-owned
`bench/bench.config.json`, set its mode to `0600`, and fill in the requested
models, efforts, task sets, and public transport/authentication identities.
Runtime credentials and endpoint names are supplied through the environment
and never belong in either config file.

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
  run-state.json                 # small atomic ledger head
  run-state-ledger/              # private append-only JSONL segments
  verifier-receipt.json
  report.json
  report.md
  native/
```

Manifests are strict and immutable: relay-backed SWE-bench Pro uses schema
version 3, while the unchanged SWE-Marathon and FeatureBench contracts remain
version 2. Legacy Pro v2 direct-auth manifests are rejected. Resume re-attests the
prepared inputs and control-plane policy hashes, then accepts only that manifest
identity. Native output is authoritative only when its exact path, SHA-256,
scope, invocation, role, and native record key are stored in the host-owned
receipt. Missing or malformed verifier evidence remains unverified; agent
success and file absence never become a score.

Run state still materializes through the public schema-v2 `BenchRunState`
contract, but new runs persist it as a schema-v3 head plus bounded,
hash-chained records. Each state transition appends to the active segment,
fsyncs it, and then atomically publishes and fsyncs the constant-size head;
lifecycle token reservation is therefore durable before spawn, and the child
PID/start identity is durable immediately after spawn. Segments rotate at 8
MiB and become immutable. Replay streams the complete contiguous chain,
rejecting gaps, duplicate indexes, hash drift, unsafe files, and malformed
interior records; only one uncommitted/torn final record is ignored. This keeps
serialized growth linear and removes the former 64 MiB whole-state limit.

Reports bind both the exact `run-state.json` head bytes and its sealed ledger
root. Legacy schema-v2 monoliths remain available to read-only consumers. Each
suite command migrates a legacy run under its lifecycle lease before process
recovery or any other external side effect; the migration uses one fixed,
crash-recoverable staging directory so repeated hard failures cannot accumulate
full-state copies.

Suite preparation publishes immutable content-addressed directories. In
particular, SWE-bench Pro records a complete transitive, artifact-hashed Python
lock plus reviewed wheel/target provenance, derives the active partition without
a network resolver, and performs the first environment install with hashes,
binary-only selection, and dependency resolution disabled. It binds the patched
evaluator tree, environment tree, Python executable, reviewed assets, and
resolved target lock to the prepared identity. A later `prep` changes only the
current pointer used by fresh runs; resume loads the exact identity frozen by
its manifest.

SWE-bench Pro additionally verifies a reviewed canonical full-row dataset
digest before publishing or loading its cache. Its session and official
evaluator containers share one frozen process/capability policy. See
[SWE-bench Pro provenance and containment](docs/swebench-pro.md) for the
dataset pin-renewal audit and opt-in Docker parity procedure.

FeatureBench likewise rejects preparation unless the complete task/image map
matches its reviewed 100-task inventory digest; the source parquet digest and
inventory digest live in `suites/featurebench/dataset-pin.json`.

## Typical flows

```bash
# SWE-bench Pro
npm run bench -- --suite swebench-pro fetch
npm run bench -- --suite swebench-pro prep
SWEBENCH_PRO_MODEL_RELAY_URL=http://pro-relay:8080/v1 \
SWEBENCH_PRO_RESTRICTED_NETWORK=swebench-pro-private \
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

Preparation, verification, and relay operation can use network access and spend
substantial resources. Pro task sessions have only their dedicated internal
relay network. Unit tests and the default CI suite are offline; live benchmark
runs are always manual.

## Arms and prompt policy

Arm A is the native stock-Codex control. Arm B uses the exact bytes in
`bench/suites/shared/arm-b-prefix.txt` and the prepared Ultracode toolchain.
Every suite manifest binds the prompt policy and tracked native patch/assets.
SWE-Marathon and FeatureBench freeze one arm per run; paired comparisons use
separate run identities. SWE-bench Pro can freeze both arms in one run because
its native layout provides a task-by-arm execution namespace.

## Authentication and isolation

Authentication and transport bindings are resolved only at launch. Manifests
and reports store mechanisms and hashes of public identities, versions,
destinations, policies, immutable runtime identities, and topology, never API
keys, auth-file paths or contents, relay/broker URLs, or Docker runtime names.

- SWE-bench Pro has no direct ChatGPT/API-key mode. Every task container must
  use a custom Codex Responses provider on a dedicated internal Docker network.
  Its only non-task endpoint is the separately operated immutable-image model
  relay attested by `SWEBENCH_PRO_MODEL_RELAY_URL` and
  `SWEBENCH_PRO_RESTRICTED_NETWORK`. The task gets no reusable provider
  credential and has no default/WAN or generic-proxy attachment. A host-wide
  policy lock covers run recovery, preflight, sessions, resume, and cleanup.
- SWE-Marathon ChatGPT mode uses the same `CODEX_AUTH_JSON_PATH` file contract,
  while its API-key mode uses `OPENAI_API_KEY`.
- FeatureBench task containers receive no reusable credential. They attach to
  a dedicated internal Docker network whose only pre-existing endpoint is a
  separately managed, labeled HTTPS credential broker. A host-wide policy lock
  covers network preflight, native execution, official evaluation, and cleanup.

The Pro harness attests the relay's declared strict request/model/destination
contract and Docker identity; the operator remains responsible for making the
relay implementation and its upstream egress match that declaration. It does
not claim to attest an undocumented host or provider firewall.

All native containers receive the complete `ultracode.benchmark.*` ownership
label tuple. Cleanup discovers by that tuple, reinspects the full identity, and
refuses to delete ambiguous or unowned resources.
SWE-bench Pro root ownership-reclamation helpers additionally use deterministic
run/task/arm-derived names and are admitted by session, run-wide, and fatal
cleanup only after exact image, command, user, policy, resource, and bind-mount
attestation. Artifacts and credential runtime homes remain in place until the
helper name is proven absent.

Native host processes receive a high-entropy lifecycle token and run-scope
identity before launch. Run state retains the token, direct-child identity, and
recovery outcome; resume conservatively reaps token-bearing descendants before
closing an interrupted invocation.

## Metrics and reporting

One normalized metrics implementation reads native rollouts and workflow
artifacts declared by each suite adapter. It keeps host and worker sessions,
mock and billable backends, token categories, cost, context pressure,
compactions, timings, failures, and annotations distinct. With a pricing
snapshot, billable or unknown-class rollouts with unreadable or missing usage
produce a partial known subtotal; missing usage from non-billable rollouts does
not affect price verification. All observed tokens remain in usage totals, but
cost includes only positive billable sessions whose native model observations
are present, uniform, exactly equal to the pricing model, and come from a
rollout with no malformed, oversized, or unterminated record. Missing,
mismatched, multi-model, or record-integrity evidence makes the known subtotal
partial; model aliases are never inferred. Valid zero-usage and non-billable
sessions are neutral to model verification. Optional timing groups identify per-task
projections of one physical batch process so summed-task, native-runner, and
verifier time count it once; members must have unique tasks and matching
physical timing identity.

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
