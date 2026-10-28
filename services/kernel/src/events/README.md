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

## Cost

Shared event costs for relay discovery, batch log reads, checkpoint operations, effect enqueue and effect persistence are documented in the [Kernel service Cost table](../../README.md#cost).

| Operation | Touches | Bound | Growth check |
| --- | --- | --- | --- |
| Released projection batch | `projectBatch` reads a released snapshot through `readBatch`, applies at most the fixed batch size without holding a database connection, then compare-and-advances the consumer checkpoint by the snapshot epoch and position. Success persists the advance; empty input leaves the checkpoint unchanged; a locked checkpoint returns busy before apply, while a lost compare-and-set returns busy after apply without this call committing its advance. Grow checkpoint and outbox history while fixing the batch size and payloads. | Constant rows and statements for a fixed batch, logarithmic blocks in checkpoint and outbox history; successful, empty, busy and lost-CAS outcomes have fixed SQL work, with application callback work bounded by the batch. | `test/growth-projection.test.ts`: “Released projection batch stays within its bound as checkpoint and outbox history grows” |
