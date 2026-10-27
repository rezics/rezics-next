# Independent label live-cap and restoration research

Research evidence, 2026-10-28. Names and SQL below are proposals, not adopted storage/API authority.

## Recommendation

Use the assignment row itself as the retained tuple head, with an optional native reservation numbered 0–31.
A partial unique index limits reservations per owner/subject; a second partial index reads only reservations.
The **same generic subject-fact source** must use this path as its label driver. Retained rows outside that
path cannot support Everything. A definition tombstone immediately invalidates its reservations through a
current parent check. A later assignment transaction can reclaim one such reservation without searching history.
This needs neither synchronous definition fanout nor a second label catalogue, live counter or permission cache.

Restore a definition's still-reserved, independently live children only. Reclaiming a reservation must atomically
soft-delete that child, retaining its identity until its original deadline; restoring the definition cannot
resurrect it. Individual undo reacquires capacity and conflicts if full. This interprets “only still-valid
assignments” concretely; an all-or-nothing restoration of every historical child is a different requirement.

Use an account-scoped revision high-water mark, containing no subject/label relation, to prevent numeric-CAS ABA
across whole-tuple purge. Preserve assignment identity through unassign/reassign while its retained row exists.
After whole-private-fact purge, creation has a new incarnation/opaque ID and a never-reissued revision.
The smallest remaining owner clarification is that stable assignment identity ends at whole-fact purge.
If identity must survive purge forever, the present identity/purge requirements cannot both hold without a
specified derivation scheme or retained identifying state. This report adopts neither exception nor a new API.

## Repository evidence and precedence

