# Model, schema and index evolution

## Independent versions

Version semantic definitions, operation contracts, storage bindings, API schemas,
analyzers and deployment builds separately. A release manifest pins a compatible
combination. A new storage index does not change predicate meaning; changed meaning
requires a new definition or explicit migration that preserves historical readings.

## Evolution protocol

Prepare definition/context/shape changes, determine affected predicates/operations,
stage conversion with retained source evidence, validate bounded samples and full
required coverage, then activate a generation with expected heads. Unknown values
remain explicit residuals, never discarded to satisfy a new validator. Long jobs
resume with fences and do not overwrite intervening human edits.

Fluree schema changes are transactions/profile changes with history, not automatic
proof that every stored instance conforms. PostgreSQL owners use forward migrations
and disposable replay. Object formats have versioned readers/writers. Search
changes build a new generation and switch only after catch-up and comparison.

## Compatibility and recovery

The redesign has no legacy-system compatibility or online-transfer obligation.
Within the new released system, define reader/writer compatibility windows and
forward recovery. Downgrade across incompatible engine formats restores a qualified
snapshot rather than opening new files with an old binary. Back up data, metadata,
keys and manifest before upgrade; test failure halfway through conversion.

Keep normative vocabulary dependencies pinned for compilation. Live-provider
conformance refreshes upstream inputs each run. Per-run tool/source capture makes
failures reproducible without permanently freezing external versions.
