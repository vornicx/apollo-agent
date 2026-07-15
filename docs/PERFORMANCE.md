# Apollo performance contract

Apollo optimizes **time to a trustworthy result**, not token speed in isolation. The runtime uses
the shallowest lane that preserves permissions, evidence, deterministic checks, and honest stops.

| Lane | Intended work | Model calls | Verification |
|---|---|---:|---|
| `instant` | Exact greetings and conversational acknowledgements | 0 locally, 1 when forced | Completion recorded and passed |
| `agent` | Normal coding, debugging, writing, extraction | 1 normally; 1 + fallback turns when needed | Baseline, shell exits, rereads, user checks, policy |
| `deep` | Architecture, research, security, deployment, destructive/high-risk work | Multi-phase | Critic, independent verifier, deterministic checks |

`auto` is deterministic and local; it does not spend a model call deciding how many model calls to
spend. A user can force any lane with `--depth` when domain knowledge beats the selector.

## Measurements

- `execution.completed` records wall time, time to first token (TTFT), and the actual number of
  provider completions inside an agent loop.
- `apollo stats` reports p50 TTFT, mean wall time, effective output tokens per wall second, cost,
  and verification rate per model.
- With at least five samples, routing uses measured effective throughput in memory.
- `apollo calibrate --write` persists effective throughput separately from raw provider generation
  speed. Quality scores are never inferred from speed.
- Benchmark schema v5 records lane, model-call count, one-shot score, full/patch choice and snapshot
  reuse. Compare correctness and false successes first, then calls, median/p95 latency, and cost.

## Alpha.5 incremental/patch evidence

Measured on 2026-07-15 in this checkout:

- The targeted large-file task ran three times: 3/3 correct, zero false successes, patch selected
  3/3 at score 0.91, one provider call/run, 33 output tokens/run, and 2.3 s median
  (`.apollo/benchmarks/benchmark-1784137232280/report.json`).
- The seven-task editing regression passed 7/7 with zero false successes, one call/run and 3.1 s
  median. Six tasks selected complete files and the large-file task selected a patch
  (`.apollo/benchmarks/benchmark-1784137271752/report.json`).
- Snapshot reuse is verified deterministically by tests that observe unchanged, changed and deleted
  files. Benchmark repetitions deliberately use isolated workspaces, so their reuse metric is 0%.

The initial regression gate is structural: an exact greeting must select `instant`, perform zero
provider calls, and still record one local execution; an ordinary task must select `agent` without planner/critic/verifier calls; forced
`deep` must preserve the complete cognitive cycle. Release evidence should add live TTFT and total
duration from the packaged application.

## Alpha.4 one-shot evidence

Measured on 2026-07-15 in this checkout:

- A three-task repair/implementation/refactor gate completed 3/3 correctly, with zero false
  successes, a 3.3 s median, and exactly one provider call per task
  (`.apollo/benchmarks/benchmark-1784123733825/report.json`).
- The same `repair-node-test` fixture completed in 2.2 s and one call. Alpha.3's tool-loop smoke
  used 12.5 s and six calls; the earlier deep route used 31.7 s and 11 turns.
- A six-task integration smoke completed 6/6 correctly. Before the source-extraction classifier
  fix it averaged 1.8 calls/run because one refactor entered the tool loop; the three-task gate
  above verifies that exact refactor now completes in one call.

These are small live regression gates, not general model-quality claims. They demonstrate that the
harness can remove orchestration calls while retaining deterministic task checks.

## Alpha.3 smoke evidence

Measured on 2026-07-14 in this checkout:

- `hola`: 0 provider calls, 0 ms runtime work, 0.59 s end-to-end CLI startup. The pre-change
  network path took about 4–5 s and could fail with the provider.
- `repair-node-test`: verified success in 12.5 s and six model calls on the `agent` lane. The prior
  routed deep-cycle attempt of the same fixture took 31.7 s and 11 turns.

These are smoke measurements, not statistically general performance claims. The raw reports remain
under `.apollo/benchmarks/` and publishable claims still require repeated fixed-tag runs.
