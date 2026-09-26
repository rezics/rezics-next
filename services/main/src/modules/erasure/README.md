# Erasure owner template

The first write/read operation is a Content revision erasure. Copy
`request.ts`, `journal.ts`, `content.ts`, and
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

Activation also needs the shared Access admission registry to recognize
`erasure.request` as receipt family `erasure-request`, and Main startup to supply
`ErasureService` with the relay and Content pools. Those composition changes
are outside this module.
