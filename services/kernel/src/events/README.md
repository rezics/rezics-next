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
