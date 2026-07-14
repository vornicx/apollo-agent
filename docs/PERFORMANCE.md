# Apollo performance contract

Apollo optimizes **time to a trustworthy result**, not token speed in isolation. The runtime uses
the shallowest lane that preserves permissions, evidence, deterministic checks, and honest stops.

| Lane | Intended work | Model calls | Verification |
|---|---|---:|---|
| `instant` | Exact greetings and conversational acknowledgements | 0 locally, 1 when forced | Completion recorded and passed |
| `agent` | Normal coding, debugging, writing, extraction | 1..N tool turns | Shell exits, rereads, user checks, policy |
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
- Benchmark schema v4 records lane and model-call count. Compare correctness and false successes
  first, then calls, median/p95 latency, and cost.

The initial regression gate is structural: an exact greeting must select `instant`, perform zero
provider calls, and still record one local execution; an ordinary task must select `agent` without planner/critic/verifier calls; forced
`deep` must preserve the complete cognitive cycle. Release evidence should add live TTFT and total
duration from the packaged application.

## Alpha.3 smoke evidence

Measured on 2026-07-14 in this checkout:

- `hola`: 0 provider calls, 0 ms runtime work, 0.59 s end-to-end CLI startup. The pre-change
  network path took about 4–5 s and could fail with the provider.
- `repair-node-test`: verified success in 12.5 s and six model calls on the `agent` lane. The prior
  routed deep-cycle attempt of the same fixture took 31.7 s and 11 turns.

These are smoke measurements, not statistically general performance claims. The raw reports remain
under `.apollo/benchmarks/` and publishable claims still require repeated fixed-tag runs.
