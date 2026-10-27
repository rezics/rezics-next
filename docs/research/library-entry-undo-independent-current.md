# Independent Library entry-slot undo research

Research date: 28 October 2026. Native baseline: `b58e45bb553591a0bc7102855b2f7c7bff7ce1e1`.
This is evidence and a recommendation for adoption, not schema/API approval or an implemented deletion guarantee.
The sibling entry-undo report was not read. Reference code was treated as untrusted text; nothing was installed,
built or executed from a reference repository. Recommendations describe original PostgreSQL/TypeScript designs,
not source to copy.

## Recommendation

Keep `library.entry` as the live owner/subject slot with its existing primary key. On clear, atomically move the
complete native row into a private, typed `library.deleted_entry` relation, giving **each deletion occurrence** its
own immutable identifier. Filling the empty slot creates a new incarnation and never touches retained deletions.
Undo inserts the selected historical incarnation only if that live slot is empty; an occupied slot returns conflict.
Successful undo consumes that one archive row. A later clear gets another deletion identifier, even when it clears
an incarnation that was previously restored. This needs neither a multi-version live table nor a generic Library
trash framework.

Use an explicit deletion identifier in response metadata on the existing HTTP 204, with a narrowly specified restore
command. It makes selection independent of receipt retention and ambiguous revision-one replacements. The identifier
is a locator, never permission. Preserve subject-slot public identity and the existing native owner authorization.
There is also a separate live-write ABA defect: revision alone cannot distinguish a replacement. Require the expected
incarnation alongside revision for new first-public revisioned writes, with a matching typed-client contract change.
The route/client owners must adopt that change explicitly; adding internal incarnation predicates alone cannot fix
a stale request whose client supplied only a restarted revision.

The shared work/hold/checkpoint ports must be agreed with their existing owners. Existing DBOS, events and commands
are reusable infrastructure; there is no implemented generic native deletion mechanism to import today. Ordinary
record undo lasts exactly 720 hours. Terminal account cleanup starts at account deletion time T, without that wait.

## What the current repository actually supplies

