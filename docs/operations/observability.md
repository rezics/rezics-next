# Observability, health and diagnosis

## Signals and readiness

Use operation/causation IDs, graph epoch and sequence, index generation and
owner checkpoints to correlate Main, Access, Content, Fuseki and workers. Track
receipt outcomes, latency, retries, outbox age, JVM/OS memory, PostgreSQL WAL,
Lucene/TDB2 growth and storage headroom. Keep credentials, private mappings,
body text and matched literals out of routine logs and support bundles.

Liveness means the process responds. Owner readiness requires its storage,
schema and command path. Graph readiness requires the guarded writer and
correct epoch; text readiness requires a qualified analyzer/index generation.
An uncertain or rebuilding index stays unavailable even when graph reads work.
Check `task urls`, `task aspire -- logs <resource>`, owner health endpoints
and the QA artifact for the operation in question.

## Incident workflow

Identify the owner, epoch and index generation. Fence unsafe admission, retain
bounded traces and receipts, then reconcile unknown outcomes before retrying.
Reproduce storage faults on an isolated copy; never start another JVM against
live TDB2. Repair the cause, requalify the affected owner, and report any
remaining gap. Follow [recovery](recovery.md) for a suspect text generation.
