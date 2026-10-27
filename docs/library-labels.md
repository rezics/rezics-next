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
partitions identifies two different labels. Rename preserves ID and assignments. Delete permanently retires that ID;
recreating the same name creates a new ID.

Normalize a submitted name by Unicode NFC, trimming leading and trailing Unicode whitespace, and replacing every
internal run of Unicode whitespace with one ASCII space. The canonical normalized string is both the displayed name
and the uniqueness key; comparison is case-sensitive. Thus `" Want to read "` and `"Want   to read"` collide, while
`"Want to read"` and `"want to read"` are distinct names. Reject an empty result, C0/C1 controls, or more than 100
Unicode scalar values after normalization. The normalization rule is version 1 and is not changed in place. It uses
no vertical-specific vocabulary.

There may be only one live label per `(owner, normalizedName)`. A second create or a rename to another live label's
name returns `409 conflict` without changing either label. A rename to the current normalized name is a no-op when
the canonical display string is unchanged. A casing change is a rename, keeps the label ID, and increments its
revision. Logical deletion releases the live-name uniqueness slot immediately. A deleted label can never be
undeleted or assigned again.

An assignment is the set fact `(owner, subjectId, labelId)`, unique under that exact tuple. A subject may have
multiple different labels, and a label may have assignments to many subjects. Applying an existing assignment again
has one effect: it returns the existing assignment identity without updating its revision, emitting a second event,
or increasing any count. This set uniqueness is different from curated Collection membership: each curated
occurrence has its own identity and a subject may occur repeatedly in one Collection.

Cap stored assignment rows at 32 per owner and subject, including rows whose label has been logically deleted but not
yet physically cleaned. Enforce the cap with a subject-scoped compare-and-swap in the same owner transaction as the
assignment and shared subject-fact-index change. A repeated active assignment is checked before the cap and remains
idempotent. The 33rd distinct stored assignment returns `409 conflict`; a new assignment may receive the same
conflict while deleted-label rows still occupy slots. Bounded shared cleanup releases those slots. This storage-slot
interpretation avoids a synchronous delete fanout and makes the cap race-safe.

An active assignment has an opaque assignment ID and revision from a per-tuple CAS head. Unassign removes that one
assignment and its one active fact-index source in the same transaction and advances the CAS head. Reassigning the
same tuple reuses its assignment identity with a higher revision. Thus a delayed unassign cannot remove a newer
reassignment. The head is cleaned with its label's bounded cleanup. Unassigning one tuple never scans a subject or
label partition.

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
common idempotency key. The request digest binds actor, action, owner, subject/label identity, expected revision, and
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

Rename and delete require the current label revision. Assignment removal requires the current assignment revision.
A stale revision returns `409 conflict` and changes no label, assignment, fact-index row, receipt outcome, or outbox
effect; stale conflicts are not committed as command receipts. Assignment create is set-idempotent, including
concurrent duplicate calls; competing mutations serialize on the subject-scoped CAS key. Receipt contents contain
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

Label writes are one input to the shared owner subject-fact index used by built-in dynamic Collections. They do not
create a label-specific view count, public membership directory, private parallel Collection, or materialized
dynamic result. The shared index carries source identity so a label tombstone makes that source fact inactive without
walking all assignments. The dynamic Collections owner defines its index representation, deduplication, and read
adapter; this contract defines only the fact contribution:

- **Everything** is the distinct subject IDs with at least one surviving explicit state, live label assignment,
  progress session, or holding fact. Follows are not facts. Duplicate source facts still produce one subject.
- A built-in state Collection contains subjects with that explicit current exclusive state. Labels do not match a
  state Collection unless a later dynamic-query contract expressly adds a label predicate.
- A label-only subject appears once in Everything and in no state Collection. A state-only subject appears in
  Everything and its one state Collection. Assigning a label never creates a default state such as `planned`.
- Clearing the exclusive state removes only that state fact. Removing a label removes only that assignment fact;
  sessions and holdings are unaffected. A subject leaves Everything when its last state, live label, session, and
  holding fact is removed.
- No independent presence or hide intent is introduced here. If product behavior later needs a factless subject to
  remain in Everything, or a subject with facts to be hidden from it, that needs a separate explicit owner fact and
  contract.

