# Harbor 0.17.1 native verifier fixture

This directory is the exact direct-child job/trial shape consumed by the
SWE-Marathon adapter at source revision
`6d6855af390226f6eca607d63818fe076e57ea8c` and Harbor `0.17.1`.

Exact SHA-256 values, in native hierarchy order, are:

- `config.json`: `832f39c8f67cc41c5a01e2c7a53ee245642f262fbeca939688af7a0d4a617993`
- `result.json`: `c53e9111a25e1bc7a3e3d99467432279ee5267848114b84deb069d59b0f8429d`
- `trial-1/config.json`: `367dcac413d0b3857866d55e72090005d278ab8602c0f533a95886e58f151d61`
- `trial-1/result.json`: `61612e02b290b8caa20e89861f8bffecf7c682a1b0069feca7cfc6e47afda38f`

The equivalent output is produced by `harbor run` with one task, one attempt,
and zero retries under a dedicated `--jobs-dir`. Repository and task payloads
were omitted, the model was replaced with `openai/gpt-test`, and the official
bounded reward was retained. This is an offline structural golden, not a model
quality result or a live session capture.

The harness capture command at this pin is equivalent to:

```bash
harbor run --path tasks --include-task-name zstd-decoder \
  --agent arm_b_codex:ArmBCodex --model openai/gpt-test \
  --n-attempts 1 --max-retries 0 --jobs-dir native/tasks
```
