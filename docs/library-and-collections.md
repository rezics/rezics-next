# Library and Collections

This document owns the shared personal Library and Collection model. The [Library Goal](goals/library.md) owns its
outcomes and completion; the [Commerce Goal](goals/commerce.md) keeps this work under the same manager. The
[Library module](../services/kernel/src/library/README.md) owns native algorithms and implementation composition.
Buying an offer neither creates a personal fact nor grants protected use; Library presence and Undo never change a
payment or entitlement.

## Ownership and behavior contracts

Web owns the shell, navigation, shared presentation patterns, Storybook and visual review. Existing producers remain
handoffs. Semantic owns definitions, subject identity and shared filter meaning; Search owns catalogue plans;
Accounts owns Access, scopes, account lifecycle and website scope alignment; Content owns Rating, reactions and
publication sources; Kernel owns shared execution, receipts and durable work. No Library or Web layer duplicates
these authorities.

Specialized behavior lives with its owner: [profiles](library-profile-consumers.md), [labels](library-labels.md),
[pins](library-pins.md), [Continue](library-continue.md), [private follow counts](private-follow-counts.md),
[dynamic Collections](dynamic-collections.md), [owner queries](library-owner-queries.md), [filtered lists](filtered-lists.md),
[Collection presentation](collection-presentation.md), [Collection Source](collection-source.md),
[progress adoption](library-import-progress-adoption.md), [VNDB imports](library-import-vndb.md),
[state history and recovery](library-entry-state-history.md), [private consumption](library-consumption-diary.md),
[consumption statistics](library-consumption-statistics.md), [reported-year summaries](library-reported-year-summary.md),
[personal score ordering](library-personal-score-order.md), [occurrence correction](library-occurrence-correction.md)
and [deletion](deletion.md). This shared owner defines the common facts and visit/admission rules; it does not restate
those specialized contracts.

## Personal facts and profile meaning

For one owner and stored subject, an explicit exclusive entry state, labels, progress sessions, holdings and personal
annotations are independent private facts. Ratings remain with Rating. A label does not create state, progress,
holding, follow or presence. Clearing one fact preserves every other live fact and its contribution to Library
membership. Clearing the last qualifying fact removes the subject from Everything; a follow, curated occurrence,
rating, trash snapshot or published-log snapshot alone does not add it.

Immutable Definitions releases supply state sets, progress modes and units, copy kinds/statuses, and accepted import
meaning. A write of a profiled value requires the current accepted profile and exact admitted ID. Historical facts
retain their accepting release pins across publication, retirement, migration and Undo. A missing profile blocks new
profiled values but does not erase historical reads, clearing or exact Undo. Labels and curated occurrence edits
require no invented profile or default state. Sparse and noncontiguous progress units retain their individual
meaning; rereads are distinct occurrences, not a reset of prior history.

Stored subject IDs, personal facts and curated occurrence IDs are not rewritten by identity resolution. New writes
address the current terminal through the ordinary native resolver. Canonical browsing shows one card per canonical
subject while retaining each original fact and accepted pin; it unions independent labels and keeps sessions and
holdings separate. Identity and row order never supply permission. Private owner-write order and identity/source
currentness follow the [owner-query contract](library-owner-queries.md).

Personal notes and priority remain owner-local and revisioned; import evidence does not overwrite them without
explicit review. Copies remain separate holdings with their own status, revision and accepted kind. Optional
physical-condition observations use the finite `physical-v1` media and packaging vocabulary only when the exact
accepted Copy kind declares that condition; omission, explicit `unknown` and intentional `null` clear have distinct
meaning. Current profile advice never changes historical admission.

Personal-score ordering, diary/history, statistics, Progress snapshots and published logs retain the separate
contracts linked above. An active progress session can coexist with a non-active explicit state. Every allowed
progress mode retains its accepted unit semantics; no provider value, session, historic activity or counted use is
inferred from import mapping metadata.

## One Collection abstraction

A Collection has one stable identity, owner/curator, visibility, metadata, membership and mount/follow targets.
Curated membership is an ordered list of distinct occurrences: duplicate subjects remain individually editable,
ordered and noted. Dynamic membership derives unique subjects from native facts or a complete authorized published
output. Canonical browsing may combine matching originals into one card but never rewrites curated occurrences.
Presentation kind and client layout do not change membership or authorization.

Built-ins use the same Collection identity and members abstraction:

- **Everything** contains the distinct subjects with at least one live explicit state, label assignment, progress
  session or holding. Clearing one source does not remove another.
- **State Collections** match an exact accepted `(profileId, stateSetId, stateId)`. Live entry, copy and session facts
  with accepted pins establish supported state sets and sibling views; labels and retained deleted facts do not.
- **Liked** contains subjects with the owner's current Content `like` or `love` reaction. Switching between them
  preserves membership; clearing or another reaction kind removes it. A reaction alone adds neither Everything nor
  explicit state. Each account has a stable private Liked identity, including when empty.

Follows do not imply membership, visibility or permission. Private labels, pins, personal counts, notes, progress,
copies and import evidence never enter public indexes or anonymous views. A public Collection may disclose only the
subjects authorized by its own visibility and membership contract; a private predicate cannot be echoed as a public
fact. Publishing is an explicit owner action with its own currentness, disclosure and lifecycle.

Common Collection creation, editing, sorting, querying, filtering, export, public output, mounts and member paging
follow the [Dynamic Collections](dynamic-collections.md), [presentation](collection-presentation.md),
[filtered-list](filtered-lists.md) and [Source](collection-source.md) contracts. They require bounded native input,
actual source authority and complete currentness; an indexed candidate, prepared handle, prior grant or header does
not replace current authorization. A page is full or proves genuine final exhaustion. Sparse matches require finite
preparation that reaches useful output; rejected raw windows never become short/empty success chains. Preparation,
dependency unavailability and genuine empty/final results stay distinct.

