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

## Backups and completion

Keep a restored cut offline until the separately recoverable erasure and
authority journals reconcile. If journal coverage is missing, the affected
restore remains unavailable. Backups retain bytes until actual sanitization,
destruction or expiry, even after current reads are denied. External copies
already delivered cannot be recalled by server deletion.

The [fixture erasure drill](../../tests/qa/fault-recovery/erasure-restore.test.ts)
and [offline graph purge drill](../../tests/qa/fault-recovery/erasure-graph-purge.test.ts)
qualify their exercised cuts. OPS10 still needs a production storage and media
destruction campaign; neither logical deletion nor a fixture rebuild proves it.
Use the [recovery runbook](recovery.md) for stopped owner copies and reactivation.
