# Independent personal labels

This document specifies private owner-created labels as independent personal facts in the generic Library. It does not
add production storage, routes, workers, a definitions compiler feature, or a second Collection implementation.
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
remaining window, without renewing undo. All 32 live parents means `409 conflict`. Reads never reclaim, repair,
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

These names reuse the current personal-library gate, owner partitioning, Access admission, and scopes. They add no
scope, change no Collection action, and do not select a transport path. The implementation agreement must bind them
to the existing personal-library command surface; do not add `/libraryShelfLabels`, another Collection route, or a
private route that computes Collection-like counts. Existing Collection routes and scopes retain their current
contracts.

Creation returns `201 {label:{id,revision}}`; rename returns `200 {label:{id,revision}}`; delete and unassign return
`200 {deleted:true}`; assignment returns `200 {assignment:{id,revision}}`. A duplicate assignment returns the same
assignment ID and revision. Catalogue pages return `200 {labels:[{id,name,revision}],next}`; one-label assignment
pages return `200 {assignments:[{id,labelId,subjectId,revision}],next}`. `library_label.assignment_list` requires
exactly one of `labelId` (subjects for a label, ordered by subject ID) or `subjectId` (labels on a subject, ordered by
label ID); the latter also performs subject-read admission. Reads contain only active rows whose definition is live.
Mutation receipts store only these minimal outcomes, not display names.

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
A stale revision returns `409 conflict` and changes no label, assignment, fact-index row, receipt outcome, or outbox
effect; stale conflicts are not committed as command receipts. Assignment create is set-idempotent, including
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

For a label deleted by its owner, assignment cleanup begins only after the 30-day undo window,
through shared bounded cleanup. It pages the owner/label/subject assignment index in keyset order, processing no more
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
fact and pin. Individual-record early purge needs separate platform permission; business transitions never establish undo authority or
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
write. Current `runCommand` requires at least one event; shared command `noEffect(value)` support is the actual
dependency for the later writer. A new-key duplicate commits a minimal receipt with ZERO domain events, outbox,
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

The applied `20261027190250_personal_labels.sql` and native schema test supply the catalogue/assignment tuple
tables, name uniqueness and due/owner-label indexes. The separately committed catalogue DAO
`services/kernel/src/library/label-store.ts` and `label-store-lifecycle.sql` provide header CAS/undo in this checkout.
They do not provide assignment IDs/slots, admission, a ready generic source or purge adapters.

The implementation handoff needs separate storage/cutover, assignment DAO, parent/source integration, command/receipt
and durable-cleanup slices, each <=400 production lines/eight files plus native acceptance. Add IDs/slots/indexes
additively, backfill <=100 raw keys before filtering with same-transaction checkpoints, preserve logical keys,
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
and duplicated source tables are not adopted. Native runtime/plan validation remains outstanding.