A current-owner rule editor with the exact null-Collection address opens as a new-rule page when Collection
admission arrives. Released definitions remain usable, while Label choices stay independently gated.

Entry reading opens one exact row from the admitted shelf page without another read or write. Review the exact Entry
before clearing it; confirmation uses the existing native clear and Undo requires its supplied native receipt. Shelf
removal keeps the row and shows its refusal after a definite native or recognized thrown failure, then rotates the
next explicit key. An uncertain result retains the exact command and captured credentials for the same viewer.
Refresh never substitutes for the original retry, settles its result or rebases it.

A denied Progress-session list is a bounded permission state with no session facts or start controls; it is neither
an empty result nor start authority. The shared 403/empty/preparing distinctions above apply to session reads too.

## Destinations and actions

This section is the shared owner for Library browser visits. Subject entry, Copies, Labels, Following, Pins, Continue,
Collections and History link to their more specific contracts for exact addresses, controls and recovery.

- A signed-in native `403` becomes a permission state, never an empty inventory, inferred capability or document `500`.
  Closed, `404`, unsupported profile/kind, invalid or stale cursor, preparing, and dependency-unavailable remain
  distinct outcomes.
- A page retains its exact admitted address and explicit bounded recovery. It never makes an automatic extra read or
  invents refreshed authority. Invalid/stale cursor recovery starts at the first page only after an explicit action;
  it preserves every valid independent filter or display choice owned by that destination.
- Viewer, credential, observation, admission, locale or visit replacement retires stale display data and callbacks.
  A denied page discloses no private stale target in its DOM. Retry/recovery reads only the address the person chose.
- A read refusal never settles a command that may have dispatched. Keep its original intent, credential and key; do
  not rebase it on refreshed facts. Same-visit denied-to-admitted Following reattachment preserves that command
  custody. Only the native receipt settles a mutation or enables its exact Undo.
- Collection-list admission and Pin admission are independent. Neither permission authorizes the other. Pin order and
  target projections never create a follow, Collection, entry, holding, grant or materialization.
- Continue's successful page, stale/malformed address recovery and native historical Progress handoff keep their
  exact saved address and owners in [Continue](library-continue.md). Following and Pins retain their own bounded
  continuation and replacement rules.

## Lifecycle, privacy and acceptance

Terminal account fencing takes effect before cleanup; readers and workers cannot recreate private facts after it.
Cleanup covers every owned row, retained receipt/evidence, external participant and shared payload custody under the
[deletion contract](deletion.md). Undo is scoped to its exact native receipt and current admission. Cleanup,
publication withdrawal and source preparation do not infer one another's completion.

