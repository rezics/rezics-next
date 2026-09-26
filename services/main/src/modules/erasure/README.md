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
rejects later inserts naming that IRI. Operators must inventory and keep the
old fileset inaccessible. This command does not activate the candidate or
complete the Content owner erasure; those steps require journal and graph
release proof before the published revision's preparation pin can be cleared.
