# Erasure, retention and exact revisions

Inventory credentials, PostgreSQL bodies/WAL, RDF, revision manifests and
payloads, objects, Lucene documents, caches, deliveries, logs, retired
generations and backups. Record authority, exact affected IDs, copy locations,
retention/holds and an advancing erasure epoch. Keep raw secrets and private
controller mappings outside the product graph.

## Operator sequence

1. Fence new admission, publication, projection and disclosure before deleting
   bytes. Quiesce writers and retain the journal that blocks stale replay.
2. Resolve holds and inventory each live and retained copy. A missing copy or
   unqualified deletion method is a blocked or retained outcome.
3. Remove current RDF and text through guarded commands. Probe exact revision,
   payload, graph and direct text reads; an RDF join can hide stale Lucene hits.
4. Where selective physical purge is unavailable, stop the sole Fuseki owner and
   rebuild an approved TDB2 and empty Lucene generation from retained sources.
   Keep the old generation inaccessible. Reconcile receipts, authority,
   references and epochs before activation.
5. Sanitize, destroy or expire obsolete filesets, objects, snapshots and
   backups under their declared policy. Record evidence for each storage class.
   Report suppression and physical destruction separately.

The [quickstart](installation.md) exercises logical text deletion using its
[raw fixture](../../infra/jena/fuseki-text-quickstart.ttl); the
[product assembler](../../infra/jena/fuseki-text.ttl) and derived recipes need
their own copy inventory. An erased RevisionRef remains erased or unavailable;
it must never resolve to replacement bytes.

## Live copies and retained recovery copies

The retention policy requires immediate suppression and deletion from active
stores within 30 days. Live erasure must remove
raw payload bytes from the affected owner rows and exact objects, including
media originals, derived objects and quarantine copies. Preserve historical
receipt identities, original digests and positions; an erased RevisionRef never
resolves to replacement bytes. Denied reads or an `erased` lifecycle flag alone
do not prove byte destruction.

Backups must age out within 90 days. Retained PostgreSQL WAL shares that 90-day
recovery ceiling: deleting a live row does not remove its older payload from a
base backup or WAL. These are retention obligations, not evidence that a
deployment has configured or completed sanitization, destruction or expiry.

## Backups and completion

Keep a restored cut offline until the separately recoverable erasure and
authority journals reconcile. If journal coverage is missing, the affected
restore remains unavailable. Backups retain bytes until actual sanitization,
destruction or expiry, even after current reads are denied. External copies
already delivered cannot be recalled by server deletion.

The [fixture erasure drill](../../tests/qa/fault-recovery/erasure-restore.test.ts)
and [offline graph purge drill](../../tests/qa/fault-recovery/erasure-graph-purge.test.ts)
qualify their exercised cuts. The
[physical campaign](../../tests/qa/fault-recovery/erasure-campaign-qualification.test.ts)
qualifies stopped-generation replacement and destruction on isolated retained
fixture copies. Production storage and media still need their own destruction
evidence; neither logical deletion nor a fixture rebuild proves it.
OPS11 restore evidence covers only the cuts qualified against the independently
retained current journal; an old journal bundled with an old backup cannot prove
that later erasures were replayed. Retained journal replay must remove restored
live payloads and objects and verify their absence before release. A saved
completion flag is insufficient if a restore has replanted bytes.
Use the [recovery runbook](recovery.md) for stopped owner copies and reactivation.

## Retained-source qualification

Publish one source for each complete owner/schema/image input key. Consumers
verify its immutable manifest-bound custody before and after use, restore
isolated writable copies and never rebuild the producer. A declared producer
build runs once under its own deadline before the physical cut. The physical
preparation clock then covers cut, seal and backup verification within 600
seconds; an adapter without a separate producer declaration keeps its single
preparation clock. Each restore, startup and readiness retains its own
600-second bound. A failed build seals no selectable source and cleans staging.

The owner completion qualification (`owner-restore-erasure-completion.test.ts`
under [fault recovery](../../tests/qa/fault-recovery/)) passed 103 assertions in
QA `20261015t200423-eab99f` on `7aad8d39c3234b06e21fd2ca8ea0f9c9a8826940`.
The separate production consumer qualification
(`owner-restore-erasure-production.test.ts`) passed 549 assertions and all 15
retained cases in `20261015t211446-1217fc` on
`937f20ad0ace19dd544626ceaf895819c17b1d37`. The latter used one running template's
database clones for cases that do not assert physical startup, preserving
physical copies for startup cases. Its active operation time was 214.984/360
seconds; cleanup was separately bounded at 73.589/120 seconds. These are
different qualification revisions, not one combined full-drill pass.

From clean main `54c95044eb7e5b5c77d7f90f81b3b697f9e66ca5`, QA
`20261015t221640-800048` ran the registered serial schedule against retained
small fixture `fx-small-c3f5d4e45d33`. OPS10 passed 19 tests / 217 assertions,
including both physical copies. The erasure restore drill failed during setup
because its Contribution environment omitted the Content reference fence.
After supplying that pool, `20261015t222802-fcec19` reached 87 assertions before
the setup expected `reconciling` from an erasure that had only suppression and
inventory recorded. The owner correctly reported `inventory_complete` with a
pending live target. Keep this drill unqualified until setup completes the
owner transition without weakening its assertions. The OPS10 pass does not
discharge this restore-journal obligation or qualify production media disposal.