The [Library Goal acceptance](goals/library.md#dependencies-and-acceptance) retains original API/native outcome
specifications, fixture/compiler/module/default-worker requirements, mounted surfaces, owner/other/anonymous/
suspended personas, currentness, privacy, replay, sparse useful pages, complete growth and lifecycle obligations.
Pages use real APIs and recorded responses and receive reviewed locale, theme, device, pointer, keyboard and touch
coverage. Story inventory and source presence alone prove none of these outcomes.
Decision: Personal Library entry reading opens one exact row from the admitted shelf page without another read or write. It shows the reconciled row's supplied state, recorded dates, active Progress snapshot and current Work context; source or row identity changes retire it, while uncertainty stays with the originating row and Work/Progress use the existing row destinations.

Decision: My Collections admits an optional string cursor of at most 4096 characters and only rows/previews layout
(default rows when absent); malformed addresses retain bounded escaped context and make no private list or pins
read until explicit GET correction or restart. Cursor correction/restart keeps a valid layout; layout correction
always starts page one because rows and previews have different page bounds. Native stale-cursor restart retains
its separate notice, and current viewer/address retirement applies through malformed-address recovery.

Decision: Collection owner pages, saved rules and publication preview/review refresh use authenticated read identity without CSRF; writes require a current token, uncertain retries retain their original sender, credential, key and operands, and publication previews exclude occurrence notes.

Decision: Populated saved-query directories expose the supplied opaque next cursor in rows and previews through
the existing page link, preserving layout and each result's bounded return origin; Edit rule uses that row's existing
result address as its bounded return through the rule page and back to the same result and directory.

The Subject Library slot owns one complete Subject-to-Collection visit: the public Collections that contain the
current Subject, opaque continuation of that public list, return to the same reader, and adding the exact Subject to
a later owned curated Collection. Native `GET /v1/subjects/{id}/collections` supplies `count:{value,exact:true}` and
`next`; Web copies a valid exact count and never substitutes zero or this page's row count. The private chooser loads
only when opened, pages the owner list at 20 rows, and writes only through the existing member command. Dynamic and
built-in identities are not curated destinations. Details, caps and cost live in the
[Subject Collection journey](../apps/web/src/library/subject-collection-journey.md).
Decision: browse visits retain the current page plus one previous cursor; Previous steps back once; Restart rereads
page one; native page size is 20.

Decision: The embedded Subject Library slot, Copies, Labels, Following and private follow counts admit authorized
current-subject reads, detail, cursor navigation and read-only retry
without a CSRF token; commands require the actual current token, while uncertain retries retain their original
credential, sender, key and operands and token arrival never submits them automatically. Private follow-count
payloads retire with their session/exposure observation and require a fresh authorized read after renewal.
Decision: A native Label catalogue 400 `invalid_cursor` preserves the exact admitted prefix and locale and offers guarded first-page navigation, dropping only the rejected cursor; it performs no automatic read or retry, and malformed Web address correction stays separate.
Decision: Malformed follow-count context offers accessible GET correction for existing subject, Collection or Space UUID
targets, while clearing returns to own outgoing counts; native authorization still decides target disclosure.

Copies admits only a UUID subject selector and an opaque page cursor of at most 2048 characters; an empty selector
means all copies. Invalid nonempty selectors or malformed/oversized page positions retain the requested URL and
perform no copy or subject read. Decision: address recovery uses explicit read-only GET correction or clearing;
correcting a selector starts page one, while correcting or restarting a page position preserves its valid subject.
The existing native invalid-cursor fallback remains bounded to one retry with the same subject and credentials,
and visibly announces that it restarted at page one.
Decision: FULL Copies preserves each native copy row and its existing `subject` summary, and adds per-copy `context` with the current bounded Semantic facts; only a completeness-aware disclosed `schema:exampleOfWork` result may identify a work/edition association, dates retain their native calendar granularity, and context grants no copy action. Until Semantic supplies that result, the association is `unsupported` and the 65,536-byte context budget refuses the rich page as `unavailable` without truncating identities.
Detail/edit return and page recovery keep that subject. Decision: changed drafts prompt before closure or internal
navigation; an unresolved command allows only Stay until its exact intent resolves.
Decision: The received private Copies page compares at most four exact IDs and observed revisions, in native page
order, using only supplied reading facts. Comparison stays inline, labels missing personal observations explicitly,
retires changed or missing selections until deliberate reselection, and clears with the current private origin.
The comparison shares the native rows’ title, calendar-date, historical-label and multiline-text readers; it has no
separate vocabulary mapper or generic comparison framework.
Its explicit Edit hands the selected current row to the existing point reader only when no editor is open; otherwise
it directs the person to the existing editor controls. Web retains ResponsiveDialog editor/detail continuity,
focus, correction and closing; native commands and Undo retain their owners.

Decision: A definitive Copy update/delete conflict blocks new commands until explicit current-detail review and acceptance; accepting replaces the draft under the existing discard choice, uses a fresh key, and never submits a write. A concealed or unavailable detail cannot be accepted; uncertain commands keep their exact original retry.

The destinations are **Library**, **Following** and **History**. Library contains a bounded Continue row, Everything,
Liked, pinned Collections and All Collections. Desktop uses a short pinned sidebar; phone uses a Collection selector
and a few pins. State is a tile chip in profile wording and a filter; state Collections may be pinned, never compulsory
navigation tabs. Following holds subjects, Collections and Spaces, with no following feed or public follower totals.

Decision: Native `GET /v1/follows?view=FULL` retains Subject and Collection summaries, and resolves Spaces only through a current active address or a current readable Realm; stale non-null addresses never fall back, UUIDs are never fabricated as Realm IDs or paths, unavailable targets have unavailable destination/actions, viewer actions are current for the caller and destination, following implies no membership or permission, pages batch at most 100 rows, and outgoing follow responses are `private, no-store`.

For a page of `P <= 100`, the existing outgoing reader selects at most 100 follow rows and preserves its signed
`(updatedAt,targetId)` cursor. If `S <= P` rows are Spaces, a full projection adds one routed batch of those `S` exact
Space identities/heads and at most one released batch of the `D` non-null address claims. It creates `S + R <= 2P`
viewer-action references for `R` Realm fallback rows, packed into at most two calls of 100 with each fallback Space/Realm pair in
one call. Each call retains the generic producer's current caller/scope/action preparation, mounted exposure lookup,
per-resource batched native read, exact Access decisions, read-only repeatable-read transaction, commit or rollback,
connection cleanup and operational-time release. The final Space and Realm head/lifecycle/address checks run inside
that transaction; address claims are checked on their separate anchor first and that connection is released before
the final home transaction. Missing and denied rows count in the same batches and serialize as unavailable. The page
does no network calls, writes, command receipts or lock acquisition; failure is an error, never an empty success.
Response bytes are bounded by 100 follow rows, labels up to the Space title limit, addresses up to 64 characters and
the finite mounted action/operation catalogue. Existing Subject and Collection FULL readers retain their current
four-worker behavior. Native acceptance and measured cost remain deferred to integration.
Decision: A definitively rejected Follow command can be replaced only after explicit own-edge/current-list review or explicit preparation of an independently permitted removal; an unavailable review retains the rejection, and an uncertain command always retains its original identity.
Personal directory cursors remain opaque and keep their current BFF limits: 4,096 characters for All Collections and
2,048 for Following. Empty, non-string, and over-limit addresses retain the request URL and offer a first-page restart
without a native directory read.
History contains consumption sessions and published logs while permitted by lifecycle policy.
[Occurrence correction and retirement](library-occurrence-correction.md) owns the native addressed operations,
receipt recovery, private visibility and independent public-snapshot policy.

Decision: A malformed saved published-log position shows a localized explanation and a locale-preserving GET link to the newest page; reading starts only when the owner opens that link.

Authorized signed-in readers can load a private session detail, its changes and completed-units pages, and their
published-log history without a CSRF token. Corrections, publication and withdrawal require a current mutation
credential; an uncertain command retains its original credential, sender, request key and operands. Public log reads
keep their existing public access rules.

An owner can read and correct partial reported start/finish dates and a private reflection on the same existing
progress session at `/v1/progressSessions/{sessionId}/journal`. One journal-local revision covers those fields and
remains independent of the session's progress revision. Missing fields are unchanged, `null` clears, and edits do not
change progress, activity or public snapshots. The exact producer and Web318 receiving contract is in
[Private progress-session journal](library-occurrence-reflections.md); date meaning is in
[Personal consumption dates](library-consumption-history.md).

Decision: On a Progress detail page, non-whitespace publication notes and changed correction input share one
Stay/Discard departure choice; only explicit Publish sends a public log command.

Continue uses active-session or profile-active-state eligibility, ranked by session activity through a bounded native
read. It never loads the whole library for browser sorting. Until the dynamic runtime exists, an entry-only page is
named **tracked entries**, never Everything.

The same abstraction must support following a readable unlisted Collection, permitted ItemList export and mounting
into a Zone through the Semantic-owned [Collection source](collection-source.md) contract. Curated export preserves
permitted occurrence notes, order and multiplicity; dynamic export emits unique subjects. Neither export nor mount
discloses private predicates/facts or grants subject access. Common bulk preview and execution bind the same admitted
filtered or selected population in at most 1,000 persisted targets. Larger selections refuse preview and ask the
user to narrow the selection. Confirmation executes those rows without rerunning the filter; changed entries are
skipped individually as changed since preview while other targets continue. Durable operation identity and per-target
results support navigation and retries without repeating completed effects. The
[bulk owner contract](../services/kernel/src/library/bulk-contract.md) defines the native boundary.

Decision: Collection readers request an exact profile status ID for all admitted native matches; changing it requires a new review, while uncertain confirmation retains the original sealed command and native deadlines.

Decision: Filtered bulk capture binds one explicit source Collection ID and canonical Members filter to the current source revision, viewer scopes/exposure and action target; it exhausts the installed Members reader before sealing a fresh operation, preserves preparing/unavailable results, and admits a zero-target preview only after a stable, genuinely exhausted empty source.

The native preview accepts `selection: {kind: "query", sourceId, filter?, sort?}` and uses the installed Collection descriptor and Members readers for every page. It admits at most 100 pages of 100 candidate rows (10,000 source candidates), refuses the 1,001st unique Subject or action occurrence, and stores at most 1,000 immutable effects. The request is capped at 64 KiB. A source descriptor read before and after capture binds Collection ID, revision, membership kind and visibility; the source digest additionally binds the canonical filter/order, viewer account/client/authentication epoch/scopes and complete selected Subject list. The operation response returns these capture operands and counts. A stable, fully exhausted empty source produces a zero-target preview; `202 {preparing:true}` and `503 dependency_unavailable` retain their typed meaning, and missing source authority never becomes empty success.

Decision: Once review is sealed, page cursors change only the displayed rows; the admitted operation remains the complete captured target set after later source revisions or filter edits, and confirmation never re-enumerates it.

Subject actions deduplicate canonical Subjects before existing action admission. Occurrence removal uses the captured Subjects to select every matching live row in the exact active curated target Collection, with a 1,001-row refusal and each member ID, revision, transaction and added time retained independently. Confirmation uses the existing immutable manifest, action writers, current authorization and original receipts. Source drift during capture refuses the preview; later target drift produces an individual stale outcome, and refreshing selection requires a new preview.

Cost: one caller performs at most two Collection descriptor reads and 100 existing Members page calls, with at most 10,000 returned source candidates and 1,000 unique selected Subjects. Each Members page retains its owner-defined nested authority, preparation and byte/row bounds. Status and Library removal resolve at most 1,000 Subjects and capture at most 1,000 owner-entry rows; add also admits the destination and captures the owner-entry counter/rows; occurrence removal performs one indexed target-occurrence query with `LIMIT 1001` and at most ten 100-Subject readability batches. The shared executor processes at most 100 targets per step and recovers each reached effect through its original receipt. Existing 24-hour execution, 48-hour result retention, 100-row physical cleanup and Accounts-owned erasure remain in force. Whole-caller native acceptance and physical cost measurements remain deferred to integration.

Each worker page reads at most 100 pending manifest rows and attempts every reached target, including conflicts, refusals and unavailable targets. Same-home writers retain the native action's existing authority/effect bound plus the operation and target locks, one terminal manifest transition, one receipt and a bounded remaining-target check. A remote Collection target adds its target-home native command and original receipt, then a source-home checkpoint that rereads that exact receipt, locks the operation and target, records the supplied result and checks whether the operation is terminal. A lost response retries the same target key and operands; an unknown receipt remains reconciling. After cancellation, the worker checks each reached remote receipt before closing pending rows, so a committed effect remains accepted. This accounting is per target and includes unchanged, refused and failed outcomes.

The operation endpoint supplies the same review identity and counts to the existing phone and desktop flows. For example, a phone may show the operation header and one page from `GET /v1/libraryOperations/{id}/outcomes?limit=10`, retaining `next` for continuation; a desktop can show a wider page from the same operation and use `state=applied` and `state=conflict` as separate result groups. Both receive the same stable operation ID, decimal target ordinal, Subject/member identity, state and reason. Rendering, keyboard behavior, theme, reduced motion and measured shell clearance remain Web-owned.

Decision: Whole-filtered personal Library removal requires a separate acknowledgement and confirmation of the native target count; ignored or unsupported filters disable admission until corrected, while Collection occurrences, Copies, Progress and purchases remain independent.

Decision: Web bulk add captures only the loaded selected canonical Subjects in first-selection order before destination choice; choosing a destination freezes its identity and revision independently of subsequent list refreshes.

Decision: Collection placement browsing retains the current page plus one previous cursor; Previous steps back once, and Restart explicitly rereads page one, so deep browsing never stores cursor history. The [Web placement journey](../apps/web/src/library/collection-placement-journey.md) owns bounded destination/anchor browsing, exact occurrence review, native transfer recovery and destination-only bulk-add reuse.

Decision: Web selected occurrence-removal review captures loaded selected member IDs in first-selection order; whole-filtered removal instead uses native complete query capture and reviews one stored occurrence page at a time, preserving duplicate Subjects, native order and the captured source independently of later filter edits.

Decision: Whole-filtered Web add uses an explicit writable curated destination and one native query capture, separate from loaded selection; a new destination or predicate requires a new review, while preparation and uncertain retries keep the original request and confirmation keys.

Decision: Inline bulk add recovery reads one native outcome page at a time; a new confirmation uses the preview's captured sender, credential and headers with its own key, and uncertain retries retain that entire command.

Web's public download controls admit a detached first-page capture of viewer, native metadata revision and exact
occurrences, then compare it with current native FULL reads at admission and terminal delivery. Each read uses the
existing 100-member page bound: two reads examine at most 200 returned members, two Collection headers and at most
four existing viewer-action/follow point reads. There is no cursor accumulation. The resulting ItemList retains
occurrence identifiers, permitted notes and order; cancellation retires delivery and retry keeps the same capture.
Decision: Malformed or noncanonical captured Collection export addresses return unavailable before native reads; valid
captures retain the exact addressed page and existing public eligibility.
Larger, later-page and filtered curated populations remain explicitly unavailable until native durable preparation
is integrated. Decision: unavailable preparation never falls back to exporting the displayed partial population;
expired preparation will require a new admitted request. The default Members factory and worker are unavailable
specification adapters, not a delivered preparation backend. Native and browser verification remain launch
integration obligations; focused tests and typing do not establish whole-feature completion.

Decision: A complete admitted export is retained only within its mounted capture for explicit Copy or Download retries; local delivery failure keeps that exact file available, and Cancel or capture retirement clears it.

Decision: Revision-zero export admission requires the current owner's native logical built-in identity in read provenance; complete bounded dynamic reads emit unique Subject URLs in native order without occurrence identifiers or notes, while larger prepared consumption remains held for the final Members and export interfaces.

Tracked-entry state actions retain unattempted targets for explicit per-entry recovery with their captured state,
revision, incarnation and command key, independent of later selection; a refused unknown replay keeps its exact intent.

Decision: Library entry Undo captures a distinct restore key with the deletion receipt and retains its original sender, headers and operands for explicit retry; cookie-backed credentials travel only as a session-bound encrypted command field, and read recovery never replaces them.

Decision: Reopened bulk Library removals offer one explicit restore at a time; a separate POST rechecks the exact native target and seals its original credential before the ordinary restore command, while a typed decoder retains the installed result-evidence fields until generated client declarations are refreshed.

## Personal portability

The private native export has version 2 coverage for retained entry annotations, accepted source observations and
live occurrence journals. Its version matrix, omission rules and bounds are owned by [Personal Library export](library-export.md)
and [Private annotation and occurrence journal export](library-journal-export.md); version 1 remains unchanged.

Provider-imported date adoption uses the [consumption-date contract](library-import-consumption-dates.md).

[Personal Library export](library-export.md) mounts authenticated capture, status, bounded pages and cancellation
at `/v1/libraryExports`. It preserves independent native facts and accepted pins with explicit source omissions;
Web assembles the versioned artifact after the final manifest. Native edits require restart, and terminal deletion
immediately denies delivery. Installed Bangumi and unexpired MAL source rows preserve personal evidence and provider identifiers;
this is neither a full account export nor an automatic restore. The separate [archive review and merge](library-archive-merge.md)
consumer accepts a completed file, keeps unsupported sections as private evidence and requires current explicit
mapping before selected entry, label or assignment effects. Reviewed V2 annotation and journal-date adoption is
specified in [Personal archive annotation and journal recovery](library-archive-personal-fact-recovery.md). Archive confirmation names each ordinal and its native `reviewRevision`; a replaced or mixed review is refused before effects, and accepted retries retain original keys and operands.

## Indexed filtering and disclosure

Decision: Collection filter links reject the whole requested read when any predicate group is invalid, exceeds
64 supplied facet values (before deduplication), or repeats a range (even identically); explicit correction removes
whole rejected groups and retains complete accepted groups, while clear removes all predicates. Original addresses
and exact accepted values remain inspectable, label hints affect display only, unrelated context survives, and only
a changed predicate resets the members cursor.

Evaluate a complete identified catalogue observation or private owner observation. Admission covers filter, source
and order together: run a direct plan bounded by the page, otherwise use prepared indexed results built in bounded
durable steps, otherwise reject with `422` before enumeration. Return filled pages or a final page, or preparing;
never chains of successful empty pages. Derive honest per-plan allowances instead of universal candidate multipliers
or a universal 256-key cap. Metadata, native authority, label parents and background preparation are charged work.

Keep the shared grammar and pure matcher semantics: same-statement qualifiers, declared units and unknown under NOT.
Owner-only NOT state includes subjects with no entry; absent catalogue evidence never proves a property. Every
disclosure, including membership, exclusions, order and fields, checks current native authority; index revisions
never grant permission. Healthy catalogue freshness is at most 60 seconds; more than five minutes behind returns
readiness. Privacy reductions take effect immediately. Owners see their own writes on their next read.

Private facts never enter public indexes, full text, totals, facets or subject membership projections. Public lists
expose no totals/facets over unchecked candidates. Publishable dynamic Collections are private until explicitly published and
disclose permitted subject membership, never the private facts or predicates that selected it. Only public membership
contributes to public listing counts; private/unlisted membership never does. Public/unlisted reads still
check each subject's current native authority; a follow or Zone mount grants nothing. Unknown and hidden private
identities share not-found. Under the [native persona contract](library-continue.md#native-authorization-boundary),
no valid suspended bearer exists: suspension advances the authentication floor/fences before Auth revokes sessions.
The actual pre-suspension token receives `401`, JSON `invalid_credentials`, and
`WWW-Authenticate: Bearer error="invalid_token"`. Correct-password sign-in returns `403 ACCOUNT_SUSPENDED` and creates
no session. Kernel's defensive `403` is not a fixture scenario; do not invent SQL or token personas. Missing,
invalid and revoked credentials retain `401`; insufficient scope retains `403` and its `insufficient_scope` challenge.
Invalid credentials never downgrade to anonymous, including public/unlisted reads.

## Lifecycle and terminal erasure

Ordinary individual deletion hides immediately and preserves exact owner undo only while kernel time is strictly
before the original 720-hour deadline. Restores recheck authority/CAS/capacity and retain accepted pins and identity;
replay never renews the window. Takedown withholds the least covered material and alone schedules no purge.
Web removal requires actual `library_entry.delete` admission independently of optional Undo's
`library_entry.restore` admission; group presence grants neither operation.

Terminal account time T immediately fences every private/unlisted read, export, count and producer. Accounts owns
one erasure coordinator with fixed versioned participants, including separate Library and financial Commerce.
Acknowledgement means actual cleanup or no applicable data, never dispatch. Minimal completion persists outside
DBOS history and defeats late resurrection. No account Undo, hold engine, custody engine or consumer wait precedes T.

Erase published logs, private/unlisted/already-deleted graphs, every old or building private generation and shared
private payload via exact producer locators and store-owner minimization. Only eligible contributions active and
PUBLIC at T retain de-identified published material. Dynamic output retains last COMPLETE A, never pending B or fresh
evaluation of private facts; curated output preserves permitted published occurrences. No unlisted output survives.
The module's [retention inventory](../services/kernel/src/library/README.md#retention-inventory) covers the whole graph;
entry/copy/follow removal alone is not whole-graph erasure. Every directory/support/change/registration/frontier/
prepared/intent store and identity first-apply/ACK custody joins that A5 inventory and terminal fence. Shared
artifacts retain exact locators under their actual store owners; the [native owner plan](library-owner-queries.md#shared-operational-identity-and-disclosure-producers)
does not certify missing whole-role cleanup or Source2a disclosure producers.
The [personal-fact/lifecycle review](research/library-outcomes-quality.md) distinguishes owned cleanup from shared
Source/DBOS minimization and durable acknowledgement. Empty local stores, queued or dispatched work establish
neither. Reuse Accounts' coordinator and actual store-owner minimizers with exact locators, fenced late inputs,
child-before-parent crash/replay and no-resurrection evidence; no Library-local service or completion writer replaces
those interfaces. Its fixture gaps are source findings, not observed native failures.
The private owner counter and stored live/archive `owner_write_seq` belong to that inventory. T immediately fences
state writers; bounded participant cleanup erases ordering metadata after its dependent private facts. Late repair
must never recreate it. This adds neither account restore nor a public activity counter.

## Acceptance and cost evidence still required

Decision: adopt the eight linked quality reports as source-bound evidence inventories; keep behavior in its existing
owner documents and every unmeasured acceptance clause open.

The [Collection review](research/collections-outcomes-quality.md) records installed curated/private built-in
ready-source support and native Liked identity/source. It does not establish a useful-page or original-outcome pass.
Preserve genuine empty `200`, exactly committed Members preparation `202 {preparing:true}` with `Retry-After` and
private/no-store, absent authority `503`, and unsupported `422` before enumeration. Zone `202 {next}` is a separate
wire contract. Duplicate occurrence editing and unique canonical browsing remain distinct; removing a Zone mount
does not delete the Collection. Original dynamic/shelf/source/Zone entry points remain in that report.

The [growth review](research/library-growth-quality.md) retains every authored triple, relation population,
same/other-partition history and repetition, including filtering at 64/512/4096. Apply corrected static C3: derive
the entire finite additive declaration before admission, including at least 16 Members + 464 History + 429 receiving
= 909 before executor, cleanup, Source and Access costs. That lower bound is not completed preparation evidence.
The live Members checkpoint remains `bd18969f/current10`; cancelled `97ef` supplies no completion. Export/filter
consumers remain held until that checkpoint supplies actual remaining scope, installed Source/read-work interfaces,
finite bounds and check evidence. This adoption changes no Members implementation or completion assignment.

Keep direct source pages within 100 candidates, at most 32 leaves and common pages within 16 reads/128 output slots.
The [filter owner](filtered-lists.md#budgets) derives `c <= min(600, 6s + 3)` for admitted per-read size `s <= 100`.
For `P=2,c=15`, the two-read bound is 608 rows, 3648 blocks, 161792 request bytes and 155648 response bytes.
The looser existing growth assertion is insufficient proof, not an observed failed exit; preserve frozen assertions
and measure the tighter owner bound. Performance owns cross-pool attribution, original attempt/phase and physical
measurements; unavailable counters are never zero. No growth measurement was supplied by these reports.

The [Library Goal](goals/library.md#acceptance) links all five Library reviews and the exact page route/story appendix;
the [Commerce Goal](goals/commerce.md#acceptance) links the three Commerce reviews. Preserve each report's original
source binding and runner commands. Stories and recordings are inventory, not native or rendered approval. Native,
acceptance and browser execution remain deferred to integration; Library Done-when 1–7 and interface evidence remain
unmeasured. Capability-manifest and page-stories mapping belong to the separate mapping brief.

One capability suite varies definitions and fixtures across curated, Everything, state, public/unlisted/private and
mounted Zone surfaces. It covers membership, filtering, bulk, export, follow, mount, lifecycle and actual cost.
Examples are harem-tagged light novels, books strictly over 1,000,000 words (equality and absent counts excluded),
both together, sparse matches, and withheld harem under positive and NOT predicates. Catalogue owns concepts,
properties/mappings and fixture configuration; holding-derived game-platform filters and user-saved queries remain
deferred. Manual platform filtering uses the admitted catalogue contract.

Required membership/filter measurements cover actual first/deep pages under
[the shared three-scale checks](filtered-lists.md#three-scale-checks), with duplicate
histories, stale labels and sparse filters. Charge private owner indexes, native fact points, catalogue/disclosure
anchors, rows, statements, buffers, bytes and bounded background/epoch maintenance; no account/history scan or free
witness work. Terminal measurements cover complete indexed child inventories and exact cross-store locators, bounded
child-before-parent pages/checkpoints and finite workflow segments. Completion requires every phase and store-owner
acknowledgement. Whole-graph crash/replay, public A/pending B, immediate concealment and no-resurrection evidence are
required. Runtime and these measurements remain incomplete; documentation adoption runs no native checks.

### Owner state-write order

- Touches: one owner-partition counter primary-key update/lock, the addressed entry/archive, and existing account
  authorization, receipt, source hooks and outbox transaction. No global counter or owner-history scan.
- Bound: constant native counter rows/statements per actual state write plus indexed depth, including first-row
  initialization and bigint fields. Only that owner's state writes serialize; charge rollback and contention.
  Ordering metadata is not free, and `noEffect` must not conceal a mutation.
- Growth check: require native same-kernel-time writes across two merged originals, concurrent same/different
  owners, clear/Undo fresh order, denied/CAS/replay/overflow rollback and terminal no-resurrection, with three-scale
  owner/entry/history captures. This document task executes or claims no such runtime/growth test. Filter-plan
  numeric budgets remain owned by [filtered lists](filtered-lists.md).

### Native identity expected effects

Library's native Source plan owns the complete expected effect set for one admitted job, native Source identity
and `collection-source` scope. The default module advances the actual saved input-generation transform through
bounded raw member/entry/label/session/copy/output pages, withdraws OLD derived readiness separately, and
builds a distinct structural canonical generation. It preserves immutable facts/pins, occurrence IDs, order,
notes, duplicates and owner state-write sequence. Existing owner selection still uses the highest live
`owner_write_seq`, including retained conflicts. Planning needs no ordinary ready Source or receiving ACK.

Only exhaustive applicable native coverage, enrolled OLD/NEW/first-apply/handoff work, final native writer and
prearm/claim/owner/capture fences, and a retained genuine commit receipt can seal a generation/version/frontier.
An actual zero takes the same path. Native late birth, writer change or rekey invalidates old currentness before
commit. Expected pages are bounded to 100 and sealed pagination still needs caller exhaustion plus current
verification on the SAME Source-home Core transaction. A JSON brand, EOF, count or whole-participant ACK
supplies no substitute. Supported native account-backed same-home work is independent of unsupported public,
frozen or foreign physical execution. Native scope success grants no permission, query publication, follow
completion, ALL-Library acknowledgement, custody release or erasure. Plan-held captures and detached old
metadata remain in existing terminal retention until real control handoff.

#### Cost

- Touches: route-leading native driver/effect/OLD ranges; exact retained plan, source/account/owner/capture,
  admission/input-generation/current-claim/prearm, seal/receipt points and native command controls. Receiving
  application and foreign Source/History producers retain their own bodies and prices.
- Bound: literal SQL and complete eight-axis operation declarations are in the
  [Library module](../services/kernel/src/library/README.md#native-identity-scope-planning-and-current-seals).
  Limits are 1..100 raw keys, inclusive indexed EOF/FK/control work, schema-bounded bytes or actual
  same-snapshot size admission. One finite static additive declaration includes successful, unavailable,
  failed, repeated and rolled-back work. A local cap cannot establish the complete parent bound; Source/Library
  terms remain unknown until their actual owners supply every additive cost and exact normal receiving recognition.
- Growth check: focused native scope-effects outcomes are authored for six-driver positive pages, omitted
  effect, exhaustive zero, late first apply, changed fences/rekey and failure/repeat/rollback accounting.
  Source delivery defers integrated native, database, browser and whole-feature/growth acceptance; typing
  alone establishes none of those outcomes.

## Independent scalar progress measures

One owner session can retain chapter, volume or other profile-approved scalar values as separate measures. The
existing session unit remains primary; each additional unit keeps its own nullable amount and total. The shared
session revision guards edits and correction retries, and one measure's clear preserves the others. The detailed
HTTP, profile, history and storage contract is in [Independent progress measures](library-progress-measures.md).
Dates, repeat totals and canonical episode membership remain separately owned outcomes.

## Native foreign listing delivery

The [Library owner contract](../services/kernel/src/library/README.md#native-foreign-listing-copies) now implements
the normal Collection-home to Subject-home positive copy using a separate native live-copy transition. Original
curator/writer/outbox roles acquire durable account lifecycle holds; after all source clients are released, the
Subject home atomically applies its existing monotone listing/count body, role inventory and immutable receiver
result. Exact cancel/apply arbitration and result-bound consume prevent a delayed first apply after account deletion.
Native projection guards also refuse old prepared writers without an exact current-transaction gate. Negative work creates no new personal payload or missing pair/version; retained versions only advance their
monotone zero cut, and terminal cleanup deletes retained identities without creating a marker.
The existing Work queue recovers incomplete transitions and bounded historical pair/version coverage. Local personal copies
retain their own-account preparation/fence and original profile/session behavior.

Erasure discovers actual copied row/transition/work locators under every retained personal role and minimizes them
in bounded native homes. Shared History/root obligations and retained public-output qualifications stay separate;
local table exhaustion is not an ACK. Restore requires admitted placement plus genuine Database-owner isolated
lineage/committed-tail reconciliation at both endpoints. No universal restore service or native/physical/main proof
is claimed.

The original identity scope-effects page and verifier remain unfinished and pending. The owner must still deliver
actual admitted job/source/scope, exhaustive six-driver expected effects/current seal, same-Source-home native
verification without foreign IO, receiving/custody/fence placement, every intermediate-page and final sealed-zero
verification, and exact nested SQL/cost bounds. The live-copy gate supplies none of that missing effects seal. The
existing SDK/Source/Account/Library/History retirement chain and the held original producer/consumer dependencies
remain as qualified in the [owner dependency contract](../services/kernel/src/library/README.md#identity-retirement-dependency-retained).

## Uploaded Bangumi collections

The mounted [Bangumi upload](library-import-bangumi.md) previews the owner's bounded JSON, resolves admitted
provider IDs, accepts explicit unmatched targets and reviews conflicts before native state admission. Current
released state roles supply the only mapping; scores, measures, notes, source privacy, dates and unknown fields
remain private evidence with reasons. Native commands retain account fences, revision guards and receipt retry.
Upload deletion and indexed Library account erasure own retained evidence; no upload publishes a review or vote.

## Personal MAL list portability

[Reviewed MAL tag adoption](library-import-mal-labels.md) extends the same retained upload/review/apply methods
with explicit existing/new private label selections. Source evidence remains independent; native label commands
never infer Entry, progress, consumption dates or publication. Web retains the existing MAL import interface.

[Personal MyAnimeList XML import](library-import-mal.md) owns the mounted authenticated preview, review,
apply, cancel and evidence-delete methods under `/v1/libraryImports/mal`. Status uses explicit native entry
admission against the current released role; scores, simultaneous progress measures, private notes, precision
dates, privacy and unsupported fields remain visible private source evidence. Identifier matching uses existing
external claims, with explicit unmatched resolution and guarded conflict replacement. Uploads and reviews belong
to Library account erasure. This source does not provide live synchronization, catalogue creation or public reviews.

[MAL and AniList scalar progress adoption](library-import-progress-adoption.md) composes each retained source row with
an explicitly selected native consumption occurrence. Exact profile-admitted units only are adopted; counts never
create canonical Episode facts or infer dates, completion, holdings or publication.

# Native personal archive recovery

[Native archive recovery](library-copy-archive-recovery.md) owns the admitted v1 format, private holding evidence,
and reviewed progress recovery. Holdings never restore an Entry, entitlement, or financial fact. Progress recovery
creates one fresh Session per explicitly selected occurrence and uses current profile meanings and native commands;
it stores exact native operands and expected revisions before effects, replays lost acknowledgements through original
receipts, and reports unreconciled outcomes as recoverable without disclosing uncheckpointed facts. It does not
restore historical dates, History, or journal/reflection annotations. Frozen native growth and whole-caller
acceptance remain deferred.

## Canonical episode facts

[Canonical episode progress](library-episode-progress.md) defines the installed authenticated per-session checklist.
Canonical completions are separate personal facts over real Episode Subject IDs and admitted direct parent
relationships. They preserve noncontiguous holes, specials and rereads without converting scalar amounts or manual
unit tokens. Catalogue order/membership/visibility changes never rewrite these rows; bounded owner reads redact
concealed identities, and correction/clear survives missing current catalogue support. Native session/profile,
receipt, revision and terminal fences apply. Web's existing canonical checklist consumes that exact contract.

## Reviewed VNDB private labels

[Explicit VNDB label adoption](library-import-label-adoption.md) adds bounded owner-selected mappings and
canonical Subject review to the existing VNDB provider flow. Native commands create only explicitly named private
labels and add assignments. Source removal/expiry clears consent/results without removing adopted native effects;
terminal erasure uses the existing source and native label coordinators. Ordinary VNDB import creates no labels.

## Web private entry and history visit

The Web-owned authenticated visit is mounted in the existing Subject Library slot and the existing progress-session
detail. The slot reads the installed typed libraryEntries({subjectId}).personal.get method and edits private
annotations through .annotations.put; source privacy corrections use .sourceObservations.patch followed by a
personal-entry readback. Each write is bound to the current viewer, CSRF session, original key and operands. Annotation
fields use field-local unchanged/clear/set operations. Provider privacy is distinct from REZICS disclosure and never
grants publication permission. The source created/updated values and native recorded time remain separately labelled.

The private /library/history route reads one native diary page and the native consumption summary. Next-page
navigation replaces the current page, and leaving cancels its continuation. Addressed occurrence details reuse the
existing progress-session page for journal correction, reopen and retirement. Acknowledged retirement refreshes the
caller and returns to the diary; it does not withdraw any public snapshot.

The installed generated client does not expose the state-history list/review/restore method family. The Subject
Library visit says that state history is unavailable and keeps it distinct from the occurrence diary. No Web history
or restoration endpoint is fabricated. See [state-history Web receiving](library-entry-state-history.md#web-receiving).

## Personal shelf ordering

The personal shelf reads one native FULL page of twenty entries. Priority and localized title orders use the native
sort and opaque continuation; Web preserves the returned row order and never derives title keys from displayed labels.
Title reads and preparation use the same native Accept-Language selection. Preparing title order exposes one explicit
bounded preparation step and its progress. Query, language, current-viewer and relevant Entry changes retire the prior
page under the existing address/current-viewer fence. Layout changes keep the same query. Unsupported saved sorts
retain their existing recovery, while an explicit supported URL sort is preserved.

Decision: each title-preparation step is user-triggered; retries keep that step's exact idempotency key, and a fresh
key is created only when the user starts the next native step.
