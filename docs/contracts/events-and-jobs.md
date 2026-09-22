# Committed events and recoverable jobs

## Ownership and transport

Use NATS JetStream for durable event/task transport. Authority remains in owner
transactions. PostgreSQL owners relay committed outbox entries through an admitted
CDC/relay path; Fluree owners relay committed event/receipt facts with recoverable
ledger/branch/commit checkpoints. Nameservice SSE is a wake-up hint, not the only
recoverable event history. External side effects never run before domain commit.

Events say what happened; tasks request work. Keep separate subjects and retention
semantics. Event consumers independently track progress; competing workers share
task consumption for one purpose. Envelopes contain event/operation ID, schema,
owner/target reference, aggregate revision, source position, routing/fence epoch,
causation/correlation and bounded data or a manifest pointer. Private principal
and credential material does not enter public events.

## Delivery, retries and fencing

Publish acknowledgement precedes advancing relay progress. Consumers commit their
effect/continuation and receipt before ACK. Duplicates and out-of-order delivery
are expected; apply expected versions and idempotent effects. Detect source gaps
or expired retention, then reconcile/rebuild explicitly. Broker dedupe windows
are not permanent exactly-once business guarantees.

Jobs record input snapshot, owner, authorization basis, expected target, generation,
lease/fence, checkpoint, retry policy, cancellation and terminal outcome. Every
page and activation checks the fence. A resumed expired worker cannot overwrite
the new worker or reactivate erased content. Fan-out creates bounded continuations
instead of keeping one huge transaction open.

## Backpressure and failures

Bound bytes, age, batch size, in-flight ACKs, retry time and dead-letter retention.
Reject or delay admission when durable intent capacity is exhausted; do not silently
discard unhandled work. Persist poison-message reason and replay disposition before
terminal handling. Permanent errors do not retry forever. External deliveries use
provider idempotency or explicit uncertain-result reconciliation.

Scheduling stores intent and due state durably; timers only wake eligible work.
Pause/rebind/cancel races recheck owner state at application. Recovery restores
source checkpoints, receipts, fences and erasure frontier before replaying effects.
Metrics distinguish ingest, relay, consumer and active-generation lag.

Qualification: commit-before-publish crash, lost ACK, duplicate/reordered events,
retention gap, queue saturation, stale worker, cancellation during activation and
restoration. Basis: [JetStream consumers](https://docs.nats.io/learn/jetstream/pull-consumers)
and [outbox routing](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html).
