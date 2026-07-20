# SWE-bench Pro evaluator fixture

This deterministic structural fixture exercises the exact top-level
`eval_results.json` contract consumed by the pinned official evaluator wrapper.
It targets evaluator revision `ca10a60a5fcae51e6948ffe1485d4153d421e6c5`.
The fixture SHA-256 is
`81288b6e80da3d003122c7ec2b2421691d1d5977ee2eeac16c5c1b024dc63786`.

The equivalent native output is produced by running the pinned evaluator over
submitted predictions and preserving its `eval_results.json`. Task identities
were replaced, booleans were preserved, and one non-boolean record was added to
characterize fail-closed parsing. No prompt, patch, credential, or repository
content is present. This is an offline structural golden, not a benchmark
result or a live capture.

The harness capture command at this pin is equivalent to:

```bash
environment/bin/python swe_bench_pro_eval.py --use_local_docker \
  --raw_sample_path raw-samples.jsonl --patch_path predictions.json \
  --output_dir output --scripts_dir run_scripts
```
