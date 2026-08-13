# dsh-benchmark

Reproducible, deterministic benchmark evidence for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) tools and plugins.

This project deliberately does **not** duplicate `dsh-batch-regression`, which runs one shell command repeatedly for median/distribution statistics. `dsh-benchmark` defines an evidence protocol around fixed cases: explicit target and suite revisions, file-derived target fingerprints, bounded argv-only subprocesses, raw measurements, versioned deterministic scoring, content-addressed reports, and baseline regression comparison.

The first release evaluates commands and JSONL runners, not subjective LLM quality.

## Evidence model

An explicit manifest freezes:

- suite name and case revision;
- target name, claimed revision, and files used to recompute its fingerprint;
- executable, constrained working directory, warmup/repeat counts, timeout, output cap, and concurrency cap;
- fixed argv and optional JSONL stdin for every case;
- expected exit code, stdout/stderr SHA-256, and optional JSONL line count;
- scorer version, minimum pass rate, output-stability rule, and maximum median-latency regression.

Each run records warmup and measured observations separately: duration in nanoseconds, exit code, signal, timeout/output-limit state, output byte counts and hashes, JSONL validity, and every expectation check. Raw argv, stdin, stdout, stderr, inherited environment, timestamps, and hostnames are excluded from reports.

## Safety model

- `shell: false`; no command strings or shell interpolation.
- `node` maps to the current absolute `process.execPath`. Other executables must be explicit workspace-relative regular files; PATH lookup is not used.
- `cwd`, target files, manifests, reports, and artifact directories cannot escape `workspaceRoot` through traversal or symlinks.
- Child processes receive a minimal deterministic environment instead of inherited secrets.
- Timeout, captured-output bytes, and concurrency are mandatory bounded manifest values.
- Secret-bearing manifest fields such as tokens, cookies, authorization, credentials, and custom environment secrets are rejected.
- Reports contain hashes and measurements, not command inputs or output bodies.
- Artifact writes are restricted to explicit `artifactDir`, content addressed, exclusive, and verified by read-back SHA-256.

Run only trusted benchmark executables. The isolation above prevents accidental shell expansion and environment leakage; it is not an OS sandbox for malicious code.

## Install in DSH

```bash
dsh plugin --profile benchmark add github:dongsheng123132/dsh-benchmark
```

The bundle registers:

- `dsh_benchmark_inspect` — inspect protocol metadata and fingerprints without execution.
- `dsh_benchmark_run` — run fixed cases and write a content-addressed report.
- `dsh_benchmark_compare` — compare current and baseline reports with manifest thresholds.

## CLI

```bash
dsh-benchmark inspect --root /workspace --manifest benchmark.json

dsh-benchmark run \
  --root /workspace \
  --manifest benchmark.json \
  --artifact-dir benchmark-artifacts

dsh-benchmark compare \
  --root /workspace \
  --manifest benchmark.json \
  --baseline benchmark-artifacts/baseline.json \
  --current benchmark-artifacts/current.json \
  --artifact-dir benchmark-comparisons
```

Exit code `0` means pass. `2` means a report/comparison was written but its scorer failed. `1` means a manifest or operational error.

## Manifest example

[`examples/benchmark.example.json`](examples/benchmark.example.json) benchmarks a fixed JSONL runner. Run it from this repository:

```bash
node bin/dsh-benchmark.mjs run \
  --root . \
  --manifest examples/benchmark.example.json \
  --artifact-dir artifacts
```

Arguments and JSONL values can contain ordinary test data, but the report stores only their SHA-256 fingerprints. Do not place real secrets in a benchmark manifest.

## Develop

```bash
npm test
npm run check
npm run smoke:plugin
```

Requires Node.js 22+. No runtime dependency or install lifecycle script is used beyond the optional DSH tools SDK peer.

## License

MIT
