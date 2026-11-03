# Selected private label consolidation

This document owns the selected-assignment consolidation journey. [Independent labels](library-labels.md) owns
native identities, commands, finite undo and reservation admission. Consolidation selects exact source and target
label IDs and explicit Subject/assignment identities. Names are display values. It does not enumerate a label's
whole membership, infer selection from a filter, change dynamic Collection operands or delete the source label.

Decision: review is a pure supplied-ID page (16 selected assignments, four per page) with encrypted 15-minute cursors
and no retained review state; its selection digest is advisory and cannot confirm a move.

## Installed review interface

`POST /v1/libraryLabels/{id}:reviewConsolidation` addresses the exact source ID. Strict JSON input is
`{targetLabelId,items:[{subjectId,assignmentId,revision}],limit?,cursor?}`. Both labels must be distinct live owner
identities. There are 1..16 items with distinct Subject IDs and 1..4 items per page (default four). Canonical request
JSON is at most 8,192 bytes, the cursor at most 4,096 characters, and response JSON at most 16,384 bytes.

Every page repeats the exact original selection and limit. The encrypted cursor binds owner, ordered selection
hash, limit, next selected offset, owner partition epoch and position. Changed selection invalidates it; native
owner-partition advancement makes it stale. Refresh starts a new observation. There is no offset SQL, whole-label
enumeration, stored review, receipt, workflow, repair, event or background work.

Response: `{selection,sourceLabel,targetLabel,items,next}`. Both labels contain `{id,name,revision}`, including on
the final page. Each item contains the exact `selected` triple, `source` and `target` observations (null or
`{id,revision,effective}`), and one outcome:

| Outcome             | Meaning                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `movable`           | Exact effective source, no effective target, and native admission currently has a free or reclaimable slot.                        |
| `already_on_target` | Exact effective source and an effective assignment to the exact target already exists.                                             |
| `missing`           | No source tuple, or the same selected incarnation/revision is ineffective.                                                         |
| `changed`           | The current source tuple has another incarnation or revision; selection is never rebased.                                          |
| `inaccessible`      | Native Subject admission does not admit this exact stored ID, including unknown IDs and redirects. Both observations are withheld. |
| `capacity_limited`  | Exact source, no effective target, and all 32 reserved slots have live parents.                                                    |

Retained target tombstones expose only the owner's addressed identity, revision and ineffective state. An
unidentified legacy live assignment is unavailable (`index_not_ready`), never silently missing or movable.
Missing, foreign and deleted source/target labels share `404 not_found`. Recreating a name cannot substitute an ID.
Parent changes during inspection fail the observation; rename also invalidates continuation's partition basis.

Review requires current owner standing, `library_entry:read`, `library_entry:update` and `personal_library` exposure.
Native Subject admission runs before assignment inspection and again before disclosure, without an owner checkout
held across Subject partition reads. Owner standing and label revisions are checked again before disclosure.
Responses are `Cache-Control: private, no-store`. No private names or assignment operands enter event/error payloads.
The existing native assignment readers reopen both labels; review changes neither selected nor unselected facts.

## Installed selection, confirmation and movement

The native review and HTTP route remain pure. The same Labels module now installs these owner-only methods;
all require `library_entry:read`, `library_entry:update` and current `personal_library` exposure. Responses are
`Cache-Control: private, no-store`.

