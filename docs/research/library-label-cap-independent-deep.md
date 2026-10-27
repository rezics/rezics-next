# Independent label capacity, identity and restoration research

Evidence date: 2026-10-28. This is a design recommendation, not an adopted schema, API or lifecycle decision.
Only this report's existence is accepted here; no product, permission, restoration or purge outcome was run.
The sibling label-cap report was not read. References were read as data; no vendor code was installed or executed.

## Recommendation and necessary adoption choices

Use at most 32 **reservations in the generic subject-fact source authority** per owner/stored subject, separate
from retained assignment rows. A reservation supports a live fact only while its exact assignment and current
definition are live. A deleted parent's reservation is immediately ineffective and may be reclaimed during the
next admitted write, without examining retained history. Preserve the existing tuple row as its own finite CAS
head; add an opaque assignment incarnation. Do not introduce an assignment snapshot archive for identical set facts.

Two meanings need explicit adoption before implementation; the existing documents do not settle them:

1. Definition undo restores its metadata and **unchanged reservations**. A reservation displaced while the parent
   was hidden is no longer a valid child claim; retain that assignment for explicit capacity-checked undo/reassign.
   Never promise restoration of all historic children, or silently restore a displaced child. If the owner requires
   all-or-nothing child restoration, use bounded staged restoration with conflict reporting instead; a header-only
   restore cannot check capacity on arbitrarily many subjects. This report recommends the unchanged-claim rule.
2. Stable assignment ID/revision continuity lasts while its private tuple row is retained. After whole-row purge,
   a fresh assignment has a fresh incarnation and old CAS targets fail. Eternal same-ID, consecutive revision
   continuity after complete erasure is not provided by the current schema. This report recommends finite identity
   continuity and binding destructive commands to `(assignmentId, revision)`, in addition to the logical tuple.

These are the smallest semantic qualifications to adopt, not permission to change routes or frozen tests here.
The cap applies to LIVE facts, including after parent undo. Retention of deleted/hidden payload under a hold uses
no live capacity; an active held fact still counts normally.

## Repository evidence and actual implementation boundary

Read in full: [labels](../library-labels.md), [deletion](../deletion.md),
[Library and Collections](../library-and-collections.md), and the Library README's deletion/restoration and bounded
purge sections. The latter already supersedes terminal label deletion and requires current CAS, 30-day undo,
capacity reacquisition, child-before-parent purge and whole-private-skeleton erasure. Its statement that tables
are absent is stale: [the applied label migration](../../services/kernel/db/library/migrations/20261027190250_personal_labels.sql)
and [native schema test](../../services/kernel/test/library/label-schema.test.ts) exist. The current task's cap of 32 live assignments
rule supersedes the remaining stored-row-cap wording, including parent-hidden rows; that wording is not a storage bound.

Additional read-only evidence, identified by commits rather than treated as imports from this checkout:

- `e9dcf2fabd:docs/library-labels.md` and `specs/library-labels-driver.ts`: reconciled readable-unprofiled assignment,
  distinct Everything facts, terminal account fencing and deferred saved queries. The driver still describes the
  obsolete stored-row cap and cannot prove the new rule without future native outcomes.
- `671f5195:services/kernel/src/library/README.md`, current `specs/library-deletion-driver.ts` and outcomes:
  same-ID undo, exact day-30 failure, replacement/name/capacity conflicts, held payload and stale-purge protection.
- `631fb96c5f:services/kernel/src/library/label-store.ts`, `label-store-lifecycle.sql`, `label-store-rename.sql`:
  real catalogue DAO, owner-scoped point keys, native live-name uniqueness, soft delete and timed restore.
  Lifecycle is one conditional header UPDATE. It currently has no assignment admission, generation or fact fence.
- `0fdd496e22:services/kernel/src/library/collection-source.ts`: source ABI only, throwing unavailable factory;
  `f6626668c2:services/kernel/src/library/canonical-source-store.ts`: derived-store ABI, also unimplemented.
  Both require current native evidence, charged internal keys, resumable alias groups and a shared owner basis.
  Neither is an implemented generic fact store or a production `sourceGet` capability.

