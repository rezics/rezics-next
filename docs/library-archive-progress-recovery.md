# Native archive progress recovery

This extends the existing private Library archive owner. It accepts completed Library export V1/V2/V3 artifacts;
it is not another importer or a general progress engine. Each reviewed archive occurrence creates one fresh native
Session. Existing Sessions, Entry state, entitlement, repeat history, publication and ownership are untouched.

Decision: recovery is per occurrence: the owner maps the source Subject to its current canonical Subject, and each
review creates a distinct fresh Session. A new review ID is a new review epoch; a previous apply key cannot be reused
for it.

Decision: A retained native command whose archive checkpoint is missing is recoverable; uncheckpointed facts stay hidden until the original receipt advances the checkpoint.

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
| Journal/reflection/assessment              | Unsupported. This progress journey discards journal dates, reflection and V3 assessment; no public votes or historical progress are created.                                                                                                                                                                                                     |

The review reports recovery as complete, partial or unsupported alongside applicable. A partial review can apply its
admitted operands while preserving each unsupported fact in the review result. The final result rereads the accepted
current Session and exact completed IDs through their native owner methods. Applying does not restore old History or
claim complete historical recovery.

Version compatibility and per-section byte accounting belong to the existing
[bounded copy adapter](library-copy-archive-recovery.md). V2/V3 additions remain unsupported coverage here;
only Session/unit records enter the existing progress evidence table. The installed producer emits V2; V3 is a
declared decoding seam pending producer delivery. Recovery continues to use the persisted original native
operands, key and checkpoint contract. Artifact versions do not change review epochs, native acknowledgement,
current profile/Subject admission or partial outcomes.

## Review epochs, retry and cancellation

A review binds owner, upload, original export version, selected occurrence and ordinal, normalized reviewed operands,
current canonical Subject/profile pin and meaning, identity epoch/component and its own review ID. The reviewed plan
does not target an existing Session revision because recovery always creates a fresh one; all new writes use native
shared revision checks. Replaying a review key with changed operands returns an idempotency conflict. A refreshed
review needs a new review key and cannot reuse an apply key already assigned to another review in the upload.

Before the first effect, Apply stores the exact native command key and canonical original operands. Each revision-
sensitive command includes the expected Session revision returned by the preceding native receipt. After a command
commits, its checkpoint stores the created Session identity and revision and pre-persists the next exact command.
Retry replays those stored operands through the native original receipt; it never rebuilds a command from a newer
Session revision under an older key. Native command authority, current Subject/profile checks, and revision fences
remain inside native transactions. A currentness failure becomes stale; it never falls back to the archived pin or a
fixture authority. A retained command with a lost checkpoint reports `recoverable`, and the result hides current
Session and episode facts until receipt reconciliation advances that checkpoint. A changed review requires a new
explicit binding and cannot adopt an older operation's receipt.

Cancellation prevents a command that has not yet been claimed. A claimed in-flight command is replayed and
checkpointed before the application reports a partial result; accepted Sessions remain. Partial reports how many
bounded steps were accepted. Ordinary addressed Session retirement remains a separate native command.

Upload cancellation keeps inspection available until the fixed expiry and prevents new review/apply effects. The
owner can delete expired evidence; account erasure calls the same bounded removeCopyArchivePage cleanup. Removing
archive/review/application evidence does not undo a native Session already accepted.

## Limits and caller cost

| Symbol            | Bound                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| U                 | 32 MiB raw upload                                                                    |
| N                 | 100,000 export records; JSON depth 16; 66,000 encoded bytes per record               |
| retained evidence | 32 MiB per upload; at most 4,096 holdings                                            |
| P                 | 10 review-page rows; each page derives at most P+1 indexed rows                      |
| A                 | 8 total measures including the primary, hence at most 7 additional                   |
| I                 | 20 selected episode IDs, limited by the delivered direct-membership cap              |
| review retention  | 4,096 review rows and 32 MiB evidence per upload; each review at most 32 KiB         |
| command retention | 8 KiB canonical JSON operands per application; at most 4,096 applications per upload |
| lifetime/cleanup  | 7-day expiry is eligibility, not timed physical deletion; each removal or terminal-erasure call deletes at most 100 indexed child rows, then a separate empty-root delete; the helper's returned `removed` count is children only |

Parsing is O(U+N) under the byte/depth/record limits. Review uses one selected-occurrence lookup, at most I selected
unit rows, one current Subject/profile observation and final currentness fence, plus at most I bounded direct
membership reads. It never scans retained owner history or arbitrary catalogue graphs.

Apply performs at most ten native commands for a scalar Session (A measure writes plus create and optional
transition). The archive caller performs one initial owner operation to load the review and persist the create
command, one checkpoint operation per native command, and one cancellation gate before each later command: at most
twenty archive operations and no separate Session reads during Apply, down from the prior path's up to twenty-one
archive operations and nine Session reads. That twenty is an archive transaction count, not a count or cost claim
for the nested native commands. Each native command still includes its own authorization, target/currentness checks,
preparation, locks, receipt, source fences, triggers, History/events, serialization, transaction and rollback.

