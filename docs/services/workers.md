# Source, media and delivery workers

## Execution contract

Workers consume committed bounded intents and invoke the authoritative owner.
They carry scoped service identities, exact input snapshots, graph/authority/
erasure epochs, leases, deadlines, cancellation and durable checkpoints. They
cannot directly rewrite Main's RDF, open live TDB2/Lucene files or bypass the
caller's delegated ceiling.

Source workers fetch current official contracts/data under provider rate/size/
redirect limits, preserve observations and propose mappings. Media workers verify
quarantined bytes and transform exact inputs. Delivery workers recheck recipients,
preferences and disclosure before external effects. Product projection workers
coalesce affected roots and submit owner commands; ordinary jena-text index
maintenance occurs inside Fuseki's text dataset wrapper.

Content projection consumes exact PostgreSQL revisions and semantic publication
events with separate checkpoints. Fetch bounded batches and extract language-aware
text outside graph transactions; guarded commands materialize derived RDF units
and their source identities through the wrapper. Stale workers cannot activate a
superseded selection or erased revision. Publication and search readiness are
separate progress states. [Search binding](../contracts/search.md#postgresql-body-projection)
owns staging, activation and reconstruction; draft saves need not rewrite Jena.

## Bootstrap scheduling and backpressure

Start with a bounded poller over committed owner outbox records and persistent
consumer progress. Main's graph outbox is written in the same guarded TDB2 update
as its corresponding command/receipt; Content and private SQL owners use their own SQL outbox.
The polling loop can initially live in the participating owner process. No Redis,
NATS/JetStream or independent worker fleet is required before the first journey.

Each consumer records its delivered frontier, uses bounded batches/bytes and
retries with finite backoff and terminal disposition. Limit retained undelivered
work and expose oldest-item age; do not move an unbounded queue into the database.
Choose a broker later when fan-out or isolation needs justify it; the relay still
uses owner receipts, idempotency and durable checkpoints. Broker delivery does
not make an external side effect exactly once.

Separate high-cost imports/builds from latency-sensitive product work when they
are activated. Concurrency budgets consider CPU, resident memory, disk I/O and
downstream capacity. Large text index reconstruction is controlled maintenance
with Fuseki stopped, not a worker opening the active files in another JVM.

## Recovery and activation

Advance a checkpoint only after the effect or durable continuation commits.
Detect expired source/outbox frontiers and rebuild/reconcile rather than silently
skip. Every page/activation checks current `dataEpoch`, generation, authority and
erasure fences. Unknown external outcomes reconcile with provider receipts;
replaying an intent without those checks can resurrect removed content or repeat
an irreversible effect.

Observe queue age, throughput, retries, terminal items and projection lag. Test
crash/restart at each durable boundary when the worker is implemented. Historical
source replay and a current Lucene rebuild use different inputs and acceptance;
index existence alone does not establish a valid projection generation.
