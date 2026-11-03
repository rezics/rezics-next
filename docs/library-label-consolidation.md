# Selected private label consolidation

This document owns the selected-assignment consolidation journey. [Independent labels](library-labels.md) owns
native identities, commands, finite undo and reservation admission. Consolidation selects exact source and target
label IDs and explicit Subject/assignment identities. Names are display values. It does not enumerate a label's
whole membership, infer selection from a filter, change dynamic Collection operands or delete the source label.

Decision: review is a pure supplied-ID page (16 selected assignments, four per page) with encrypted 15-minute cursors
and no retained review state; its selection digest is advisory and cannot confirm a move. Confirmation requires all
selected items to retain their exact review evidence and current Subject exposure; a plan expires 15 minutes after
creation, at most eight unexpired plans are retained per owner, and each apply request handles one item.

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

## Installed confirmation and movement

`POST /v1/libraryLabels/{id}:confirmConsolidation` accepts the complete review evidence across all pages. It checks
the exact source and target identities/revisions, every selected source and target assignment observation, current
Subject exposure and current native capacity before storing immutable bindings. A selection digest alone cannot
confirm a move. The typed client declarations include review, confirmation, apply, retry, cancel and result routes.

`POST /v1/libraryLabels/{id}:applyConsolidation` advances one selected item. It calls native target assign at the
confirmed target revision, then native source unassign at the confirmed source revision and assignment identity.
Native target assignment also compares the confirmed target assignment observation under the Subject guard. Before
source removal, native unassign checks the exact accepted target incarnation and revision is still effective.
Each stored item has original target and source receipt keys. `retryConsolidation` resumes only an item already in
progress and replays those same receipts after an unknown outcome. `cancelConsolidation` prevents new items and
returns accepted partial results. `GET /v1/libraryLabels/{id}/consolidations/{confirmationId}` reads the current
result under owner and Subject admission. The existing native assignment readers reopen each label after a move.

Decision: confirmation rejects changed, missing, inaccessible or capacity-limited review items as a whole; after
confirmation, a changed binding stops that item and requires a new review. This keeps a selected plan tied to the
evidence the owner explicitly confirmed.

Web's existing Labels interface owns the single consolidation flow and can use these APIs. It must not interpret
`movable` or the `selection` hash as permission or immutable confirmation. No competing label editor, list engine or
bulk job is introduced.

The stored plan binds both parent revisions, assignment incarnation/revision and current Subject exposure. Refresh
requires new explicit confirmation. Native target assign and addressed source unassign retain their receipts,
History, events and export fences exactly once. Source removal follows only definite accepted/current target
assignment, including target acceptance with a lost acknowledgement. Original replay cannot consume a later changed
source. Cancellation stops new items and returns accepted partial results without promising batch atomicity. It
resets an item that has not started its target operation; an uncertain target receipt is replayed and the source is
retained if cancellation arrives before source removal. The source label stays live, and source assignment undo
retains its original finite deadline. Owner erasure removes plans;
the native ten-minute expiry worker deletes expired plans and their bounded child items.

Only native reservation semantics admit target assignment: no source-first deletion, extra reclaim, temporary 33rd
effective label or renewed undo deadline. Source labels remain live until ordinary explicit deletion. Source undo
remains finite, addressed and subject to current identity, cap and authority. Any retained composition needs finite
expiry, bounded per-owner admission and shared terminal/expiry cleanup. The journey grants no Entry state, Session,
follow, licence or publication, and changes no imported evidence or public snapshot.

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

Focused native cases cover review conflicts, negative target probes, deep/final pages, maximum names, stale source
revision/incarnation, source delete/recreate, target rename, changed Subject authority, another owner, strict
confirmation, capacity refusal, successful selected moves, already-on-target, lost acknowledgement replay,
cancellation, finite undo and terminal erasure/expiry cleanup. Complete-caller statements, rows, buffers, bytes and
effects at native64/512/4096 remain deferred to integration. Native setup failure stays failed/unmeasured.

Sources read: `docs/library-labels.md`, native metadata/assignment commands and storage, reservation/parent/tuple SQL
and migrations, native Subject and family admission, shared cursor codec and existing native label fixtures. No
external product survey is needed to preserve the adopted native model.
