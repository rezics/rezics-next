# Structure history and revision anchors

## Storage and identity

Structure and Occurrence are stable semantic identities. TDB2 holds current
structure facts and immutable revision metadata; application-owned payloads and
manifests retain exact prior structure states. A structure revision identifies its
component, predecessor, operation and complete immutable payload root. A fixed
manifest additionally pins selected target revisions. Database MVCC and discarded
TDB2 file generations are not the structure history API.

Never use target Resource ID as occurrence ID, one database per book version,
or a dataset-wide sequence as an unqualified public revision. RDF Lists can be
exchanged where appropriate; mutable large compositions use identified occurrences
and bounded ordered access. Removed occurrences keep their identity for progress,
comments and import correspondence under retention/disclosure policy.

## Mutations and sealing

Insert/move/reorder/remove operations carry the expected structure head and an
immutable operation identity. Validate allowed target grain, parent ownership,
cycle rules and order keys against an explicit candidate and dependency snapshot.
Every topology mutation advances the same structure head; activation CAS requires
that head plus all other mutable dependencies used in validation. Thus two changes
cannot both rely on an obsolete topology. Referenced remote owners follow explicit
admission/fence contracts rather than a fictitious cross-store transaction.

Small structures seal complete payloads. Large structures use immutable paged
manifests with bounded fan-out, stable occurrence records and ordered child/range
indexes. A small edit copies affected pages and their path to a new root while
reusing unchanged pages. History resolution starts from that complete root; it
does not replay every prior edit. Keep current RDF occurrence/order projections
consistent with the new root in the guarded activation transaction.

A large replacement/import stages pages and validates a complete manifest before
activation. The root switches in one bounded guarded transaction, with revision
metadata, command receipt, dataset sequence and outbox batch. For a large RDF
projection, stage a generation and switch its selected pointer with that root;
queries cannot accidentally union old/incomplete generations. Concurrent edits
are explicitly reconciled or rejected using expected heads. Staging is not a
published revision, and a successful HTTP response without a receipt is not proof
of activation. Receipts distinguish no-op, stale and successful change.

## Recovery and retention

Restore creates a new revision/current head from retained bytes after current
profile, target and disclosure checks. It never rewinds the dataset or recursively
restores referenced content. Retention pins immutable manifests/pages and any
fixed target revisions; object GC observes complete fenced reachability. TDB2
compaction preserves retained revision metadata as ordinary live RDF facts.

Movement copies and verifies anchor metadata, manifests and payloads before the
old owner is retired. A restore/cutover uses the dataset epoch rules without
changing the meaning of retained revision IDs. Missing/erased payloads produce
unavailable results, never a current-head fallback.

Validate deep ordered reads, repeated targets, moving/removing the same occurrence,
cycle races, partial staging, stale leases, corrupt pages, fixed/follow selections,
removed targets and restored epochs. The
[revision representation](../implementation/graph-records.md#immutable-revision-representation)
and [Jena command protocol](../storage/jena.md#transactional-command-endpoint) own the
shared physical mechanism.
