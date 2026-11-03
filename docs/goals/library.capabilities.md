# Library capability acceptance inventory

The owner-only `GET /v1/libraryReportedYearSummary?year=...` and typed
`libraryReportedYearSummary.get({query:{year}})` extend the delivered native journal and all-time counters.
The [reported-year contract](../library-reported-year-summary.md) owns precision, independent bucket grouping,
installation/currentness and Web318 clear/cancellation/retry receiving. Focused scenarios are in
`test/library/reported-year-summary.test.ts`; three-scale and full lifecycle acceptance remain deferred to integration.

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
shape, mapping, retained losses, bounds and Web responses; broader frozen acceptance remains an integration check.

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
their Library presence under the existing authority. Stored subject references and accepted profile meaning remain
intact.

Scalar sessions also retain each admitted unit independently: an owner can create and read one chapter-and-volume
session, update or correct either measure under explicit revision control, and replay a write without duplicating its
history or effects. `services/kernel/test/library/progress-http.test.ts` owns the focused native journey;
[Independent progress measures](../library-progress-measures.md) defines the exact API contract and limits.

Each existing occurrence also has a private journal for partial reported start/finish dates and a reflection, with
one revision independent of progress values. [Private progress-session journal](../library-occurrence-reflections.md)
defines the exact producer and Web318 receiving contract; [Personal consumption dates](../library-consumption-history.md)
owns reported-date meaning.

**User job and fixtures:** An owner changes one fact and reads the surviving facts and Everything membership
immediately. The union includes live state, effective labels, retained sessions/history and holdings; following,
curated occurrences and published snapshots alone do not create presence. Fixtures must use accepted subject
references and actual current authorization. Historical pre-profile data and receipts require the accepted
restoration seam; current writes cannot manufacture that history.

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

**User job and fixtures:** The owner sees current Everything membership from independent facts, sees Liked only from
the actual reaction source, resumes the current Continue destination, and uses useful filtered pages without a
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

**Done-when:** Following, private owner counts and History use their existing owner boundaries. Public discovery
contains no private Library facts; publication is explicit, never inferred from payment, import mappings or personal
edits.

**User job and fixtures:** A person follows/unfollows explicitly, reads only authorized private counts, and publishes
a log only through the explicit owner action. Public search, lists, Collections and snapshots expose no private
states, labels, sessions, copies, counts or profile values. The private count reader uses the actual Collection,
Space or account-management authority and the outgoing follower's own identity.

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

Native `POST /v1/libraryExports`, owner status/pages GET and DELETE cancellation are mounted; the
[portable format and Web handoff](../library-export.md) own schema, meanings, bounds and failure states.
Focused native HTTP cases cover two owners, independent facts, paging, stale edits, cancellation and terminal
barriers. Full integration acceptance remains deferred. Installed Bangumi and unexpired MAL row evidence preserve stored provider identifiers;
raw XML and review/apply capabilities are excluded; no Web export page or re-import compatibility is claimed.

[Personal archive validation and remaining merge journey](../library-archive-merge.md) share the installed v1
producer vocabulary and bounds. An inert bounded decoder checks completed artifacts and reports explicit
entry/label/assignment mapping coverage and retained unsupported sections. Its focused cases include a decode of
actual native export records. No archive-consumer HTTP methods, native merge effects or integrating Web interface
are installed by this preparatory slice. Native review/apply, journal, cancellation, retention/erasure and composed
cost/growth evidence remain pending; the existing export's evidence status is unchanged.

## Evidence stage

Specification, native driver, implementation exposure, user-case acceptance at a recorded revision, and promotion
remain separate stages. Existing wrappers and source exports establish inventory only. Native results, screenshot
artifacts, measurements and promotion are pending integration evidence on its recorded commit.

## Personal Bangumi upload

[Supported envelope and mounted methods](../library-import-bangumi.md) cover private preview, identifier matching,
explicit target review, confirmed native state application, conflict preservation, original-command retries,
bounded partial outcomes, cancellation and owner deletion. Other fields remain private loss-aware evidence.
Focused scenarios: `services/kernel/test/library/list-import-bangumi-http.test.ts`; broader frozen acceptance
remains an integration responsibility, and source delivery does not assert its result.

## Personal MyAnimeList export slice

Mounted source: [MAL contract and Web transport examples](../library-import-mal.md). The implementation binds
current authority, admitted external identifiers, released state roles, native entry revisions and original command
receipts. Private evidence retains fields without native admission, including simultaneous chapter/volume values.
`services/kernel/test/library/list-import-mal.test.ts` covers parser losses and HTTP preview/review/apply,
unmatched selection, conflicts, retry, owner isolation, malformed input, cancellation and terminal denial.
Broader acceptance and integration remain deferred; constructed transport examples are not execution evidence.

# Native archive holdings inspection

[Installed evidence methods and limits](../library-copy-archive-recovery.md) accept actual personal Library v1
artifacts and expose owner-only holding pages, cancellation and bounded removal. Native review, explicit create/reuse,
stable effect outcomes, scheduled expiry removal, client generation and Web adoption remain a continuation.
The focused native scenario is `services/kernel/test/library/copy-archive.test.ts`; full recovery acceptance and
native64/512/4096 executed caller growth are not claimed.
