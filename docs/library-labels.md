# Independent personal labels

This document owns the accepted private label model, HTTP contract and cost obligations in the generic Library.
Native storage is partially implemented; the implementation boundary below distinguishes it from absent producers.
Collection query runtime and saved-query semantics remain with the dynamic Collections contract.

## Model

For an account and subject, the owner may have zero or one explicit exclusive entry state and zero or more distinct
personal labels, progress sessions, and holdings. These are separate facts. A label assignment does not set or clear
the entry state, start a session, create a holding, follow a subject, grant an entitlement, or assert a separate
presence or hide preference. Creating a label definition alone assigns it to no subject.

Labels are owner vocabulary. A definition is private to one account and has an opaque `labelId`, a normalized display
name, an immutable owner scope, a monotonically increasing revision, and a live or deleted state. Every native key
includes the owner partition and `labelId`; a label ID has no global lookup meaning. The same byte ID in two owner
partitions identifies two different labels. Rename preserves ID and assignments. Delete soft-deletes that ID;
recreating the same name creates a new ID. Owner undo within 30 days restores the historic identity under current CAS
and live-name uniqueness checks; a conflicting recreated name must be resolved before restore.

Normalize a submitted name by Unicode NFC, trimming leading and trailing Unicode whitespace, and replacing every
internal run of Unicode whitespace with one ASCII space. The canonical normalized string is both the displayed name
and the uniqueness key; comparison is case-sensitive. Thus `" Want to read "` and `"Want   to read"` collide, while
`"Want to read"` and `"want to read"` are distinct names. Reject an empty result, C0/C1 controls, or more than 100
Unicode scalar values after normalization. The normalization rule is version 1 and is not changed in place. It uses
no vertical-specific vocabulary.

There may be only one live label per `(owner, normalizedName)`. A second create or a rename to another live label's
name returns `409 conflict` without changing either label. A rename to the current normalized name is a no-op when
the canonical display string is unchanged. A casing change is a rename, keeps the label ID, and increments its
revision. Logical deletion releases the live-name uniqueness slot immediately. A soft-deleted label cannot be
assigned while hidden; restore is undo, not a fresh assignment or profile reinterpretation.

An assignment is the set fact `(owner, subjectId, labelId)`, unique under that exact tuple. A subject may have
multiple different labels, and a label may have assignments to many subjects. Applying an existing assignment again
has one effect: it returns the existing assignment identity without updating its revision, emitting a second event,
or increasing any count. This set uniqueness is different from curated Collection membership: each curated
occurrence has its own identity and a subject may occur repeatedly in one Collection.

**DECIDED live cap:** at most 32 effective assignments per owner and stored subject. On the SAME `label_assignment`
row, add opaque `assignment_id` and nullable `slot_no` in 0..31. A native partial unique index on
`(route,account_id,subject_id,slot_no) WHERE slot_no IS NOT NULL` bounds reservations; the partial source index on
`(route,account_id,subject_id,assignment_id) WHERE slot_no IS NOT NULL` is the generic Collection label driver's sole
access path. Keep the existing logical tuple PK. No duplicate polymorphic fact table, cached permission or live count.
An effective assignment requires a reservation, a current nondeleted assignment and a current live same-owner parent.
Deleted-parent reservations are ineffective immediately; inactive retained history and held bytes use no live capacity.

An admitted write takes a transaction advisory subject guard, materializes <=32 reservations, locks their parents
plus the target parent in sorted order `FOR SHARE`, then applies exact row CAS and native uniqueness constraints.
Hash collisions cause contention only. An effective duplicate returns unchanged ID/revision before capacity checks.
If necessary, reclaim ONE deleted-parent reservation: atomically soft-delete that child at the parent's ORIGINAL
`deleted_at`/`purge_after`, advance its revision and clear its slot before reuse. Retain its identity/payload for its
remaining window, without renewing undo. All 32 live parents means `409 library_label_capacity`. Reads never reclaim, repair,
stamp expiry or enqueue work. Retry snapshot/unique races through the whole native command, not aborted SQL.

