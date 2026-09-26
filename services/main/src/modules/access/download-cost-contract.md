# Media download lease cost contract

The media owner resolves the current avatar slot with its `(target, context,
role)` primary key and joins one selected representation. `AccessDownloadLeases.admit`
validates one principal, subject, Work scope and media asset. Its indexed lookups are bounded by the two 256-row pending limits;
expired unstarted leases are reaped in two batches capped at 257 rows. Each
admission writes one lease. `begin` revalidates the exact two authority sources
and changes one lease row. `finish` changes one row and is idempotent for the
same terminal state. It never traverses object or Work history.

Main reads at most one current media-owner basis and at most 8 MiB of immutable
object bytes per request. HTTP delivery yields 64 KiB chunks. Download admission
and strong revocation together admit at most 256 pending commands, private
search reads and download streams. Revocation scans each claimed source through
its partial pending index with `LIMIT 257`; it fails closed above the shared
drain budget. Download rows use scope/principal partial indexes; the revocation
list uses a unique lease-ID index. The IAM07 integration test checks the index
exists and exercises two overlapping streams through cancellation and delivery.

These are explicit application/row/byte bounds. They do not assert object-store
latency or a physical PostgreSQL I/O bound.
