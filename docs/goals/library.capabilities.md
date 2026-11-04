# Library capability acceptance inventory

The owner-only `GET /v1/libraryReportedYearSummary?year=...` and typed
`libraryReportedYearSummary.get({query:{year}})` extend the delivered native journal and all-time counters.
The [reported-year contract](../library-reported-year-summary.md) owns precision, independent bucket grouping,
installation/currentness and the integrating reader’s clear/cancellation/retry receiving. Focused scenarios are in
`test/library/reported-year-summary.test.ts`; three-scale and full lifecycle acceptance remain deferred to integration.

[Selected label consolidation](../library-label-consolidation.md) has native/HTTP review, immutable confirmation,
one-item apply and original-receipt retry, cancellation and result. The typed client declarations expose the full
review/confirm/apply/retry/cancel/result route surface and its retained result wire type.
Review is capped at 16
explicit assignments and four per page; retained plans expire after 15 minutes, with eight unexpired plans per owner.
Focused native files are `services/kernel/test/library/label-consolidation-review.test.ts` and
`services/kernel/test/library/label-consolidation-native.test.ts`; the landing command is
`bun run --cwd services/kernel check test/library/label-consolidation-review.test.ts test/library/label-consolidation-native.test.ts`.
Native outcomes cover evidence conflicts, source and target revision fences, selected movement, no duplicate target
effects, capacity refusal, original receipt replay, cancellation, finite undo and cleanup. Native64/512/4096
complete-caller growth remains deferred to integration; focused results do not establish that growth clause.
The landing entry point is `test/library/label-consolidation.test.ts`, reusing the native outcome scenarios.
Immutable Subject security-evidence binding and typed-client generation remain a continuation alongside growth.

Commerce now installs complete filtered selection capture in the existing Library bulk operation. The preview
names an explicit source Collection and canonical Members filter/order, exhausts the installed native reader under
stable source revision and current viewer authority, and returns captured source operands to the operation client.
The 64-KiB request, 100-page/10,000-candidate preparation bound and 1,000-effect bound are enforced; pending and
unavailable sources remain typed. Status, Collection add, occurrence removal and Library removal all reuse their
existing action admission, immutable manifest and target writer. Remote Collection results now retain the original
target-home receipt until the source operation verifies and acknowledges it. Unknown responses stay reconcilable;
retries keep the same receipt key and operands, and cancellation recovers late committed results before closing the
remaining set. Result pages and state groups remain bounded and leave the confirmed manifest intact. Focused coverage
is `services/kernel/test/library/collection-bulk-capture.test.ts` and the composed route scenarios in
`services/kernel/test/library/collection-bulk-operation.test.ts`, including filtered review, source drift,
same-key confirmation replay, mixed and paged results, remote receipt recovery, cancellation, credential fencing and
expiry cleanup. Accounts erasure still has no account-home producer locator or late-disposition fence for
target-home `bulk_effect` rows; this slice adds no effect ledger or remote receipt erasure claim. Whole native/frozen
acceptance, retained 64/512/4096 growth, browser review, full-Kernel and heavy-placement checks remain controller
work after integration. Web retains its existing four interface owners and uses this operation contract.

Personal consumption statistics now have the mounted owner-only
`GET /v1/libraryConsumptionSummary` and typed `libraryConsumptionSummary.get()` caller.
The [statistics contract](../library-consumption-statistics.md) owns exact occurrence,
distinct-subject, repeat, completeness and retry/clear semantics for the existing Web interface.
Focused native scenarios: `test/library/consumption-statistics.test.ts` cover explicit native
completion, repeats, independent entry state, clear/replay, corrections, removal, unknown
historic profiles, other owners, terminal fences, bounded reads and unavailable/cancelled reads.
Broader acceptance and Web interface validation remain deferred to integration.

This inventory maps the seven Library Done-when clauses to their existing native acceptance, persona denials,
owned routes and current page-story source exports. Product behavior remains in the linked owner documents and the
[Library Goal](library.md). This file records evidence status; it does not replace frozen outcomes or establish
completion.

## Source binding and evidence status

The clean worker source inspected before editing was 5ff5df48738f205a35b56f18576c101e2c310567. The integrated
current-dev quality reports are retained at these source commits:

- commerce-outcomes-quality.md: 75c114ed143ed5c5834d1f34d840bdddcd6b5af3
- library-outcomes-quality.md: dc0e18618eecace62cebd39ebeb9cd91b428d27a
- profiles-labels-quality.md: 327cf74ccadc20d3c16bbf1a12fb7e17141e77f6
- commerce-page-review-quality.md: e903579b1311b6e421d61bc282db5c7b7b02d525
- library-growth-quality.md: e8c73df39740e4325578311e3ab8515e6a18e319
- commerce-cost-lifecycle-quality.md: 3e18811b1f7b2770c2a958bee309d6d282a46f54
- collections-outcomes-quality.md: 33ec58e4d47a648a378006c9c20a389fb1d1e051
- library-page-review-quality.md: b5627d8073412ea5e6d43978c2456c3855b87911

The page-review inventory is bound to source 88a6a9c65a15ad5314f9337a2ddf4362c9df9bed. Comparing that source with
the worker base found no changes to the Library routes, the 53 listed Library story families, the frozen Library
outcome specifications, the Kernel Library wrappers, or the nested Web personal host. Eight other story files
changed. Source equality for these named paths verifies the export inventory only; it is not a fresh Storybook
runtime index or acceptance result.

Every capability below is bound to the worker base plus its cited source review and remains UNMEASURED. The review
reports contain source-declared unavailable fixture or observation seams, not observed failing exits. No Library
native, Web native, acceptance, browser, screenshot, root, worker-check or remote-check was run for this inventory.
The controller defers those checks to integration. Do not infer a pass, failure, flake, visual approval or promoted
revision from a file, a story, a recorded JSON response or a wrapper.

The exact story references below are apps/web/src/stories/<file>#<export>. Viewport selection is global; a single
source export may cover both desktop and phone only when that export renders the named state at both sizes. No
runtime IDs or viewport-suffix IDs are claimed.

## Native acceptance register

Personal AniList portability: `test/library/list-import-anilist.test.ts` exercises the mounted preview/review/apply
composition with persisted native authority and subjects. The [source contract](../library-import-anilist.md) owns
shape, mapping, retained losses, bounds and Web responses. Independent custom-list label adoption is specified in
[the label adoption contract](../library-import-anilist-labels.md) and covered by
`test/library/list-import-anilist-labels.test.ts`; native64/512/4096 complete-caller growth remains deferred.
The generated AniList requests/results now include exact source score evidence, owner-selected native units, separate
effect consent and typed unavailable results. Content's conditional counted-vote/currentness producer is still
missing, so no native score write or clear is admitted and score adoption is not Done. Web325 remains the complete
AniList interface; broader frozen acceptance remains an integration check.

Personal VNDB XML upload now has mounted preview/page/source/review/apply/cancel/delete methods documented in
[its owner contract](../library-import-vndb.md), with focused native HTTP scenarios in
`services/kernel/test/library/list-import-vndb-http.test.ts`. This adds explicit released entry-state application
and private loss retention. Exact source votes now have a separate native-question/units review, but score application
is typed unavailable until Content supplies the writer's atomic reviewed-current admission guard. No native vote,
aggregate, broader frozen acceptance or live provider-account support is claimed.
Retained-source continuation preserves note/date/progress/privacy spelling, separates refreshed metadata consent,
and binds corrected-match label adoption to its reviewed match digest. State, metadata and date lost acknowledgements
can reconcile original native receipts after source expiry/cancellation while fresh effects and expired evidence reads
are refused. The native personal command accepts the existing trusted admission protocol without changing other
providers' request digests. Bangumi metadata now uses that boundary for an exact source-row admission check, then
keeps only opaque original receipt linkage until 24 hours after its unchanged seven-day evidence deadline. The
mounted retry reads exact native receipts without reopening proposals or source text; a started intent without a
receipt cannot dispatch. Scheduled cleanup scrubs and finally deletes through two bounded indexed stages, while
terminal erasure keeps its existing phase. Expired label-preview reconciliation remains unavailable. The source
contract derives whole-document observations, repeated dispatches and cleanup costs; independent all-pool
64/512/4096, composed V4 fidelity/recovery refusal and terminal acceptance remain controller integration work.

The Kernel wrappers import the original frozen specifications. These commands are the supported native entry
points from the worktree root; they are listed as evidence entry points and were not executed here.

