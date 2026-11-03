# Native archive progress recovery

This extends the existing private Library archive owner. It accepts only the installed Library export v1 artifact;
it is not another importer or a general progress engine. Each reviewed archive occurrence creates one fresh native
Session. Existing Sessions, Entry state, entitlement, repeat history, publication and ownership are untouched.

Decision: recovery is per occurrence: the owner maps the source Subject to its current canonical Subject, and each
review creates a distinct fresh Session. A new review ID is a new review epoch; a previous apply key cannot be reused
for it.

## Owner interface

All pages are private, no-store. Every call requires the receiving owner's current account and personal_library
admission. Progress pages, review, apply and result also require reading_progress exposure. Review requires copy:list
and progress_session:read; apply requires copy:list, progress_session:read, progress_session:create and
progress_session:update. Upload IDs, archived Session IDs and review IDs are scoped to the receiving account.
Foreign, expired, cancelled-for-apply, removing and terminal-account evidence cannot disclose or start effects.

| Method                                                              | Body/query                                                                                               | Result                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| GET /v1/libraryCopyArchives/{id}/progress?after=…                   | Original export ordinal, default -1                                                                      | Up to ten retained Session occurrences and next                   |
| GET /v1/libraryCopyArchives/{id}/progress/{sessionId}/units?after=… | Selected archived occurrence and unit ordinal                                                            | Up to ten exact unit IDs and next                                 |
| POST /v1/libraryCopyArchives/{id}/progressReviews                   | sessionId, current canonical subjectId, mode, current unit, additionalMeasures, unitIds; Idempotency-Key | Bound review, current meanings and support report                 |
| POST /v1/libraryCopyArchives/{id}/progressReviews/{reviewId}:apply  | Idempotency-Key                                                                                          | Bounded application state and exact accepted-step count           |
| GET /v1/libraryCopyArchives/{id}/progressReviews/{reviewId}         | Review ID                                                                                                | Review, application status, and current native Session/unit facts |

For a scalar Session, additionalMeasures is an explicit list of {sourceUnit,unit} mappings. It is capped at
MAX_PROGRESS_MEASURES - 1 (seven); unitIds is capped at MAX_EPISODE_IDS (20). Both arrays are required, even
when empty. The owner selects only IDs present under that archived occurrence. The current Subject must resolve
to itself; an old source ID or reference is evidence, not permission to redirect a request.

Typed kernel/client declarations expose CopyArchiveProgressPage, CopyArchiveProgressUnitPage,
CopyArchiveProgressReview, CopyArchiveProgressApplication and CopyArchiveProgressResult. Web can bind these
methods after their installed declarations are present. Web319 remains the only episode checklist, Web320 the
measure editor and Web323 the export interface. This contract adds no DTO adapter or checklist surface.

## Supported and unsupported facts

| Archived fact                              | Review and native effect                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One Session occurrence                     | Explicitly selected by its archived Session ID within the owner upload. A fresh current Session is created for it. Equal Subject or measures never collapse occurrences.                                                                                                                                                                         |
| Primary scalar amount/total                | Owner selects a current profile unit. Current profile rules validate total and amount independently; exact decimal text is passed through the existing native create/record commands. Missing amount remains absent and zero remains zero.                                                                                                       |
| Additional scalar measures                 | Each archived measure is reviewed independently against its selected current unit. Valid measures are created and recorded under the shared current Session revision. Unknown source units, absent fields, rejected amounts/totals and unmapped measures stay visible as unsupported evidence; they do not invalidate another supported measure. |
| Cursor locator/position                    | Current cursor_position unit must be admitted. A present locator and position are applied together through the native record command; absent or incomplete values are not filled in.                                                                                                                                                             |
| Completed unit identities                  | Only exact selected IDs under the occurrence are eligible. The current profile must admit completed_units/episode; the existing direct current schema:isPartOf membership seam decides each ID. Detached, inaccessible, malformed and unselected IDs are not added.                                                                              |
| Completed-unit count                       | Preserved for review. A count never expands a range or creates identities. When fewer supported IDs exist than the count, only admitted IDs are applied and the review reports the unsupported remainder.                                                                                                                                        |
| State                                      | Archived active stays active. completed and abandoned use the actual native terminal transition after supported values. Retired or unknown states have no recovery plan.                                                                                                                                                                         |
| Historical dates                           | Source start, finish and last-change timestamps remain separately visible and are listed as unsupported. Native Session and transition times use their current command times.                                                                                                                                                                    |
| Version Subject, revision, pin and history | The old version Subject is displayed as unsupported mapping. Archived IDs, profile pins and revisions never authorize or choose commands. Exported progress History is not restored. No existing Session is corrected, retired or reopened.                                                                                                      |
| Journal/reflection                         | Unsupported. These annotations have no installed archive recovery consumer.                                                                                                                                                                                                                                                                      |

