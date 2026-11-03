# Selected personal entry correction

The owner may review corrections to priority and private list notes for a fixed set of existing Library entries. This
composition uses the current rich-entry owner and its addressed annotation command; it does not create entries, infer a
selection from a query, or change profile meaning, state history, progress, ratings, source evidence, or publication
authority.

Decision: A review selects at most 16 canonical Subject IDs, returns four items per page, accepts the native 4,096-byte
UTF-8 note bound, stays confirmable for 15 minutes, and retains outcomes for 15 more minutes.

## Journey and native methods

`POST /v1/libraryEntryAnnotationCorrections` accepts `items`, each containing `subjectId`, exact `incarnationId`,
`currentRevision`, and independent `note` and `priority` operations. Each operation is `preserve`, `set` or `clear`.
Review admission checks those identities under the current owner and Subject controls, stores a private owner-bound
review epoch, and returns page zero. Duplicate Subject IDs, invalid values, over-bound notes, and over-bound serialized
requests are rejected.

`GET /v1/libraryEntryAnnotationCorrections/{reviewId}?page=N` returns the current native note and priority for the
selected page, its exact reviewed operation while the selected incarnation remains readable, the original identity and
item outcome, and the next fixed page number. Every response containing private values is `private, no-store`. A
missing entry or a Subject the owner cannot currently read is `unavailable`; a changed incarnation or revision is
`stale`. A recreated incarnation has no current values in this review. Neither case creates an entry or exposes an
inaccessible note or requested note value.

`POST /v1/libraryEntryAnnotationCorrections/{reviewId}/confirm` accepts the exact `epoch` and one selected `position`.
The item uses its review-stored request ID to call the existing `PUT /v1/libraryEntries/{subjectId}/annotations`
command with the annotation revision and entry incarnation/revision guard. A changed entry or annotation requires a
new review. A matching native receipt preserves the original acceptance after a lost acknowledgement. A fresh review
gets fresh request identities and cannot reuse a receipt for changed operands.

`POST /v1/libraryEntryAnnotationCorrections/{reviewId}/cancel` accepts the exact epoch. It retains earlier accepted
items and marks work not yet started as `not-started`. The native annotation command locks the exact review header
while it checks cancellation and applies an edit, so cancellation waits for an in-flight item and prevents later items
from starting. Reopening reports `accepted`, `unchanged`, `stale`, `unavailable` or `not-started` for each selected
item and rereads current native values. Empty note set is invalid; clear stores null. Preserve sends the native
`unchanged` operation. An operation that already matches current values is `unchanged` and creates no annotation
revision, event, History entry or source-fence change; the native command records its original no-effect receipt.

The client exports `EntryAnnotationCorrectionInput`, `EntryAnnotationCorrectionSelection`,
`EntryAnnotationCorrectionOperation`, `EntryAnnotationCorrectionPage` and
`EntryAnnotationCorrectionItem`. `createKernelClient()` exposes the mounted route methods on
`libraryEntryAnnotationCorrections`; confirm takes `{ epoch, position }`, and cancel takes `{ epoch }`.
`PersonalEntryAnnotationWrite.entryGuard` carries `{ incarnationId, currentRevision }` for the addressed native
command. This is the handoff contract for Web318's selected-entry correction flow.

## Retention, authority and cost

At most four open reviews and eight retained review headers are admitted per owner. Each review has no more than 16
items; each stored item retains at most one requested note within the native note bound. Current preview values are read
again from the addressed native entry and are not copied into retained review state. This caps retained requested-note
bytes at 512 KiB per owner, plus fixed row metadata. Admission only retires up to eight expired
rows through the owner-retention index and probes at most nine retained and five live rows. A 15-minute review expiry
is followed by 15 minutes of outcome retention. The scheduled cleanup deletes at most 100 due review headers per
page through `entry_annotation_review_due`; each parent cascade removes at most 16 items. Terminal account erasure
uses its appended `entry_annotation_review` phase and the fixed owner graph query.

For selection size `S=16`, page cap `P=4`, and note bound `B=4096`, request parsing and storage are bounded by `S` and
`B`; response serialization is checked against a 256 KiB byte ceiling. Review-header admission uses
`entry_annotation_review_owner_retention (route, account_id, purge_after, review_id)` and
`entry_annotation_review_owner_expiry (route, account_id, expires_at, review_id)`. Header reopening is one primary-key
lookup on `(route, account_id, review_id)`. Item page reads use the item primary key `(route, account_id, review_id,
position)` with a four-row range. Native entry identity probes use the `library.entry` primary key on
`(route, account_id, subject_id)`; annotation currentness uses `entry_personal_fact`'s same owner/Subject primary key.
Personal read also uses the bounded source-observation parent key and the existing observation order. No page evaluates
a query, scans owner History, or searches for an entry revision.

An accepted item pays the complete existing annotation command path: current account and Subject authorization,
receipt lookup, entry and annotation row locks, annotation CAS, native History/receipt ownership, event and export-source
fence effects. An unchanged guarded command locks and compares the addressed rows, then exits through the native
no-effect path without creating an empty annotation shell. A stale command rolls back its transaction and stores only
the stale review outcome. An unavailable Subject does not call the write command. Original receipt replay skips the
edit and its source-fence and event effects. Cancellation commits prior accepted items and never rolls them back.

Focused journey coverage is in `services/kernel/test/library/entry-annotation-correction.test.ts`. Native64/512/4096
growth acceptance and full caller measurements remain deferred to the controller's frozen acceptance.