| Method                                             | Input and result                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/libraryLabels/{id}:selectConsolidation`  | Supply `{sourceLabel,targetLabel,items}` by joining the exact review pages, retaining their order and observations. An idempotency key is required. Returns `{id,digest,expiresAt}`. |
| `GET /v1/libraryLabelConsolidations/{id}`          | Returns immutable captured evidence, original per-item `operations`, current state and accepted partial item results.                                                                |
| `POST /v1/libraryLabelConsolidations/{id}:confirm` | Explicit `{digest}` and an idempotency key bind the captured selection. Returns `{id,digest,confirmed:true}`.                                                                        |
| `POST /v1/libraryLabelConsolidations/{id}:apply`   | `{ordinal}` applies one selected item, in order. Repeating the ordinal uses its original native assign/unassign receipts. No new client operation key is accepted.                   |
| `POST /v1/libraryLabelConsolidations/{id}:cancel`  | An idempotency key cancels new effects and returns accepted partial results.                                                                                                         |
| `DELETE /v1/libraryLabelConsolidations/{id}`       | An idempotency key removes the finite retained composition; it does not undo accepted effects or remove either label.                                                                |

Selection re-runs bounded native review and rejects changed visible evidence, nonmovable items and substituted
labels. It captures distinct live parent IDs/revisions, exact source and target assignment incarnations/revisions,
current Subject identity/type/security evidence, the initiating client and attribution, and stable original command
keys. The review selection digest cannot confirm a move. Confirmation rechecks the captured evidence and binds
its separate immutable digest. Refresh requires removal of the old composition, a new review and new explicit
confirmation. Original selection receipts never recreate expired or removed evidence.

Decision: retain one composition per owner for 15 minutes, including completed/cancelled results, and apply one
explicit ordinal per request; explicit removal releases admission without changing native facts.

Fresh native effects share-lock the retained confirmation against cancellation/removal/expiry, acquire the native
Subject guard before sorted exact parent locks, recheck both parent revisions and the addressed source/target
facts, and re-admit current Subject authority and security evidence. Target assignment runs through native 32-slot
admission; only its definite accepted receipt permits addressed source unassignment. Existing target assignment
has no duplicate event or domain effect. No source-first removal, extra reservation reclaim, temporary 33rd label,
source-label removal or renewed undo deadline is introduced.

Items expose `pending`, `unknown`, `target_accepted` or `moved`. A durable start precedes native dispatch. Result
and retry resolve original native receipts, including a target acceptance whose acknowledgement/checkpoint was
lost. Receipt-only recovery cannot start a fresh fact effect, including after cancellation. If target acceptance is
known but the source evidence changed, the target remains accepted and the source remains untouched. Cancellation
can leave such a partial result; it promises neither batch atomicity nor automatic rollback. Native undo addresses
the original source assignment ID and deleted revision and retains its original finite deadline and current
identity/capacity/authority requirements. Replay never consumes a later restored or replacement source.

Use `evidence.sourceLabel.id` and `evidence.targetLabel.id` to reopen the existing native
`GET /v1/libraryLabelAssignments?labelId={id}` readers (or their existing FULL views). Web's existing Labels
interface owns this one flow: explicit selection, review, selection capture, explicit confirmation, one-item retry,
partial results/cancel, and reopening both labels. The native migration and Library schema snapshot include the retained composition. Client declarations still require
regeneration before integration. No Web component or competing label editor is installed here.
Unselected facts, query operands, import evidence and public snapshots retain their native meanings. These methods
grant no Entry state, Session, follow, licence or publication.

The retained root has an exact owner primary key, a 32,768-byte payload bound, 1..16 items and an indexed
partition/expiry window. Existing label maintenance removes expired roots under the account barrier, and the
shared Library owner-graph erasure has an appended `label_consolidation` phase. No local timer or new bulk engine
is used. Shared receipt/History payload minimization retains its existing native ownership.

## Cost and verification boundary

Review performs four fixed owner snapshots, six exact label metadata probes, two partition probes and native time
acquisition, plus exposure admission before inspection and final disclosure. Each returned item's native Subject
admission is charged before and after inspection, including mapping, original/terminal authority and their nested
account/family work. Inaccessible items perform no assignment probes. Each admitted item performs an exact source
tuple read and the existing reservation statement: at most 32 covering entries plus one exact target tuple probe,
including a negative target result. Capacity inspection performs at most 32 exact parent points. Serialization
charges the repeated selection, full legal names, cursor and response. No locks, reclamation or writes occur.

Tuple predicates use `(route,account_id,subject_id,label_id)` on the assignment primary key. Reservations use
`label_assignment_reserved_source` with `(route,account_id,subject_id)` and `slot_no IS NOT NULL`, ordered by
`assignment_id`, limited to 32. The partial unique reserved-slot index bounds this source even with arbitrary
deleted history. Parents use `personal_label(route,account_id,label_id)`. Neither LIMIT alone nor the live-label cap
bounds deleted-parent scans; the lateral OFFSET 0 barrier preserves parameterized parent points rather than an
owner-history join. Only an actual deleted parent at these points is
a reclaim witness. Review does not pay for native reclamation or extend any deadline.

Focused native cases cover conflicts, negative target probes, deep/final pages, maximum names, stale assignment
revision, source delete/recreate, target rename, another owner, inaccessible IDs, strict selection validation,
32-live-parent refusal and deleted-parent reservations without read effects. Complete caller statements, rows,
buffers, bytes and effects at native64/512/4096 with fixed S/P remain required. Native setup failure stays
failed/unmeasured. Movement, rollback, original retry, lost acknowledgement, cancellation, finite undo, terminal
cleanup and complete caller growth are continuation acceptance, not inferred from review.

Sources read: `docs/library-labels.md`, native metadata/assignment commands and storage, reservation/parent/tuple SQL
and migrations, native Subject and family admission, shared cursor codec and existing native label fixtures. No
external product survey is needed to preserve the adopted native model.

## Focused native coverage and deferred measurement

`services/kernel/test/library/label-consolidation.test.ts` composes real catalogue/assignment commands, native
review, installed HTTP routes, original receipts and shared erasure. It covers selected moves and native reopening,
existing targets, 32-slot refusal/deleted-parent admission, stale source identity/revision, source recreation,
target rename, changed Subject exposure, lost acknowledgement, replay after restoration, cancellation, finite undo,
owner isolation and terminal/expiry removal. The original pure-review focused tests retain their assertions.

Complete-caller native64/512/4096 measurements remain continuation work, including nested authority, locks,
receipt resolution, History/events, export fences, serialization and terminal cleanup. The new composition adds
fixed exact root reads/writes, at most two indexed parent points and two tuple points per fresh guard, and up to
four native supplied-ID review pages per capture. Each apply has at most one native assign and one native unassign;
receipt-only result recovery uses the original keys and rolls back absent-receipt fresh bodies. Capacity refusal
rolls back native admission and preserves the source; existing-target acceptance uses the native minimal no-effect
receipt. These index predicates explain bounded intended work, not measured complete-caller growth or buffers.
The due query uses `(partition_no,expires_at,route,account_id)`; no deleted-parent catalogue scan is introduced.
Broader native/growth and Web acceptance remain deferred to integration.
