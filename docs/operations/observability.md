# Observability, health and diagnosis

## Correlation and signals

Propagate request/operation/causation IDs, dataset identity, `dataEpoch` and graph
sequence across Main, Fuseki requests, Access decisions and consumers. Preserve
operation receipt correlation through timeouts; HTTP failure alone cannot decide
whether a guarded graph update committed. Record index generation and analyzer
configuration with text query traces. Avoid private content, credentials, raw
account mappings and sensitive matched literals in routine logging.

Measure graph/query/update latency and errors, transaction queue/wait time,
result bytes, graph expansion budgets, JVM heap/GC, process resident memory,
TDB2/Lucene disk growth, Lucene failures/merge/rebuild progress, OS memory and
storage headroom. Track PostgreSQL lock/WAL pressure, outbox age, durable consumer
frontiers, retries, object integrity and source drift. Measure actual Jena and application signals; do not label TDB2 internal positions
as permanent revisions.

Trace Content revision/operation and both source positions through publication
and projection. Measure preparation-pin age, extraction bytes, rewritten RDF/index
bytes, TDB2 writer occupancy, stale-event rejection and separate committed,
published and searchable latency. Count total backend attempts and serial stages
for the entire request, including cold authorization/readiness and retries.
No routine trace should contain body text or private index terms.

Not every desired signal is a built-in Fuseki metric. Main provides command,
receipt, authority and query-budget instrumentation; the host provides disk and
process observations. Any optional Fuseki metrics endpoint stays private. A text
coverage frontier is an application/index-generation claim, not inferred from
the existence of an open Lucene directory.

## Separate readiness

| Signal | Meaning |
| --- | --- |
| Process liveness | The process responds; it does not prove useful storage or authority. |
| Graph readiness | Compatible configuration/model, correct dataset/epoch, TDB2 reads and required guarded-write path available. |
| Content readiness | PostgreSQL Content schema/lineage, exact revision reads and local command/receipt path available; separate from graph and search health. |
| Text readiness | The active mapping/analyzer generation passed integrity probes at its declared graph fence; not in an uncertain/rebuilding state. |
| Protected command readiness | Main can bind a current Access decision and complete or reconcile its command protocol. |
| Worker readiness | Durable checkpoint and source/authority/erasure frontiers allow the next bounded page/effect. |

The quickstart's HTTP probes exercise only substrate behavior when run. The
sample starts no Main readiness endpoint, Access policy engine or public health
contract. After an unclean stop or index failure, retain a text-unavailable state
until [rebuild/recovery](recovery.md) verifies it. Index errors may also interrupt
writes through the wrapper; reconcile receipts and expose the actual degraded
operation set instead of promising that every graph write remains available.

SLOs use measured baselines for the first host/journey. Alert on lost progress,
uncertain authority, integrity failure or actionable resource saturation. Limit
log volume and label cardinality; operation IDs belong in traces/log fields,
not unbounded metric labels. Large-corpus throughput has not been measured.

## Incident workflow

Identify the affected owner, graph epoch and index generation. Fence unsafe
admission, preserve bounded traces/receipts and the failed storage set, reconcile
unknown outcomes, reproduce only on an isolated copy, repair and requalify before
activation. Never run an extra JVM against the live TDB2 path for diagnosis.
Reindexing cannot repair an unfixed authority, bad revision manifest or object
integrity defect. Report what the probes establish and keep unresolved coverage
visible until the owning recovery gate is met.