Collection query execution remains out of scope. A later dynamic Collection may consume the shared indexed label fact
under its own supported predicate and visibility rules; this specification defines neither a query language nor
runtime membership. A private query never writes public Collection membership.

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
exact label or assignment key, its owner/subject index key, the shared subject-fact-index key, required CAS/head
keys, and the common command receipt/outbox keys. Assignment storage is capped at 32 per subject. Rename and logical
delete update one definition and its name/CAS/receipt/outbox keys regardless of assignment population. There is no
synchronous fanout, whole-account array, per-label count repair, database cascade, or trigger that skips workflow
admission.

Logical delete changes the definition to a terminal tombstone and increments its generation in one transaction.
That commit immediately hides the label from catalogue and assignment reads, makes its assignments inactive in the
shared subject-fact index, and prevents future writes or dynamic-query use. It does not synchronously remove
assignment rows. Recreating the same name makes a new ID and generation; cleanup for the old ID cannot match or
delete the new label's assignments.

Physical cleanup runs through the shared kernel bounded cleanup protocol and account-deletion barrier. It pages the
owner/label/subject assignment index in keyset order, processing no more than 100 candidates per page with `O(P)`
memory and `O(N)` total work. Page effects, checkpoint, terminal fence, and replay receipt commit together. A crash or
lost acknowledgement may replay a page without deleting later rows or reversing a tombstone. No library-local
orchestrator, mass cascade, unbounded trigger, or cleanup path outside the shared protocol is added. Account deletion
fences reads, mutations, receipt lookup, and cleanup publication; late work cannot recreate the owner partition.
Account deletion erases all private label definitions, assignments, CAS heads, cursors, and label receipts; it retains
no label contribution as a public artifact.

Acceptance growth traces add unrelated labels and assignments at three increasing scales. They measure real native
rows and statements for assignment, rename, and logical delete; unrelated owner data may add only fixed or logarithmic
index work. Deep catalogue and assignment cursors remain within the 100-candidate page limit. Paged deletion traces
cover committed-page crash, replay, concurrent same-name recreation, and the account-deletion barrier. The tests do
not pin a query plan or estimate cost from a policy map.

## Profile policy and implementation handoff

Owner-defined label names are not definition values: they are not compiler vocabulary, inherited profile data, a
profile revision, or an inline profile field. No definition compiler or release change is part of this contract.
Profile absence must never silently create built-in labels or enable an adapter.

**Approval question before implementation:** may an owner assign a personal label to a subject whose accepted
definition release has no library profile, using the existing personal-library capability, or must assignment to that
subject remain unavailable until an explicit profile policy is agreed? This specification does not answer that
product policy. Label creation remains owner data; no profile is synthesized and no missing-profile assignment is
silently enabled. The implementation agreement must record the answer and corresponding native outcome before the
feature is activated.

After that answer and the shared subject-fact-index adapter are agreed, the implementation handoff is at most 400
production lines across at most eight files. Reuse the generic Library command/receipt/admission, shared encrypted
cursor, shared fact index, existing Collections and shared cleanup/account barrier. Do not add a second list engine,
public view counts, a label Collection route, a profile compiler extension, or saved-query runtime. The production
change must add native row tests and the driver-backed outcomes in `specs/library-labels-outcomes.test.ts`.

## Evidence read for this contract

The repository contract is `docs/library-and-collections.md`; its cited research is `docs/research/library-abstraction.md`.
Current implementation boundaries are described by `services/kernel/src/library/README.md`,
`services/kernel/src/library/personal-routes.ts`, `services/kernel/src/library/collection-routes.ts`,
`services/kernel/src/library/shelf-contract.md`, and `services/kernel/src/library/shelf-maintenance-ops-contract.md`.
The accepted profile ABI uses immutable release digests and a closed type-to-profile reference; a missing profile does
not fall back to the unattached legacy migration profile. It defines no owner-created label vocabulary. This contract
adds no profile field or compiler behavior, and leaves the effect of profile absence on owner label assignment as the
approval question above.

The read-only reference sources consulted were BookWyrm's `bookwyrm/models/shelf.py` and Bangumi's
`openapi/components/user_subject_collection.yaml` and `user_subject_collection_modify_payload.yaml`, at the commits
listed in `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md`. BookWyrm has owner-local shelves and enforces
one subject/shelf pair; Bangumi exposes tags independently alongside its exclusive collection type. Those examples
inform the distinction only; their model and field limits are not copied.
