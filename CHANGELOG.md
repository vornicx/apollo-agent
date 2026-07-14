# Changelog

All notable changes to Apollo are recorded here. Versions follow Semantic Versioning; alpha releases may still change internal contracts, while persisted mission contracts remain explicitly versioned.

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
