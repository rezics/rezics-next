# Library bulk selection and actions

Decision: filtered selections always use canonical Members `id` order; omitted query order is normalized by the native capture, and Web callers send and verify the same order.

## Owner journey

The owner chooses one readable Library Collection, an optional supported filter, and one existing action: change
tracked status, add missing Subjects to a curated Collection, remove matching Collection occurrences, or remove
personal Library entries. The preview captures the source descriptor, viewer authority, filter, order and full
selected population, then seals the exact Subject or occurrence effects in the durable bulk manifest. The owner
reviews that complete preview and explicitly confirms it. Confirmation applies only manifest identities through
the existing action writers; it never reruns the filter.

Members preparation belongs to the installed Library source. A pending preparation returns `202 {preparing:true}`.
The caller retries the same preview body and idempotency key so the durable source checkpoint can advance. No partial
bulk manifest is sealed, and an incomplete or unavailable source is never treated as an empty selection. Once sealed,
source changes cannot add targets; each native action compares its captured revision or occurrence identity and
records a per-target conflict when that target changed.

## Bounded work

Requests are at most 64 KiB. Query capture makes at most 100 Members reads of at most 100 raw rows each: 10,000 raw
candidate rows, at most 1,000 distinct Subjects, and at most 1,000 persisted effects. Occurrence removal also
expands the selected Subjects to the complete matching occurrence set before sealing and refuses above the effect
limit. Capture binds before/after source descriptors and the current caller authority.

The inclusive cost is the sum of both descriptor reads, every existing Members page's reservation, preparation,
filter compilation, query/native read, currentness and disclosure work, duplicate/rejected/empty/lookahead rows,
occurrence expansion, manifest persistence, and failure/rollback paths. Each Members page keeps its installed native
allowance; multiplying the per-page allowance by the maximum page count is a static ceiling, not a measured
whole-command cost. The prepared Library command retains its existing attempt deadline and transaction rollback.

Confirmation changes the operation root and emits the existing Core outbox event. The default Library WorkModule
receives that event; each workflow step reads at most 100 pending target rows, and a segment registers at most ten
steps. Count each target's existing native authorization, CAS, command receipt, exact replay, remote reconciliation,
acknowledgement, retry and rollback work. Current authorization and native target comparison govern every effect.

## Installed receivers

The native ABI is `POST /v1/libraryOperations` for preview, `POST /v1/libraryOperations/:operationId:confirm` for
explicit confirmation, and the existing status/outcomes/cancel routes for recovery. The confirmation command carries
the operation identity and its own idempotency key; the default caller is `libraryWorkModule`, which registers
`library.collectionBulk` and consumes the Core confirmation outbox event. The native operation scenarios in
`services/kernel/test/library/collection-bulk-operation.test.ts` cover filtered capture, replay, source drift,
outcomes, cancellation and receipt recovery. `services/kernel/test/library/collection-bulk-capture.test.ts` pins
full continuation capture and the 100-page/10,000-row bounds.

The original native 64/512/4096 growth, authority, PoolAccess ABA, broad browser review and promoted-main receiving
remain with their existing acceptance receivers. Focused static accounting and tests do not claim those deferred
measurements.
