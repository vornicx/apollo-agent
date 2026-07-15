# Apollo benchmarks

Apollo's benchmark suite measures tasks, not prose quality. Every task is materialized into an
isolated workspace and ends in deterministic filesystem or command checks. Reports distinguish
verified success, honest stops, false success, ordinary failure, and invalid infrastructure attempts.

## Run it

```bash
apollo benchmark --list
apollo benchmark --variant apollo-routed
apollo benchmark --variant apollo-single
apollo benchmark --variant all --repeat 5
apollo benchmark --variant all --repeat 5 --concurrency 2
apollo benchmark --variant model-only,model-tools --repeat 3
apollo benchmark --variant apollo-routed --limit 1   # smoke test
```

Reports are written under `.apollo/benchmarks/<benchmark-id>/`; isolated fixture workspaces live
under the system temporary directory so they cannot discover or mutate the Apollo parent repo. Every benchmark
mission also writes the same versioned mission/evidence contract as an ordinary Apollo mission.

## Core suite

The public suite contains eleven reproducible tasks spanning repair, implementation,
refactoring, investigation, multi-file work, contradictory goals, missing external authority, and
ambiguous destructive requests. It includes a large-file exact-patch task. Successful work must pass real checks. For an honest-stop case,
claiming success is counted as a false success.

## Current measured evidence

The alpha.5 policy gate targeted the new large-file task for three repetitions: 3/3 correct, zero
false successes, patch selected 3/3 at score 0.91, one call/run and 2.3 s median
(`.apollo/benchmarks/benchmark-1784137232280/report.json`). The seven editing tasks then passed
7/7 with one call/run and 3.1 s median (`.apollo/benchmarks/benchmark-1784137271752/report.json`).

The alpha.4 one-shot gate ran repair, implementation, and source refactoring through the routed
runtime on 2026-07-15. It scored 3/3 with zero false successes, a 3.3 s median, and exactly one
provider call per run (`.apollo/benchmarks/benchmark-1784123733825/report.json`). A separate
same-fixture repair smoke completed in 2.2 s and one call
(`.apollo/benchmarks/benchmark-1784123047106/report.json`), versus 12.5 s and six calls on alpha.3.
Both still ended in deterministic workspace checks. These small samples are regression evidence,
not a publishable general comparison.

The complete ten-task suite was run on 2026-07-13 with a ChatGPT/Codex subscription after the
runtime changes in this checkout:

| Variant | Correct | False successes | Median | Total turns | Marginal API cost |
|---|---:|---:|---:|---:|---:|
| `apollo-routed` | 10/10 | 0 | 44.1 s | 103 | $0 |
| `apollo-single` | 10/10 | 0 | 49.9 s | 111 | $0 |

Raw local reports:

- `.apollo/benchmarks/benchmark-1783912250345/report.json` (`apollo-routed`)
- `.apollo/benchmarks/benchmark-1783912788974/report.json` (`apollo-single`)

An adaptive-runtime smoke on 2026-07-14 ran the same `repair-node-test` fixture through the new
`agent` lane: verified success, zero false success, 12.5 s, six actual model calls, and $0 marginal
cost (`.apollo/benchmarks/benchmark-1784048042838/report.json`). The previous routed run of that
fixture took 31.7 s and 11 turns. This single paired fixture is a regression signal (about 60%
lower wall time), not a replacement for a repeated ten-task comparison.

A 200-attempt repeated campaign was also started for this release. The provider subscription reached
its weekly usage limit partway through, so that campaign is explicitly **inconclusive** and is not
published as a quality comparison. The incident led to invalid-attempt accounting and
quota fail-fast behavior. The two complete ten-task passes above remain the current integration evidence.

On this small run, routing preserved correctness while reducing median duration by about 11.5%
and total turns by about 7.2%. This is real integration evidence, not a universal quality claim:
the suite needs repeated runs on a fixed release tag and additional providers before publishing a
general score. `model-only` is a controlled file-block baseline without tools; `model-tools` gives
the same fixed model workspace tools but no planner, critic, independent verifier, routing, or
memory. `apollo-memory` remains reserved until its controlled corpus and distractor protocol land;
Apollo refuses to label simulated numbers as measurements.

Repeated reports use schema version 5 and include selected execution depth, model-call count,
calls per run, mean, median, p95, sample standard deviation, total turns, and a Wilson 95% interval for correctness. Use `--label` to record the machine or
release tag. They also record one-shot eligibility/score, full/patch selection and snapshot reuse.
Use `--task <id>` for a targeted gate. A publishable comparison should use `--variant all --repeat 5` or more.
`--concurrency` bounds parallel attempts; reports retain deterministic task/variant/repetition order.
Provider exceptions are marked `invalid` and excluded from correctness, latency, cost, and confidence
intervals. A terminal provider quota error stops new work so a depleted account cannot masquerade as
poor agent quality.

The benchmark also drove measurable convergence work. The first isolated routed pass scored 3/10
with two false successes; successive changes to deterministic-check authority, exact-content
checks, early ground-truth completion, and `needsInput` raised the final pass to 10/10 with zero
false successes.

## Reproduction standard

A publishable result must include the Apollo commit/tag, provider/model identifiers, configuration,
Node and OS versions, hardware, raw `report.json`, mission evidence, failures, and exact command.