The review reports recovery as complete, partial or unsupported alongside applicable. A partial review can apply its
admitted operands while preserving each unsupported fact in the review result. The final result rereads the accepted
current Session and exact completed IDs through their native owner methods. Applying does not restore old History or
claim complete historical recovery.

## Review epochs, retry and cancellation

A review binds owner, upload, original export version, selected occurrence and ordinal, normalized reviewed operands,
current canonical Subject/profile pin and meaning, identity epoch/component and its own review ID. The reviewed plan
does not target an existing Session revision because recovery always creates a fresh one; all new writes use native
shared revision checks. Replaying a review key with changed operands returns an idempotency conflict. A refreshed
review needs a new review key and cannot reuse an apply key already assigned to another review in the upload.

Apply persists one step reservation and checkpoint at a time and calls the existing Session create/record/transition
and episode membership commands. Stable native receipt keys make an original retry after a lost acknowledgement
return the same fresh Session and effects. Before each new effect, current Subject/profile identity is checked
against the review. A currentness failure becomes stale; it never falls back to the archived pin or a fixture
authority. Cancellation prevents the next reservation. An in-flight native command may finish; its exact outcome is
checkpointed, and accepted Sessions remain. Partial reports how many bounded steps were accepted. Ordinary
addressed Session retirement remains a separate native command.

Upload cancellation keeps inspection available until the fixed expiry and prevents new review/apply effects. The
owner can delete expired evidence; account erasure calls the same bounded removeCopyArchivePage cleanup. Removing
archive/review/application evidence does not undo a native Session already accepted.

## Limits and caller cost

| Symbol            | Bound                                                                               |
| ----------------- | ----------------------------------------------------------------------------------- |
| U                 | 32 MiB raw upload                                                                   |
| N                 | 100,000 export records; JSON depth 16; 66,000 encoded bytes per record              |
| retained evidence | 32 MiB per upload; at most 4,096 holdings                                           |
| P                 | 10 review-page rows; each page derives at most P+1 indexed rows                     |
| A                 | 8 total measures including the primary, hence at most 7 additional                  |
| I                 | 20 selected episode IDs, limited by the delivered direct-membership cap             |
| review retention  | 4,096 review rows and 32 MiB evidence per upload; each review at most 32 KiB        |
| lifetime/cleanup  | 7 days; removal and terminal erasure delete at most 100 indexed child rows per call |

Parsing is O(U+N) under the byte/depth/record limits. Review uses one selected-occurrence lookup, at most I selected
unit rows, one current Subject/profile observation and final currentness fence, plus at most I bounded direct
membership reads. It never scans retained owner history or arbitrary catalogue graphs. Apply performs at most ten
native commands for a scalar Session (A measure writes plus create and optional transition), with one
reservation/checkpoint per command, native preparation, receipts, History/event work, source invalidation,
transaction and rollback included. Completed-unit membership is paid by the native episode command once. Page and
cleanup work use the archive's section/session indexes. No arbitrary LIMIT over unrelated units or History
establishes the I/P bounds.

Native64/512/4096 unrelated same-owner Session/unit/History acceptance and whole-caller row/buffer/byte/effect
measurements remain integration acceptance. The focused native test establishes the owner outcome only; it is not a
replacement for the frozen growth oracle. Performance review is requested for any uncertain whole-caller terms.