Local authorities are [Deletion](../deletion.md), [Library and Collections](../library-and-collections.md),
[profile consumers](../library-profile-consumers.md), and the [Library deletion contract](../../services/kernel/src/library/README.md#deletion-and-restoration-first-public-contract).
The account reports [account deletion](account-deletion.md) and [Library retention](library-account-retention.md)
support terminal fencing, evidence custody and bounded cleanup; neither resolves successive ordinary entry replacements.
Their older inventories are not a substitute for inspecting this baseline's applied migrations.

| Native evidence                                                                                                                                                                                                                                                                                                                                    | Consequence for this question                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Entry migration](../../services/kernel/db/library/migrations/20261025173210_library_entries.sql), [shelf migration](../../services/kernel/db/library/migrations/20261027103142_library_shelf_core.sql)                                                                                                                                            | Live PK is `(route, account_id, subject_id)`. Nullable `incarnation_id`, activity/finish and type-source observations already exist. Account partition is logical `route >> 4`, not PostgreSQL table partitioning.                                                                     |
| [Model](../../services/kernel/src/library/entry-model.ts), [store](../../services/kernel/src/library/entry-store.ts), [insert](../../services/kernel/src/library/entry-store-entry-insert.sql), [update](../../services/kernel/src/library/entry-store-entry-update.sql), [delete](../../services/kernel/src/library/entry-store-entry-delete.sql) | Insert starts revision 1. Update/delete compare only slot and revision. Delete physically removes and returns a limited projection. That projection omits shelf columns and incarnation; archiving its returned TypeScript `Entry` would already lose data.                            |
| [Commands](../../services/kernel/src/library/entries.ts), [routes](../../services/kernel/src/library/personal-routes.ts)                                                                                                                                                                                                                           | DELETE is 204. Route-level live pre-read prevents replay after clear. Command preparation also reads/resolves before the command receipt. Neither is a retained-deletion lookup.                                                                                                       |
| [Subject resolver](../../services/kernel/src/library/subject-anchor.ts), [profile contract](../library-profile-consumers.md#authorization-receipts-and-replay)                                                                                                                                                                                     | Native `subject:read` checks and redirect resolution exist. Stored `subject_id` and `requested_subject_id` are distinct. Profile pins are specified on fact rows, but current Entry model/SQL does not persist/project a pin. Current type/source observations cannot reconstruct one. |
| [Command runner](../../services/kernel/src/library/command-support.ts), [executor](../../services/kernel/src/command/command.ts), [receipt seek](../../services/kernel/src/command/read-receipt.sql)                                                                                                                                               | Current account, scope, fence and authentication epoch are checked before the keyed receipt read. `runCommand` uses serializable transactions, native time, retry and atomic receipt/outbox/fence commit. Restore must use these boundaries.                                           |
| [Account sharing](../../services/kernel/src/access/account-share.ts) and [Access contract](../../services/kernel/src/access/README.md)                                                                                                                                                                                                             | `shareAccount` takes the native account lock against terminal deletion. The Library runner's current authorization reads the account but does not itself call `shareAccount`; the new entry write paths must do so, rather than assuming an unrelated caller already did.              |
| [Work registration](../../services/kernel/src/library/work.ts), [work module](../../services/kernel/src/library/work-module.ts), [effects](../../services/kernel/src/events/effects.ts), [retention](../../services/kernel/src/work/retention.ts)                                                                                                  | Library registers listing work. Effects provide durable event-driven dispatch and DBOS registration. Workflow-history collection is a separate age-based owner, not record trash, legal holds or Library due purge.                                                                    |
| [Receipt migration](../../services/kernel/db/migrations/20261025095021_receipt_principal.sql), [retention inventory](../../services/kernel/src/library/README.md#privacy)                                                                                                                                                                          | Core receipt PK includes partition, principal kind/ID, command kind and idempotency key. No Library-specific core receipt expiry/minimizer is implemented. DBOS history defaults to 30 days, configurable 7–365; this is not a receipt or record-retention promise.                    |

The [native deletion outcome interface](../../specs/library-deletion-driver.ts) and
[outcomes](../../specs/library-deletion-outcomes.test.ts) require increased deletion/restoration revision, exact
incarnation/value/pin preservation, replacement conflicts, revoked replay denial, strict day-30 expiry, parked stale
purge fencing and actual bounded scans. They remain runtime requirements, not proof of existing implementations.
This research neither changes them nor supplies a test-owned deletion backend.

An entry state transition changes a still-live fact. `completed`, `paused` and `dropped` are values, not deletion
states; copying a value into another state is not undo. Session abandon, copy disposal, following/unfollowing, offer
delisting and entitlement revocation likewise retain their own business meaning. As the
[Commerce contract](../../services/kernel/src/commerce/README.md#deletion-and-account-private-minimization-first-public)
states, deletion restore cannot reverse payment/refund truth. Only an explicit record deletion starts this window.

## Primary-source comparison

**Nextcloud: separate trash storage and collision-aware restoration.** In pinned
[`Trashbin.php`](https://github.com/nextcloud/server/blob/0e43b0a02d4ab36727ad121b6dc91238587b386c/apps/files_trashbin/lib/Trashbin.php),
`move2trash` separates original location from a filename/deletion-time trash address and retains versions.
`restore` checks login, writable destination and space; it preserves mtime. `getUniqueFilename` avoids overwriting
an existing file by choosing a restored name. The pinned
[`testRestoreFileDoesNotOverwriteExistingInRoot`](https://github.com/nextcloud/server/blob/0e43b0a02d4ab36727ad121b6dc91238587b386c/apps/files_trashbin/tests/TrashbinTest.php)
checks both old and replacement contents. This supports independent retained storage and explicit collision handling,
but a Library entry cannot be renamed to a second subject slot. Use conflict instead. Do not copy its timestamp
addressing: the inspected move path nudges time on lock conflict and can unlink an already-existing trash path.
That is not evidence of an immutable per-deletion identifier satisfying every repeated-clear case.
Nextcloud's [official retention documentation](https://docs.nextcloud.com/server/latest/user_manual/en/files/deleted_file_management.html)
also distinguishes minimum retention from actual space/age cleanup; its policy is not REZICS's exact deadline.

**Discourse: same-object soft deletion with explicit recovery side effects.** Pinned
[`Trashable`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/concerns/trashable.rb)
excludes deleted rows by default and provides deliberate deleted-row scopes. Pinned
[`PostDestroyer`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/lib/post_destroyer.rb)
separates recovery from deletion, restores related state and updates counts/events; the
[`guardian`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/lib/guardian/post_guardian.rb)
checks current recovery eligibility. These posts have object IDs, so retaining their row does not consume the identity
of a different new post. A default scope alone cannot solve entry-slot reuse, raw SQL readers or derived disclosures.

**Cloud Storage: version identity plus destination precondition.** Google's
[restore API](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/restore) selects a deleted object by
name and generation; some hierarchical cases additionally need a UUID restore token. It supports
`ifGenerationMatch=0` to require no live destination. Without such protection restore can overwrite a live object;
it creates a new generation rather than preserving REZICS incarnation semantics. Adopt precise source addressing and
destination absence, not its default overwrite behavior or a new cryptographic capability.

**Azure: behavior depends on namespace/version mode.** The
[official blob soft-delete documentation](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview)
explicitly describes the hierarchical-namespace case where deleting A, uploading B at the same path and restoring A
requires removing/renaming B first. Flat-namespace undelete/version behavior differs, including restoring multiple
versions together. REZICS needs the first conflict property and selective restoration of one deletion, not an
aggregate undelete-all operation. Hidden retained objects also require intentional listing behavior.

Shared evidence supports separating logical name from retained version, hiding immediately, restoring under current
authority, and treating destination conflicts and cleanup separately. It does **not** establish a universal table
layout, recovery deadline, timestamp key, automatic rename policy or account restoration model.

## PostgreSQL alternatives and why the live PK should stay

| Design                                                                                                                         | Actual PostgreSQL properties                                                                                                                                                                                                                                | Fit here                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Private deleted row beside unchanged live PK                                                                                   | Existing PK arbitrates concurrent inserts into the slot. Archive PK selects exactly one deletion. Existing active reads never encounter archive rows. Two typed row mappings must stay aligned.                                                             | Recommended: least disturbance to existing identity, keysets, counters and source holders.                             |
| Multi-incarnation `entry`, PK including incarnation; partial unique `(route, account_id, subject_id) WHERE deleted_at IS NULL` | Allows several deleted rows with one live slot. Restore is an UPDATE competing through that partial unique index. Every live read/index/join/writer must deliberately constrain active rows. Partial uniqueness cannot serve as an ordinary slot FK target. | Technically valid, but changes the PK and broadens the reader/writer/index migration. Not justified for this one slot. |
| Keep one tombstoned row under today's PK                                                                                       | Cannot retain A and store B at the same PK. Overwriting the row loses A; forbidding B violates refill; appending to JSON creates an unbounded history container.                                                                                            | Reject.                                                                                                                |
| Generic existing deletion engine                                                                                               | Shared command/work/event infrastructure exists, but no generic deletion/hold storage/restore engine is implemented. Collection tombstoning is type-specific and lacks restore metadata.                                                                    | Reuse infrastructure and agree missing ports; do not invent an import or a per-type dispatch enum.                     |

PostgreSQL [constraints](https://www.postgresql.org/docs/18/ddl-constraints.html) distinguish PK/unique keys from partial
unique indexes; a partial index is not an ordinary referenced unique key. The
[partial-index documentation](https://www.postgresql.org/docs/18/indexes-partial.html) requires the query predicate to
imply its index predicate. An index is not a global application filter, and `WHERE deleted_at IS NULL` is not an
expiry/hold authority. A time-moving `now()` predicate is not a maintenance strategy.

Use plain INSERT, never `ON CONFLICT DO UPDATE` on restore. PostgreSQL's
[uniqueness implementation contract](https://www.postgresql.org/docs/18/index-unique-checks.html) makes concurrent
insert/delete conflicts wait and recheck visibility. Thus checking absence before a transaction is insufficient,
whereas inserting under the live PK makes two competing restores or restore-versus-create arbitrate safely.
The [INSERT reference](https://www.postgresql.org/docs/18/sql-insert.html) documents conflict arbitration and RETURNING;
if using `DO NOTHING`, zero inserted rows must abort restoration and preserve the archive, not report success.
Serializable retries still reauthorize and reacquire the same native target guards.

## Minimal keys, fields and transaction rules

Proposed names below are internal, not a new public vocabulary or generic trash catalogue.

| Relation                                | Required fields and keys                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing `library.entry`                | Keep PK `(route, account_id, subject_id)`. Make `incarnation_id` server-assigned and non-null after cutover. Keep revision and all existing columns, including stored requested/source IDs and exact accepted pin when introduced. Fresh create gets a new incarnation; ordinary update preserves it.                                                                                                                                                                         |
| Proposed `library.deleted_entry`        | PK `(route, account_id, deletion_id)`. `deletion_id = command.transactionId` for this successful delete is sufficient: native transaction identity, not wall time or browser randomness. Store `subject_id`, non-null `incarnation_id`, `deleted_revision`, `deleted_at`, `restore_until`, and the **complete typed pre-delete row**, including its previous revision and transaction identity. No FK to the reusable live slot, no unique constraint on subject, no cascade. |
| Due index on deleted entries            | Generated `partition_no = route >> 4`; B-tree `(partition_no, restore_until, route, account_id, deletion_id)`. Each entry is a pending deletion while its archive row exists. Holds remain authoritative external checks after candidate selection. PK prefix serves terminal account pages ordered by `deletion_id`.                                                                                                                                                         |
| Shared work state, owned by kernel work | Exact native locator `(route, account_id, deletion_id)`, expected `incarnation_id` and `deleted_revision`, phase/sequence/cursor and durable continuation/custody locators. No fact bodies, account generation or local scheduler. Hold authority supplies a transactionally guarded current decision for this exact locator.                                                                                                                                                 |

Check route/account agreement as existing personal tables do; deleted rows have the same value/pin size constraints
as live rows. The deletion UUID is an opaque native transaction ID, not a routed subject/account ID: derive the
archive route from the authorized account, never from `routeOf(deletion_id)` or an ID-route equality assumption.
`restore_until` is set once to native `deleted_at + interval '720 hours'`, not a timezone-dependent month
or browser date. Payload and deletion identity are immutable while retained; only restore consumption or eligible
purge removes that row. No archive revision update is necessary for holds. A separate authoritative hold revision/lock
must serialize hold changes with destructive commit; a worker's earlier observation is insufficient.

The archive needs every persisted native column, not merely the public Entry projection: state, requested subject,
created/updated timestamps, activity/finish, source/type observation and transaction facts, and the bounded accepted
profile pin once its owning migration exists. Keep the saved payload revision distinct from tombstone revision:
delete at live revision r records `deleted_revision = r + 1`; restore uses `r + 2`. Fail with explicit conflict before
mutation if the current integer revision cannot represent both transitions. This is an exhaustion rule, not silent
wrap/reset. Moving to bigint would be a separate revision/client-owner change.

1. **Clear:** enter the native command and check current-own-account scope/gates with `shareAccount` in its
   authorization callback, before the receipt read. This account lock must also cover replay and every competing
   entry write path; taking it only in the fresh-command body leaves that fence incomplete. Then take the native
   shelf/head lock when applicable. On a fresh command, select/delete exactly the stored
   slot with expected revision **and incarnation**. Copy its full native RETURNING row into the archive in that same
   transaction. Archive insert failure rolls back removal. Commit active counter/fact-index withdrawal, event,
   minimal outcome and durable work intent with it. No effects on CAS miss. An exact authorized replay skips removal.
2. **Refill:** ordinary profiled create inserts a fresh incarnation under the unchanged slot PK and normal profile
   validation. It has no archive cleanup predicate. A same-state PUT is not restoration and must not borrow an old pin.
3. **Restore:** current owner management scope/gates and account lock precede receipt. A fresh restore locks one
   archive PK, verifies owner, path's exact stored subject, source eligibility, saved incarnation/deletion revision,
   and `command T < restore_until`. Insert the saved fact with that incarnation and newer CAS revision under the live
   PK. Consume exactly that archive row only after successful insertion, all in one transaction. Occupancy or other
   conflict rolls back everything, leaving the deletion independently restorable until its deadline.
4. **Purge:** lock/recheck that exact archive target and current hold in the writing transaction; require due time
   or the separate terminal-account predicate. Delete only the archive row and its exact private deletion evidence
   within the adapter's custody. Never issue a subject-wide live DELETE. A consumed/missing archive is a safe no-op.

An archive row's disappearance fences a parked purge of it; identifier nonreuse prevents a later deletion of the
same incarnation from matching. Two restores of different deletions of one slot compete through the live PK; exactly
one can succeed. Restoring A after B was cleared is allowed, but B's deletion remains independent. This is not
last-write-wins, a merge, or an implicit preference for the most recent deletion.

Preserve original user value dates (`created_at`, activity/finish and saved user-update time) exactly. Record lifecycle
times separately (`deleted_at`, restore command receipt/event time); do not sort an old reading fact as newly read
merely because Undo ran. A restored row's revision and command transaction identity advance; the original transaction
identity remains in the saved payload/its existing history until archive consumption. No historical row, digest or
receipt is rewritten to fabricate that lineage. If the shelf owner requires derived placement recomputation from
progress accumulated while absent, agree that separately; do not silently replace saved user dates with head maxima.
Sessions, sparse units, histories, copies, labels, follows and curated occurrences are independent and untouched.

## Migration without historical guesses

Add the archive relation/indexes with no pre-existing deletion payload to migrate. Older physical deletes cannot be
made restorable by guessing from core receipts or current subjects. State explicitly that recoverability starts when
the retained-delete writer is enabled. Install the complete archive mapping in the same rollout as that writer;
each later fact-column migration must update both mappings, including nullable pins during transition.

First fence out old writers that can create null incarnations or physically delete, using the existing owner
cutover/maintenance protocol. Assign fresh incarnation IDs to new rows and lazily stamp a locked legacy null row
before its first new deletion/CAS observation. Finish remaining nulls with <=100 raw primary keys per indexed,
checkpointed page, **before** null/hold/pending filters. CAS includes observed revision, transaction identity and
`incarnation_id IS NULL`; do not treat null as one shared incarnation or overwrite an already-stamped row. Preserve
every value, pin, timestamp, revision and existing receipt digest. IDs come from existing `newId(route)`; they are
not inferred from current type, subject redirect target, creation timestamp or UUID ordering.

Checkpoint advancement and assignments commit together. New writers cannot introduce nulls behind the cursor;
only after indexed exhaustion under that writer fence enforce non-null on live incarnations. Terminal account
fencing wins over a resumed migration. Use shared durable migration/checkpoint work, not a second account job engine.
Profile migration must cover retained rows if deletion can run during its transition, or gate retained deletion on
the existing owner-ready cutover. Adopt the latter for the smallest first-public rollout. Null/legacy pins use only
the profile owner's declared legacy adapter and captured release, never current type as historical evidence.

The [bulk contract](../../services/kernel/src/library/bulk-contract.md#shared-shelf-identity-prerequisite) separately proposes
persistent absent-slot generations/admission ordering. Reuse its agreed native guard when implemented; it is not
present merely because the nullable incarnation column exists. It protects a captured **absent** slot across
create/delete/recreate and cannot be replaced by the archive. This report does not add another generation system.

## Restore addressing and the unchanged 204 body

| Candidate                                                                               | Collision/replay and client consequences                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original DELETE request key + its expected revision, scoped to owner and stored subject | Viable with a dedicated unique native archive locator/index and frozen original request binding. Revision alone is ambiguous across incarnations. Reusing a key with changed input must conflict through the existing receipt; never choose “latest deletion of this subject”. No DELETE body change, but restore still needs a new typed route. Depending solely on a core receipt to find the archive couples restore to another owner's retention; key reuse after future expiry also needs an explicit horizon. |
| Explicit deletion ID in 204 metadata                                                    | Recommended. Exact archive point seek; no extra idempotency-key index, historical search or key-lifetime dependency. Same-key authorized DELETE replay returns identical metadata from its minimal native outcome even after refill/restore. A fresh delete key on an absent slot conflicts; it cannot manufacture a handle. Requires agreed response headers and generated restore-client support.                                                                                                                 |
| Existing authorized point read                                                          | Current GET returns only the live slot; after refill it finds B, not A. There is no existing retained-entry point-read API to reuse. A future deletion-state GET could take an exact deletion ID or indexed original delete key, but that is another contract, not a free workaround. No list/search over deleted history is needed for first-public Undo.                                                                                                                                                          |

Concrete proposal for route-owner adoption: keep DELETE status/body `204`/empty; add
`Library-Entry-Deletion-Id` and `Library-Entry-Deletion-Revision` response headers. The internal command returns only
the descriptor needed to reproduce these headers, native commit metadata and expiry, not the deleted state/pin/body.
Propose `POST /v1/libraryEntries/:subjectId/restore` with closed body `{ deletionId, revision }`, where revision is
the deletion revision from metadata, and its **own** existing `Idempotency-Key`. Return the normal typed entry after
success. The stored source `subjectId` comes from the pre-delete native Entry, not a fresh alias resolution.
Header spelling/path/status and permission binding are proposals until the route owner adopts them.

No new permission engine is needed: bind restore to the existing current `library_entry:update` management checks,
with the same native account/fence/epoch/gates; ordinary delete keeps `library_entry:delete`. Missing/foreign handle
is concealed. Authorized occupied/stale/expired undo returns 409; a missing consumed/purged handle cannot restore.
An exact successful restore replay returns its original outcome without running insert again, even if the slot was
subsequently cleared. New restore keys cannot reuse a consumed archive. At day 30 a fresh undo fails even if held;
an authorized replay of an already committed undo is acknowledgement, not another restoration or renewed window.

Fresh restore must satisfy current native source-read eligibility before exposing a subject through any resulting
view. Use `subject-anchor.ts`/native Access at the command's T and the existing cross-anchor preparation protocol,
not fake positive eligibility or a connection held across unrelated anchors. Keep stored source/alias IDs verbatim
even when readability follows a redirect. Do not authorize by a newly resolved slot or migrate A into a survivor.
Current source authorization/gates precede receipt disclosure where applicable; current profile/membership validation
for a **new value** must not be inserted before an exact authorized receipt. Clearing an owned existing fact remains
possible when its current profile/source no longer admits new values. Undo of the identical accepted value reads its
stored pin/release through the historical decoder; absence of today's Library profile alone cannot block it.

Remove the ordinary live-row pre-read from DELETE/replay admission. Native owner authorization can run without a live
row; retained/receipt selection is exact and concealed. Never run a generic absent-live GET to discover undo identity.
Separately, adopt expected incarnation on revisioned live update/delete requests and expose it as a CAS guard in
Entry reads/write results. This preserves public slot identity; it is not a second public resource. A stale revision-1
DELETE for A arriving after B's revision-1 create must conflict, even when the stale request uses a fresh key.
The alternative is a persistent monotonic slot revision allocator, with overflow/migration costs, not a hidden
revision-only solution. Reusing public `transactionId` as an additional expected-write guard is possible but couples
write identity to every update; immutable incarnation matches the existing native and bulk contracts more directly.

[RFC 9110 §15.3.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.5) permits metadata in a 204 response while
forbidding response content. The typed [client](../../packages/client/README.md) is generated from Kernel routes:
keep DELETE `data` void, expose/read metadata through the actual HTTP Response, add the typed restore call, and retain
the descriptor for Web's Undo action. Browser state/time is convenience only. On network loss retry the same delete
key; no second privileged token, crypto format, server token store or cookie-derived authority is needed. CORS header
exposure, if used cross-origin, belongs to the HTTP owner. Existing receipts/responses must not be silently rewritten.
An old physical-delete receipt can replay its original acknowledgement without fabricated undo metadata; it cannot
promise an archive that was never written. Preserve its original input digest and outcome compatibility.

## Immediate hiding, bounded purge and evidence custody

Moving the row out of the live table gives immediate source exclusion, but all first-scope members, Everything,
state, continue, search, sitemap, count, ItemList and feed adapters must still observe current live truth. A retained
entry is not Everything presence. Other live labels/copies/sessions can independently support subject membership;
withdrawing only entry support must neither delete them nor remove a genuinely supported aggregate membership.
Adjust active state/count/fact-index contributions once at hide and reacquire them once at successful restore.
Purge only retained data; it never decrements live counters. No archive UNION enters ordinary queries.

Public dynamic disclosure needs existing source-liveness witnesses/generation fences; an asynchronous zero event
alone is insufficient. Page output rechecks current native authority/liveness for candidates, and the
[listing freshness protocol](../../services/kernel/src/library/listing-freshness-contract.md) fences delayed positives.
Safe references reveal only permitted identity/deleted state; retained private state/pins never appear in ordinary
owner reads, stranger probes, events or tombstone references. Takedown withholds the least affected field/record,
does not start deletion, and never schedules purge merely because a notice arrived.

Use a due-source shape such as the following as an adapter contract, not production SQL added by this research:

```sql
WITH source_keys AS MATERIALIZED (
  SELECT restore_until, route, account_id, deletion_id
  FROM library.deleted_entry
  WHERE partition_no = $partition AND restore_until <= $cutoff
    AND (restore_until, route, account_id, deletion_id) > ($due, $route, $owner, $id)
  ORDER BY restore_until, route, account_id, deletion_id
  LIMIT $p                         -- 1 <= p <= 100, no extra lookahead
)
SELECT * FROM source_keys;          -- hold/pending checks occur after this page
```

The initial page has a separate no-cursor seek, not null tuple components. Index columns and
[row comparisons](https://www.postgresql.org/docs/18/functions-comparisons.html#ROW-WISE-COMPARISON) must have the
same lexicographic order. [MATERIALIZED](https://www.postgresql.org/docs/18/queries-with.html) prevents folding filters
into this candidate page; it does not force an index plan. The inspected PostgreSQL
[`SS_process_ctes`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/optimizer/plan/subselect.c)
also explicitly distinguishes forced materialization from inlining. Advance after the last examined raw key,
including held/rejected candidates. Sweep again or use the shared hold-release wakeup so skipped held rows become
runnable after release; never restart at the first held row indefinitely or permanently forget a skipped key.

Terminal account work instead pages archive PK prefix `(route, account_id)` and live entry PK at T, without a due-time
filter, under the current terminal account lock/T binding. It covers every retained deletion plus the live row; no
account restore/generation, platform grant, fresh human impersonation or 30-day wait. Current legal holds still
suspend destructive pages. Hold changes and purge rechecks serialize; restoring a still-live account's record does
not reopen a terminal account. Ordinary undo's strict deadline is unchanged by hold length or work delays.

Each page has <=100 source keys/effects including lookahead, bounded payload bytes and finite command deadline.
Its exact effects, native sequence/checkpoint, receipt and durable runnable continuation commit together. Use existing
`runCommand`, `registerEffects`, WorkModule, queues and DBOS steps; segment after <=100 pages. Commit-before-enqueue
is recovered from the shared runnable intent. Crash/replay after enqueue must use native state, not workflow-ID
existence: DBOS histories can expire. The missing shared due/hold adapter and recovery integration must actually land;
do not add a Library-local timer or call the history-retention sweep a record-purge scheduler.

The bound is **application source keys**, not a promise that PostgreSQL touches at most 100 physical tuples/buffers.
MVCC dead versions, visibility checks, heap/TOAST and B-tree paths add physical work; shared-index height grows with
population. The archive due seek is approximately `O(log D + P)` visible key work plus guarded point reads/writes,
bytes and shared-command/authorization costs. Terminal cleanup is linear overall in that account's retained rows,
not constant. Prove actual index conditions, filtered rows, loops, buffers, bytes and statements with
[EXPLAIN ANALYZE/BUFFERS](https://www.postgresql.org/docs/18/using-explain.html), including many held predecessors,
same-partition unrelated history and replacement churn at the specified geometric populations. A returned-row cap
or `LIMIT 100` after a hold anti-join proves neither source bound nor absence of a scan.

Archive purge proves only removal from that native relation and demonstrated owned locators. New DELETE outcomes
should retain minimal descriptors, but older `core.receipt.response` can contain full removed Entry values. Create,
update and restore receipts can also hold private states/pins. `core.outbox`, `editorial.write_basis`, consumer
checkpoints and DBOS inputs/results/steps/events have separate owners and retention/custody requirements. Do not
scan JSON receipts, broadly delete principal history, drop undelivered events or claim archive-only physical erasure.
Record exact receipt PKs, event `(partition, epoch, position, sequence)`/transaction and workflow/page locators at
creation or through the owning adapter; require delivery/custody acknowledgement before evidence minimization.
If historic locators cannot establish complete custody, report that limit rather than invent an all-history lookup.
Backups, logs, exports, replicas and caches remain outside demonstrated archive erasure too.

## Adoption splits, costs and counterexamples

The manager can adopt this layout without approving production changes in this report. Keep each implementation
capability <=400 changed production lines and <=8 paths, splitting further if either limit would be exceeded:

| Capability / owner                            | Concrete paths or existing seams; required agreement                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Retained-entry storage                        | One Library migration, `entry-model.ts`, `entry-store.ts`, insert/update/delete SQL, new archive read and restore SQL (8 paths). Agree full-row mapping, non-null cutover, revision exhaustion and internal signatures.                                            |
| Bounded incarnation migration                 | Dedicated migration adapter/page SQL and registration using existing shared checkpoint protocol; <=4 paths. Coordinate profile-ready gate and actual writer cutover rather than introduce another migration engine.                                                |
| Entry commands and HTTP / Library route owner | `entries.ts`, `command-support.ts`, `personal-routes.ts` and focused native tests. Adopt expected-incarnation request/response ABI, 204 descriptor metadata, explicit restore route, existing update authority and replay ordering.                                |
| Shared lifecycle/work owner                   | Existing command/event/work registration plus agreed due/hold/checkpoint exports, <=8 paths per shared capability. Transactional hold guard, pending scan/recovery and custody must be real, not Library stubs.                                                    |
| Entry purge adapter                           | Proposed Library deletion adapter/page SQL and `work-module.ts`, <=4 production paths after shared ports exist. Own exact retained-entry guard, terminal-account page integration and no live counter effect.                                                      |
| First-scope read/projection owners            | Adapt native fact-index, built-in Collection and listing witnesses separately within <=8 paths each. Prove immediate hiding and support-aware Everything/count behavior without reading archives.                                                                  |
| Web and generated client owners               | Update Undo descriptor handling, typed restore and source-incarnation preconditions; regenerate client/OpenAPI through their owner. Generated declarations are not hand-edited. Shared response/API changes need that cross-owner agreement before implementation. |
| Acceptance integration owner                  | Use the existing real deletion driver/outcomes. Add repeated clear/refill/reclear, legacy-null migration, full-row fidelity and simultaneous restore/create cases through production seams; never weaken existing acceptance or fabricate a native backend.        |

Costs are one typed retained row per outstanding deletion, one due index, duplicate mapping maintenance, write
amplification and independent retained payload storage proportional to deletion churn over the window. A fixed
per-slot history cap that silently evicts unexpired payload would violate the contract. Admission/rate policy may
limit new commands explicitly but must not erase already-promised recovery. Shared evidence minimization remains
a cross-owner dependency for any stronger erasure claim. Exact header names and ABI rollout, source eligibility
binding and any shelf placement recomputation require owner adoption; the recommendation above selects defaults
without treating them as already implemented authority.

Counterexamples the implementation must survive:

- Clear A/r1 to D1; create B/r1; restore D1: conflict, B untouched, D1 retained. Revision-only restore/deletion fails here.
- Clear B to D2; restore D1: A returns, D2 remains; purge D2 later cannot touch A. No subject-wide archive replacement.
- Restore D1; clear restored A to D3; deliver D1's parked purge: D3 and the current slot survive. Incarnation alone
  is insufficient because A's incarnation was deliberately preserved across Undo.
- Lose DELETE response; refill slot; retry original key: reproduce D1 descriptor without clearing the replacement.
  A live pre-read or “most recent deleted entry” lookup breaks this.
- Two restores race, or restore races refill: live PK picks one; losing transaction retains its archive and effects.
- At the exact deadline a legal hold still retains bytes: new undo fails; hold release enables due work, not disclosure.
- Account terminalizes while restore/migration is paused: native account lock/fence rejects late writes; cleanup is
  eligible at unchanged T and ordinary record deadlines cannot revive the account.
- A removed current profile does not invalidate exact pinned Undo; a fresh new value still needs current capability.
  A changed redirect never rewrites the saved source/alias IDs or supplies historical accepting-type evidence.

Shared parts with copies/Collections/members/labels are timing, authority-before-receipt, exact CAS, holds, due-source
page bounds, durable custody and immediate exclusion. Their object identities and conflicts differ: copies allow
several same-subject rows; members retain occurrence ID/order/capacity; Collections have their own ID and independently
deleted children; labels compete over active normalized names and assignment caps. Do not generalize entry slot PK,
archive shape, alias resolution or restore insertion into a per-type enum/permission engine.

## Source register and verification

All external material below was inspected on 28 October 2026. Cache paths are relative to the main checkout's
`.reference/`; its index was updated for these sources. Repository links above pin inspected commits. Vendor docs
are dated observations rather than claims about every deployed product version.

| Source / cache                                                        | Pin, licence and inspected material                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nextcloud / `library-entry-undo-independent-current/nextcloud-server` | [Repository](https://github.com/nextcloud/server), `0e43b0a02d4ab36727ad121b6dc91238587b386c`. [COPYING-README](https://github.com/nextcloud/server/blob/0e43b0a02d4ab36727ad121b6dc91238587b386c/COPYING-README): AGPL-3.0-or-later default; inspected `apps/files_trashbin/lib/{Trashbin,Expiration}.php`, `Trash/LegacyTrashBackend.php` and `tests/TrashbinTest.php` carry AGPL-3.0-only SPDX notices. |
| Discourse / reused `partitioned-sitemap-feeds/discourse`              | [Repository](https://github.com/discourse/discourse), `589325e2b8466178ee83acac9ec411de555a0093`; GPL-2.0-or-later per README/LICENSE.txt. Inspected `app/models/concerns/trashable.rb`, `lib/post_destroyer.rb`, `lib/guardian/post_guardian.rb`.                                                                                                                                                         |
| PostgreSQL / reused `library-shelf-maintenance/postgres`              | [Repository](https://github.com/postgres/postgres), `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`; PostgreSQL License (`COPYRIGHT`). Read `src/backend/optimizer/plan/subselect.c` through Git object text. Sparse-cache retrieval of `nbtinsert.c` failed with a TLS EOF; uniqueness evidence instead comes from the official version-18 documentation linked above. No claim depends on unread source.      |
| PostgreSQL 18 documentation                                           | Official constraints, partial indexes, INSERT, uniqueness checks, row comparisons, WITH and EXPLAIN pages linked above; [PostgreSQL License](https://www.postgresql.org/about/licence/). These are PostgreSQL semantics, not measurements of the proposed REZICS queries.                                                                                                                                  |
| Google Cloud Storage documentation                                    | Official Objects: restore page linked above, including generation preconditions and restore-token limitations; documentation under CC-BY-4.0, code examples Apache-2.0 as its footer states. No vendor implementation was copied.                                                                                                                                                                          |
| Microsoft Azure documentation                                         | Official soft-delete overview linked above, especially hierarchical-name collision and version-mode distinctions; Azure documentation [CC-BY-4.0 licence](https://github.com/MicrosoftDocs/azure-docs/blob/main/LICENSE) and Microsoft Learn [terms](https://learn.microsoft.com/en-us/legal/termsofuse), subject to stated exceptions. No SDK/source was copied.                                          |
| HTTP semantics                                                        | RFC 9110, §15.3.5, June 2022; IETF Trust/BCP 78 terms and Revised BSD terms for extracted code components. Used for bodyless success metadata only; no code extracted.                                                                                                                                                                                                                                     |
| Native REZICS                                                         | Baseline commit above; repository [LICENSE](../../LICENSE). Owning documents and actual source/SQL/test paths are cited throughout. The first-public deletion brief and frozen outcomes were read; no sibling research findings were consulted.                                                                                                                                                            |

Validation for this research change: `test -s docs/research/library-entry-undo-independent-current.md` and diff review.
No production schema, API, acceptance test or frozen file changes; no application-runtime or query-plan success is
claimed. The only auxiliary writes outside the worktree are the explicitly authorized reference clone/cache and
`.reference/INDEX.md`, preserving primary evidence for later work.