Definition undo within 720 hours restores metadata and ONLY unchanged, independently live reservations. Reclaimed
or individually unassigned children never auto-revive; explicit child undo/reassign reacquires capacity and conflicts
when full. Individual unassign clears its reservation and starts its own 720-hour window. Inactive retained bytes
use no capacity or disclosure. This defines “only still-valid assignments”, not historical-graph restoration.

**DECIDED identity:** the assignment row is its own finite CAS head. Reassign while retained preserves its opaque ID
with a newer revision; after WHOLE purge a fresh same-tuple assignment receives a fresh native opaque ID and initial
revision 1. Every destructive unassign/undo binds `assignmentId`, `expectedRevision` AND owner/subject/label tuple.
Late purge binds ID/revision/deletedAt and cannot erase a newer episode or incarnation. No eternal private head,
account/global revision allocator or assignment archive; integer revision exhaustion fails closed.

## Commands, admission, and receipts

The additive command action names are:

| Action                          | Existing library scope |
| ------------------------------- | ---------------------- |
| `library_label.create`          | `library_entry:update` |
| `library_label.rename`          | `library_entry:update` |
| `library_label.delete`          | `library_entry:update` |
| `library_label.assign`          | `library_entry:update` |
| `library_label.unassign`        | `library_entry:update` |
| `library_label.list`            | `library_entry:list`   |
| `library_label.assignment_list` | `library_entry:read`   |

These actions reuse `personal_library`, owner partitioning, native Access admission and the existing `library_entry`
scopes. They add no resource type or scope and change no Collection action. The accepted HTTP paths are:

- `GET /v1/libraryLabels`: optional `q`, `cursor`, `limit`; returns `200 {labels:[{id,name,revision}],next}`.
- `POST /v1/libraryLabels`: `{name}`; returns `201 {label:{id,revision}}`.
- `PATCH /v1/libraryLabels/{id}`: `{name,revision}`; returns `200 {label:{id,revision}}`.
- `DELETE /v1/libraryLabels/{id}`: query `revision`; returns `200 {deleted:true}`.
- `POST /v1/libraryLabels/{id}:restore`: `{revision}`; returns `200 {label:{id,revision}}`.
- `POST /v1/libraryLabels/{id}:assign`: `{subjectId}`; returns `200 {assignment:{id,revision}}`.
- `POST /v1/libraryLabels/{id}:unassign`: `{subjectId,assignmentId,revision}`; returns `200 {deleted:true}`.
- `POST /v1/libraryLabels/{id}:restoreAssignment`: `{subjectId,assignmentId,revision}`;
  returns `200 {assignment:{id,revision}}`.
- `GET /v1/libraryLabelAssignments`: exactly one of `labelId` or `subjectId`, optional `cursor`, `limit`, `view`;
  returns `200 {assignments:[{id,labelId,subjectId,revision}],next}` in default `BASIC` view. Row `id` is `assignmentId`.

**WEB ADDRESS DECISION:** Labels preserves `q` exactly up to 100 Unicode scalar values; correcting a prefix starts at page one, while correcting a cursor carries the unchanged valid prefix.

**WEB NAME INPUT DECISION:** Create and rename explain and validate the normalized 100-scalar native bound without rewriting raw drafts or captured commands; the separate 1000 UTF-16-unit input cap remains, and uncertain retries retain their original operands.

**WEB NAME READER DECISION:** Measured overflow offers local inline expansion and collapse beside the independent shelf link, following the Collection note reader; fitting names have no reader control, and reading preserves exact text, locale and focus without requests or rename permission.

The catalogue's single visible heading name is the shelf link; its row hit area stays separate from the local reader control, whose actual touch target is at least 44px in each dimension.

**WEB DRAFT DECISION:** Only non-whitespace name text differing exactly from its separate create or captured rename baseline needs a draft-loss choice; an original pending or uncertain command is not an unsent draft. Dismissal, replacing an action, internal navigation and supported document unload protect unsent names; Stay preserves exact text and field focus, while Discard sends no command. Confirmed saves clear only the submitted text, and authority retirement bypasses protection.

