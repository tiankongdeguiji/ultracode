# Harbor 0.17.1 Arm A native verifier fixture

This directory records the direct-child job/trial shape consumed by the
SWE-Marathon Arm A adapter at source revision
`6d6855af390226f6eca607d63818fe076e57ea8c` and Harbor `0.17.1`.

The equivalent output is produced by `harbor run` with one task, one attempt,
zero retries, and Harbor's installed `codex` agent. Repository and task
payloads were omitted, the model was replaced with `openai/gpt-test`, and the
official bounded reward was retained. This is an offline structural golden,
not a model quality result or a live session capture.

The harness capture command at this pin is equivalent to:

```bash
harbor run --path tasks --include-task-name zstd-decoder \
  --agent codex --model openai/gpt-test --n-attempts 1 --max-retries 0 \
  --jobs-dir native/tasks
```

Exact SHA-256 values are listed below and checked when the fixture is indexed:

- `config.json`: `c44cb08813df3e160ad631ecbe53df13215a1adcaea4ef3e24d2154b371a3d79`
- `result.json`: `c53e9111a25e1bc7a3e3d99467432279ee5267848114b84deb069d59b0f8429d`
- `trial-1/config.json`: `86b26f57a8f2e707fd3a39640b58ceb66ebbb8efae9574935eefdfdde1204254`
- `trial-1/result.json`: `61612e02b290b8caa20e89861f8bffecf7c682a1b0069feca7cfc6e47afda38f`
