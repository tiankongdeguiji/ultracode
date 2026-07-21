# Shared benchmark foundation

This directory contains the reusable control plane for Ultracode's software-
engineering benchmarks. It deliberately does not expose a benchmark CLI or a
working suite yet. SWE-bench Pro, SWE-Marathon, and FeatureBench adapters will
land in follow-up changes on top of this foundation.

## Shared contract

All suites use the same strict envelope for:

- immutable, suite-versioned experiment manifests;
- private result paths, leases, and atomic artifact publication;
- hash-chained run-state history and crash recovery;
- process ownership and descendant cleanup;
- toolchain and source provenance;
- normalized failures, metrics, verifier receipts, and reports.

Suite adapters retain authority over native preparation, execution, and
verification. A native verifier result enters a report only when a host-owned
receipt binds its exact path, digest, invocation, scope, role, and native record
key. Missing or malformed evidence remains unverified.

The future result layout is fixed now so adapters compose without migrations:

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

`bench/.cache/`, `bench/results/`, and the operator-owned
`bench/bench.config.json` are ignored. They may contain prepared inputs,
runtime state, and private configuration and must never be committed.

## Development

Install dependencies once, then run the benchmark typecheck or the repository
gate:

```bash
npm ci
npm run bench:check
npm run typecheck
npm run lint
npm test
```

Tests are offline and deterministic. Process and signal-sensitive files run
serially in the default test command; the remaining tests run in parallel.

## Adapter boundary

Follow-up suite adapters implement `SuiteAdapter` from
`bench/src/shared/contracts.ts` and provide their native runner plus analysis
hook. Adapters may consume the shared control plane, but shared modules never
import an adapter or native suite asset. This keeps the dependency direction
acyclic and allows each suite to land in a focused pull request.
