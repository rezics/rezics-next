# Structure history and revision anchors

## Storage and identity

Structure and Occurrence are stable semantic identities. Fluree stores their
fact transitions. A business structure revision anchors the exact component
state and operation; it does not duplicate the entire tree into a second history
system. A fixed manifest additionally pins selected target revisions.

Never use target Resource ID as occurrence ID, one Fluree branch per book version,
or a database-wide transaction counter as an unqualified public revision. RDF
Lists can be exchanged where appropriate, but mutable large compositions use
identified occurrences and bounded ordered access.

## Mutations and sealing

Insert/move/reorder/remove operations carry expected structure head and immutable
operation identity. Validate allowed target grain, parent ownership, cycle rules
and order-key constraints in the authoritative command/transaction. Concurrent
topology mutations cannot both pass checks against an obsolete tree.

Small operations create a new head directly. Large replacement/import stages a
generation, validates completeness and current authority, catches up or rejects
concurrent changes, then atomically activates. Temporary staging is not visible
as a published revision. Receipts distinguish no-op, stale and successful change.

## Recovery and retention

Restore creates a new current state from a retained revision after current profile,
target and disclosure checks. It never rewinds Fluree or recursively restores
referenced content. Preserve removed occurrence identity for progress, comments
and import correspondence. Revision retention pins required commit history and
external payloads; collection of history must account for all retained anchors.

Cross-ledger movement preserves exact anchor resolution or captures an equivalent
retained representation before the old location is removed. Validate deep cursor
reads, repeated targets, partial staging, stale leases and removed target states.
