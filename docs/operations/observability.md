# Observability, health and diagnosis

## Signals

Propagate request, operation, causation and source-commit IDs across services.
Trace owner commands, Fluree queries, Access decisions, solver candidate fetches,
relay/worker stages and object operations. Redact credentials, account mappings
and private content; diagnostic privilege is explicit.

Measure latency/error/timeout by operation and outcome, candidates/graph expansions,
memory and result bytes, Fluree novelty/index lag, cache misses, transaction queue,
PostgreSQL lock/WAL/replica lag, consumer backlog age, source drift, solver steps,
media work and storage/restore headroom. Separate absence from unavailable inputs.

## Health and budgets

Startup verifies required configuration/model/storage versions. Liveness detects
a stuck process without depending on every downstream service. Readiness checks
the dependencies required for the advertised operation; optional search/delivery
degradation is reported separately from durable-write readiness.

SLOs are selected per journey using measured baselines on the two hosts. Alert on
actionable saturation, stale authority, data integrity or lost progress; avoid
high-cardinality labels and unbounded logging. Keep error outcomes visible even
when advisory automation or a partial rollout continues.

## Incident workflow

Identify affected owner/generation, stop unsafe admission, preserve bounded traces/
receipts, reproduce on an isolated target, repair the cause and reconcile durable
state. Reindex/replay is not a cure for an unfixed authority or identity defect.
Record the tested scope and unresolved risk without claiming whole-system proof.
