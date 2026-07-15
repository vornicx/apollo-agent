# Changelog

All notable changes to Apollo are recorded here. Versions follow Semantic Versioning; alpha releases may still change internal contracts, while persisted mission contracts remain explicitly versioned.

## 0.2.0-alpha.5 — 2026-07-15

### Added

- Incremental private snapshot caching with per-file reuse/refresh telemetry and content fingerprints.
- Automatic scored selection between complete-file one-shots, exact SEARCH/REPLACE patches, and the existing agent fallback.
- Schema-v5 benchmark metrics and targeted `benchmark --task <id>` runs, including a reproducible large-file patch task.

### Changed

- One-shot output is staged and committed as a rollback-capable batch; patches are materialized in memory before entering the same transaction.

### Fixed

- File application rejects symbolic-link path segments and restores previously committed files when a later replacement fails.

## 0.2.0-alpha.4 — 2026-07-15

### Added

- One-shot-first workspace execution with relevance-ranked bounded context, baseline checks, complete-file application, post-write inspection, and deterministic verification.
- Explicit `harness.context_prepared`, `one_shot.completed`, and `one_shot.fallback` events, plus `--no-one-shot` for controlled fallback and benchmarks.

### Changed

- Ordinary coding, debugging, and refactoring now attempt one model completion before entering the existing tool loop; failed attempts continue from the current workspace state.
- Source extraction such as “extract into format.js” is classified as refactoring instead of data extraction.

### Fixed

- File blocks are all path-validated before the first write, preventing partial application when a later path is invalid.
- Embedded Desktop runtimes watch their parent process and exit if the native shell is killed, avoiding stale runtimes on port 4317.

## 0.2.0-alpha.3 — 2026-07-14

### Added

- Adaptive `instant`, `agent`, and `deep` execution lanes with deterministic auto-selection and a `--depth` override.
- Live answer deltas in Desktop, execution TTFT/wall-time telemetry, and benchmark model-call/depth accounting.

### Changed

- Exact greetings complete locally with zero provider calls; ordinary work uses a single tool loop with deterministic post-execution verification; the full plan/critic/verifier cycle is reserved for complex and high-risk work.
- Independent read tools execute concurrently while writes and shell actions retain deterministic model order.
- Routing learns effective end-to-end throughput and p50 TTFT from local run telemetry without overwriting raw provider speed.
- Completion token budgets and task estimates now reflect the selected lane and actual prompt size.

### Fixed

- Verification shell output capture is stable for very short failing processes.

## 0.2.0-alpha.2 — 2026-07-14

### Fixed

- Direct conversational missions no longer enter a critic/replan loop while waiting for tool evidence that cannot exist for a reply.

## 0.2.0-alpha.1 — 2026-07-14

### Changed

- Release checksums, build-provenance attestations, package validation, and FUSE-independent AppImage builds.
- Desktop mission replies now persist as user-facing summaries and appear directly in mission control.
- Trivial conversational missions emit successful verification evidence instead of a contradictory unverified outcome.
- Dashboard integration tests wait for actual state transitions instead of relying on fixed timing.

## 0.2.0-alpha.0 — 2026-07-13

### Added

- Autonomous Linux Desktop packaging with an embedded Apollo bundle and Node runtime.
- Native mission center for launching, streaming, canceling, clarifying, and retrying missions.
- Versioned mission, outcome, and evidence bundles.
- Per-project execution policy with read, write, shell, and critical risk classes.
- Auditable permission decisions and credential redaction in JSONL event records.
- Repeated benchmark runs, direct-model baselines, dispersion, Wilson confidence intervals, and raw reports.
- Infrastructure-aware benchmark accounting that excludes provider outages and quota exhaustion from quality scores.
- CI for TypeScript, tests, runtime bundling, Rust, and tagged `.deb`/AppImage releases.

### Changed

- Midas context is grounded with provenance and is enabled by default when configured.
- Deterministic checks are authoritative and false completion claims remain visible.