| Acceptance surface                        | Existing wrapper and frozen source                                                                       | Command                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal Library outcomes                 | services/kernel/test/library/outcomes.test.ts imports specs/library-outcomes.test.ts                     | bun run --cwd services/kernel check test/library/outcomes.test.ts                                                                                                                                                                                                                                                                             |
| Label outcomes                            | services/kernel/test/library/labels-outcomes.test.ts imports specs/library-labels-outcomes.test.ts       | bun run --cwd services/kernel check test/library/labels-outcomes.test.ts                                                                                                                                                                                                                                                                      |
| Profile outcomes                          | services/kernel/test/library/profiles-outcomes.test.ts imports specs/library-profiles-outcomes.test.ts   | bun run --cwd services/kernel check test/library/profiles-outcomes.test.ts                                                                                                                                                                                                                                                                    |
| Dynamic Collection outcomes               | services/kernel/test/library/dynamic-outcomes.test.ts imports specs/dynamic-collections-outcomes.test.ts | bun run --cwd services/kernel check test/library/dynamic-outcomes.test.ts                                                                                                                                                                                                                                                                     |
| Shelf outcomes                            | services/kernel/test/library/shelves-outcomes.test.ts imports specs/library-shelves-outcomes.test.ts     | bun run --cwd services/kernel check test/library/shelves-outcomes.test.ts                                                                                                                                                                                                                                                                     |
| Private follow counts                     | services/kernel/test/library/follow-counts-outcomes.test.ts imports specs/follow-counts-outcomes.test.ts | bun run --cwd services/kernel check test/library/follow-counts-outcomes.test.ts                                                                                                                                                                                                                                                               |
| Entry Undo and terminal lifecycle support | Existing Kernel command, Undo, incarnation, participant, owned-graph and custody suites                  | bun run --cwd services/kernel check test/library/entry-lifecycle-command.test.ts test/library/entry-undo-http.test.ts test/library/entry-incarnation.test.ts test/library/entry-incarnation-precondition.test.ts test/library/erasure-participant.test.ts test/library/erasure-owned-graph.test.ts test/library/native-source-custody.test.ts |
| Entry state history and recovery          | Focused owner history, restore, continuation, incarnation and account-purge scenarios                    | bun run --cwd services/kernel check test/library/personal-http.test.ts test/library/account-fact-purge.test.ts                                                                                                                                                                                                                                |
| Served Web personal outcomes              | apps/web/tests/native/web-personal-driver.host.test.ts binds specs/web-personal-outcomes.test.ts         | bun apps/web/scripts/check.ts --personal-host                                                                                                                                                                                                                                                                                                 |
| Web visual capture                        | Web screenshots use the existing Storybook runner and exact source exports                               | bun run --cwd apps/web screenshots --story 'pages-library-*' --width 390 --width 1280 --out .temp/library-page-review/pages                                                                                                                                                                                                                   |

