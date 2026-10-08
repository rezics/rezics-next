# Erasure owner template

The first write/read operation is a Content revision erasure. Copy
`request.ts`, `journal.ts`, `content.ts`, `receipt-family.ts`, and
`services/main/src/routes/erasures.ts` for another
PostgreSQL-owned target family; extend the single `relay.erasure` journal and
`relay.erasure_target` instead of creating another frontier. Its caller verifies
Account, registers and claims an Access admission, binds a digest to the
idempotency key, checks exact owner targets, journals committed intent, applies
the owner tombstone, seals the Access outcome, and reads the journaled report.
An owner failure after journaling remains pending for `completePendingContentErasures`.
`remediateErasedContentSources` revisits entries that completed before source clearing existed: it reads one
raw window of the journal by `erasure_epoch` (100 rows and one look-ahead), and re-applies each entry's own id and
epoch to targets that still store a source, under the current preservation fence and the exact graph proof. It
never erases a target for the first time, mints no identity and keeps no frontier; every non-cleared outcome is
returned. The original requester's same-key replay reaches the same code. Entries of 65..256 targets are reported
as `graph-limit`.

The executable examples are `tests/qa/integration/erasure-api.test.ts` for
denial, replay, stale/concurrent targets, partial failure, recovery, and bounded
cost, and `tests/qa/fault-recovery/erasure-restore.test.ts` for retained copies
and isolated restore. `reconcile.ts` compares owner copies with the retained
journal and keeps unsupported owner targets held. Graph-owned targets need the
Jena erasure command registration before they can leave that hold.

The receipt family is discovered from `receipt-family.ts`. Main startup supplies
`ErasureService` from its relay and Content pools, and the route module exports
the bearer and idempotency metadata used by OpenAPI generation.

Relay 014 points to the latest signed recovery coverage head across consumers.
`authority.ts` compares the restored Access outbox and every discovered Access
state table with that current head while the Access recovery fence remains held.
The capture and HMAC key require separate protected custody, and capture must
follow the last admitted authority change. This offline check scans Access rows
once; it does not turn an older backup into current authority by itself.

For a journaled Content revision that already has graph data, the isolated
`infra/jena/purge-tdb2.sh EMPTY_DEST_BASE EXACT_REVISION_IRI ERASURE_EPOCH`
builds a new TDB2 copy from retained quads, runs the pinned compactor, and
rebuilds an empty Lucene index. It accepts only an exact Content revision URN.
The candidate retains an `ErasedRevision` tombstone; the native command gate
rejects later inserts naming that IRI. Verify the stopped candidate's exact
graph and direct text reads, retained revision and lineage, and copy inventory;
then copy `erasure-purge.ready` to `erasure-purge.verified`. With the same Fuseki
volume stopped, `infra/jena/purge-activate.sh activate CANDIDATE_BASE
EXACT_REVISION_IRI ERASURE_EPOCH RETIRE_ID` promotes it. A parent marker blocks
startup across an interrupted rename. The old fileset stays inaccessible under
`rezics-retired-RETIRE_ID` until `purge-activate.sh destroy RETIRE_ID
EXACT_REVISION_IRI ERASURE_EPOCH RETIRE_ID` unlinks it after verification.
`purge-activate.sh destroy` reports a digest of the retired-fileset marker only
after unlinking the old generation. Record that evidence against the live TDB2
and Lucene retention domains. Snapshot, backup and media domains remain
`unverified` with a required evidence reason; the erasure's destruction summary
remains `retained` until each copy is resolved. Suppression is reported
separately. The sanitizer follows public and private Content projection anchors,
including `ContentPrivateProjection`, so retained private MatchUnit bytes for
the exact erased revision are excluded from the candidate. The native gate
prevents either public or private references from retargeting that revision.

`graph.ts` supplies the bounded live suppression primitive for one journal
identity and up to 64 exact Content revisions. It inventories public and private
indexed units, removes their triples in one native command, writes exact
tombstones and a graph outbox receipt, then reads the receipt and absence proof.
`outbox-event.ts` is the discovered handler for that graph event. The native
gate rejects replay that names an erased revision. The HTTP request suppresses
the graph first and passes the exact receipt to Content. Migration 122 retains
an immutable supersession of each active preparation while keeping its original
settlement proof. `content-publication/relay.ts` acknowledges old active outbox
events only after checking that supersession against the current graph tombstone
and receipt. `replay-supersessions.ts` applies the same exact check to every
active pin and supersession row in a restored Content owner before
`reconcile.ts` releases its restore hold; the graph erasure is replayed first,
and an unavailable or different receipt keeps that restore held. A replacement
publication yields a new projection; a lost index is replayed by
`task search:rebuild` from the retained Content cut.
Both offline Lucene rebuild paths use `ErasureTextIndexer` to register the
server's filtered-graph text assembler before opening the candidate index.

Cost: preflight and Content erase touch at most 64 exact revisions and their
preparations; the graph command inventories at most 64 indexed units and makes
at most three bounded attempts. Five fixed graph copy domains add constant
relay registration work. Projection replay checks one supersession per old
active event. Restore reconciliation uses two indexed probes per journal
entry, with at most 64 target revisions, and reads no Content bodies for that
proof. The offline sanitizer copies and compacts the complete TDB2
dataset and rebuilds Lucene once, so it scales with stored bytes and requires
capacity for the candidate and retained old generation until retirement.