Existing assignment columns suffice for the logical key `(route, account_id, subject_id, label_id)`, timestamps,
integer CAS revision, transaction stamp, individual tombstone and exact 720-hour deadline. They do **not** supply
opaque assignment identity, a bounded live access path, capacity serialization, legal-hold authority or durable purge.
Definition `revision` suffices as its deletion-episode stamp while deleted: rename is live-only, restore advances it.

## Primary sources and common patterns

The cache root below is `/home/edge/projects/rezics/rezics-next/.reference/`; INDEX.md records reuse and licences.

| Source, pinned cache and licence                                                                                                                                                      | Inspected primary files and finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, `library-shelf-maintenance/postgres`, PostgreSQL License (`COPYRIGHT`)                                                         | [CREATE INDEX source documentation](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/ref/create_index.sgml), `src/backend/commands/indexcmds.c:CheckPredicate`: predicates cannot depend on another table's changing state. [MVCC/locks](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/mvcc.sgml): snapshots, lock strength, serialization retries. [Limit executor](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeLimit.c): LIMIT consumes its child's outputs, not that child's examined keys. |
| Discourse `589325e2b8466178ee83acac9ec411de555a0093`, `partitioned-sitemap-feeds/discourse`, GPL-2.0-or-later (`README.md`, `LICENSE.txt`)                                            | [TopicTag](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/topic_tag.rb) has a surrogate ID and unique topic/tag pair; [Tag](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/tag.rb) uses dependent destruction and count repair; [Trashable](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/concerns/trashable.rb) separates ordinary scope from retained deleted rows. These do not establish bounded parent deletion or restoration admission.                                                              |
| Nextcloud Server `0e43b0a02d4ab36727ad121b6dc91238587b386c`, `library-entry-undo-independent-current/nextcloud-server`, AGPL-3.0-only for inspected file (SPDX; repository `COPYING`) | [apps/files_trashbin/lib/Trashbin.php:restore/getUniqueFilename](https://github.com/nextcloud/server/blob/0e43b0a02d4ab36727ad121b6dc91238587b386c/apps/files_trashbin/lib/Trashbin.php) rechecks destination writability and free space, avoiding overwrite by choosing another name. Recheck current constraints; do not import its renaming policy or filename search loop.                                                                                                                                                                                                                                                                                  |

These systems separate logical uniqueness, record identity and hidden retained data; restore is not unconditional
reinsertion. None inspected implements this exact combination of a live cap of 32, parent O(1) deletion and private erasure.
The slot invariant and counterexamples below are original reasoning, not claims of a copied proven implementation.
Official PostgreSQL [partial indexes](https://www.postgresql.org/docs/18/indexes-partial.html),
[index restrictions](https://www.postgresql.org/docs/18/sql-createindex.html),
[CTE materialization](https://www.postgresql.org/docs/18/queries-with.html) and
[EXPLAIN](https://www.postgresql.org/docs/18/using-explain.html) support the proposed native techniques, not a measured plan.

## Why the smaller alternatives fail

- Put 4096 distinct assignment rows for one subject behind deleted definitions, then 32 live rows. Joining parent
  liveness before `LIMIT 33` may examine 4128 assignment keys. Returning 32 does not bound the source. Even
  `WHERE assignment.deleted_at IS NULL` includes all 4096 parent-hidden children.
- A subject advisory lock plus that query prevents racing writers but retains the unbounded scan and missing
  assignment ID. A live counter becomes stale on parent deletion; fixing it synchronously touches all subjects.
  A positive pointer to one parent becomes invalid when that parent changes; its failure proves no negative about
  other sources. Neither a counter nor a pointer is current membership authority.
- `WHERE parent.deleted_at IS NULL` is not a legal cross-table partial index predicate. Calling a parent-reading
  function IMMUTABLE lies to PostgreSQL; parent updates do not maintain child index entries. Copying parent-active
  or parent-generation into children leaves stale entries unless fanout occurs. An epoch equality join still scans
  unbounded old child keys; partitioning by label generation cannot bound the union for one subject.
- An owner generation switch invalidates unrelated live facts; a definition generation alone cannot rebuild every
  subject's active set in constant work. An increment-only generation is useful evidence, not a second catalogue.
- Restore a deleted parent with 32 assignments on subject S after those slots have been reused by 32 other labels:
  blindly clearing the header tombstone creates 64 live facts if retained assignments remain the active authority.
  Filtering to the first 32, silently stealing claims, or declaring all children valid violates the contract.
- Resetting an erased tuple to revision 1 lets an old revision 1 unassign target a new fact (ABA). Keeping its private
  head forever violates whole-private-skeleton purge. Deterministic tuple IDs alone still permit revision ABA and
  durable linkability; a secret-derived ID/global noncycling revision scheme would need a different accepted identity
  contract, key lifetime and revision range. It is not supplied by today's columns.

## Proposed native keys and invariants

Names in this section are proposals for the generic owner, not new exported APIs. No private profile policy exists.
Keep assignment rows as retained facts/CAS heads. Add `assignment_id uuid NOT NULL`, unique by
`(route, account_id, assignment_id)`. Preserve the tuple PK and existing label FK; no assignment archive/head table.
All mutation CAS checks include tuple, assignment_id and revision. Increment without wrapping; integer exhaustion
fails closed. The assignment ID is the retained incarnation; it is not a deletion-episode ID or a bearer capability.
An episode is `(owner, assignment_id, tombstone_revision, deleted_at)`; for definitions substitute label_id.
Reassign uses the same retained row/ID with a higher revision; old timers and old CAS cannot affect it.

Add definition `visibility_generation bigint NOT NULL DEFAULT 1`, advancing only on delete/restore, never rename.
Keep it with its definition and purge it there. A shared owner fact-membership fence advances once per effective
source mutation or parent liveness change, without enumerating subjects/Collections; it is the built-in source's
native fence, not a definition dictionary or a claim that facts are positive/negative. It also fences derived repair.
Use the generic owner's one header, proposed PK `(route,account_id)` with `fence bigint NOT NULL CHECK(fence>0)`;
an atomic INSERT/ON CONFLICT UPDATE increments it, failing closed on overflow. Purge it with the private owner.

Integrate reservations as label rows of the **same** prospective `library.subject_fact_source` used by generic
fact producers and readers. Required label fields: route, account_id, subject_id (unchanged stored ID), driver,
source_id (= assignment_id), label_id, source_revision, label_slot. Source revisions match the current retained row.
Use smallint driver/slot columns; label driver ordinal 2 matches the accepted source ABI, without changing its codec.
For a polymorphic table, also add nullable `label_assignment_id uuid`: label rows require equality with source_id;
other drivers require NULL. A foreign key cannot be conditional on driver, so a blanket source-ID FK is incorrect.
Non-label drivers keep their own rules; the following constraints apply only to labels:

```sql
-- Alongside generic PK (route,account_id,subject_id,driver,source_id):
CHECK (driver <> 2 OR
       (label_slot IS NOT NULL AND label_slot BETWEEN 1 AND 32 AND label_id IS NOT NULL
        AND source_revision IS NOT NULL AND source_revision >= 1
        AND label_assignment_id IS NOT NULL AND label_assignment_id = source_id));
CHECK (driver = 2 OR label_assignment_id IS NULL);
CREATE UNIQUE INDEX fact_label_slot ON library.subject_fact_source
  (route,account_id,subject_id,label_slot) WHERE driver = 2;
CREATE UNIQUE INDEX fact_label_tuple ON library.subject_fact_source
  (route,account_id,subject_id,label_id) WHERE driver = 2;
CREATE INDEX fact_label_page ON library.subject_fact_source
  (route,account_id,label_id,subject_id,source_id) WHERE driver = 2;
CREATE INDEX fact_label_raw ON library.subject_fact_source
  (route,account_id,subject_id,source_id) WHERE driver = 2;
```

Add `FOREIGN KEY(route,account_id,label_assignment_id)` referencing the assignment unique key, with NO ACTION;
driver/source_id and generic owner keys must be NOT NULL. Assert subject/label equality in the transaction
and current-read join. Existing assignment owner-label index serves retained cleanup, never admission. Existing
deleted-row due indexes remain; they do not contain children hidden only through a parent. Parent purge walks the
owner-label child index directly. Private parent names may need nullable expired tombstones for child-only holds:
allow NULL only on deleted definitions, retain the existing length check and require non-NULL for live definitions.
This lets due name bytes disappear while a held child's FK still needs a temporary private anchor.

Serialization guard: `pg_advisory_xact_lock(hashtextextended(concat_ws(':', 'library-label-cap', route::text,
account_id::text, subject_id::text), 0))`, using canonical UUID text. Hash collisions cause extra contention only.
This transaction lock stores no private head. It is sufficient **with** slot constraints, current parent locks and
incarnation CAS, not alone. If the generic owner selects a row guard instead, it must purge that private subject
guard after indexed source/retention exhaustion; its integer is not a live count or permanent tuple identity.
For a multi-subject purge page, deduplicate and sort actual signed advisory keys before acquiring them, then parents
by UUID. Compute guard keys in the bounded raw-page SELECT; never acquire locks on an unbounded query's outputs.

## Transaction protocol and adversarial interleavings

Use the real command's SERIALIZABLE transaction and existing bounded retries/deadline, not a DAO-owned connection.
Order: current admission and `shareAccount` barrier; subject guard; discover <=32 raw reservations; parent rows
in UUID order `FOR SHARE` (including the requested parent); exact assignment row `FOR UPDATE`; source changes;
shared membership fence; receipt/outbox commit. Hold parent locks through commit. `FOR KEY SHARE` is too weak:
ordinary non-key header updates can pass it. Definition-only commands take their one parent lock and never later
take subject guards. Purge acquires subject before parent too; never hold a parent lock while waiting for a subject.
The SERIALIZABLE snapshot may predate a guard wait. Retry the whole command with a fresh snapshot on serialization
failure/deadlock and a proven slot/tuple insertion race (which may report unique_violation); do not retry a statement
inside an aborted transaction or misclassify a genuine name/capacity conflict. The existing wrapper needs this audit.
These qualifications follow PostgreSQL's [isolation rules](https://www.postgresql.org/docs/18/transaction-iso.html)
and [row-lock compatibility](https://www.postgresql.org/docs/18/explicit-locking.html), not the advisory lock alone.

Admission discovers all reservations, not history. Lock <=33 distinct parents by exact owner/label keys. Read the
target tuple. An already effective assignment returns its unchanged ID/revision **before** capacity checks, with
no fact write/event/fence change. Otherwise choose an unused slot or one whose locked parent is deleted. Reclaim
only the one needed: CAS-check its old assignment/source revision, stamp the child tombstone with that parent's
original deleted_at/purge_after and advance child revision, remove its source claim, then insert the requested
claim and create/revive the target row. Retain old payload; this is not early purge. Roll back everything on conflict.
Ordinary writes against a hidden definition are concealed/rejected; they cannot start a later child undo clock.

| Race / operation                              | Required result under this protocol                                                                                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two different assignments contend for slot 32 | Same subject guard serializes them; one fills it, the other conflicts if all 32 parents remain live. Concurrent duplicate calls return the same identity/revision.                                                                              |
| Parent delete races assignment/reclaim        | FOR SHARE versus header UPDATE orders commits. Before delete, new assignment may commit then becomes hidden; after delete, assignment is rejected or the stale slot is reusable. No subject fanout.                                             |
| Rename, normalized no-op, name recreation     | Existing live-name index decides uniqueness. Rename changes only header/name metadata, creates no fact; no-op preserves revision. Recreated name has a different label ID.                                                                      |
| Unassign, reassign, delayed unassign, reclear | Live-parent unassign advances assignment revision and deletes only its exact source claim. Reassign revives the retained ID at a newer revision; stale removal fails. Reclear creates a new episode/deadline; old episode undo/purge conflicts. |
| Assignment undo                               | Require current ID/revision, kernel time < purge_after and live parent; reacquire a slot under the same guard. Full capacity conflicts without effects. It never restores the parent.                                                           |
| Parent undo                                   | Native name/CAS/time check and generation/fence advance. Unchanged claims become effective, always <=32 slots. Independent child tombstones and reclaimed claims stay hidden; explicit child undo can reacquire capacity.                       |
| Old purge versus newer assignment/parent      | Exact episode predicate and lock recheck fail after restore/reassign/reclear. Never delete by tuple alone, old label name, or workflow ID.                                                                                                      |
| Hold or terminal account deletion             | Holds preserve covered bytes, not capacity/disclosure. Terminal T prevents new owner commands/replays; system purge checks terminal account/T without impersonating an active account.                                                          |

Slot proof: each effective label fact has a distinct reserved slot in 1..32. Parent delete removes effective facts
without increasing reservations. Reclaim replaces one ineffective reservation under its parent's lock. Parent undo
can only activate existing reservations. Therefore every commit has <=32 live labels, irrespective of retained N.
This proves logical capacity, not physical PostgreSQL scan/buffer bounds or product authority.

## Read authority, bounded work and validation still required

`sourceGet` must remain read-only. For a subject, first materialize reservations, then perform exact current
assignment and parent checks in the same statement snapshot. Apply source liveness before producing Everything
evidence. No opportunistic cleanup in reads, cached allow, owner-wide label lookup or unconditional negative count.

```sql
WITH raw AS MATERIALIZED (
  SELECT subject_id, source_id, label_id, source_revision, label_slot
  FROM library.subject_fact_source
  WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND driver=2
  ORDER BY source_id LIMIT 32
)
SELECT raw.*, l.visibility_generation FROM raw
JOIN library.label_assignment a
  ON a.route=$1 AND a.account_id=$2 AND a.subject_id=raw.subject_id
 AND a.label_id=raw.label_id AND a.assignment_id=raw.source_id
 AND a.revision=raw.source_revision AND a.deleted_at IS NULL
JOIN library.personal_label l
  ON l.route=$1 AND l.account_id=$2 AND l.label_id=raw.label_id
 AND l.deleted_at IS NULL;
```

Sort this bounded result by label_id for subject assignment pages. For one-label pages, use fact_label_page with
`subject_id > after`, ORDER BY subject_id/source_id and LIMIT P **inside raw before liveness checks**. For generic
label-driver repair use fact_label_raw with `(subject_id,source_id) > after`, limit P before checks. P<=100 includes
lookahead; advance after the last examined key even if every parent is deleted. Never refill to obtain P live rows.
All exact joins require measured PK/unique-index probes; a materialized CTE alone does not force that join plan.

| Operation, excluding shared admission/receipt work | Proposed bound per attempt, not measurements                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject label read                                 | <=32 raw source keys, <=32 assignment and 32 parent points; one SQL statement, O(32) memory.                                                                                                                                                                                                |
| Assignment admission with stale-slot reuse         | <=32 source keys, <=33 parent locks, one target point and one stale child mutation; <=41 DAO statements using separate ordered parent probes (1 guard +1 slots +33 parents +1 target +2 reclaim +1 target write +1 source insert +1 fence).                                                 |
| Unassign/individual undo                           | Exact tuple/source plus guard; undo uses the admission bound; unassign needs no history or subject scan.                                                                                                                                                                                    |
| Definition rename/delete/metadata undo             | Rename one DAO statement, no fact fence; delete/undo one header statement plus one owner-fence statement, independent of subject count.                                                                                                                                                     |
| Assignment page / repair                           | <=P<=100 raw source keys, <=P assignment and P parent probes, one materialized SQL statement before final shared-protocol checks; last-examined continuation, no hidden P+1.                                                                                                                |
| Purge                                              | <=P<=100 retained child keys before hold tests. With sorted subject guards, one parent lock, child locks/deletes, exact source deletes, one fence and two durable work statements: <=4P+7+H(P) statements including BEGIN/COMMIT; H(P) is the shared hold port's not-yet-established bound. |

For an explicit fixed-width projection, slot fields (route4, three UUIDs48, label UUID16, FK UUID16, revision4,
slot2, driver2) total 92 bytes; assignment witness (ID16/revision4/deleted_at8)28 and parent witness
(ID16/revision4/generation8/deleted_at8/purge_after8)44. Thus 32 triples carry <=5248 binary field bytes,
100 carry <=16400; these exclude protocol, NULL markers, tuple/index headers and statement parameters.
Reserve finite wire/memory bytes too, e.g. 64 KiB for these projections, and measure actual transport encoding.
Catalogue names add <=400 UTF-8 bytes each. No payload/name belongs in an assignment source projection.
Retained assignment rows project 120 fixed field bytes (five UUIDs, route/revision, four timestamps); 100 are 12000.
Together with source/parent evidence they stay <=25600 field bytes. Hold/work payload costs are additional and
must have real shared-port limits before claiming a complete purge budget. Native FK/unique probes and transaction
control also count as work; one application SQL statement is not one physical point or tuple examined.
Parent finalization adds an indexed child-exhaustion point and exact parent DELETE; it cannot skip held children.

Source ABI accounting must charge all internal/repeated assignment keys and final evidence checks, not merely one
emitted subject. Reserve 32 source keys plus 32 assignment rereads (and 32 parent keys if classified as raw witnesses) before a
full subject call; otherwise use a smaller resumable raw window. One owner window must remain <=100 charged keys,
Zone's aggregate <=256. Points, empty seeks, statements and bytes have separate finite allowances. Actual Semantic
basis reads additionally reserve 8192 identityMetadataRows plus core-home points; they are not hidden inside 32/100.
For general pages, conservative source/assignment/parent charging is 3P keys: P<=33 before reserving final-use
rereads, and smaller after those reservations. P=100 is a raw ceiling, never permission to spend 300 internal keys.

Derived index presence is never a current positive or negative. Recheck definition generation, exact claim and
actual owner source fence on every proof/final use. A changed parent or source fence invalidates old negatives,
coverage and publication CAS; return not_proven/readiness until the existing source protocol re-establishes proof.
No catalogue of all parent generations, extra cursor vector or permission mirror is needed. Preserve accepted raw
fact UUID/stored-subject continuation and Semantic original/terminal checks; do not rewrite aliases or stored IDs.

Before activation, use existing native growth capture at 64/512/4096 **inactive rows on the same subject**, not just
unrelated owners. Include long/interspersed dead-parent histories, all 32 live, all 32 stale, same-tuple churn,
held tombstones, first/deep pages, concurrent slot 32/33, definition undo after reuse and parked old purge. Capture
actual EXPLAIN ANALYZE/BUFFERS rows times loops, rows removed by filters, index conditions, heap fetches, blocks,
statements, failed/retried attempts and bytes. Require raw limits below filtering and exact point joins; reject broad
assignment/parent scans or sort/hash work over retained history. Run warm/cold and churn/dead-tuple cases without
forcing indexes to disguise the production plan. B-tree depth may grow logarithmically; MVCC versions, vacuum,
contention and IO prevent a hard physical 32/100 tuple or latency guarantee. Returned rows and estimated cost are
not proof. No native experiment was essential to these logical counterexamples; plan validation remains unperformed.

## Erasure, migration and implementation handoff

At ordinary expiry, purge the whole assignment/head/source relation under exact ID/deleted revision/deleted_at
and current hold checks. A fresh create may reassign the identical fact even when undo has expired; that is an
explicit new write, not an expired restore. While retained it advances the same ID/revision, invalidating old work.
The existing newId(route) mints UUIDv7-based IDs; use a newly minted ID after actual purge, never a caller's old ID
or derived tuple ID. Its collision model is probabilistic, not an eternal nonreuse registry. If strict mathematical
nonreuse is required, an allocator with a noncycling durable high-water mark and namespace cutover is an additional
owner decision; it need not retain tuple mappings. Never reset/wrap revisions under an existing incarnation.
If frozen command input cannot bind assignmentId, another native alternative is a global noncycling revision
sequence, used for **every** assignment mutation, not just creation: all committed revisions are distinct, so an
old tuple/revision cannot match a new incarnation. A sequence contains no owner/tuple mapping or private skeleton.
Use a regular WAL-logged sequence with INCREMENT 1, CACHE 1 and NO CYCLE, seeded above every previously issued
revision; if that bound is unknown, an identity/command namespace cutover is required, not merely max(current rows).
Current integer revisions exhaust at 2^31-1 and must then refuse writes; widening the transport/type is a separate
decision. Never reset the allocator; backup/namespace cutover must preserve nonreuse of all previously issued CAS
values. PostgreSQL [CREATE SEQUENCE](https://www.postgresql.org/docs/18/sql-createsequence.html) documents noncycling
allocation and gaps. This is a viable tradeoff, not a reason to assert that revision+1 after purge is safe.

Parent purge runs generation-scoped owner/label/subject pages, rechecking the parent episode in each writing
transaction; remove reservation references and child rows before the definition. Held rows count as examined and
advance the cursor, but retain unfinished held work for release/rescan, not a false completed checkpoint. Child-only
holds retain only necessary parent anchors, not expired name bytes; erase anchors once indexed FK exhaustion is
proven. All stale reservations may be detached without erasing held payload. Account purge is due at terminal T,
not T+30 days; erase all private reservations, assignments, headers, owner fences, derived evidence and located
receipt/outbox/workflow payload under the shared authority's custody rules. Durable page effects, checkpoint,
receipt and next intent commit together; commit-before-enqueue must remain runnable. No local job framework.

Do not take parent locks across pages. Reuse existing native durable work primitives, but acknowledge that general
hold/runnable-purge adapters are missing. `trustedAccount` is active-only. `runCommand` currently requires an event;
the command owner also needs an honest no-effect receipt path for fresh-key duplicate assignment without a second
fact event. Authorization, scopes, epoch, real subject/resource Access and shareAccount stay outside the DAO,
before receipt lookup including replay. Readable unprofiled subjects remain eligible; no profile pin is invented.

Migration: add nullable assignment IDs, visibility generation and generic-source constraints/indexes additively.
Backfill <=100 raw tuple keys per durable page before filtering, preserving logical keys and user values; assigning
new IDs necessarily writes old rows and is not a metadata-only migration. No public assignment identity exists in
the current implementation to remap. Build reservations with bounded per-subject progress: live children first,
then parent-hidden, non-individually-deleted children in deterministic label-ID order, up to 32 total. A 33rd LIVE
candidate is an explicit cutover conflict. Hidden excess must receive the explicit reclaim transition above
(parent deadline, child revision advance), under the adopted unchanged-claim rule; never silently lose undo claims.
Data compliant with the old stored-row cap fits without this reclaim. There is no route, tuple or subject rewrite and no archive.
Keep label writes unavailable during initial construction; catalogue parent writes must participate in the shared
fence before construction starts. Fence/restart pages affected by parent changes, validate uniqueness/non-NULL and
source completeness against a stable owner fence, then enable all read/write paths together. A generic owner's
per-driver readiness bit/checkpoint is required and private; incomplete means unavailable, not an empty Library.
Keep old tuple PK and existing APIs; never dual-read retained rows as active after cutover. No saved-query work.

Suggested implementation slices, each capped at 400 changed lines including native tests and <=8 paths:

- Storage: migration, schema dump, generic source DAO/types, source constraint SQL and native schema/growth tests
  (<=7 paths). Requires the generic owner adopting these reservations as its sole label source authority.
- Assignment DAO: store TS, guard/slot-select SQL, assignment CAS SQL, reclaim SQL, source mutation SQL, native
  state-machine and growth tests (<=7). Depends on storage and committed catalogue DAO, not imagined Access.
- Definition integration: catalogue lifecycle SQL/TS, shared source-fence SQL/DAO, source label reader SQL/TS and
  native restoration/race tests (<=8). Adopt unchanged-claim restoration before dispatch; rename creates no fact.
- Commands/source: existing personal commands/routes, common no-effect receipt support, source adapter, existing
  driver/outcomes and native admission tests (<=8 per owner slice). Preserve current transport and real Access.
- Durable deletion: purge adapter TS/SQL, work-module/work registration, hold binding, page/crash/growth tests
  (<=8). Requires actual shared deletion/hold/custody ports; child-before-parent and terminal fencing are mandatory.

The recommendation is one bounded native access path plus retained tuple identity, conditional on the two explicit
adoption choices above. This report supplies evidence and a validation plan; owning documents must adopt decisions.
