# Event contracts

Every event type committed by a command is registered with a data schema in
`catalogue.ts`. Module catalogues supply product schemas; `registerEventTypes`
adds startup registrations and refuses duplicate types. The first successful
command commit seals the catalogue, including commands without a receipt.

The writer refuses unregistered types and data that fails its registered schema
with a `TypeError` (HTTP 500). It checks the JSON form that will be stored, after
the event-count checks and before authorization finalization and the fence.
Failure rolls back domain writes, receipts and log rows. Schemas are compiled
once at registration; the writer, log reader and effects share the same lookup.
Validation takes O(total event data bytes) CPU for at most `MAX_COMMAND_EVENTS`,
with no SQL or additional partition lock time.

A task that emits a new event type registers its schema in that same task.
Test-only types are registered by the kernel test preload; production code never
imports those fixtures.

## Consumer lag

`core.consumer_lag` stores one row per consumer with the oldest pending envelope time and the time the relay observed
it. Each `startRelays` tick upserts the row using the minimum pending time returned by its existing partition scan;
an empty scan records `oldest_pending_at = NULL`. This adds one row write per tick and does not add a scan.

`readConsumerLag(client, consumer)` returns the consumer's `{ oldestPendingAt, observedAt }` with one primary-key
read, or `null` if no tick has recorded the consumer. `consumerReady(lag, { maxLagMs, now })` is true only when the
row was observed within the maximum age and either no envelope is pending or its oldest pending time is within that
age. A stopped relay therefore becomes not ready when its observation expires.

## Effect owner admission

An effect may declare the optional `admit(client, event)` hook, where `client` is a `pg` `PoolClient` and `event` is
the original `CloudEvent`. `relayEffects` runs all matching hooks in envelope-position, event-sequence, then effect
registration order inside one short transaction from the native relay pool. It commits and releases that connection
before `enqueue` starts any workflow. Effects without the hook keep the existing enqueue path.

Each owner uses the hook for one idempotent keyed insert per event in its own work table, with conflicts as no-ops so
existing processed state is retained. Admission uses bounded exact native keys on the supplied client only, including a committed obligation
when needed for applicability; it does not call the network or hold a connection while a workflow is enqueued.
A hook failure rolls back every admission in the batch, skips enqueue and leaves the checkpoint unchanged for a normal retry. After admission commits, enqueue and the existing checkpoint
compare-and-set proceed as before. A failed enqueue or lost compare-and-set can replay the batch, so workflow identity
remains deterministic and owner admission must remain idempotent. The owner `run` path tolerates a processed item and
inserts that same item if it is missing; the work change time comes from the original event's `time`.

Queued, pending and failed jobs keep an unprocessed owner item independently of DBOS history retention. Consumer lag
covers delay before admission. Admission and enqueue are not an owner cleanup acknowledgement or proof of global
erasure closure.

## Shared-history erasure

The native preference producer records exact receipt and outbox locators through `declareCommandHistory` in its
serializable source transaction. Each event's typed subject/related-party scope is unioned with the verified native
identity roles. Event locators use the actual `(partition_no, position, event_seq)`, and a local shared guard orders
them against the erasure seal. This delivers preference copy custody and the default preference receipt response
minimizer only. Other command/effect/workflow producers, outbox payload minimizers and durable-copy minimizers remain
actual runtime gaps; the shared-history participant stays pending, including for an empty covered prefix.

An outbox event locator identifies `(partition_no, position, event_seq)`. Its minimized storage form retains that
stable identity, event type and schema version while removing payload and subject fields that carry account data.
Readers must recognize a minimized-event marker and preserve contiguous log positions and event sequences; they must
not invent a replacement payload. Delivery dispatch and business-effect completion are separate obligations:
successful dispatch alone does not prove a registered effect finished. A source may remove payload only after every
applicable downstream consumer has durably taken custody of its own payload or completed its effect and recorded
the source handoff. Durable effect locator completion evidence is required by the erasure coordinator's open locator-
work rule. Minimization, reader support, consumer proof and source handoff remain open gaps.

## Cost

Shared event costs for relay discovery, batch log reads, checkpoint operations, effect enqueue and effect persistence are documented in the [Kernel service Cost table](../../README.md#cost).

| Operation                 | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Bound                                                                                                                                                                                                                        | Growth check                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Consumer lag record       | One upsert per tick per consumer, using the minimum from the existing partition scan.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant added work per tick; the existing scan over the fixed 4096-partition map is unchanged.                                                                                                                              | `test/events/growth-consumer-lag.test.ts`: “Consumer lag record stays within its bound as consumer rows grow”               |
| Consumer lag read         | One primary-key read by consumer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Constant work, returning at most one row from a table with one row per consumer.                                                                                                                                             | `test/events/growth-consumer-lag.test.ts`: “Consumer lag read stays within its bound as consumer rows grow”                 |
| Released projection batch | `projectBatch` reads a released snapshot through `readBatch`, applies at most the fixed batch size without holding a database connection, then compare-and-advances the consumer checkpoint by the snapshot epoch and position. Success persists the advance; empty input leaves the checkpoint unchanged; a locked checkpoint returns busy before apply, while a lost compare-and-set returns busy after apply without this call committing its advance. Grow checkpoint and outbox history while fixing the batch size and payloads. | Constant rows and statements for a fixed batch, logarithmic blocks in checkpoint and outbox history; successful, empty, busy and lost-CAS outcomes have fixed SQL work, with application callback work bounded by the batch. | `test/growth-projection.test.ts`: “Released projection batch stays within its bound as checkpoint and outbox history grows” |
| Effect owner admission    | When registered effects provide `admit`, `relayEffects` applies matching hooks in envelope-position and event-sequence order in one transaction, releases the connection, then enqueues workflows and compare-and-advances the checkpoint. An admission error rolls back the complete batch and skips enqueue and checkpoint movement. Grow matching events/effects while fixing the bounded batch size.                                                                                                                               | O(matching events/effects) application work, one short transaction, and no connection held during enqueue; no history or partition scan beyond the existing relay.                                                           | `test/events/effect-admission.test.ts`                                                                                      |