A lost acknowledgement before a checkpoint adds one bounded archive reload (`reserve`) and a retry through the same
native original receipt. Nested native rollback is charged inside that native command; a thrown checkpoint or
archive operation is not free and is another caller restart through `reserve`. For L lost-ack replays before
checkpoint, the archive transaction count across the first attempt and those retries is at most 20+L, and no native
effect is duplicated. A rejection that records `stale`/`failed` after a native failure adds one archive write of
that outcome; native work that rolled back is still charged.

Each command serialization is bounded by 8 KiB; a ten-step application cumulatively rewrites at most 80 KiB of
command JSON while retaining at most 8 KiB of active command JSON. Those are different quantities. Across 4,096
retained applications, active command JSON is at most 32 MiB per upload.

`progressResult` is not part of Apply's zero-Session-read claim. It performs its own archive observations (load
review/application, then a currentness recheck) plus `readSession` and, when the plan has unit IDs, `readEpisodes`.
A scalar plan with empty `unitIds` has E=0 episode reads. The complete journey is Apply + `progressResult` +
serialization of both responses.

Cleanup enters through owner `remove` or terminal-erasure `copy_archive`, each holding the root lock after
admission, not through `removeCopyArchivePage` alone. The shared page budget is at most 100 child rows across
application, review and upload-row tables and is not reset per table. Each visited table does one indexed bounded
selection/delete. A separate indexed root DELETE with three bounded existence probes runs after that; the final page
may therefore remove 100 children plus one root. The helper's returned `removed` counts children, not the root.
SQL statement count is not the removed-row count. A 100-row all-application page can physically delete at most
800 KiB of active command JSON, plus separately bounded row/review/result data; that 800 KiB is not a charge for
the root, probes, locks or wrapper. Root/probes/locks/wrapper are charged separately. The seven-day expiry makes
evidence eligible; it does not promise timed physical deletion. Explicit removal and terminal erasure continue while
children remain.

Completed-unit membership is paid by the native episode command once. Page and cleanup work use the archive's
section/session indexes. No arbitrary LIMIT over unrelated units or History establishes the I/P bounds. No
production total-history COUNT proves the cleanup cap; tests name known identities and remaining active bytes
outside the measured caller.

### Caller equations

Symbols: A=apply archive transactions, N=nested native commands, L=lost-ack replays before checkpoint, R=result
archive observations, S=Session reads, E=episode reads, C_child≤100, C_root∈{0,1}. Unrelated same-owner
Session/unit/History population is U.

- Apply (ten scalar steps, no lost ack): A=1+10+9=20, S=0, N=10. Command JSON retained ≤8 KiB; cumulative rewrite
  ≤80 KiB. Envelope in U: statements and returned/affected rows constant; shared hit/read logarithmic in U
  (index). Change-linear in N and accepted steps, not in U.
- Retry from a lost ack before checkpoint of step k: the retry caller still pays remaining checkpoints and
  cancellation gates; L such replays add L archive reloads. Across first attempt plus retries, A≤20+L. Nested
  native rollback is inside N, never omitted from the journey. Retry rows are logarithmic in U (reserve plus
  nested native index probes); statements stay constant.
- Rejection after native currentness/conflict failure: N includes the rolled-back command; one extra archive write
  records `stale`/`failed`. Envelope in U remains constant/log.
- Result: R=2, S=1, E=1 if unit IDs else 0. Scalar recovery here has E=0. Envelope in U: constant/log.
- Journey: J = Apply + Result + both serializations. Zero Session reads describes Apply only.
- Cleanup page: wrapper (admission, authorization, currentness, operational transaction) + root lock + removing
  mark + per visited child table an indexed select/delete against the remaining shared budget + optional root
  delete with three probes. Envelope in U: constant statements/rows, logarithmic blocks. Change-linear in C_child,
  not in total owner history. Final page: C_child + C_root. 800 KiB is the application-command JSON maximum on an
  all-application child page, charged beside the root/probes/locks/wrapper, not instead of them.

Native64/512/4096 whole-caller statements, returned/affected rows and shared hit/read for apply, retry,
rejection/rollback, `progressResult` and owner-remove cleanup are executed by
`services/kernel/test/library/copy-archive-progress-growth.test.ts` against an isolated native stack and a bounded
fixture. Unrelated same-owner Session/unit/History rows are seeded as planner population; measured callers remain
the production apply, result and owner-remove paths. Sequential scans are allowed only while a relation stays within the shared eight-page tiny-heap
limit; unit, History and archive child tables must be index-only once they exceed it. Native Session writers
still seq-scan `progress_session` above that limit; Library owns those triggers. Apply's measured archive
envelope stays constant/log in U. Native growth
capture admits 128 MiB of charged plan evidence so a ten-step composed apply can retain its nested notices. The installed export currently emits V4, which the archive
parser does not accept; the growth fixture encodes a V2 artifact from the native Session rather than the live
producer. Native Session writes require `advance_progress_discovery_generation_update` to alias transition tables as
`previous_row`/`next_row`; PL/pgSQL `OLD`/`NEW` make `old.route` and `new.route` ambiguous. Native64, Native512 and
Native4096 are measured by that growth test. Other scales stay unmeasured. The focused owner-outcome test in
`copy-archive.test.ts` is not a substitute for those measurements.
