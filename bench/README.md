# Benchmark harness

This harness compares stock Codex (Arm A) with Codex plus Ultracode (Arm B)
on pinned software-engineering suites and their native verifiers. SWE-bench Pro
and SWE-Marathon share the benchmark foundation for immutable manifests,
leases, hash-chained run state, process recovery, provenance, metrics, verifier
receipts, and reports.

## Requirements

- Node 20 or newer and dependencies installed with `npm ci`.
- Git and Docker.
- SWE-bench Pro preparation requires CPython 3.11 with pip 24.2 and `venv` on a
  reviewed Linux/glibc or macOS target; it does not require `uv` or GNU `patch`.
- SWE-Marathon preparation requires Linux x64 with a Linux amd64 Docker daemon,
  plus `uv` and GNU `patch`.
- A local standalone Linux-x64 Codex ELF selected by `toolchain.codexBinary`;
  this is required on macOS too and is never fetched by preparation.
- Network access while fetching pinned sources, Python artifacts, and task
  images.

Copy `bench/bench.example.config.json` to the ignored, operator-owned
`bench/bench.config.json`, fill in the selected suite's model, authentication,
and public infrastructure identity fields, and set its mode to `0600`.
SWE-bench Pro runtime relay URLs and Docker network names are supplied through
the environment and never belong in the config file.

## CLI

The suite selector is explicit and must come first:

```bash
npm run bench -- --help
npm run bench -- --suite swebench-pro --help
npm run bench -- --suite swebench-pro <fetch|prep|run|eval|report|status|clean> [options]
npm run bench -- --suite swe-marathon <prep|run|report> [options]
```

A typical pilot is:

```bash
npm run bench -- --suite swebench-pro fetch
npm run bench -- --suite swebench-pro prep
SWEBENCH_PRO_MODEL_RELAY_URL=http://pro-relay:8080/v1 \
SWEBENCH_PRO_RESTRICTED_NETWORK=swebench-pro-private \
npm run bench -- --suite swebench-pro run --run-id pro-pilot \
  --model <model> --effort <effort> --arm both --count 20 --seed 7
npm run bench -- --suite swebench-pro eval --run-id pro-pilot --resume
npm run bench -- --suite swebench-pro report --run-id pro-pilot
```

A SWE-Marathon pilot freezes exactly one arm per run:

```bash
npm run bench -- --suite swe-marathon prep
CODEX_AUTH_JSON_PATH=/path/to/auth.json \
npm run bench -- --suite swe-marathon run --run-id marathon-a1 \
  --model <model> --effort <effort> --arm a --task-id zstd-decoder
npm run bench -- --suite swe-marathon report --run-id marathon-a1
```

The native evaluator is the sole score authority. Agent success, a captured
patch, or an output file without a matching host-owned receipt never becomes a
verified result.

## Persistent contract

Each run uses the shared suite-scoped envelope:

```text
bench/results/<suite>/<runId>/
  manifest.json
  run-state.json
  run-state-ledger/
  verifier-receipt.json
  report.json
  report.md
  native/
```

### SWE-bench Pro persistence

For SWE-bench Pro, the schema-v3 manifest freezes the selected instances, arm order, requested
model and effort, resource limits, prompt policy, prepared toolchain identity,
dataset digest, evaluator revision, container policy, and public relay
attestation hashes. Resume accepts only that exact identity and recovers
token-bearing native descendants before launching more work.

Preparation publishes content-addressed inputs. The evaluator environment uses
a checked-in transitive artifact lock, reviewed platform provenance,
hash-required binary-only installation, and the pinned patched evaluator tree.
The dataset cache is published only after the complete canonical row digest
matches the configured pin. The initial pin is explicitly marked as an
unaudited local content digest and must be independently renewed before results
are treated as publishable benchmark evidence.

Task-image repositories are extracted from stopped containers and sanitized
once per selected task by host Git before the COPY-only overlay build. The
original image checkout is hidden by the trusted bootstrap, and Arm A and Arm B
modify isolated container-layer copies of the same sanitized base closure.

### SWE-Marathon persistence

SWE-Marathon uses a schema-v2 manifest for one arm and one native Harbor job per
selected task. It freezes the prepared source/toolchain identity, task image
digests, bridge and ownership assets, model/effort, timeouts, and pricing. Resume
requires the prior receipt-bound native job config; redo archives the invalidated
job so paid usage remains cumulative. See the suite guide for its distinct
credential and native-evidence boundary.

## Model isolation

SWE-bench Pro has no direct ChatGPT/API-key mode. Task containers receive no
provider key, auth file, generic proxy, or default/WAN attachment. They attach
only to a dedicated internal non-attachable Docker bridge. The separately
operated immutable-image model relay is the only infrastructure endpoint on
that bridge and may retain its explicitly attested upstream attachment.

The harness binds the full endpoint inventory, selected network, relay image,
runtime command and mounts, public identity/version, fixed destination, model,
and strict Responses-only contract. Each task is created stopped for complete
container-policy inspection. Startup executes a pinned musl loader and BusyBox
nonce gate; no task-image executable runs until the live attachment and
topology pass reinspection. Drift invalidates the run.

This proves the inspected Docker topology and the relay's declared contract;
the Docker daemon, relay implementation, upstream egress, provider, and
credential scope remain trusted operator components. See
[the SWE-bench Pro security and provenance guide](docs/swebench-pro.md) for the
precise boundary and pin-renewal procedure.

## SWE-Marathon boundary

SWE-Marathon uses the pinned Harbor runner and accepts only the owned
direct-child trial reward bound by the verifier receipt. ChatGPT mode reads the
private `CODEX_AUTH_JSON_PATH` file contract; API-key mode uses `OPENAI_API_KEY`.
The harness supplies credentials from an ephemeral runtime home, but task code
shares their security domain and can persist them in output or artifacts, so
benchmark accounts must be disposable, narrowly scoped, and protected by
independently restricted egress. Treat retained output as sensitive. See the
[SWE-Marathon guide](docs/swe-marathon.md) for pins, lifecycle rules, and native
evidence requirements.

## Development

The offline gate is:

```bash
npm run bench:check
npm run typecheck
npm run lint
npm test
```

The live Docker parity test is opt-in, uses only an explicitly supplied local
image, and never pulls:

```bash
UC_LIVE_TESTS=1 UC_DOCKER_PARITY_IMAGE=<already-local-image> \
  npx vitest run --config vitest.live.config.ts test/live/bench-swebench-pro-docker.test.ts
```

Live benchmark runs can consume substantial compute, network access, and model
tokens and are always manual. Do not commit `bench/.cache/`, `bench/results/`,
`bench/bench.config.json`, prepared sources, runtime homes, credentials, or
generated plugin bundles.
