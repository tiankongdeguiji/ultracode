# FeatureBench native verifier fixture

This is a sanitized structural fixture derived from the observed upstream
FeatureBench aggregate. The uncommitted source capture had SHA-256:

```text
07e201b69219f522ca6b723f9b0f0d7b2bda9069f3b03925d021f12df05f89f0
```

The native run used FeatureBench source revision
`445dcbaec0b2e136061b0acb54e753c0a9f1888e` and dataset revision
`e99d6efdfe511ea832c1b5735c536129561ec96a`. Its aggregate was produced by the
pinned equivalent of:

```bash
.venv/bin/fb eval --predictions-path runs/2026-07-19__13-00-41/output.jsonl \
  --dataset LiberCoders/FeatureBench --split fast --task-id <five-task-set>
```

Task identities and predictions were replaced, while the official five-task
counts and aggregate values (`pass_rate: 0.951`, `resolved_rate: 0.8`) were
preserved. The fixture is native-shaped evidence for offline parser tests; it
is not a benchmark result or a model-quality claim.
