# SWE-bench Pro benchmark harness

This harness compares stock Codex (Arm A) with Codex plus Ultracode (Arm B)
on a pinned SWE-bench Pro dataset and official evaluator. It builds on the
shared benchmark foundation for immutable manifests, leases, hash-chained run
state, process recovery, provenance, metrics, verifier receipts, and reports.

## Requirements

- Node 20 or newer and dependencies installed with `npm ci`.
- Git and Docker.
- CPython 3.11 with pip 24.2 and `venv` on a reviewed Linux/glibc or macOS
  target; it does not require `uv` or GNU `patch`.
- Network access while fetching pinned sources, Python artifacts, Codex, and
  task images.

Copy `bench/bench.example.config.json` to the ignored, operator-owned
`bench/bench.config.json`, fill in the model and public relay identity, and set
its mode to `0600`. Runtime relay URLs and Docker network names are supplied
through the environment and never belong in the config file.

## CLI

The suite selector is explicit and must come first:

```bash
npm run bench -- --help
npm run bench -- --suite swebench-pro --help
npm run bench -- --suite swebench-pro <fetch|prep|run|eval|report|status|clean> [options]
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

The native evaluator is the sole score authority. Agent success, a captured
patch, or an output file without a matching host-owned receipt never becomes a
verified result.

## Persistent contract

Each run uses the shared suite-scoped envelope:

```text
bench/results/swebench-pro/<runId>/
  manifest.json
  run-state.json
  run-state-ledger/
  verifier-receipt.json
  report.json
  report.md
  native/
```

The schema-v3 manifest freezes the selected instances, arm order, requested
model and effort, resource limits, prompt policy, prepared toolchain identity,
dataset digest, evaluator revision, container policy, and public relay
attestation hashes. Resume accepts only that exact identity and recovers
token-bearing native descendants before launching more work.

Preparation publishes content-addressed inputs. The evaluator environment uses
a checked-in transitive artifact lock, reviewed platform provenance,
hash-required binary-only installation, and the pinned patched evaluator tree.
The dataset cache is published only after the complete canonical row digest
matches the reviewed pin.

## Model isolation

SWE-bench Pro has no direct ChatGPT/API-key mode. Task containers receive no
provider key, auth file, generic proxy, or default/WAN attachment. They attach
only to a dedicated internal non-attachable Docker bridge. The separately
operated immutable-image model relay is the only infrastructure endpoint on
that bridge and may retain its explicitly attested upstream attachment.

The harness binds the full endpoint inventory, selected network, relay image,
runtime command and mounts, public identity/version, fixed destination, model,
and strict Responses-only contract. A nonce-bound gate keeps each task stopped
until its image, labels, capability policy, environment, and sole network
attachment pass inspection. Drift invalidates the run.

This proves the inspected Docker topology and the relay's declared contract;
the Docker daemon, relay implementation, upstream egress, provider, and
credential scope remain trusted operator components. See
[the SWE-bench Pro security and provenance guide](docs/swebench-pro.md) for the
precise boundary and pin-renewal procedure.

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