Both lists use signed, authenticated/encrypted cursors and `limit` 1..100, default 20. Assignments by label are ordered
by subject ID; assignments by subject are ordered by label ID and also require subject-read admission. Reads contain
only effective assignments with live same-owner parents. Duplicate assignment returns the unchanged ID/revision.
Mutation receipts retain minimal outcomes and undo revisions, never names or private display fields.
All catalogue and assignment mutations, including both restores, require `library_entry:update`.

Delete declares `Library-Label-Revision` and unassign declares `Library-Label-Assignment-Revision` in OpenAPI success
headers. Each is the actual post-delete revision from the native command receipt. Exact old-key replay returns the
SAME original header even after restore or replacement. Undo submits the known opaque ID and that revision; it needs
no expiry header, hidden-record lookup, inferred revision or transport pre-read. Fresh capacity failure is
`409 library_label_capacity`. Restore has distinct stable `409` codes: `library_label_restore_stale`,
`library_label_restore_expired`, `library_label_restore_occupied`, `library_label_restore_capacity`.
Ordinary stale/name conflicts retain `conflict`; foreign and unknown resources retain the same `404 not_found`.

`q` is a normalized LITERAL name prefix using the version-1 NFC/whitespace/case-preserving rules; empty normalized
`q` is unfiltered. Seek the existing `C`-collated partial live-name B-tree with a Unicode-scalar prefix upper bound
(no upper bound when none exists), skipping the surrogate range. `%`, `_` and backslash are literal, never wildcards.
Bind normalized `q` into the cursor. There is no catalogue cap, arbitrary full scan or shorter Unicode-name limit.
The continuation carries opaque ID plus bounded position evidence, with a keyed name reread under the cursor basis;
never place a legal long Unicode name in the shared cursor's 256-byte after-key.

`FULL` by subject adds only `label:{name}` to each BASIC row through <=32 current parent points; it fetches no progress
or subject display data and adds no progress gate. `FULL` by label adds `subject` (the standard viewer-authorized
summary or null) and `libraryEntry` (the [safe current shelf entry](../services/kernel/src/library/shelf-contract.md) or null). Only an existing entry carries its `state` and
`activeProgressSession`; a session alone never manufactures an entry tile. The page includes `label:{id,name,revision}`
even when empty, without a new `GET /:id` or catalogue walk.