Read the full local [label specification](../library-labels.md), [deletion policy](../deletion.md),
[Library deletion section](../../services/kernel/src/library/README.md#deletion-and-restoration-first-public-contract),
and [Library model](../library-and-collections.md). The base is `49fd7ef7e3860e3951b5648aa10ea18785ae5c07`.
Its label prose still contains terminal deletion, stored-32 and an unresolved profile question. Read-only
reconciled evidence at `b4ebaf8710` (`docs/library-labels.md`, `specs/library-labels-driver.ts`) settles
30-day undo, terminal account erasure, and labels on readable unprofiled subjects. The current task explicitly
supersedes stored-32 for **both** deleted assignments and children of tombstoned definitions. No sibling cap
report was read. Nothing here converts research into a second authoritative topic specification.

Actual applied-schema evidence is
[`20261027190250_personal_labels.sql`](../../services/kernel/db/library/migrations/20261027190250_personal_labels.sql)
and its [native structural test](../../services/kernel/test/library/label-schema.test.ts).
Definitions have owner-scoped UUID, revision, transaction ID and deletion/due times, with live-name uniqueness.
Assignments have PK `(route,account_id,subject_id,label_id)`, revision/transaction/times, parent FK, an
owner/label/subject index and partial due index. There is no assignment ID, slot, cap guard or definition generation.
The FK is `NO ACTION`, not a purge implementation. The README's “no applied tables” statement is stale.

No `label-store.ts` is integrated in this checkout. Read the actual committed catalogue DAO at `c99cc0139a`
and its corrected lifecycle SQL at `631fb96c5f`: `services/kernel/src/library/label-store.ts` and
`services/kernel/src/library/label-store-lifecycle.sql`. It performs one-header CAS delete/restore, preserves children,
uses caller time, and relies on native name uniqueness. It does not implement assignment admission or Access.
Also read the catalogue/deletion/reconciliation briefs as read-only evidence, not executable imports.

Read both current source-owner/access-path briefs and the committed owner ABI at `0fdd496e22`,
`services/kernel/src/library/collection-source.ts`. Its factory deliberately throws `dependency_unavailable`.
It requires the same curated/built-in/activated/frozen authority, current source/original/terminal Access,
raw/internal/rejected/lookahead keys charged before work, owner windows ≤100 and aggregate caller allowance 256.
Its eight-key continuation and 77-byte source tuple are already specified; identity metadata costs are separate
(two 4096-home sweeps). A 32-slot label check must fit that allocation, not receive a free nested budget.
The canonical-store brief is a specification, not evidence of an implemented generic fact source.

## Primary evidence: what real systems establish

Cached repositories were reused, read as untrusted data, and never installed, built or executed. Paths below
are relative to `/home/edge/projects/rezics/rezics-next/.reference/`; sparse files also exist as pinned Git blobs.
The shared `INDEX.md` records this research's reuse. These sources support patterns, not copied implementation.

| Source and licence | Pinned paths / primary link | Finding |
| --- | --- | --- |
| PostgreSQL, PostgreSQL License (`COPYRIGHT`), `700b422af7e26cf310caf3fb76d78f4c8ca39c1f` | `library-shelf-maintenance/postgres/src/backend/commands/indexcmds.c`, `CheckPredicate`; [source](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/commands/indexcmds.c) | Index predicates reject subqueries/mutable functions. A falsely declared immutable parent lookup is unsound. |
| OpenFGA, Apache-2.0 (`LICENSE`), `57b39bc3dcc12f92270602bc01eb933ca4accfbe` | `search-visibility-witnesses/openfga/assets/migrations/postgres/001_initialize_schema.sql`; `pkg/storage/sqlcommon/sqlcommon.go`, `GetDeleteWriteChangelogItems`; [source](https://github.com/openfga/openfga/blob/57b39bc3dcc12f92270602bc01eb933ca4accfbe/pkg/storage/sqlcommon/sqlcommon.go) | Logical tuple PK and generated ULID are different identities. Exact duplicate-ignore skips both write and changelog; changed conditions conflict. Delete/recreate is not everlasting incarnation identity. |
| SpiceDB, Apache-2.0 (`LICENSE`, `NOTICE`), `7e7420c3f541648971b70642691ef86cac00a6cc` | `search-visibility-witnesses/spicedb/internal/datastore/postgres/readwrite.go`; under the same `postgres/`, `migrations/zz_migration.0001_1eaeba4b8a73_initial.go`, `migrations/zz_migration.0017_add_index_tuple_alive_by_resource_rel_subject.go`; [source](https://github.com/authzed/spicedb/blob/7e7420c3f541648971b70642691ef86cac00a6cc/internal/datastore/postgres/readwrite.go) | Local tuple liveness has an indexed deletion marker; TOUCH can no-op. Namespace deletion also updates tuples: it is not evidence for constant-cost parent invalidation. |

The shared pattern is native tuple uniqueness, explicit current liveness and transactional mutation, with identity
separate from change history. Neither project proves this product's parent-dependent cap or undo policy.
PostgreSQL [partial-index rules](https://www.postgresql.org/docs/current/indexes-partial.html) permit a
row-local reservation predicate, not a parent-active predicate. [Lock modes](https://www.postgresql.org/docs/current/explicit-locking.html)
make `FOR SHARE` conflict with a parent's non-key update; `FOR KEY SHARE` does not suffice.
These are native capabilities to implement in this repository's PostgreSQL/TypeScript stack.

## Minimal native representation

Keep the existing logical tuple PK, FK, name index and due indexes. Add only `assignment_id uuid NOT NULL`
and `slot_no smallint NULL` to assignments, after the cutover below. Set a native `gen_random_uuid()` default
for new assignment IDs (already used elsewhere in this database); structural fixtures need not supply the new column. The row's existing revision is its CAS head;
`(assignment_id,revision)` identifies a deletion episode when tombstoned. Existing `transaction_id`,
`deleted_at` and `purge_after` bind the episode's command/time; no extra opaque deletion-episode column is needed.
The ID is an opaque retained incarnation, not proof that a caller owns the tuple. Every lookup includes route/owner.
No ID-only global lookup or caller-selected resurrection ID is admitted.

Proposed final constraints/indexes (DDL is illustrative; existing objects are not rewritten):

```sql
ALTER TABLE library.label_assignment
  ADD CHECK (slot_no IS NULL OR slot_no BETWEEN 0 AND 31),
  ADD CHECK (deleted_at IS NULL OR slot_no IS NULL);
CREATE UNIQUE INDEX label_assignment_reserved_slot
  ON library.label_assignment(route,account_id,subject_id,slot_no)
  WHERE slot_no IS NOT NULL;
CREATE INDEX label_assignment_reserved_source
  ON library.label_assignment(route,account_id,subject_id,assignment_id)
  INCLUDE (label_id,slot_no,revision,transaction_id)
  WHERE slot_no IS NOT NULL;
CREATE UNIQUE INDEX label_assignment_identity
  ON library.label_assignment(route,account_id,assignment_id);
```

The two first indexes prove ≤32 reserved rows for a subject, including stale reservations; arbitrary retained
history has `slot_no IS NULL`. They do **not** assert all reservations are currently live.
This is a physical access path of the generic fact authority over authoritative assignments, not a private
parallel membership table. All generic label-source reads and assignment reads use the identical active predicate:
reserved assignment, assignment not deleted, current same-owner definition not deleted. No generic historical
label-source mirror may bypass it. If the shared authority requires a physical source table instead, put these
same slot constraints there and transactionally bind exact assignment ID/revision; do not install two authorities.

Add/reuse a generic subject-fact guard PK `(route,account_id,subject_id)` with no cached positive/count.
It is absent in this base and must be supplied by the generic owner, not assumed implemented.
Also add `label_revision_head(route,account_id,last_revision integer)` with PK `(route,account_id)` and
`0 <= last_revision <= 2147483647`. All actual assignment transitions allocate strictly increasing numbers:

```sql
UPDATE library.label_revision_head SET last_revision=last_revision+:k
WHERE route=:r AND account_id=:a AND last_revision <= 2147483647-:k
RETURNING last_revision; -- allocate the k consecutive values ending here; k <= 2 per assign
```

Initialize once per account, never reset on tuple purge; remove at terminal account erasure. This scalar retains
no owner-to-subject/label skeleton. It travels with the account partition on relocation. Exhaustion fails closed;
there is no wrap, cycling or account-ID reuse. Widening revision representation is a later owner decision.
A database sequence is an alternative only with explicit relocation/restore nonreuse guarantees: PostgreSQL
[sequence state is not transactional](https://www.postgresql.org/docs/current/functions-sequence.html).
No global sequence service or eternal tuple history is required by the proposed account-local allocator.

Use the existing definition `revision` as the current parent witness/generation: delete and restore already advance
it; rename may conservatively invalidate a witness without creating any assignment or label fact. No additional
catalogue or fanout generation column is necessary. Include parent revision in observations, never persist an allow.

## Admission, lock order and races

Current Auth/Access, scopes, subject readability, gate and `shareAccount` admission stay outside the DAO and precede
receipt lookup. Generic labels accept readable unprofiled subjects; they synthesize no profile/state/pin.
Use the caller's actual native transaction/time. All mutators, including future cleanup adapters, obey:
account barrier → account revision-head lock when needed → subject guards in UUID order → definition rows in UUID
order → assignment rows → shared checkpoint/receipt/outbox. Definition-only commands acquire no subject guard.
For purge, select a bounded raw key page first, then acquire these locks and recheck the parent/hold in that order;
never lock the parent first and then wait on a subject guard. Preselected keys authorize nothing.
Potential assignment mutations lock the revision head before the guard even if later found to be no-ops;
only an actual transition increments it. Never discover a mutation under the guard and then lock the head.

An assignment takes the subject guard, materializes ≤32 reservation rows, locks their distinct parents plus the
target parent `FOR SHARE` in sorted order, and checks the exact tuple. A currently active duplicate returns the
same ID/revision before capacity decisions; no revision allocation, new event or source contribution follows.
A same-key receipt replay returns its original minimal outcome only after current admission; it never readmits a
removed fact. Different-key concurrent duplicates serialize at the same guard and see the committed row.

If no free number exists, reclaim ONE reservation whose now-locked definition is tombstoned. Update its row by
exact tuple/ID/revision: clear `slot_no`, advance CAS, set `deleted_at` and `purge_after` to that parent's deletion
and due times, and persist its runnable lifecycle intent. This is a bounded write-side lifecycle transition;
it preserves retained payload/identity and never renews the window. Legal hold does not prevent freeing capacity.
Then insert/reactivate the requested tuple with a free slot, same retained ID if present, and a new revision.
If all 32 reservations have live parents, conflict. A deleted parent consumes no effective capacity even before
cleanup: the next admission can always reclaim its slot. Unassign is an exact tuple CAS clearing its slot and
soft-deleting it at command time; individual restore requires same episode, live parent and time < due, then the
same capacity acquisition. If a deadline-expired row still exists under hold, fresh assignment can reuse its
identical set fact with a higher revision; this is new assignment, not late undo.

| Interleaving | Required result / proof |
| --- | --- |
| Concurrent distinct 32nd/33rd | One guard serializes both; slot uniqueness additionally prohibits a 33rd reservation. |
| Rename versus assign | Parent lock orders them; same tuple/source identity survives; no label fact is created by rename. |
| Parent delete versus source read | Every new read snapshot checks parent; no delayed counter/cache can claim current positive. |
| Parent restore versus reclaim | If restore wins, reservation is live and cannot be reclaimed. If reclaim wins, child is tombstoned before restore, which cannot revive it. |
| Label restore after slots reused | Only remaining live reservations revive. Reclaimed children stay deleted; their individual undo conflicts at full capacity, never evicts another claim. |
| Tuple unassign/reassign/reclear | Retained ID is stable; each transition has a greater revision; old CAS/episode cannot clear the newer assignment. |
| Old purge after newer assignment | Exact ID/revision/deleted-time/parent episode mismatch is a no-op; no broad tuple delete. |
| Held deleted payload | Retain bytes but no reservation/live contribution; hold never extends undo or grants authority. |
| Terminal account T | `shareAccount` serializes writes with terminal deletion; later replay/read/write is denied; system cleanup cannot recreate private facts. |

O(1) header restore with complete atomic restoration of all historical children is impossible under these bounds:
put the only conflicting child at subject N+1, while N prior subjects fit. A bounded header command cannot
distinguish these states without fanout or already-maintained aggregate evidence. Arbitrarily many subjects make
that evidence expensive to maintain as slots are reused. The proposed interpretation avoids that promise and
matches “only still-valid”; if the owner instead requires whole-graph conflict, choose a separately specified
bounded asynchronous restoration operation, not an unbounded scan or silent partial all-or-nothing claim.

## Read-only source work and durable purge boundary

`sourceGet` names the requested internal operation, not an existing export. It performs no repair, expiry writes,
reclaim or durable enqueue. For one subject use this exact source shape; outside it, recheck native subject/Collection authority before disclosure:

```sql
WITH reserved AS MATERIALIZED (
  SELECT assignment_id,label_id,revision,slot_no
  FROM library.label_assignment
  WHERE route=:r AND account_id=:a AND subject_id=:s AND slot_no IS NOT NULL
  ORDER BY assignment_id LIMIT 32
)
SELECT x.*,p.revision AS parent_revision,p.deleted_at AS parent_deleted_at
FROM reserved x LEFT JOIN LATERAL (
  SELECT revision,deleted_at FROM library.personal_label
  WHERE route=:r AND account_id=:a AND label_id=x.label_id LIMIT 1
) p ON true;
```

Return raw reservations/evidence, including rejected parents, to the trusted generic adapter; only live parent
rows produce label facts. Source completion requires examining this entire reserved range, or genuine indexed
exhaustion; allowance <32 may require continuation, not false. Missing parent is never positive. Point membership
checks use the same current tuple+parent predicate. Positive and negative evidence is valid only at its native
observation: reread current parent and membership at final use after a changed observation, not just a stored
pointer/counter. Fresh page snapshots prevent old repeatable-read state from becoming cross-page authority.
PostgreSQL [isolation semantics](https://www.postgresql.org/docs/current/transaction-iso.html) matter here.

Owner-wide generic label traversal seeks the partial source index on `(subject_id,assignment_id)` with raw LIMIT
≤100 before parent filtering/dedup. By-label assignment pages can use the existing owner/label/subject index:
materialize ≤P raw tuples before tombstone filtering, advance after the last examined key, and permit short/empty
progress pages. No refill. Sort the bounded subject's ≤32 rows in memory for label-ID order.
The generic adapter merges state/session/holding drivers, charges every internal key, and proves its own canonical
coverage/alias progress under the accepted source ABI; an emitted subject is not a single-key cost proxy.

Ordinary due cleanup selects raw keys from the existing due index; definition cleanup selects ≤100 raw assignment
keys from the owner/label index before hold/eligibility filters. Retained parent-hidden children need no synchronous
stamping: the parent's runnable intent owns their due walk. Reclaim adds individual due metadata only when needed.
Each write page rechecks current episode, authoritative kernel time and hold, commits exact child effects,
checkpoint/receipt/next intent together, and advances past held keys. Held rows have a separate durable revisit
obligation; exhaustion of one pass does not mean payload erased. Bound workflow segments to ≤100 pages.
At account T use terminal system authority, never the active-only trusted-account runner; no 30-day account wait.

Exhaust assignment rows and source/derived references before deleting definition parents; the existing label FK
and owner-label index support exact exhaustion probes. Remove subject guards only after all generic facts and
retained tuple heads are exhausted. Guard creation/removal must serialize on its actual row; a writer finding a
deleted locked guard restarts admission instead of proceeding without a guard. Purge all private IDs/relations,
including guards, derived evidence and exact receipt/outbox/workflow payload locators, with shared custody
acknowledgements. Legal hold can retain a concealed parent until held children are exhausted. These shared hold,
intent and payload-custody adapters are explicit implementation dependencies, not existing imports in this base.
An ordinary read returning empty is not proof of physical erasure.

## Costs, rejected shortcuts and required native validation

Logical bounds below exclude the separately admitted command envelope/Auth/Access/identity work. They are proposed
budgets, not measurements or product acceptance results. Rows rejected by filters and every reread still count.

| Operation | Raw candidate keys / additional native work | Proposed SQL and byte ceiling |
| --- | --- | --- |
| Subject label source | ≤32 reservations + ≤32 exact parent probes; no retained-history candidates | 1 SQL; project ≤128 binary bytes/key plus ≤32 parent bytes/key, ≤512 bytes/key with transport overhead: 16 KiB |
| Assignment with reclaim | ≤32 reservations; ≤33 parent probes, target tuple + ≤1 reclaimed tuple, allocator/guard points | ≤12 DAO statements, ≤2 assignment writes + fixed guard/head/intent writes; 32 KiB metadata budget |
| Rename/delete/restore header | 1 exact header, native name-uniqueness probe on rename/restore | ≤2 DAO statements; normalized name ≤400 UTF-8 bytes; 4 KiB metadata budget, independent of child count |
| Raw list or destructive page | ≤100 total candidate encounters including rereads; select ≤50 keys if each needs one candidate reread, ≤50 effects | ≤12 batched DAO statements; ≤512 serialized metadata bytes/key, 64 KiB page budget |

Reserve byte/point/statement allowances before dispatch; do not fetch names or variable payload for source checks.
Byte values are explicit adapter ceilings to verify, not PostgreSQL heap/WAL sizes. A shorter admitted prefix is
required if serialization exceeds them; no truncation of a key. Lock acquisition batching must preserve the stated
order; if implemented as per-key SQL, charge its actual extra statements instead of claiming the table's ceiling.
Mutation exact-tuple/reclaim rereads also charge the aggregate caller ledger (up to 34 candidate encounters,
although the reservation range itself has only 32 keys). A final-use source reread reserves another window.
For destructive pages choose q so selection plus every candidate reread stays ≤100; no hidden 100+100 work.
Current old outcome assertions of total `rowsRead <=32` cannot measure a worst-case 32-source +32-parent path;
source-key and native-point counts must be distinguished by the owner. This report edits no frozen test.

Rejected counterexamples: parent-filtered `LIMIT 33` can scan 4096 dead-parent children to find zero live ones;
an advisory lock fixes neither that scan nor CAS identity; a live counter stays positive after parent delete;
“last generation” negatives stay false after parent restore; a local `deleted_at IS NULL` partial index still
contains unlimited dead-parent history; a parent-generation join still walks every old generation unless it has
a bounded selector. A cross-table partial predicate cannot self-update when its parent changes. A cached list of
32 IDs works only if it is this same native constrained authority with transactional current-row/parent checks.
A per-tuple permanent head violates whole-private-skeleton erasure. Revision reset to 1 after purge lets an old
`unassign(tuple,1)` delete a new incarnation even when its opaque ID differs, because the current input has no ID.
The high-water scalar closes that hole without treating possession of an ID as Access.

No focused native experiment was essential to these logical counterexamples; no database/service was started.
Implementation must validate first/deep/empty/all-stale source windows and success at **64/512/4096 inactive
histories on ONE subject**, plus unrelated owners and a high-fanout definition. Capture actual SQL and
`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)`, loops, rows removed, heap fetches, buffers, statements and serialized bytes.
Demand bounded reservation-index seeks and exact parent lookups, not a join/hash/seq scan over retained history.
Repeat with unreclaimed reservations, held rows, reused slots and concurrent restore/reassign/purge barriers.
Do not disable planner choices or substitute estimated cost/returned rows: [EXPLAIN documentation](https://www.postgresql.org/docs/current/using-explain.html)
explains the distinction. MVCC dead tuples/index bloat and lock latency are additional operational costs, not
proven ≤32 physical reads; realistic vacuum/churn evidence remains necessary.

## Migration, identity cutover and implementation splits

Use a new additive migration; never edit the applied migration or rewrite stored owner/subject/label IDs.
First inventory whether assignment commands ever shipped: this base has schema/fixtures, not public assignments.
Fence old/new assignment writers during cutover. Add nullable columns and new tables/indexes, then backfill ≤100
raw tuple keys/page before filtering; checkpoint atomically. Generate opaque IDs, preserve values/times/old CAS,
assign slots to live-parent rows only and retain hidden rows. Validate ≤32 live rows per subject during the
bounded walk: the applied schema has no cap, so the old prose is not proof. Overflow blocks activation, never
arbitrarily drops a live fact. For this unshipped source, hidden rows start without reservations. If a prior public
implementation exists, preserve its proven still-valid reservations too; do not silently change its undo promise.
For the unshipped source, stamp hidden unassigned-slot rows with the parent's original deletion episode without extending its deadline;
independently deleted children keep their own deadline. Seed each account revision high-water above every retained
assignment revision before activation. Validate constraints/indexes, then mark the native source basis ready and
switch all assignment/Everything reads together; never publish a mixed incomplete source as empty/negative.
Existing assignment revisions need not be rewritten. If old deleted revisions have already been forgotten while
commands were public, max(current rows) cannot prove nonreuse: require a known historical high-water or a separate
explicit CAS-format cutover. Do not manufacture that evidence. There is no such product implementation claimed here.

After adoption, bounded implementation units can each stay within 400 production lines/eight paths:

Paths below are under `services/kernel/`; new filenames are proposed. Each slice has ≤8 paths, ≤400 production
lines, plus meaningful native tests; split again if actual shared-port integration exceeds that production budget.

1. Storage/cutover (4 paths): `db/library/migrations/<next>_label_assignment_slots.sql`,
   `src/library/label-assignment-cutover.ts`, `src/library/label-assignment-cutover.sql`,
   `test/library/label-assignment-schema.test.ts`. Reuse native migration admission, no new harness.
2. DAO (6 paths): `src/library/label-assignment-store.ts`, `label-assignment-admit.sql`,
   `label-assignment-write.sql`, `label-assignment-lifecycle.sql` in that same source directory;
   `test/library/label-assignment-store.test.ts`, `test/library/label-assignment-races.test.ts`.
   Requires the agreed generic guard and catalogue exports, not a second guard owner.
3. Generic source (5 paths): proposed `src/library/subject-fact-source.ts`, `src/library/subject-fact-labels.sql`,
   owner ABI `src/library/collection-source.ts` (not integrated here), `test/library/subject-fact-labels.test.ts`,
   `test/library/growth-label-assignment-source.test.ts`. The generic owner supplies its sole source authority.
4. Lifecycle adapter (5 paths): proposed `src/library/label-assignment-deletion.ts`,
   `src/library/label-assignment-purge.sql`, existing `src/library/work-module.ts`,
   `test/library/label-assignment-restore.test.ts`, `test/library/label-assignment-purge.test.ts`.
   Requires actual shared hold/intent/checkpoint/custody exports; does not implement them locally.
5. Command composition (4 paths): proposed `src/library/label-commands.ts`, existing `src/library/personal-routes.ts`
   and `src/library/work.ts`, plus `test/library/support/label-outcome-driver.ts`. Use real native admission and
   the existing outcome suites; transport adoption remains with the command owner, not this research.

These are dependency splits, not dispatched workers or a promise the absent generic/deletion runtime fits in one
DAO patch. No vertical vocabulary, saved-query runtime, private permission/profile engine, route change or new job
framework is adopted. An assignment is an identical set fact: retain its row through undo/reassign, not an entry
value snapshot archive for every revision. Shared legal-hold custody may retain episode metadata; it must not
invent mutable assignment values. Only report existence is accepted here; native permissions/lifecycle and the
proposed SQL/byte/plan budgets remain unvalidated product work.