The Web personal host and focused hosts under apps/web/tests/native/ exist as nested files. The generic host selection
uses only top-level tests/*.host.test.ts and therefore does not discover those nested suites by file presence.
The dedicated personal-host entry above is the recorded entry point for the original Web personal journey. Suite
existence, runner discovery, execution and acceptance are separate evidence.

The original Web personal specification retains 23 cases. Library-relevant entries include:

- specs/web-personal-outcomes.test.ts:183 — Alice tracks a Book and a Recipe, sets a state, adds labels and a copy,
  and records progress through served pages.
- specs/web-personal-outcomes.test.ts:216 — Alice library page lists exactly the native entries across real
  pagination.
- specs/web-personal-outcomes.test.ts:225 — Alice state filter lists exactly the native entries in the selected
  state.
- specs/web-personal-outcomes.test.ts:238 — Alice's curated Collection page shows its native members to her and
  once publicly to anonymous.
- specs/web-personal-outcomes.test.ts:252 — a member of a mounted Zone Collection appears on the served Zone page.
- specs/web-personal-outcomes.test.ts:260, 265, 270 and 277 — the Library, state, curated Collection and mounted
  Zone member filters return their exact native members.
- specs/web-personal-outcomes.test.ts:281 — Bob sees none of Alice's private state, labels, copies or progress.
- specs/web-personal-outcomes.test.ts:312 and 333 — each personal BFF request carries Alice's identity/current
  authority; revocation stops access on the next request.
- specs/web-personal-outcomes.test.ts:349 — suspension signs out at the next BFF request and refuses a
  suspended-account sign-in.

## Private cross-subject diary

The [private consumption diary](../library-consumption-diary.md) installs `GET /v1/libraryDiary` and
`POST /v1/libraryDiary:cancel`, with exact reopening through the existing presented progress-session detail.
Recording-start/UUID descending navigation preserves repeats and incomplete sessions without a shelf entry,
publication or known historical dates. The installed journal supplies optional partial dates and a private numeric
assessment with its independent meaning revision; the diary projects it without changing recording order. Both stay
independent of progress revision and public Subject votes; corrections and clearing use the journal owner's methods.
Native owner/subject authority, caller-bound absolute expiry,
bounded indexed slots and terminal erasure are part of the reader contract. The compact native scenarios are
`services/kernel/test/library/diary.test.ts`; frozen acceptance and the reserved integrating Web surface remain
controller-owned. No competing interface or new historical-date writer is introduced.

### Reported-year occurrence navigation

The existing private diary now accepts typed year and month/`unallocated` filters and returns actual completed
occurrence IDs, including repeated Subjects, with summary-comparable revision currentness. Native journal indexes
seek addressed buckets; corrections and retirement invalidate filtered continuations. Existing unfiltered order,
scopes, disclosure, eight navigation slots, cancellation and exact Session/journal reopening are retained.
[Installed navigation and cost contract](../library-consumption-diary.md#opening-a-reported-year-count) owns the
query shape and lifecycle. Focused typed-client scenarios extend `services/kernel/test/library/diary.test.ts`.
Web318 continued by Web142 remains the history interface owner. Frozen acceptance, Web integration and executed
whole-caller native64/512/4096 growth remain deferred to integration.

Composed continuity uses the installed all-time source generation for both summary and filtered diary, including
reflection/assessment corrections that leave membership unchanged. Exact original-key receipt replay preserves
currentness and the addressed occurrence; null/zero and independent journal/progress revisions stay distinct.
Unfiltered history tolerates absent optional journal columns with unavailable dates and omitted unsupported assessment.
The existing Web diary guards unavailable dates. `services/kernel/test/library/diary-continuity.test.ts` adds persisted
repeats, correction across buckets, private values, historical profile display, concealment, eight-slot exhaustion,
original cancellation, absolute expiry and terminal cleanup. Inclusive source cost is in the
[statistics contract](../library-consumption-statistics.md#composed-occurrence-continuity-cost); native three-scale,
frozen, full-Kernel and rendered review remain controller-owned, with no execution result claimed here.

## Capability map

### 1. Shared curated and built-in Collections

**Done-when:** Curated and built-in Collections share identity, visibility, common members/filtering, ordering
where applicable, notes, follows, export and Zone mounting. Curated duplicate occurrences stay editable; removing a
mount does not delete its Collection.

**User job and fixtures:** Owners create, read and edit a curated Collection; readers see only the permitted
visibility; built-in dynamic Collections use the same identity and member cursor while retaining unique canonical
subjects. Native fixtures use real owner partitions, curator/member relationships, public/private/unlisted
visibility, duplicate occurrences and notes. The Web personal fixture includes a real mounted Zone consumer.
Story-only constructed members or export responses do not establish native API behavior.

**Native acceptance entries:** specs/library-outcomes.test.ts:292 (public/private/unlisted visibility), :315
(revision guard), :351 (ordered duplicate members, moves, notes and deletion), :418 (foreign mutation denial), and
:819 (explicit Collection follow remains private). specs/dynamic-collections-outcomes.test.ts:349 (curated and
built-in identity/cursor/visibility), :394 (duplicate occurrence order and notes versus unique built-ins), :566
(curator authorization and viewer-native reads), :594 (owner-private predicates), :709 (follow, mount, export and
bulk selection use the same Collection identity), and :846 (curated order versus dynamic unique keyset).
The Zone owner suites are test/zones/membership-contract.test.ts and test/zones/page-continuation-contract.test.ts;
the served Zone outcome is also retained at specs/web-personal-outcomes.test.ts:252 and :277.

**Personas and denial cases:** curator/owner, another authenticated viewer, anonymous, suspended and terminal
accounts; public, unlisted and private Collections; foreign/private mutation denial; current viewer-native member
reads; hidden targets and unavailable source authority remain separate cases.

**Owned routes and story exports:**

- /collections/$id — library-collection.stories.tsx#Curator, #PrivateCurator, #AnotherReader, #PrivateNotFound,
  #UnknownNotFound, #UnlistedVisitor, #PublicVisitor, #Empty, #OnePage, #ManyPages, #NotesAndDuplicates, #Preparing,
  #RestartAfterEpochChange, #PublicItemListExport, #PublicItemListExportOwnerUnavailable and
  #PublicItemListExportIncomplete.
- Collection editing and occurrence identity — library-collection-editor.stories.tsx#Details, #Members, #Reordering,
  #Note, #Selection, #RemovalAndUndo, #ExpiredUndo, #SelectedRemoval, #SelectedMove and #AddItems;
  collection-add-members-phone.stories.tsx#OwnerAddsOccurrence and #UncertainOccurrenceRecovery.
- Built-ins and filtering — library-collection-dynamic.stories.tsx#Everything, #Liked, #State, #Paged, #Preparing and
  #Unavailable; library-collection-filters.stories.tsx#Reference, #ConceptSelected, #WordRangeApplied,
  #CombinedFilters, #NoMatches, #Preparing and #FilterSourceUnavailable.
- Following and preview — library-collection-patterns.stories.tsx#FollowingEnabled and
  library-collection-preview.stories.tsx#Members, #Empty, #Unavailable and #Preparing.
- Creation and pins — /collections/new and /library/collections use
  library-collections.stories.tsx#CreateValid, #CreateInvalid, #CreatePending, #CreateFailed, #NoCollections,
  #ManyCollections, #PreviewMembers, #PreviewPending, #PreviewUnavailable, #PinAndUnpin, #MovePinnedCollection,
  #PinConflict, #PinAtCapacity, #PhoneSelectorOpen and #CollectionsAndPinsUnavailable.
- Saved rules — /library/rules/new uses library-collection-rule.stories.tsx#Draft, #ActualCreate,
  #PrivateUnavailable and #Denied. /collections/$id/rule uses
  collection-rule-editor-details.stories.tsx#Available, #NarrowLongText, #RetainedStateSet, #UnavailableChoices,
  #UnconfirmedSave and #NewPrivateDraft.
- Selected publication — /collections/$id/publish uses
  library-collection-publication.stories.tsx#SelectedEmpty, #SelectedNonempty, #Denied, #Stale, #SourceUnavailable
  and #Retry.
- Zone mounting and mounted membership — /zones/$id and its subject routes remain Zones-owned. The existing
  zone.stories.tsx entries stay in the Zone ledger; the Web personal native cases above cover the mounted consumer.
  No Zone story is recast as a Library-owned page story.

**Evidence:** Base 5ff5df48738f205a35b56f18576c101e2c310567; collections-outcomes-quality report
33ec58e4d47a648a378006c9c20a389fb1d1e051 and library-page-review-quality report
b5627d8073412ea5e6d43978c2456c3855b87911. Source inventory only, UNMEASURED. The dynamic review names missing
fixture and source-observation seams; no inferred incompatibility is an observed failing exit.

**Commands:** Use the frozen wrappers in the Native acceptance register. The Kernel, Zone and Web commands are
evidence entry points only; none ran in this inventory.

### 2. Independent personal facts and Library presence

**Done-when:** Owners manage exclusive states, independent labels, copies/holdings and every supported progress
mode, including rereads and noncontiguous completed units. Clearing one personal fact preserves other facts and
their Library presence under the existing authority. Owners also create/read/correct/clear private notes, personal
priority and independently addressed provider-entry privacy/timestamp evidence without manufacturing state. Stored
subject references and accepted profile meaning remain intact.

Scalar sessions also retain each admitted unit independently: an owner can create and read one chapter-and-volume
session, update or correct either measure under explicit revision control, and replay a write without duplicating its
history or effects. `services/kernel/test/library/progress-http.test.ts` owns the focused native journey;
[Independent progress measures](../library-progress-measures.md) defines the exact API contract and limits.

`progress-measures.test.ts` adds the composed selected-occurrence MAL/AniList chapter-and-volume journey, concurrent
separate corrections, journal preservation and uncertain native receipt recovery after profile
replacement or retirement. Native adoption preserves admitted siblings and reuses the original key/revision before
current readback; fresh effects bind the reviewed profile inside the writer. Removed measures keep their accepted
meaning and values while current recording is unsupported. Retired detail remains concealed. Existing presentation
coverage for missing releases, incompatible units and unsupported historical pairs is retained. Full/frozen native,
all-pool three-scale growth and browser acceptance remain controller-owned and unexecuted in this change; the
inclusive cost derivation is source analysis, not measured acceptance.

Each existing occurrence also has a private journal for partial reported start/finish dates, a reflection and an
integer assessment (units 0–20, displayed as units/2), with one revision independent of progress values and an
assessment meaning revision independent of public questions. [Private progress-session journal](../library-occurrence-reflections.md)
defines the exact producer and Web318 receiving contract; [Personal consumption dates](../library-consumption-history.md)
owns reported-date meaning.
Entry state recovery is a separate owner-only journey: inspect exact native transitions, review one before-state
against the current live incarnation and profile, then restore it through a revision-guarded fresh edit.
[Library entry state history and recovery](../library-entry-state-history.md) owns the installed methods, coverage,
conflicts, retention and cost bounds. Focused HTTP and account-erasure coverage lives in `personal-http.test.ts` and
`account-fact-purge.test.ts`.

The bounded viewer-facts producer at `services/kernel/src/library/viewer-facts.ts` composes the installed
`rating/register.ts` counted reader with prepare before checkout, read inside the caller snapshot, and finish after
release. Standard-question survivor and redirected requests use counted targets, with duplicate correlations and
exact Entry precedence. Native present/zero, clear, absence and unavailable retain their identity/revision and
currentness evidence privately. The unchanged wire maps clear to an absent score and refuses an entire page for
native disclosure unavailable. Nonstandard questions explicitly return vote unavailable/question. Search keeps
its staged admission/final disclosure obligations and Web keeps its interfaces; this is independent of owner-wide
shelf score currentness and score ordering.

Source outcome coverage is `test/library/viewer-facts.test.ts`, using real vote/merge commands and the native
worker rather than a replacement reader, including late selected-row changes. Native execution was not reached:
the focused runner reports `Schema dump differs from db/library/schema.sql.` before tests. The real compiler/
generator was attempted but stopped on existing missing counted-client declarations and unrelated workspace
errors; it emitted no client closure. This runtime change needs no wire extension; existing viewer-facts and
counted-client generation remain separate. Frozen full acceptance and independent native growth remain controller
checks. The [owner contract](../library-and-collections.md) publishes wire caps separately from native limits and
accounts for preparation/disclosure, caller seeks, final repeated observations, encoding and retry/failure work.

**User job and fixtures:** An owner changes one fact and reads the surviving facts and Everything membership
immediately. The union includes live state, nonempty private annotations, reviewed source observations, effective
labels, retained sessions/history and holdings; following, curated occurrences and published snapshots alone do not
create presence. Source privacy never authorizes public disclosure. Fixtures must use accepted subject references
and actual current authorization. Historical pre-profile data and receipts require the accepted restoration seam;
current writes cannot manufacture that history.

**Native acceptance entries:** specs/library-outcomes.test.ts:492 (exclusive state and CAS), :553 (incarnation
guards and captured receipts), :646 (one progress mode/intent), :680 (sparse completed-unit changes), :738
(backward cursor and stale revisions), :764 (reread history), :786 (independent copies), and :847 (private fact
concealment). specs/library-labels-outcomes.test.ts:132 (labels coexist with exclusive state), :446 (state and
labels remain independent), :486 (labels create no implicit state/session/holding/follow/entitlement), and :537
(state-only and label-only source facts). specs/library-shelves-outcomes.test.ts:352 and :527 retain progress
activity and reread behavior.

**Personas and denial cases:** owner, foreign viewer, anonymous and suspended bearer are independent. Private
state, labels, sessions, units, copies and follows remain concealed from another account and anonymous requests;
suspended private reads/writes fail with the existing authorization response. Subject revocation and stale
revisions do not become empty success.

**Owned routes and story exports:** /library uses library-entries.stories.tsx#SignedIn, #ExposureOpen, #ExposureClosed,
#StateFilterCleared, #FilteredEmpty, #UndoAfterShelfRemoval, #RestoreOccupied, #RestoreStale, #RestoreExpired,
#UndoRestored, #SelectedLabelChoice and #TypeSelected; library-patterns.stories.tsx#EntryPresentations,
#SmallEntryGrid, #MediumEntryGrid, #LargeEntryGrid, #StateFilterActive and #SelectionMode. /library/copies uses
library-copies.stories.tsx#ManyCopies, #None, #OneCopy, #LongContent, #NoLongerOffered, #UnsupportedProfile,
#KnownHistoricalLabels, #UnknownLegacy, #ExactCapturedStatusEdit, #EmptyLaterPage and #DeniedDetail, plus
library-copies-patterns.stories.tsx#AddFormOpen, #EditFormOpen, #CreateRefused, #MultipleCopyTypes,
#HistoricalMeaningUnavailable and #StaleDelete. /library/progress and /library/progress/$id use
library-progress.stories.tsx#SignedIn, #LaterPageEmpty, #FilteredLaterPageEmpty, #UnknownUnitNarrow,
#Unavailable and #ExplicitVersionChoice; library-progress-session.stories.tsx#ProfileUnits, #EmptyChanges,
#CompletedAmountHistory, #SparseHistory, #RetiredPair, #HistoricScalar and #Unavailable.

**Evidence:** Base 5ff5df48738f205a35b56f18576c101e2c310567; library-outcomes-quality report
dc0e18618eecace62cebd39ebeb9cd91b428d27a and profiles-labels-quality report
327cf74ccadc20d3c16bbf1a12fb7e17141e77f6. Source inventory only, UNMEASURED. Existing original assertions stay
unchanged; the reports' historical fixture limitations are not failing exits.

**Commands:** Use the frozen wrappers in the Native acceptance register. They are evidence entry points only; none
ran in this inventory.

FULL personal shelf and static curated Collection pages now attach Type-specific key facts from one bounded Semantic
list-presentation batch. The selected Type and active release govern facts; Collection presentation overrides do not.
The shared subject summary keeps language and cover handling, duplicate original Collection occurrences remain ordered,
and page lookahead is excluded from Semantic and viewer authority. After foreign reads, the exact native page is
reauthorized before disclosure. A visible subject with no configured keys returns `{}`; missing/denied identity or a
changed page withholds the row. Page-level viewer-fact failures (`identity`, `currentness`, `response_limit`) are
returned as value-free `unavailable`; row-level zero, absence and scope/question-unavailable states remain distinct.
Personal-score ordering remains `503 dependency_unavailable` until Content supplies the owner-wide currentness fence;
the bounded viewer overlay does not satisfy it.

Deferred to controller integration: frozen A06 acceptance, full-Kernel/root checks, native growth/placement evidence,
browser stories and the heavy acceptance suite. This worker runs only changed-workspace typechecking and the changed
focused tests under the landing policy.

### 3. Definition-driven profiles, release changes and historic reads

**Done-when:** Definition-driven Library profiles work consistently across compatible subject types, release
changes and historic reads/Undo. Generic labels and curated edits need no invented profile or state.

**User job and fixtures:** A subject accepted by its released definition uses only the declared state/progress/copy
values. The owner can still read and clear a value pinned to an older accepted release after a type/release change,
and exact Undo restores its historic meaning. Generic labels and curated membership remain available without an
invented profile. Native profile inputs compile through Definitions; historic pre-profile DATA and original receipts
remain a distinct fixture requirement.

**Native acceptance entries:** specs/library-profiles-outcomes.test.ts:158 (pins through migration and replay), :202
(immutable publication and activation/rollback), :232 and :245 (data-only verticals and inheritance), :286
(changed/removed values), :452 (all 18 legacy mode/unit pairs), :544 (sparse opaque completion keys), :656
(historic reads after head change), :674 (private profile pins and accepting types), :777 (legacy unknown values),
:1012 (removed values remain readable and clearable), and :1057 (profile removal preserves pinned facts).
specs/library-labels-outcomes.test.ts:813 covers readable unprofiled labels and curated membership without
inventing profiled state; specs/dynamic-collections-outcomes.test.ts:420 and :473 retain compatible profile and
release identity cases.

**Personas and denial cases:** owner, foreign, anonymous and suspended; hidden subject, revoked subject-read
authority, missing current profile, old-but-readable value and unsupported fresh write are separate. A denied caller
does not infer an accepting type, value, profile pin or migration state.

**Owned routes and story exports:** /library and subject controls use
library-entries.stories.tsx#TypeSelected, #TypeNoMatch and #TypePickerUnavailable; library-progress.stories.tsx
#UnsupportedProfile, #UnknownUnitNarrow, #ExplicitVersionChoice and #UnknownUnitDetailsOpen;
library-progress-session.stories.tsx#ProfileUnits, #RetiredPair, #HistoricScalar, #SparseHistory, #UnresolvedUnit
and #WithheldSummaries; progress-index-historical-meaning.stories.tsx#MissingHistoricalMeaning,
#ExactValuesByKeyboard and #KnownUnitUnchanged. Independent label and unprofiled states use
library-labels.stories.tsx#UnprofiledSubject; library-label-shelf.stories.tsx#Hidden; subject-labels.stories.tsx#NoLabels
and #PickerOpen; and
library-collection-editor.stories.tsx#DynamicRule and #Presentation.

**Evidence:** Base 5ff5df48738f205a35b56f18576c101e2c310567; profiles-labels-quality report
327cf74ccadc20d3c16bbf1a12fb7e17141e77f6. Source inventory only, UNMEASURED. The report identifies an unavailable
historical DATA/receipt restoration fixture and migration-page observations; these are source gaps, not observed
test errors.

**Commands:** Use the frozen wrappers in the Native acceptance register. They are evidence entry points only; none
ran in this inventory.

### 4. Everything, Liked, Continue, filtering and bounded owner queries

**Done-when:** Everything, state, Liked, Continue and canonical browsing meet the adopted native owner-query and
disclosure contracts. Filtering and owner-local plans work wherever the common Collection abstraction appears,
with next-read owner-write visibility, honest preparation/unavailable responses and bounded native work.

**User job and fixtures:** The owner sees current Everything membership from independent facts, including annotation-
only and provenance-only entries, sees Liked only from the actual reaction source, resumes the current Continue destination, and uses useful filtered pages without a
false empty result, hidden-data leak or cross-owner read. Native queries use actual writes followed by next-read
observations, admitted filters, sparse pages and every declared growth axis. Reported scales are authored targets,
not measured populations.

**Native acceptance entries:** specs/dynamic-collections-outcomes.test.ts:506 (labels, state, retained sessions and
holdings preserve Everything membership), :552 (source changes invalidate old cursors), :594 (private predicates
stay owner-only), :652 (bounded filtered useful pages), :685 (viewer-bound cursors), :778 and :915 (three-scale
page-work and sparse filter bounds), and :1029 (Everything excludes follow-only, curated-only and unsupported
state). specs/library-shelves-outcomes.test.ts:743 and :792 (tab sort and ties), :886 (state filter and Continue
share the shelf mode), :942 (private cursor binding and expiry), :997 (owner privacy), and :1260 (bounded shelf
order/progress). The Web personal outcomes at :216, :225, :260, :265, :270 and :277 verify served Library/state/
Collection/Zone member lists. Dedicated Continue source scenarios remain in
specs/web-personal-outcomes.test.ts and the native source owner suites.

The installed rich-entry owner journey is `test/library/entry-personal.test.ts`: independent note/priority CAS,
reviewed provider admission/correction, partial and offset source timestamps, account isolation, source retry,
stale/duplicate refusal, and annotation-only/provenance-only Everything support. Terminal fact deletion includes
retained source rows in `test/library/account-fact-purge.test.ts`. These focused tests do not establish the deferred
full Everything/Web acceptance journey.

Selected priority and private-note correction is installed in `test/library/entry-annotation-correction.test.ts` and
the [selected correction contract](../library-entry-selected-correction.md). It binds fixed Subject IDs to entry
incarnation, entry revision, annotation revision and review epoch; cancellation leaves accepted items intact, and
native receipt replay does not repeat their annotation effects. Native64/512/4096 growth acceptance remains deferred.
Retained provider metadata composition is owned by [library-import-entry-metadata](../library-import-entry-metadata.md):
it reviews actual retained provider fields, requires explicit per-field confirmation, and uses the native annotation
and provenance commands. Focused import metadata scenarios live in `test/library/entry-import-metadata.test.ts`;
native growth acceptance remains deferred to the controller.

**Personas and denial cases:** owner and another owner partition, anonymous public reader, suspended bearer,
public/private/unlisted Collection, public-source revocation, hidden candidate, private filter, unsupported filter,
unavailable source, expired or tampered cursor, and terminal account fencing remain separate.

**Owned routes and story exports:** /library uses library-page-states.stories.tsx#EverythingAndLiked,
#ContinuePresent, #ContinueAbsent and #PinnedCollections; library-personal-library.stories.tsx#SelectedPartialOutcomes,
#SelectedUnknownRecovered, #SelectedNoCommonState, #SelectedAuthorityLost, #SelectedLabelPartialOutcomes,
#ChronologicalOrder, #ChronologicalDenied and #ContinueUnavailable. The dedicated /library/continue route currently
has library-continue.stories.tsx#Unavailable; region patterns are library-continue-patterns.stories.tsx
#FractionProgress, #PositionOnlyProgress, #NoProgress, #SessionOnly, #Empty, #Preparing, #Unavailable, #Denied and
#Navigation; the reader patterns are continue-reader-phone.stories.tsx#RegionNavigation,
#DestinationNavigation and #UnavailableRecovery. /collections/$id uses the dynamic and filter stories listed under
capability 1. The mounted Zone member consumer remains Zones-owned.

**Evidence:** Base 5ff5df48738f205a35b56f18576c101e2c310567; collections-outcomes-quality report
33ec58e4d47a648a378006c9c20a389fb1d1e051, library-growth-quality report
e8c73df39740e4325578311e3ab8515e6a18e319 and library-page-review-quality report
b5627d8073412ea5e6d43978c2456c3855b87911. Source inventory only, UNMEASURED. The current reports retain missing
reaction/private-subject fixtures, prepared-query readback, full-pool cost observations and growth measurements.
No missing producer was replaced and no authored budget was weakened.

**Commands:** Use the frozen wrappers in the Native acceptance register. The Kernel and served Web commands are
evidence entry points only; none ran in this inventory.

### 5. Following, private counts, History and public disclosure

**Done-when:** Following opens readable Subject, Collection and Space destinations from native FULL rows and exposes
only current destination actions; unavailable, stale or inaccessible Space targets stay unavailable. Private owner
counts and History use their existing owner boundaries. Public discovery contains no private Library facts;
publication is explicit, never inferred from payment, import mappings or personal edits.

**Commerce Collection discovery contribution:** `publicCollectionDiscoverySource({pool})` supplies bounded current
native candidates and `readPublicCollectionDiscoverySummaries(dependencies, ids, context)` supplies the final
authorized card batch. Search's existing mixed reader admits 200 identities and preserves routed 100-key batches;
Content must use the current summary union and canonical Collection destination. Current withdrawal, stale lifecycle
crossing and absent selected-output authority fail closed. De-identified curated public headers use their retained
native authority; retained dynamic output without its native witness and the Collection population census remain
unavailable. The new persisted lifecycle and exact-100 summary cases live in
`services/kernel/test/library/collection-discovery-summaries.test.ts`. Worker typechecking and focused discovery
tests are separate from the deferred frozen/native acceptance, Search/Content Home acceptance, independent
64/512/4096 retained-handle growth, browser review, root/full-Kernel and heavy placement checks; those remain
unexecuted here and with the controller.

**User job and fixtures:** A person follows/unfollows explicitly, reads only authorized private counts, and publishes
a log only through the explicit owner action. The single Following page retains Subject and Collection behavior,
resolves Space address or Realm navigation through Community, and returns caller-current viewer actions without
implying membership. Public search, lists, Collections and snapshots expose no private states, labels, sessions,
copies, counts or profile values. The private count reader uses the actual Collection, Space or account-management
authority and the outgoing follower's own identity.

**Native acceptance entries:** specs/library-outcomes.test.ts:626 (explicit unfollow survives entry transitions),
:819 (Collection follow remains private), :847 (owner data is concealed from other and anonymous), :884 (public
subject listing excludes private derived rows), :937 (published logs are immutable snapshots with owner controls),
and :979 (suspended credentials refuse private reads and writes). specs/follow-counts-outcomes.test.ts:71–179
(management authority, identity resolution, denial and cursor boundaries), :190–266 (replay, suspension and terminal
work), and :288–327 (unavailability, public artifacts and growth). Its literal cases include
“follower counts are visible only through existing target management authority and outgoing follows only to their
follower,” “anonymous suspended no-scope and closed gate requests fail closed without disclosing counts,”
“unready projection and unavailable Access never masquerade as observed zero,” and “private follow data never enters
public responses FTS public counts sitemaps or notifications.”

**Personas and denial cases:** following owner, target manager, delegated manager, foreign viewer, anonymous,
suspended, missing-scope and concealed target. Preserve 401 for anonymous, 401 invalid_credentials for a suspended
bearer, 403 for missing scope, concealed 404 and unavailable 503. Unavailable is never zero. Public discovery and
private history authorization are separate authorities.

**Installed native Following producer:** `services/kernel/test/library/full-views.test.ts` covers a mixed page with
Subject, Collection and address-backed Space destinations, a changed Space address, caller-current action operands,
unavailable unsupported targets and concealed inaccessible targets. This focused evidence does not replace frozen
native acceptance or its bounded-growth review.

**Owned routes and story exports:** /library/following uses library-following.stories.tsx#SignedIn, #Empty,
#HiddenTarget, #UnfollowFailure, #Unavailable and #Error; following-controls.stories.tsx#FollowAndRemove,
#UnavailableTarget, #Pending, #AmbiguousRetry, #Conflict and #Revoked. /library/follow-counts has two separate
source families, both currently titled Pages/Library/Private follow counts:
library-private-follow-counts.stories.tsx#ReadyZero, #ReadyNonzero, #ContextualZero, #DeniedContext, #Unavailable,
#Loading and #InvalidContext; private-follow-counts-phone.stories.tsx#RecoveryToFollowing, #BackToLibrary,
#LongCountAndGuidance and #IndependentRecoveryAndWithdrawal. These are separate file#export families, not a
viewport-suffix pairing. /library/logs (My logs) uses library-my-logs.stories.tsx#Owner, #Empty, #Long,
#UnknownSubject, #Denied, #Unavailable, #Preparing, #NewestPage, #Restarted and #SignedOut, plus
published-log-history-phone.stories.tsx#OwnerHistoryNavigation, #LongNotesAndNavigation, #FirstPageEmpty,
#LaterEmptyRecovery, #UnavailableRecovery, #DeniedRecovery, #PreparingRecovery, #RestartedHistory, #RestartedEmpty
and #SignedOutRecovery. /logs/$id uses library-log.stories.tsx#SignedIn and #SignedOut; owner snapshot/delete/restore
states use library-logs-patterns.stories.tsx#Snapshot, #ConfirmDelete, #Deleted, #Restored and #RestoreRefused.

**Route distinction:** there is no /library/history route. Retained progress/session history uses
/library/progress/$id; owner-published logs use /library/logs; a published-log detail uses /logs/$id.

**Evidence:** Base 5ff5df48738f205a35b56f18576c101e2c310567; library-outcomes-quality report
dc0e18618eecace62cebd39ebeb9cd91b428d27a and library-page-review-quality report
b5627d8073412ea5e6d43978c2456c3855b87911. Source inventory only, UNMEASURED. The private-count fixture's operated/
organization Auth host and terminal deletion operation remain unavailable in source; that limitation is not an
observed failure and no successful subset substitutes for the original suite.

**Commands:** Use the frozen wrappers in the Native acceptance register. The Kernel and served Web commands are
evidence entry points only; none ran in this inventory.

### 6. Exact Undo and complete terminal cleanup

**Done-when:** Lifecycle cleanup covers the complete owned graph and shared payload custody, with immediate terminal
fencing, real participant completion and no resurrection. Ordinary exact Undo remains governed by shared deletion.

**User job and fixtures:** An owner can perform ordinary exact Undo only inside the shared deadline and only while
the same independently live reservation remains eligible. At terminal time, fresh authentication and typed
confirmation fence writes before cleanup; completion requires all real participants and shared payload custodians,
durable acknowledgement and replay/resurrection safety. Local empty stores, queued work, dispatched work and
workflow history removal are not completion.

**Native acceptance entries:** specs/library-labels-outcomes.test.ts:571 (logical label deletion hides query facts),
:598 (bounded cleanup recovery), :644 (account-deletion barrier), :1044 (stale reservation and parent Undo cap),
:1092 (parent hiding and unchanged-claim Undo), and :1134 (retained identity through stale purge). The profile
specification at :940 covers a deletion fence against paused migration recovery. Existing supporting suites are
services/kernel/test/library/entry-lifecycle-command.test.ts, entry-undo-http.test.ts,
entry-incarnation.test.ts and entry-incarnation-precondition.test.ts; terminal/shared custody suites are
erasure-participant.test.ts, erasure-owned-graph.test.ts, native-source-custody.test.ts and the existing
services/kernel/test/access/erasure-native.test.ts and auth-history-proof.test.ts.

**Personas and denial cases:** owner, another viewer, anonymous, suspended, scope-less and terminal owner; current
authorization before receipt lookup; expiry, occupied replacement, stale compare-and-swap, child-before-parent
cleanup, late delivery and resurrection are distinct outcomes.

**Owned routes and story exports:** ordinary entry Undo uses
entry-removal-undo-phone.stories.tsx#RemovalAndUndo, #OccupiedRecovery, #StaleRecovery, #ExpiredRecovery,
#RestoredFullText, #UnavailableResult, #ClosedResult and #RemovedWithoutReceipt, plus
library-entry-undo.stories.tsx#NoJavaScriptUndo. Label Undo uses library-labels.stories.tsx#Undo,
#RetainedUndoAfterStale and subject-labels.stories.tsx#UndoVisible. Published-log deletion uses
library-logs-patterns.stories.tsx#ConfirmDelete, #Deleted, #Restored and #RestoreRefused.
The existing bulk status and Undo routes are /library/operations/$id and /library/operations/$id/undo; no dedicated
Library story family exists for either route, so their page-story cells remain explicitly missing. This does not
authorize a new bulk protocol or story.

**Evidence:** Base 5ff5df48738f205a35b56f18576c101e2c310567; library-outcomes-quality report
dc0e18618eecace62cebd39ebeb9cd91b428d27a, profiles-labels-quality report
327cf74ccadc20d3c16bbf1a12fb7e17141e77f6 and library-growth-quality report
e8c73df39740e4325578311e3ab8515e6a18e319. Source inventory only, UNMEASURED. The Auth account-operation host,
shared Source/DBOS cleanup custody, complete participant disposition and durable acknowledgement remain
source-declared gaps. No local cleanup result or missing binding is reported as a test failure.

**Commands:** Use the frozen Library wrappers in the Native acceptance register. Existing Access and shared History
proof remains with its owner. All commands are evidence entry points only; none ran in this inventory.

### 7. Real APIs and storage through reviewed pages

**Done-when:** Real APIs and storage support subject actions, Library/Collection browsing and editing, labels, copies,
progress, Following and History through reviewed pages using Web's shared shell and patterns.

**User job and fixtures:** The served page uses the real API response and current identity for the named route,
persona and action. Frozen native outcomes establish the backend boundary; Storybook source exports establish only
authored interface scenarios. The native Web personal specification is the composed served-page supplement; a
mocked or recorded story is not a substitute for it.

**Native acceptance entries:** the five original Kernel wrappers listed above remain the frozen Library acceptance.
The served Web personal suite includes the exact cases at specs/web-personal-outcomes.test.ts:183, :216, :225, :238,
:252, :260, :265, :270, :277, :281, :312, :333 and :349. Existing focused nested host files are
apps/web/tests/native/library-navigation.host.test.ts, library-labels.host.test.ts,
native-curated-collections.host.test.ts, native-following.host.test.ts and web-personal-driver.host.test.ts. The
focused hosts' existence does not prove discovery by the generic top-level host selection.

**Personas and denial cases:** owner, another viewer, anonymous, suspended and terminal; Collection curator/reader
visibility; private-label denials; subject authorization/revocation; explicit public versus private data; route
loading, preparation, unavailable and errors remain separate states.

**Owned routes and source-story register:**

| User surface and route file                                                                                            | Owner boundary                                                                               | Existing source-story references                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal Library — apps/web/src/routes/library/index.tsx                                                               | Commerce owns the journey; Web owns the shell and patterns                                   | library-page-states.stories.tsx#Empty, #ContinuePresent, #ContinueAbsent, #LongContent, #Unavailable, #Error, #EverythingAndLiked and #PinnedCollections; library-entries.stories.tsx#SignedIn, #ExposureOpen, #ExposureClosed, #StateFilterCleared, #FilteredEmpty, #UndoAfterShelfRemoval, #UndoRestored, #SelectedLoadedPage, #ChosenColumns, #SelectedLabelChoice, #TypeSelected and #TypeNoMatch                                                                                                                                                                                                                                                          |
| My Collections — apps/web/src/routes/library/collections.tsx                                                           | Commerce journey; Web presentation                                                           | library-collections.stories.tsx#NoCollections, #ManyCollections, #PreviewMembers, #PreviewPending, #PreviewUnavailable, #LongCollectionTitles, #Unavailable, #Error, #PinsUnavailable, #LibraryNoPins, #LibraryThreePins, #LibraryNinePins, #CollectionsNoPins, #PinAndUnpin, #MovePinnedCollection, #PinConflict, #PinAtCapacity and #PhoneSelectorOpen                                                                                                                                                                                                                                                                                                       |
| Dedicated Continue — apps/web/src/routes/library/continue.tsx                                                          | Commerce journey; Web presentation                                                           | library-continue.stories.tsx#Unavailable; library-continue-patterns.stories.tsx#FractionProgress, #PositionOnlyProgress, #NoProgress, #SessionOnly, #Empty, #Unavailable, #Preparing, #Loading, #Denied and #Navigation; continue-reader-phone.stories.tsx#RegionNavigation, #DestinationNavigation and #UnavailableRecovery                                                                                                                                                                                                                                                                                                                                   |
| Following — apps/web/src/routes/library/following.tsx                                                                  | Commerce journey; Accounts owns account state                                                | library-following.stories.tsx#SignedIn, #UnfollowMenuPhone, #Empty, #InactivePage, #AfterLastUnfollow, #Unavailable, #Error, #HiddenTarget and #UnfollowFailure; following-controls.stories.tsx#FollowAndRemove, #DeleteOnly, #UnavailableTarget, #Pending, #AmbiguousRetry, #Conflict and #Revoked                                                                                                                                                                                                                                                                                                                                                            |
| Private counts — apps/web/src/routes/library/follow-counts.tsx                                                         | Commerce journey with Accounts management authority                                          | library-private-follow-counts.stories.tsx#ReadyZero, #ReadyNonzero, #ContextualZero, #DeniedContext, #Unavailable, #Loading and #InvalidContext; private-follow-counts-phone.stories.tsx#RecoveryToFollowing, #BackToLibrary, #LongCountAndGuidance and #IndependentRecoveryAndWithdrawal                                                                                                                                                                                                                                                                                                                                                                      |
| Private labels — apps/web/src/routes/library/labels.tsx                                                                | Commerce journey; Semantic owns subject type/visibility                                      | library-labels.stories.tsx#SignedIn, #SignedOut, #Empty, #NextPage, #RenameConflict, #Undo, #LiteralPrefix, #SparsePrefix, #EmptyPrefix, #LaterPagePrefix, #UnconfirmedChange, #RetainedUndoAfterStale, #Unavailable, #Preparing, #UnprofiledSubject, #Capacity, #PickerPages, #PhoneBeforeCapacity, #PhoneCapacity, #RenameSelected and #DeleteConfirmation; library-label-shelf.stories.tsx#ThreeWorks, #FortyWorks, #Empty, #ShelfActions, #RetainedUndo, #Unavailable, #Preparing and #Hidden                                                                                                                                                              |
| Copies — apps/web/src/routes/library/copies.tsx                                                                        | Commerce journey; Semantic owns profile releases                                             | library-copies.stories.tsx#ManyCopies, #None, #OneCopy, #LongContent, #Unavailable, #Error, #NoLongerOffered, #UnsupportedProfile, #KnownHistoricalLabels, #UnknownLegacy, #RequiredReleaseUnavailable, #DeniedDetail and #ExactCapturedStatusEdit; copy-editor-phone-journey.stories.tsx#Inline, #SheetOrDialog and #HistoricalClose; copy-note-reader.stories.tsx#ExactNote, #SeparatePhysicalCopies, #UnresolvedHistory, #RetiredCurrentKind and #KeyboardReading                                                                                                                                                                                           |
| Progress index — apps/web/src/routes/library/progress.index.tsx                                                        | Commerce journey; Semantic owns accepted profiles                                            | library-progress.stories.tsx#SignedIn, #ExposureOpen, #ExposureClosed, #Empty, #LaterPageEmpty, #FilteredLaterPageEmpty, #UnknownUnitNarrow, #Unavailable, #Error, #UnsupportedProfile and #ExplicitVersionChoice                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Progress session/history — apps/web/src/routes/library/progress.$id.tsx                                                | Commerce journey; retained facts stay with Library                                           | library-progress-session.stories.tsx#SignedIn, #ProfileUnits, #ProfileUnitsRecordingUnavailable, #DeclaredRecordingRefused, #RetiredPair, #EmptyChanges, #LongContent, #NarrowOriginalHistory, #CompletedAmountHistory, #Unavailable, #Error, #HistoricScalar, #SparseHistory, #OpaqueCursor, #UnresolvedUnit and #WithheldSummaries; progress-history-reader-recovery.stories.tsx#ShortZeroDuplicatesAndLifecycle, #FirstPageEmpty, #LaterEmptyIndependentRecovery, #SparseFirstPageWithContinuation, #AbsentOperation and #RetiredCurrentAuthority                                                                                                           |
| My logs — apps/web/src/routes/library/logs.tsx                                                                         | Commerce owns Library log history                                                            | library-my-logs.stories.tsx#Owner, #Empty, #Long, #UnknownSubject, #Denied, #Unavailable, #Preparing, #NewestPage, #Restarted and #SignedOut; published-log-history-phone.stories.tsx#OwnerHistoryNavigation, #LongNotesAndNavigation, #FirstPageEmpty, #LaterEmptyRecovery, #UnavailableRecovery, #DeniedRecovery, #PreparingRecovery, #RestartedHistory, #RestartedEmpty and #SignedOutRecovery                                                                                                                                                                                                                                                              |
| Published-log detail — apps/web/src/routes/logs/$id.tsx                                                                | Commerce owns the Library log journey                                                        | library-log.stories.tsx#SignedIn and #SignedOut; library-logs-patterns.stories.tsx#Snapshot, #ConfirmDelete, #Deleted, #Restored and #RestoreRefused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Bulk status — apps/web/src/routes/library/operations/$id.tsx                                                           | Commerce owns operation recovery                                                             | MISSING: no dedicated operation-status story family in the current owned inventory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Bulk Undo — apps/web/src/routes/library/operations/$id_.undo.tsx                                                       | Shared deletion contract owns Undo; Commerce owns the page journey                           | MISSING: no dedicated operation-Undo story family in the current owned inventory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Curated Collection detail — apps/web/src/routes/collections/$id.tsx                                                    | Commerce owns the journey; Web owns the common page and visual review                        | The Collection, editor, dynamic-member, filter and preview exports listed under capability 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Curated Collection creation — apps/web/src/routes/collections/new.tsx                                                  | Commerce owns the journey; Web owns presentation                                             | library-collections.stories.tsx#CreateValid, #CreateInvalid, #CreatePending and #CreateFailed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Saved rule detail/create — apps/web/src/routes/collections/$id_.rule.tsx and apps/web/src/routes/library/rules/new.tsx | Commerce owns the journey; Semantic owns definition semantics                                | collection-rule-editor-details.stories.tsx#Available, #RetainedStateSet, #UnavailableChoices, #UnconfirmedSave and #NewPrivateDraft; library-collection-rule.stories.tsx#Draft, #ActualCreate, #PrivateUnavailable and #Denied                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Selected Collection publication — apps/web/src/routes/collections/$id_.publish.tsx                                     | Commerce owns the journey; Content owns publication facts                                    | library-collection-publication.stories.tsx#SelectedEmpty, #SelectedNonempty, #Denied, #Stale, #SourceUnavailable and #Retry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Subject actions and labels — apps/web/src/routes/subjects/$id.tsx and its slug/view routes                             | Subject page composition remains with its existing owner; Library owns its personal controls | subject.stories.tsx#LibrarySlotMenuPhone, #LibrarySlotMenuDesktop, #ExposureOpen, #ExposureClosed, #UndoAfterLibraryRemoval, #UndoRestored, #RestoreOccupied, #RestoreStale and #RestoreExpired; subject-labels.stories.tsx#NoLabels, #ThreeLabels, #ThirtyTwoLabels, #PickerOpen and #UndoVisible; subject-library-controls.stories.tsx#LoadedCollectionChoices, #LabelPickerAndAssignment and #LabelRemoveAndUndo; subject-library-view.stories.tsx#DetailsSignedOut, #DetailsSignedIn, #RealmCredits and #RelationsSignedOut; library-subject-return-context.stories.tsx#RealmReader, #CurrentReaderView, #CanonicalFallback and #PrivateParametersExcluded |
| Settings Collection visibility — apps/web/src/routes/settings.tsx                                                      | Settings/Accounts owns the page; Library contributes the Collection privacy control          | settings.stories.tsx#SignedIn, #StaleVisibility, #SavedVisibility, #CollectionsClosed and #SignedOut                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Home Continue source — apps/web/src/routes/index.tsx                                                                   | Web owns Home and its shell; Library owns the Continue source contract                       | home.stories.tsx#SignedIn, #PartialSources, #Preparing, #Unavailable, #Empty, #Following, #KindSelection, #KindChoicesUnavailable and #KindChoicesNextPage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Zone-mounted members — apps/web/src/routes/zones/$id.tsx and Zone subject routes                                       | Zones owns mounted page composition and source exposure                                      | Existing zone.stories.tsx#Home, #Subject, #UnknownZone, #PrivateOwner, #Unavailable and #DirectTargetsClosed remain in the Zone ledger; Library does not reassign them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The route register describes authored source stories only. It does not claim recorded-response freshness, native
authorization, browser runner discovery or rendered quality.

**Visual evidence gaps:** no screenshot path, current native recording, browser trace or visual judgment is supplied
for this inventory. The page-review report requires original-size full-page captures at 390 and 1280 widths, light and
dark themes and all eight locales (representative locale selection must be named if not all are reviewed). A 390px
viewport does not establish coarse-pointer behavior. Record fine/coarse pointer, keyboard and touch outcomes
separately, including focus order, Escape/focus return, target size and retry behavior. Capture after story completion
and font readiness; a recorded response or source export is not a screenshot or a visual pass.

## Personal Library portability

New native captures use V4 (`private-library-owner-facts-v4`): the fixed V3 sections followed by `vndbUploads`,
`vndbEvidence`, `anilistUploads`, `anilistEvidence`, with 21 section totals and epoch 4 cursors. Retained unexpired
VNDB and retained AniList parsed source rows preserve provider identifiers, unknown/invalid vocabulary, score scale,
and date precision under recursive capability redaction. Parent/row mutations, expiry without writes, completed
request replay, cancellation and terminal fencing remain fail-closed. The received journal assessment seam is retained
in V4; it adds no writer. V1/V2/V3 decoding remains fixed. Copy/progress inspection accepts the exact V3 assessment
inventory without assessment adoption; Entry/label merge accepts V1/V2. All installed archive consumers refuse V4.
The existing Web export interface and canonical archive consumer retain their interface/recovery ownership. Native growth and broader
integration acceptance remain deferred. See [export contract](../library-export.md#version-4-provider-evidence-and-assessment-seam).

New captures use V4 for provider evidence while stored V3 captures retain the V2 section inventory plus private journal
assessment. Personal archive review accepts completed V1/V2/V3 manifests with exact per-version section and byte
accounting; V1/V2 meanings and inventories remain fixed, V3 assessment is independently reviewed for an explicit
current occurrence. V2/V3 private source observations retain their explicitly mapped admission/correction journey;
V4 provider sections remain unsupported. Entry/label archive merge remains V1/V2 only. Native64/512/4096 executed
growth evidence remains deferred to integration.

MAL, AniList and VNDB consumption-date adoption is integrated with each provider's existing private import journey. A
source row targets one owner-supplied progress occurrence; supported calendar precision is retained through review and
the atomic journal patch. AniList `startedAt`/`completedAt` and VNDB `fields.started`/`fields.finished`
retain source precision and use the same atomic journal patch while preserving each provider's row, page, review,
source and cleanup interfaces. Review binds the provider source and canonical Subject to the supplied occurrence,
profile identity and journal revision; the private upload retains per-field receipts. Web303/Web325 keep their existing
interfaces; Web318/Web142 keep journal/history ownership. Generated client declarations remain unavailable until the
kernel client producer has its configured compiler database. See the [date adoption contract](../library-import-consumption-dates.md).

Native `POST /v1/libraryExports`, owner status/pages GET and DELETE cancellation are mounted; the
[portable format and Web handoff](../library-export.md) own schema, meanings, bounds and failure states.
Focused native HTTP cases cover two owners, independent facts, paging, stale edits, cancellation and terminal
barriers. Full integration acceptance remains deferred. Installed Bangumi and unexpired MAL row evidence preserve stored provider identifiers;
raw XML and review/apply capabilities are excluded; no Web export page or re-import compatibility is claimed.

[Curated Collection recovery](../library-archive-collection-recovery.md) consumes completed V1/V2 native exports through
owner-only upload, indexed preview, explicit canonical Subject review, bounded native apply and per-occurrence
outcomes. The typed client exposes upload, status, Collection/occurrence pages, review, apply, outcomes and cancel.
Explicit reviewed presentation now defaults to mixed or admits an actual current Type, preserving raw archived
meaning and distinguishing alternatives. Immutable review digests bind the choice/current release and original native
create operands/key; stale new creation is refused, exact receipts replay and later stored-choice fallback persists.
The actual route schema exposes preview/review/confirmation/result additions with `fullRestoration:false`.
The library schema snapshot is refreshed from the actual migrated database; retained client declarations await
the existing producer after the unchanged Community compiler errors are resolved; see the [transport continuation](../../.temp/continuation/collection-presentation-client.md).
Native64/512/4096 and browser/full-kernel acceptance remains unexecuted by this change.
Only one curated Collection is supported; recovery preserves duplicate occurrences, valid archived ordinal order,
and distinct empty/cleared/missing note outcomes while creating fresh private native IDs. The 24-hour expiry is an
absolute admission cut: a live lease cannot admit another native step, while one already-admitted effect retains its
exact key and operands until the original native receipt is reconciled. Expiry redacts private review evidence and
cleans at most 100 indexed child/root rows per invocation; accepted native Collections and their member facts remain
independent. Dynamic and built-in Collections, grants, saved rules and public output remain unsupported. Broad
native64/512/4096 growth acceptance and the adjacent Web recovery interface remain deferred to integration; Web323
still owns export UI.

[Personal archive review and merge](../library-archive-merge.md) accepts the exact installed V1/V2/V3 format without
changing V1/V2 section inventories. The bounded decoder checks complete manifests, records and bytes; private methods
page evidence and coverage, require explicit canonical Subject plus current Entry/Session review, and delegate selected
entry, label, assignment, annotations, journals, and source observations to their existing native commands. V3
assessment adoption binds its meaning, current assessment, Session creation/identity, profile guard and journal revision,
then sends one original PATCH with the selected dates, reflection and assessment. V1/V2 assessment absence, unknown V3
meanings and archive IDs remain non-authoritative evidence. Source-observation admission and correction bind the
explicit canonical Subject and provider/record address; archived privacy or timestamps do not set native visibility or
audit time. The consumer retains per-item receipts, cancellation, seven-day lifetime and owned-graph erasure. Focused
scenarios cover both private journeys, zero/nonzero/null, repeated occurrences, stale targets, exact replay, partial
cancellation, expiry and denial. Generated client emission remains pending on existing Kernel compiler errors; the
retained snapshot lacks assessment, reflection and immutable review-revision confirmation. Canonical archive8bb/Web323
owns that generated handoff; Web318/142 keeps the manual occurrence interface. Frozen acceptance and measured
native64/512/4096 cost evidence remain deferred. See [personal fact recovery](../library-archive-personal-fact-recovery.md)
for supported field choices and limits.

Archive Entry/label confirmation declares generator-visible upload/preview/review/apply methods and explicit per-item
`reviewRevision` from the [merge owner](../library-archive-merge.md). Mixed stale batches are refused before native
effects; accepted keys, canonical operands and receipts survive retries. Focused native coverage is
`services/kernel/test/library/library-archive-merge.test.ts`. Client transport coverage in
`packages/client/tests/library-archive-merge.test.ts` preserves original JSON text and envelope upload through preview.
The complete typed journey must add review and exact returned-revision apply together with refreshed declarations.
The retained generated upload body is `unknown`, preview/review omit `reviewRevision`, and apply accepts
`{ordinals: number[]}`. Regeneration and the typed `{items: {ordinal: number; reviewRevision: number}[]}` confirmation
journey remain required before Web file admission; see
[the generated transport continuation](../../.temp/continuation/archive-client-installation.md). Source-checked emission
now precedes full workspace compiler/construct checks and includes independent public type exports; publication still
requires every check. The canonical Web archive
consumer8bb owns file/recovery UI integration. Frozen acceptance and composed native cost measurements remain deferred to integration.

### Native archive progress recovery

[Installed evidence methods](../library-copy-archive-recovery.md) and [progress recovery methods](../library-archive-progress-recovery.md)
accept completed personal Library V1/V2/V3 artifacts with exact per-version section and byte accounting.
The installed producer emits V2; V3 uses the declared assessment vocabulary pending producer delivery.
Annotations, provenance, journals/assessment and provider evidence remain unsupported in this progress journey;
only manifest/coverage and typed holdings/Session/unit evidence are retained. V4 remains refused. Holdings remain
evidence-only; an explicitly reviewed progress occurrence creates a fresh native Session through the installed Session and direct episode-membership commands.
Exact command operands and expected revisions survive a lost archive checkpoint and replay through the original
native receipt. The owner reports `recoverable` while reconciliation is pending and withholds uncheckpointed facts.
The focused native scenario is `services/kernel/test/library/copy-archive.test.ts`; frozen full recovery acceptance
and native64/512/4096 executed caller growth remain unmeasured and deferred.

### Personal Bangumi upload

[Supported envelope and mounted methods](../library-import-bangumi.md) cover private preview, identifier matching,
explicit target review, confirmed native state application, conflict preservation, original-command retries,
bounded partial outcomes, cancellation and owner deletion. [Retained tag adoption](../library-import-bangumi-labels.md)
adds separate owner review/confirmation and native private create/assign commands with original receipts, explicit
unchanged/invalid/stale/capacity/partial outcomes and bounded same-row review cleanup. A seven-day absolute deadline
gates reads, reviews, fresh state/label admission and provider-evidence export; the scheduled expiry worker deletes at
most 99 rows plus a root per current-owner-fenced command, and terminal erasure uses the existing appended
`bangumi_upload` phase. Review command receipts keep only opaque tokens; acknowledged native facts survive expiry.
Exported Bangumi evidence remains V4 export-only and V1/V2/V3 recovery inventories are unchanged. Native64/512/4096
whole-caller growth and composed frozen acceptance remain deferred to integration. Score review now retains and displays Bangumi's source score and scale
beside the selected Content question and owner-entered units; zero, absence, unsupported values and explicit clear
remain distinct. Set/clear confirmation is separate, but score outcomes are typed unavailable until Content provides
an atomic reviewed question/current-vote/counting-identity guard for `createVoteCommands.putVoteOutcome`; no native
vote or aggregate write is claimed. The focused HTTP test covers source distinctions, consent omission, changed
selection and preservation of an existing vote. Score declaration generation and Web rendering remain continuation
work with their existing owners; no completed score UI is claimed. The existing Web324 interface consumes the
generated state/tag delivery.
The private note/privacy/source-date path still needs receipt-only recovery when an already-started native command
crosses source expiry; expiry must not admit a new effect once the evidence is scrubbed. Local Kernel typecheck
reported `../../packages/client/src/index.ts(268,8): error TS2307: Cannot find module './kernel/rating/own-votes-counted' or its corresponding type declarations.` among other diagnostics. Focused HTTP/export/erasure tests
did not execute because the check stopped at `Schema dump differs from db/library/schema.sql.` The Content-owned schema
derivation is pending; no frozen, native growth, browser or root check was run.
Focused scenarios: `services/kernel/test/library/list-import-bangumi-http.test.ts`; broader frozen acceptance
remains an integration responsibility, and source delivery does not assert its result.

### Personal MyAnimeList export slice

[Retained MAL tag adoption](../library-import-mal-labels.md) adds exact supported source evidence, reviewed
existing IDs/proposed normalized names, per-value native create/assign outcomes and original-key resumption to the
installed review/apply producer. `test/library/list-import-mal-labels.test.ts` covers the private label journey,
grammar losses, duplicates, invalid/colliding names, capacity, target replacement, refresh, lost acknowledgement,
partial cancellation, expiry/removal and foreign owners. The account graph test includes retained adoption fields.
Generated-client label coverage, explicit changed-Subject mapping and whole-caller native64/512/4096 coverage
remain pending. The [Performance review](../library-import-mal-labels.md#performance-review) records the
O(R*T*D) document work and requires JSONB traffic and nested preparation/History/event/index costs in that
measurement. Frozen integration remains deferred; no new growth measurement is claimed.

Mounted source: [MAL contract and Web transport examples](../library-import-mal.md). The implementation binds
current authority, admitted external identifiers, released state roles, native entry revisions and original command
receipts. Score review retains the source value and scale, owner-selected standard-question units, private own-vote
baseline and explicit clear/replacement consent in the existing bounded plan. The conditional Content vote writer is
not installed, so selected score actions return typed unavailable and perform no vote effect; score adoption is not
Done. Private evidence retains fields without admission, including simultaneous chapter/volume values.
`services/kernel/test/library/list-import-mal.test.ts` covers parser losses, score review/unit selection, zero and
missing score consent, stale local votes, typed unavailable outcomes and the existing preview/review/apply, retry,
owner isolation, malformed input, cancellation and terminal denial cases. Broader frozen acceptance and integration
remain deferred; constructed transport examples are not execution evidence. Persisted VNDB lifecycle cases remain
unverified because native fixture setup fails on the retained base as detailed in the source owner contract.

### MAL and AniList scalar progress adoption

[The adoption contract](../library-import-progress-adoption.md) extends both retained-row reviews with explicit
existing-occurrence selection or consented native start, current profile/unit checks and per-measure native receipts.
Only exact source-to-unit matches admitted by the active profile are supported; zero remains distinct from missing,
local values are preserved by default, and scalar counts never create canonical Episode facts or dates. The focused
provider tests cover source review, native measure adoption and result reopening. Native growth execution and full
controller acceptance remain deferred.

### Explicit VNDB private label adoption

[The adoption contract](../library-import-label-adoption.md) installs owner-private map/review/page/apply/retry/cancel
methods on the existing VNDB flow, indexed finite consent/items, native creation/assignment receipts and source
cascade cleanup. Focused source and erasure cases accompany the implementation. Web303 integration and executed
native64/512/4096 whole-caller growth measurements remain controller work; derived bounds alone do not close them.

## Canonical episode completion capability

Owners can independently mark canonical episodes 1 and 3 while 2 stays unmarked, with specials and rereads kept
separate. The mounted `progress_session.episodes` and `progress_session.record_episodes` operations use persisted
Episode Subjects and admitted direct parent relationships; generic progress retains its existing meaning.
[Exact shapes, limits and lifecycle](../library-episode-progress.md) include private bounded inspection, catalogue
withdrawal/visibility changes, correction/clear, current revisions, owner isolation and stable retry identity. The
focused native journey composes actual inverse pages with exact ID inspection, covers lost acknowledgements and
stale revisions, and shows retired session state separately from current profile support. Its generated client
methods are installed. Concealed/missing Subjects stay redacted with `completed:null`; dependency failure is 503
`semantic_not_ready`; unsupported profile additions are 422 `unsupported_library_profile`; retired reads and fresh
writes are 404 `not_found`, while exact admitted receipts replay. The owner document records response examples and
source-derived costs. The frozen integration, full-Kernel, native 64/512/4096 growth and browser checks remain
controller-owned and were not run in this attempt.

## Personal-score shelf order

The [installed score contract](../library-personal-score-order.md) adds `personalScore` to the actual native
query/schema/client producer, rated-first keysets in both directions, atomic Entry/Content-vote derivative
maintenance and an explicit 100-entry installation command. `test/library/shelf-score.test.ts` covers native raw
page traversal, both filters, zero/ties/unrated, write/clear/counted-target changes, Entry identity/removal,
bounded installation and opaque negative/expired cursors. These are focused tests, not native growth measurements.
Content's owner-wide identity-currentness producer is an explicit unbound port; the default public order remains
503 unavailable even after installation. The viewer-facts overlay is independent. Whole public traversal after
binding the native producer, complete merge/lifecycle currentness and controller native growth remain outstanding
in `.temp/continuation/personal-score-currentness.md`. Existing date-order assertions are unchanged.

## Evidence stage

Specification, native driver, implementation exposure, user-case acceptance at a recorded revision, and promotion
remain separate stages. Existing wrappers and source exports establish inventory only. Native results, screenshot
artifacts, measurements and promotion are pending integration evidence on its recorded commit.
