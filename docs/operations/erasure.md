# Erasure, retention and exact revisions

## Inventory and disclosure fence

Classify credentials/control state, current RDF, revision manifests and payloads,
source evidence, object bytes, Lucene documents, caches, delivery metadata, logs,
audit records, retired storage generations and backups. Each class declares its
purpose, permitted disclosure, retention/holds and verified erasure procedure.
Raw secrets and private controller mappings stay outside the product graph.

Track `requested -> fenced -> inventory_complete -> deleting -> reconciling -> verified`.
A hold, missing copy or unqualified destruction mechanism is an explicit blocked
or retained status. Record authority, affected resource/revision IDs, copy
locations and a monotonically advancing erasure epoch. Fence disclosure and new
activation before deletion; workers, rebuilds, imports and restores check that
frontier. A graph deletion alone cannot invalidate existing caches or deliveries.
The current Access implementation can durably deactivate one principal, advance
its enforcement epoch and retain a private outbox fact. It blocks later Access
claims and current Work reads; a bounded reconciler settles pending Work
create/edit admissions. Account's authenticated deletion path requires that
fence before deleting the user, sessions and OAuth tokens. The local drill
checks this ordering and refuses deletion during an Access outage. Other
consumers, a cross-owner erasure journal and physical deletion still require
implementation.

## Current RDF and text deletion

Main submits a guarded command through the Fuseki `text:TextDataset` endpoint to
remove current assertions and update allowed tombstone/receipt state together.
The configured `text:uidField` supports deletion of the corresponding Lucene
entries. Deleting directly through a raw TDB2 path bypasses this maintenance and
is restricted to an offline migration followed by index reconstruction.

Verify both a graph read and a direct `text:query` over the affected graph without
an RDF join that could mask an old hit. Retain and verify a non-indexed graph
anchor for that probe, as in the [quickstart](installation.md), so a missing graph
cannot short-circuit index evaluation. Test matched literals, snippets, counts
and copied labels, not just a resource's root page. Even a deleted Lucene document
may remain in old segments and backups. Logical deletion is not physical erasure.
The bootstrap mapping is illustrated by the
[assembler](examples/fuseki-text.ttl); product mappings must inventory every
indexed predicate and derived document recipe.

## Revision records and physical copies

TDB2 does not provide the permanent revision history required by REZICS. Main
maintains immutable revision manifests/payloads and their references under the
[history contract](../implementation/graph-records.md). Erasure explicitly covers those
objects in addition to current RDF. A RevisionRef whose content is erased returns
erased/unavailable, never replacement bytes under the original reference. Keep
only permitted non-sensitive tombstones and decision evidence.

Deleted RDF strings can remain in storage dictionaries, old database generations,
journals and filesystem/media copies. TDB2 compaction switches active storage
while old generations can survive; its
[administration contract](https://jena.apache.org/documentation/tdb2/tdb2_admin.html)
does not establish selective byte sanitization. Encryption at rest alone does
not erase selected plaintext RDF, Lucene documents or copies protected by other keys.

When physical deletion is required and no qualified selective purge covers the
class, use a controlled sanitized rebuild:

1. Keep the erasure fence active, stop admissions and the only Fuseki JVM, and
   inventory active/retired database, index, object, staging and backup locations.
2. Produce an authorized retained RDF dataset and retained revision/object set,
   excluding forbidden content while preserving unaffected named graphs, identity
   and exact hashes. Never place the removed plaintext in the verification report.
3. Load a new empty TDB2 location using the compatible TDB2 tooling; rebuild a
   new empty Lucene index from its approved RDF and recipe. Keep the old generation
   inaccessible. Capacity must cover the rewrite and any required retained copies.
4. Reconcile retained manifests, receipts, references, authority and erasure epochs.
   Verify forbidden graph/text/object reads are absent and unaffected revisions
   resolve to their original bytes. Activate with a new `dataEpoch` and index
   generation so pre-rewrite handles and jobs cannot reactivate old content.
5. Destroy or expire each obsolete controlled fileset, object, snapshot and backup
   under the declared policy, including filesystem snapshots and encryption-key
   scope. Record evidence per storage class; suppressing access is not evidence
   that the underlying bytes were destroyed.

This maintenance procedure is a REZICS implementation requirement, not a built-in
Jena purge command or an already supplied sanitizer. Coalesce requests and choose
retention domains to bound cost; do not promise a physical completion deadline
until the selected storage/media procedure is qualified.

## Backups and completion

Backups declare expiry, holds, custody and restore restrictions. Report retained
copies as retained until they are sanitized, destroyed or expire. A separately
recoverable erasure journal must be applied before old backups are served or
outbound work is replayed. If journal coverage is unavailable, keep the affected
restore offline. Independent previously delivered copies/screenshots cannot be
recalled through server deletion.

Completion requires the copy inventory, actual destruction/retention disposition
and probes for current/exact-revision reads, search, payload delivery, reimport,
cached generations and an isolated restore. This documentation task specifies
that gate; it has not executed an erasure or storage-media qualification.