`FULL` by label additionally requires `library_entry:list`, `progress_session:list`, `personal_library` and
`reading_progress` before private SQL. Parent metadata, assignment candidates and the <=100 subject-ID entry/session
batch share one owner-partition repeatable-read snapshot. Release that checkout before the existing per-partition
standard subject summaries. Use normal native authorization before receipt lookup, without transport pre-reads,
[cross-partition SQL](architecture.md#data-access), per-item HTTP, profile lookup/acceptance or a second list engine.

Every request first validates strict JSON against a closed, typed schema. Unknown fields, duplicate JSON object keys,
string-to-number/boolean coercion, malformed IDs, and out-of-range revisions are rejected. Mutations require the
common idempotency key. The request digest binds actor, action, owner, subject/label/assignment identity, expected revision, and
canonical input. Reusing a key with a different digest returns the existing idempotency conflict. Exact replay returns
the committed outcome and never re-executes the effect.

For every read, mutation, and idempotency replay, authenticate an active account, current authn epoch, the applicable
existing library scope and resource admission, and the account-deletion fence before reading owner data, a cursor, or
a command receipt. In particular, do not probe a receipt before authorization and then hide its result. An anonymous,
suspended, deleted, or scope-less principal cannot observe or mutate labels. A foreign or unknown owner-scoped label
ID has the same `404 not_found` result, including for assignment reads, rename, delete, unassign, and replay attempts.
An account sees only its own label catalogue. Assignment creation first resolves the canonical catalogue subject and
admits the same existing owner/subject library read before reading or writing an assignment; caller-supplied type,
route, or requested identity cannot expand that admission. A missing or foreign subject is not converted into an
owner-visible label fact.

Rename and delete require the current label revision. Assignment removal requires its actual assignment ID and revision.
Catalogue retries retain their original request key and revision; refreshing or resolving a conflict does not rebase an open edit, and reopening explicitly captures the current label.
A stale ordinary revision returns `409 conflict` (restore uses its distinct codes) and changes no label, assignment,
fact-index row, receipt outcome, or outbox effect; stale conflicts are not committed as command receipts. Assignment create is set-idempotent, including
concurrent duplicate calls; competing mutations serialize under the transaction advisory subject guard. Receipt contents contain
only the committed action result and opaque IDs/revisions, not
label display names or private subject facts. A delete receipt replay therefore cannot restore a retired label or
disclose its old name. Account deletion denies later receipt reads, even when the caller presents an old valid key.

Reads use owner-partitioned indexes and keyset pagination. A page examines at most `P` indexed candidates and returns
at most `P`, with `1 <= P <= 100` and `O(P)` memory. Catalogue order is `(normalizedName, labelId)`; assignment order
is `(subjectId, labelId)` for one label and `(labelId, subjectId)` for one subject. Cursors use the shared kernel
authenticated/encrypted codec and bind viewer, action/route, query, sort, page size, index basis, and expiry. A
mutation that changes the relevant ordered result invalidates its basis; callers restart after `409 stale_cursor`.
Never use offset pagination, full-account arrays, or an owner-wide label scan.

## Built-in Collection facts

Label writes are one input to the generic owner fact source used by built-in dynamic Collections. They do not
create a label-specific view count, public membership directory, private parallel Collection, or materialized
dynamic result. The same-row reserved index and current parent points above make parent hiding effective immediately
without walking assignments or copying facts. The generic source consumer owns deduplication and its read
adapter; this contract defines only the fact contribution:

- **Everything** is the distinct subject IDs with at least one live explicit state, live label assignment,
  progress session, or holding fact. Follows are not facts. Duplicate source facts still produce one subject.
- A built-in state Collection contains subjects with that explicit current exclusive state. Labels do not match a
  state Collection unless a later dynamic-query contract expressly adds a label predicate.
- A label-only subject appears once in Everything and in no state Collection. A state-only subject appears in
  Everything and its one state Collection. Assigning a label never creates a default state such as `planned`.
- Clearing the exclusive state removes only that state fact. Removing a label removes only that assignment fact;
  sessions and holdings are unaffected. A subject leaves Everything when its last state, live label, session, and
  holding fact is removed.
- A soft-deleted state, assignment, session, or holding is not a live Everything input even while its payload remains
  available for owner undo during the 30-day window.
- No independent presence or hide intent is introduced here. If product behavior later needs a factless subject to
  remain in Everything, or a subject with facts to be hidden from it, that needs a separate explicit owner fact and
  contract.

This document defines no query language or Collection runtime. The Dynamic Collections contract owns built-in result
semantics and the shared members page; its Everything result consumes live label facts through that same reserved
access path. This contract adds no custom label predicate or saved-query runtime. A private label fact is never exposed as a
public member field.

Labels alone establish no profile binding or lookup. Only surviving live entry, retained-session and copy facts with
actual accepted pins establish in-use state sets and sibling state Collections. Soft-deleted/trash snapshots are exact
undo evidence, not in-use sets. A profiled label-only subject gets no current or historical profile guess. The Collection
contract owns that meaning; this contract adds no label-profile pin, label-only state-view binding or saved-query scope.

## Privacy and disclosure

Label definitions, names, assignments, revisions, cursors, and receipts are private owner data. They never enter
public full-text search, public counts, public subject-to-Collection pairs, `who also read`, public sitemaps, or
anonymous subject views or published logs. A label's existence, name, assignment, or matching predicate is not a
public fact.

Private label events use the owner account ID as the event subject. They carry only opaque label/assignment identity
and the minimum private subject key needed by an authorized owner-side consumer; they do not copy the display name
into a public event or a subject-partition projection. Label writes produce no public listing event. Existing public
listing rows and events remain sourced only from explicitly public Collection membership.

An explicit public Collection may disclose the subject IDs it returns under that Collection's own visibility and
membership contract. It must not disclose the private label ID, name, assignment, predicate, or other private value
that selected a subject. A public label-based dynamic query, if later allowed by the dynamic Collection contract,
still exposes only its returned subject IDs and the Collection's ordinary public metadata. Changing a Collection to
private or deleting it revokes that Collection disclosure according to the existing Collection/listing protocol;
it does not change the owner's label facts.

## Mutation and cleanup cost

The following are policy bounds, not claims of passing native measurements. Charge raw source keys BEFORE filters,
including rejected, internal, lookahead and reread work across every Access, source, catalogue and summary pool.
Necessary parent/cursor/fence metadata points, statements, retries, bytes and physical heap/buffer work are additional
measured dimensions. Shrink raw windows to fit owner<=100 and aggregate caller<=256, retaining the existing separate
semantic identity allowance. No emitted-row count can substitute for these charges.

### Catalogue list and literal prefix search

- Touches: owner admission, live-name B-tree range, cursor basis and exact continuation-name reread.
- Bound: <=100 raw candidates, O(P) memory, fixed metadata points; long legal names require no linear catalogue work.
- Growth check: native q/continuation plans at growing catalogue sizes and long Unicode boundaries are unimplemented.

### Create label

- Touches: owner admission, exact definition/name uniqueness, shared receipt/outbox and source metadata as needed.
- Bound: fixed keys/statements; unrelated catalogue growth adds at most logarithmic index work, with no catalogue cap.
- Growth check: end-to-end native create growth remains unimplemented; [catalogue tests][catalogue-tests] cover the DAO.

### Rename label

- Touches: exact label CAS, old/new name keys, receipt/outbox and source evidence; never child rows.
- Bound: fixed keys/statements independent of assignment population; unchanged canonical name has no domain effect.
- Growth check: [outcome acceptance][outcomes] requires unrelated-data traces; a production driver remains unimplemented.

### Delete label

- Touches: exact parent CAS/tombstone, source fence and shared receipt/outbox/durable cleanup intent.
- Bound: fixed keys/statements with no assignment fanout; child count affects only eventual paged cleanup.
- Growth check: [outcome acceptance][outcomes] requires delete growth/crash/replay; integrated execution is unimplemented.

### Restore label

- Touches: exact historic parent CAS/deadline/name uniqueness, source fence and minimal receipt/outbox.
- Bound: fixed keys/statements; restore unchanged reservations implicitly, never enumerate or revive reclaimed children.
- Growth check: [catalogue tests][catalogue-tests] cover DAO undo/name collision; integrated restore growth is unimplemented.

### Assign label

- Touches: admitted subject/owner, guard, reserved-source seek, exact desired tuple, sorted current parents, optional reclaim.
- Bound: <=32 reservations, <=33 parent locks, one reclaim and fixed command metadata; duplicates precede capacity work.
- Growth check: [native admission plans][admission-plans] measure 64/512/4096 inactive histories, including rejected paths.

### Unassign label

- Touches: owner/subject admission, guard, current parent, exact assignment-ID/tuple/revision CAS, fence and receipt/outbox.
- Bound: fixed points/statements; clear one reservation and retain only that episode for 720 hours.
- Growth check: integrated native unassign growth is unimplemented; [outcome acceptance][outcomes] defines required behavior.

### Restore assignment

- Touches: historic assignment-ID/tuple/revision/deadline, guard, <=32 reservations/current parents and shared command keys.
- Bound: <=33 parent locks and one reclaim to reacquire capacity; no history scan or renewal of the original undo deadline.
- Growth check: explicit native undo/admission integration remains unimplemented; reassignment evidence is not undo proof.

### BASIC assignment list

- Touches: owner/subject admission, exact parent metadata and indexed label or reserved-subject source candidates.
- Bound: <=100 raw page candidates; subject source <=32 plus necessary current-parent/metapoints, charged separately.
- Growth check: native read-driver plans and deep-cursor measurements remain unimplemented; DAO admission is not read proof.

### FULL assignments by subject

- Touches: BASIC sources and <=32 exact current-parent name points; no progress or display-summary reads.
- Bound: same bounded reservation window plus separately charged metadata points; no retained-history or catalogue scan.
- Growth check: native FULL-by-subject producer and all-pool measurements remain unimplemented.

### FULL assignments by label

- Touches: admission/gates, parent/page and owner entry/session batch in one RR snapshot, then standard subject summaries.
- Bound: raw page<=100 and native subject-ID batch<=100; fixed per-subject points, finite summary concurrency, all pools charged.
- Growth check: native batch/FULL producers and end-to-end all-pool measurements remain unimplemented.

### Automatic purge and terminal account cleanup

- Touches: bounded raw due/owner-label keys, account barrier, episode CAS/locks, child then parent and owned private payload.
- Bound: <=100 raw keys per durable page, O(P) memory/O(N) total; effects/checkpoint/next intent commit together.
- Growth check: [outcome acceptance][outcomes] requires crash/replay/terminal traces; runnable integration is unimplemented.

An ordinary create, rename, assignment, or unassignment touches a fixed set of keys in one owner partition: the
exact label or assignment key, its bounded reservation/parent keys, the generic owner fact-source fence,
and the common command receipt/outbox keys. Reservations are capped at 32 per subject, not retained rows. Rename and logical
delete update one definition and its name/CAS/receipt/outbox keys regardless of assignment population. There is no
synchronous fanout, whole-account array, per-label count repair, database cascade, or trigger that skips workflow
admission.

Logical delete hides the definition behind a tombstone and increments its existing revision in one transaction.
That commit immediately hides the label from catalogue and assignment reads, makes its assignments inactive in the
generic source, and prevents future writes or dynamic-query use. It does not synchronously remove
assignment rows. Recreating the same name makes a new ID; cleanup for the old ID cannot match or
delete the new label's assignments.

Individual unassign schedules automatic bounded purge at its own 720-hour deadline.
For a label deleted by its owner, automatic physical assignment purge begins only after the 720-hour undo window,
through shared bounded durable cleanup, without a later owner request. Before that deadline, an admitted assignment may reclaim one inactive reservation
by soft-deleting its child as specified above; this neither purges payload nor renews undo. Purge pages the owner/label/subject assignment index in keyset order, processing no more
than 100 candidates per page with `O(P)` memory and `O(N)` total work. Page effects, checkpoint, terminal fence, and
replay receipt commit together. A crash or lost acknowledgement may replay a page without deleting later rows or
reversing a tombstone. No library-local orchestrator, mass cascade, unbounded trigger, or cleanup path outside the
shared protocol is added. Terminal account deletion fences reads, mutations, receipt lookup, and cleanup publication;
late work cannot recreate the owner partition.

Account deletion is terminal at fresh authentication plus typed confirmation time `T`. Only `account-tombstoned.v1`
exists; there is no account restore, scheduled/cancelled event, account-deletion state port, or account-generation
counter. It fences later owner reads and writes and starts a separate bounded durable purge immediately. Whole label and
assignment facts are personal, so their payload and skeleton are erased as that work settles. Legal-hold integration
is deferred from first scope; no new hold/custody engine is required. The handoff is durable and does not wait for projection consumers; the delete response may precede
physical purge completion. Ordinary label deletion still permits owner undo within 30 days. Restore uses current
`deleted_at`/`purge_after`/CAS and the historic
fact; labels carry no profile pin. Individual-record early purge needs separate platform permission; business transitions never establish undo authority or
purge timing. Takedown withholds the least affected field/record and never schedules purge solely for the notice;
a legal-order purge is a separate platform-authorized operation.

**DECIDED retention:** only Collections active and PUBLIC at `T` survive. A public dynamic Collection retains its last
completely published generation. That read-only, de-identified output keeps current viewer-native subject access.
Private, UNLISTED and already-deleted Collections, including formerly-public ones, are hidden immediately and erased by
bounded work. Retention uses the set fixed at `T`, never a fresh query at `T` or pending output; if no dynamic generation
completed, no subject set is manufactured.
Only already-published subject IDs survive; label names, assignments and other private label data never become public.

Acceptance growth traces add unrelated labels and assignments at three increasing scales. They measure real native
rows and statements for assignment, rename, and logical delete; unrelated owner data may add only fixed or logarithmic
index work. Deep catalogue and assignment cursors remain within the 100-candidate page limit. Paged deletion traces
cover committed-page crash, replay, concurrent same-name recreation, and the account-deletion barrier. The tests use actual native plans, never estimated cost or a policy map.

Subject-source acceptance additionally grows inactive history on the SAME subject at 64/512/4096 rows, including
long/interspersed deleted-parent prefixes and individual tombstones, with 32 live or 32 stale reservations.
Capture real SQL and EXPLAIN ANALYZE/BUFFERS (loops, removed rows, index conditions, heap fetches, buffers),
statements, retries and bytes. Require the partial reserved-source seek and exact current parent points, not
parent-filtered LIMIT or a scan/sort/hash over retained history. Charge <=32 reserved source keys and <=32 parent
points separately; this is not a promise of <=32 total rows/physical heap visits. Admission permits <=33 parent
locks and one reclaim. Keep existing normal empty/new-subject rowsRead<=32 and growth/buffer bounds unchanged.
Every internal/rejected/lookahead/reread key counts under owner<=100 and aggregate caller<=256; reserve finite
point/statement/byte budgets and use smaller raw windows before filtering when necessary, advancing after the last
examined key even on empty pages. Semantic identity metadata has its own existing allowance, never hidden here.

Reuse parent revision as evidence, with no extra visibility generation. Effective fact mutations and parent
delete/restore advance the generic owner fact-source fence in the SAME native command, without subject/list fanout.
Changed evidence invalidates positives, negatives and completeness before final use; no cached allow or ready empty
result. That fence, producer hooks and source-completeness cutover remain missing implementation dependencies.
Public follow-count coverage of current account eligibility remains a separate gap; this private fact-source fence
does not supply it.

Native delete/restore/reclaim/purge order is account barrier, sorted transaction advisory subject guards, sorted
parent FOR SHARE locks, exact assignment CAS, source fence, shared receipt/outbox/checkpoint. Header-only commands
never acquire subject guards after parent locks. Purge selects bounded raw keys first, rechecks current episode,
authoritative time under those locks, and commits effects/checkpoint/next intent together. Child exhaustion precedes
parent purge. No local timer.

Fresh-key duplicate assignment requires an idempotent minimal receipt with NO domain fact event or source-fence
write. The shared `noEffect(value)` export now exists in `services/kernel/src/command/command.ts`, with
`no-effect-fence.sql` committing the receipt at the observed partition position. Ordinary unmarked empty-event
results still fail. The later assignment writer must use this existing command capability without domain writes
or registered work. A new-key duplicate commits a minimal receipt with ZERO domain events, outbox,
write basis or position advance; ordinary finalize/current authorization still run. Do not bypass the command,
skip its receipt, or mint a fixture/no-op domain event. Runnable bounded purge and cleanup of owned private
receipt/outbox/workflow payload remain integration work; no label-local engine or invented shared custody port.

## Profile policy and implementation handoff

Owner-defined label names are not definition values: they are not compiler vocabulary, inherited profile data, a
profile revision, or an inline profile field. No definition compiler or release change is part of this contract.
Profile absence must never silently create built-in labels or enable an adapter.

**DECIDED:** a readable subject needs no library profile for label assign/unassign or curated occurrence add/remove.
Missing/retired profiles forbid only NEW state/progress/holding values; stored own facts remain readable and clearable.
Existing real subject visibility, scopes, CAS, deletion fences and authorization-before-receipt continue to apply.
No default state, legacy fallback, profile synthesis or new presence/hide primitive is introduced. Everything contains
unique subjects with any surviving state, live label assignment, retained session or holding; follow/curated-only
subjects and soft-deleted facts do not count. Clearing state preserves other facts; the last live fact removes membership.

The [catalogue schema](../services/kernel/db/library/migrations/20261027190250_personal_labels.sql) supplies tuple,
live-name and due indexes. The [reservation migration](../services/kernel/db/library/migrations/20261027234813_label_reservation_source.sql)
adds same-row IDs/slots, covering reserved-source indexes and a shared fact-source head, not producer readiness.
The [catalogue DAO](../services/kernel/src/library/label-store.ts) and [lifecycle SQL](../services/kernel/src/library/label-store-lifecycle.sql)
provide metadata CAS/undo. The [assignment DAO](../services/kernel/src/library/label-assignment-store.ts),
[reservation seek](../services/kernel/src/library/label-assignment-reservations.sql) and
[reclaim CAS](../services/kernel/src/library/label-assignment-reclaim.sql) implement native set admission and original-deadline reclaim.
[Native admission tests][admission-tests] and [plan tests][admission-plans] exist; they do not prove shipped HTTP or purge.

Label HTTP routes, native command/receipt integration, assignment unassign/undo/pages, q seek, FULL owner tile batch,
source cutover/fence producers and automatic whole-purge/private receipt/outbox/workflow payload cleanup remain unimplemented.
The [current personal routes](../services/kernel/src/library/personal-routes.ts), [OpenAPI](../contracts/openapi.json) and
[generated client](../packages/client/src/kernel/library/personal-routes.d.ts) do not publish these label endpoints.
The [restore problem definitions](../services/kernel/src/http/problem.ts) and their
[schema test](../services/kernel/test/http/library-label-restore-problems.test.ts) establish error shapes only.
The [standard summary reader](../services/kernel/src/library/views.ts) and [shared cursor](../services/kernel/src/tokens/list-cursor.ts)
are existing integration surfaces. Implementation briefs are requirements, not evidence of shipped producers.

The remaining implementation needs separate storage/cutover, assignment lifecycle/pages, parent/source integration, command/receipt
and durable-cleanup slices, each <=400 production lines/eight files plus native acceptance. Use the existing IDs/slots/indexes;
backfill <=100 raw keys before filtering with same-transaction checkpoints, preserve logical keys,
values/times/revisions, and block activation on 33 live facts. Fence writers/parent changes and prove source
completeness before enabling the one source; incomplete is unavailable. No copied parent-generation catalogue.
Reuse generic Library command/receipt/admission, shared encrypted cursors, existing Collections and shared cleanup/account barrier. Do not add a second list engine,
public view counts, a label Collection route, a profile compiler extension, or saved-query runtime. The production
change must add native row tests and the driver-backed outcomes in `specs/library-labels-outcomes.test.ts`.

## Evidence read for this contract

The repository contract is `docs/library-and-collections.md`; its cited research is `docs/research/library-abstraction.md`.
Current implementation boundaries are described by `services/kernel/src/library/README.md`,
`services/kernel/src/library/personal-routes.ts`, `services/kernel/src/library/collection-routes.ts`,
`services/kernel/src/library/shelf-contract.md`, and `services/kernel/src/library/shelf-maintenance-ops-contract.md`.
The accepted profile ABI uses immutable release digests and a closed type-to-profile reference; a missing profile does
not fall back to the unattached legacy migration profile. It defines no owner-created label vocabulary. This contract
adds no profile field or compiler behavior, and adopts the decided unprofiled assignment policy above.

The read-only reference sources consulted were BookWyrm's `bookwyrm/models/shelf.py` and Bangumi's
`openapi/components/user_subject_collection.yaml` and `user_subject_collection_modify_payload.yaml`, at the commits
listed in `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md`. BookWyrm has owner-local shelves and enforces
one subject/shelf pair; Bangumi exposes tags independently alongside its exclusive collection type. Those examples
inform the distinction only; their model and field limits are not copied.

The live-cap reconciliation adopts [both](research/library-label-cap-independent-current.md)
[independent reports](research/library-label-cap-independent-deep.md): same-row reservations, unchanged-claim parent
undo and finite assignment identity with ID-bound CAS. Alternative revision allocators, extra visibility generations
and duplicated source tables are not adopted. Native admission plan tests exist; complete source/HTTP/cleanup proof remains outstanding.

[catalogue-tests]: ../services/kernel/test/library/label-store.test.ts
[admission-tests]: ../services/kernel/test/library/label-assignment-store.test.ts
[admission-plans]: ../services/kernel/test/library/label-assignment-growth.test.ts
[outcomes]: ../specs/library-labels-outcomes.test.ts
