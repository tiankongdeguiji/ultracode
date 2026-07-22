# FeatureBench upstream patch preimages

`upstream-preimages.tar.gz.base64` contains only the six Python files modified
in place by `bench/suites/featurebench/codex-chatgpt.patch`. They come from
`https://github.com/featurebench-org/FeatureBench.git` at commit
`445dcbaec0b2e136061b0acb54e753c0a9f1888e`.

Decoded archive SHA-256:

`19f53a17502bd49ecb143ff71cddc4cb4e754197dcb53dba0fe50d439d690ccc`

The archive is deterministic. Regenerate it from a checkout whose HEAD is the
pin above:

```bash
git archive --format=tar HEAD \
  featurebench/harness/container.py \
  featurebench/harness/run_evaluation.py \
  featurebench/infer/agents/codex.py \
  featurebench/infer/config.py \
  featurebench/infer/container.py \
  featurebench/infer/run_infer.py |
  gzip -n -9 |
  base64
```

The offline unit test decodes these exact preimages, applies the complete patch,
and compiles every resulting Python module.
