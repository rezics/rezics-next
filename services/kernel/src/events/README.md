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

## Shared-history erasure

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
