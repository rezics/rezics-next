# Committed events and recoverable jobs

## Ownership and transport

Start with bounded polling and direct dispatch from durable owner outboxes.
NATS JetStream is the selected later distributed transport when fan-out or process
isolation warrants it; it is not a startup dependency. Authority remains in owner
transactions. PostgreSQL owners relay committed outbox entries through an admitted
CDC/relay path. Main stores each event intent with its domain mutation and receipt
in the same TDB2 transaction, submitted through Fuseki's wrapped dataset. Main's
relay polls that RDF outbox through bounded SPARQL reads; it does not depend on
native change streams, transaction-log access or a database notification feature.
External side effects never run before the authoritative domain commit.

Events say what happened; tasks request work. Keep separate subjects and retention
semantics. Event consumers independently track progress; competing workers share
task consumption for one purpose. Envelopes contain event/operation ID, schema,
owner/target reference, aggregate revision, application source position, routing/
fence epoch, causation/correlation and bounded data or a manifest pointer. Private
principal and credential material does not enter public events. Internal receipt
or maintenance progress records are not automatically public notifications.

## RDF outbox and source position

The application owns `{datasetId, dataEpoch, sequence}`; sequence is a decimal
string in transport and is comparable only within that dataset and epoch. Every
sequenced RDF mutation inserts exactly one outbox batch header with the same
position, bounded event count and exact event references. Zero-event batches
explicitly record progress. Domain events within a batch have stable IDs and
ordinals; no downstream consumer infers a total order between independent owners.
The counter is neither a TDB2 transaction ID nor an engine commit hash.

The relay requests bounded batches above its last acknowledged position, ordered
by numeric sequence, and verifies batch completeness before dispatch. Initially,
each consumer acknowledges only its durable effect or continuation, after which
its source checkpoint advances. When a broker is enabled, the relay instead waits
for JetStream acknowledgements for every event in the batch before advancing its
handoff checkpoint; broker consumers still acknowledge their own durable effects.
A relay checkpoint can live in its operational PostgreSQL owner. A crash between
acknowledgement and checkpoint commit repeats the batch, which consumer idempotency
handles. There is no cross-store/transport transaction. A timer can wake the relay;
polling retained source and checkpoints suffices for recovery.

The first Main implementation uses a private PostgreSQL durable handoff and one
explicitly initialized checkpoint per relay consumer. It verifies a contiguous
RDF batch, exact member count and ordinals, typed event objects, terminal receipts and revision
manifest references, then writes internal CloudEvents 1.0 Work outcome envelopes
by stable event ID before advancing the checkpoint. The private envelopes retain
the admitted scope, request digest, terminal outcome and exact result references.
Zero-event batches advance without envelopes. Source gaps, changed epochs and
recovery holds stop advancement. This is a first transport boundary, not a
complete authoritative journal: relay lag, later authority/erasure facts,
downstream consumer effects and retention/reconciliation remain to be qualified.
[Executed evidence](../../services/main/tests/evidence/2026-09-24-main-outbox.xml)
covers duplicate handoff after a crash, four Work outcome kinds and stop conditions.

Keep the source retention floor and epoch visible to the relay. An unexplained
sequence gap, missing event object, expired retained range or unexpected epoch
stops normal advancement and enters explicit reconciliation. Cleanup may prune
only through the admitted recovery floor after required relay progress and
retention rules are satisfied. It cannot delete intents simply because a process
attempted to publish them. The outbox records bounded maintenance transactions too;
compaction of TDB2 storage does not itself change application sequence.

## Delivery, retries and fencing

Consumers commit their effect/continuation and receipt before ACK. Duplicates and
out-of-order delivery are expected; apply expected revisions and idempotent effects.
Detect expired retention and reconcile/rebuild explicitly. Broker dedupe windows
are not permanent exactly-once business guarantees.

Jobs record input manifest/snapshot, owner, authorization basis, expected target,
generation, lease/fence, checkpoint, retry policy, cancellation and terminal
outcome. Every page and activation checks the fence. A resumed expired worker
cannot overwrite the new worker or reactivate erased content. Fan-out creates
bounded continuations instead of keeping one huge transaction open.

Restore or destructive reload fences the old writer and starts a new data epoch
before new writes. Retained old receipts/events preserve their original positions.
Reconcile restored source state against relay/consumer receipts and any external
effects before replay. Never compare sequence values across epochs or reinterpret
a missing old receipt as proof that an earlier side effect did not occur. Current
readiness, index generation and erasure fences govern whether replay can activate
new derived state.

## Backpressure and failures

Bound bytes, age, batch size, in-flight ACKs, retry time and dead-letter retention.
Reject or delay admission when durable intent capacity is exhausted; do not
silently discard unhandled work. Persist poison-message reason and replay
disposition before terminal handling. Permanent errors do not retry forever.
External deliveries use provider idempotency or explicit uncertain-result
reconciliation.

Scheduling stores intent and due state durably; timers only wake eligible work.
Pause/rebind/cancel races recheck owner state at application. Recovery restores
source checkpoints, receipts, fences and erasure frontier before replaying effects.
Metrics distinguish application ingest, relay, consumer and active-generation lag.
Lucene rebuild state is independent of successful delivery of a content event.

Qualification: commit-before-publish crash, lost ACK, duplicate/reordered events,
zero-event batches, missing batch members, source retention gap, queue saturation,
stale worker, cancellation during activation, restored old-lineage receipts and
replay reconciliation. Basis: [JetStream consumers](https://docs.nats.io/learn/jetstream/pull-consumers)
and [PostgreSQL outbox routing](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html).
The [Jena binding](../storage/jena.md#application-source-positions) owns the RDF
transaction/position mechanism; these sources do not provide native TDB2 CDC.
