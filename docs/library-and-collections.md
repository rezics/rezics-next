# Library and Collections

The [private reported-year summary](library-reported-year-summary.md) extends native completed occurrences with
explicit journal finish-year membership, twelve months and a year-only bucket, preserving separate all-time semantics.

The [personal consumption statistics contract](library-consumption-statistics.md) defines
private completed occurrences, distinct stored subjects and repeats from retained native
sessions, independently of current shelf state, holdings and published logs.
Decision: use explicit native completion for all-time counts and preserve unknown historic
profile coverage; date editing and canonical episode membership retain their existing owners.

A person's library and their lists are one capability. Every vertical (books, anime, games, visual novels, recipes,
records) configures it through definitions; no vertical has kernel code of its own. This document adopts required
first-public behavior, not a claim of runtime completion. The [Library module](../services/kernel/src/library/README.md)
records actual implementation and remaining gaps. The [Library Goal](goals/library.md) owns delivery under the
commerce manager, separately from the [purchase contract](../services/kernel/src/commerce/README.md). Purchasing
does not silently create Library facts; Library presence or Undo never grants or reverses payment/benefit rights.
[Scope](scope.md) defers user-saved dynamic queries.

The shared owner contracts are [Dynamic Collections](dynamic-collections.md), [Collection source](collection-source.md),
[filtered lists](filtered-lists.md), [Collection presentation and editor](collection-presentation.md),
[independent labels](library-labels.md),
[selected label consolidation](library-label-consolidation.md),
[profile consumers](library-profile-consumers.md), and [deletion](deletion.md). Indexed evaluation and source-scoped
concurrent identity currentness below supersede older per-page proof/replay, whole-slot observation and identity-basis protocols in
those adoption surfaces and earlier research. Their ABI revisions belong to their owners; this adoption creates no
alternate mode, budget, API or authority document. The [library abstraction research](research/library-abstraction.md)
is background evidence, not implementation evidence.

## Private consumption diary

The [private diary](library-consumption-diary.md) adopts cross-subject occurrence navigation over real native
sessions, separately from public published logs and current shelf summaries. Decision: order by immutable recording
start descending, then full session UUID descending; use eight expiring owner navigation slots and the existing
presented session method for exact reopening. Repeats and unfinished sessions remain separate. Recording timestamps
are explicitly labelled audit facts. Decision: read partial dates and their independent revision from the installed
journal owner in the bounded session seek; unknown dates remain null, without an invented historical sort.
Native subject visibility controls optional labels. The linked contract owns installed methods,
caller binding, bounded continuation lifecycle, concurrent edits, terminal fences and Web recovery semantics.

## Personal facts and one Collection abstraction

[Personal AniList uploads](library-import-anilist.md) have mounted private preview, paged review, confirmed apply
and cancellation. Only uniquely mapped released state roles enter native entry commands; every other source field
remains visible private evidence. This replaces the AniList personal-import deferral only, not other sources or sync.

Retained AniList custom-list membership has an independent [explicit private-label adoption](library-import-anilist-labels.md)
review within that producer; default display groups and unsupported tags never imply assignments.

Selected private label consolidation is an explicit Labels action over supplied assignment identities. Its installed
native review, confirmation, one-item apply/retry, cancel and result boundary is owned by
[the consolidation contract](library-label-consolidation.md); both labels reopen through the native assignment readers.
Immutable Subject security-evidence binding, generated client declarations and full caller growth remain a continuation.

The mounted [personal VNDB upload](library-import-vndb.md) supports private preview, identifier matching, explicit
review and confirmed entry-state apply through existing native commands. Scores, dates, progress, notes and unmapped
fields remain visible private evidence; broader personal-list migration remains second scope. Upload/review records
are bounded Library-owned data included in terminal erasure; cancellation never reverses acknowledged native facts.

For one account and stored subject there is at most one explicit exclusive entry state, independent labels, progress
sessions and copies (holdings). These are separate private native facts; ratings remain with ratings. Profiles in
immutable definitions releases supply state sets, progress modes/units, copy kinds/statuses and import mappings.
Progress setup treats the loaded subject and default mode/unit as its baseline; only subject, version, mode, unit or exact total-text changes need departure protection, and restoring those values clears it.
Stored accepted pins retain their immutable meaning after release activation or retirement. Missing profiles block
new profiled values, not historic reads, clearing or exact undo. Generic labels and curated occurrence edits need no
profile binding or lookup, and never invent a default state.
Copy location/source allow 200 Unicode scalar values each and notes 1,000; the editor shows localized limits and accessible field errors after an invalid submit, preserves exact draft text, and validates before capturing a new command.

A Collection has one identity, curator, visibility, title/description, follow target, Zone mount and schema.org
`ItemList` surface. Curated membership stores ordered occurrences, each with its own ID and note; duplicates remain
editable. Dynamic membership derives unique subjects from native truth. One shared Collection members service and
page serves curated, Everything, state and Liked, with shared filters, sorts, summaries, cursors and actions.
Grid/list/table layout is a client UI choice. Collection presentation kind is an owner-selected or derived
definitions Type; members keep their own Types. Neither changes membership or authorization. The joint
[Collection presentation and editor contract](collection-presentation.md) owns the selected fields, editor operations
and current delivery inventory.

- **Everything** includes a subject with live explicit state, a nonempty private annotation, a reviewed provider
  observation, an effective live label assignment, retained session/history or retained holding. Removing one fact
  leaves membership while another survives. Empty entry shells, trash, follows, curated occurrences, ratings and
  published-log snapshots alone establish no membership. An annotation or observation adds no state, session,
  copy, label, rating or public disclosure.
- **State Collections** match explicit state by `(profileId, stateSetId, stateId)`. Only live entry, retained copy
  and session facts with actual accepted pins support an in-use state set and all its sibling views, including empty
  siblings. Labels and soft-deleted snapshots support none. No current or historical type is guessed from metadata.
  Support is derived representation, never a second authority; digest ordering is not semantic chronology.
- **Liked** derives from the owner's current SUBJECT `like` or `love` reaction. Switching between those preserves
  membership; clearing or another kind removes it. Thread/post reactions do not qualify. A reaction alone adds
  nothing to Everything or explicit state. Every account has a stable logical Liked that is always private, including a genuine
  empty `200`. Content owns the owner-scoped reaction adapter; copying into a curated Collection creates independent
  occurrences. Native [logical identity](../services/kernel/src/library/builtin-identity.ts) and the
  [Content reaction source adapter](../services/kernel/src/library/liked-source.ts) are installed. Complete useful
  members pages, current disclosure/source-version coverage and positive reaction-only outcome evidence remain
  unmeasured; source presence does not establish that journey.

The [native owner plan](library-owner-queries.md#native-candidate-support-and-complete-observations) owns the ONE
private OWNER candidate/support directory shared by built-ins and admitted owner queries, native indexed truth,
complete selective observations and finite repair. It is discovery data, never permission or a new personal fact;
no per-built-in membership caches or copied exact-fact-witness stores. That plan preserves the full required union.
Every qualifying producer must cover insertion; incomplete coverage returns preparing/readiness, never false empty.
Native current membership and disclosure reject stale positives immediately, including deleted label parents.
Web Shelf cursor values are opaque and limited to 2,048 characters; invalid selections require an explicit field correction, and clearing a stale cursor preserves remaining filters and display choices.
Bounded durable maintenance may prepare indexes. Logical Library/Collection list and detail reads stay pure;
they never repair indexes or create headers or grants. The personal native chronological shelf adapter may, after
current owner admission and an indexed missing/uninitialized-gate probe, run the existing guarded owner initialization
command before final RR checkout. Only actual initialization creates its command receipt/advancement event and
original bounded backfill intent; warm reads do not. Empty readiness comes only from the original three owner-input
EXISTS decisions, and incomplete nonempty generations remain unavailable. See the [shelf contract](../services/kernel/src/library/shelf-contract.md#default-producer-composition).
The common members GET may
start bounded idempotent derived preparation and its work intent under the adopted
[dynamic members contract](dynamic-collections.md#model-and-identity), keyed by viewer, Collection, validated filter,
sort and accepted release/meaning. It writes no domain state, header, grant, event or receipt. Retained preparation
returns `202 application/json` with exactly `{preparing:true}`, `Retry-After` and owner-private `no-store` caching;
retry the same validated URL and cursor. No members, next, operation ID or partial data accompanies `202`.
Genuine exhaustion stays `200 {members:[],next:null}`; unavailable runtime/work stays `503`. Zone POST is unchanged.
[Continue](library-continue.md#http-contract) GET starts no work; this exception does not extend to it.
Accounts owns the additive fenced event-free operational transaction plus atomic intent and native SPEC; consume
only its actual [Core export/contract](../services/kernel/src/command/README.md#operational-transactions).
The adopted plan uses same-pg-client DBOS transactional enqueue, existing gate/Access/account fences and DBOS
recovery, with no separate intent table/relay/queue. Current executor source is present; Library preparation and
its native custody proof remain required pending. `runCommand`/`noEffect` or enqueue after commit cannot replace it.

## Logical identities and canonical browsing

Built-in identities are stable and deterministic from owner and built-in key, independent of labels, release digest
and materialization. Every account has an empty logical Everything; state discovery is read-only and private by
default. Liked uses the same logical Collection contract. State identities remain pinnable. Dynamic DTOs omit
curated member count, creation/update times, order epoch and occurrence fields; no fabricated zeros or occurrences.
An explicit owner rename wins over the localized built-in title.

## Private rich personal entries

One authenticated owner entry combines locally edited notes and priority with independently addressed provider
observations for one canonical Subject. The mounted owner API is `GET /v1/libraryEntries/{subjectId}/personal`,
`PUT /v1/libraryEntries/{subjectId}/annotations`, `POST /v1/libraryEntries/{subjectId}/sourceObservations` and
`PATCH /v1/libraryEntries/{subjectId}/sourceObservations`. The native commands use the existing Library receipt,
current Subject, account and terminal lifecycle authorities. Reads and write responses are owner-private and
`no-store`; they do not alter explicit state or the consumption-date/session owner.

Annotation revision `0` creates the first version; each successful compare-and-set advances it. Note and priority
each require `{op:"set",value:...}`, `{op:"clear"}` or `{op:"unchanged"}`. Notes are limited to 4,096 UTF-8 bytes.
Priority is personal list position, not a catalogue rank or rating. Null means unranked.

Owners can also review priority and private note corrections for a fixed selection of exact existing entry
incarnations and revisions. Preserve, set and clear are independent per item; confirmation reuses the addressed rich
entry annotation command, while reopening returns current native values and per-item outcomes. See the [selected
correction contract](library-entry-selected-correction.md) for its bounds, expiry, cancellation and client operands.

Decision: Personal priority is an owner-local list position from 1 through 100, where 1 is highest; null is unranked.

Each source observation is separately addressed by owner, canonical Subject, provider key and provider record ID.
Admission requires `confirmReviewed:true` and inserts once; a duplicate address conflicts. Correction requires the
observation's current revision and confirmation; each privacy/timestamp field is set, cleared or left unchanged.
Source privacy says only what the provider entry meant: `private`, `source_visible`, `unknown`, `absent` or explicitly
`cleared`. `source_visible` is never a REZICS publication or disclosure grant. Original timestamp strings, precision
and zone knowledge remain source evidence; they are not native audit time or consumption dates. See the detailed
[annotation contract](library-entry-annotations.md) and [source provenance contract](library-entry-provenance.md).

Annotation-only facts and any reviewed provider observation participate in Everything through the existing native
`entry` owner support family. An empty/cleared annotation shell does not. State Collections still require their
accepted explicit state pin. Ordinary state removal preserves annotations and provider observations. Terminal
account fact deletion removes both, including all source observations.

The four personal-list import owners use the same typed admission/read DTO. They address evidence only with an
already-resolved canonical Subject and the provider's stable record identity; this API does not resolve provider
IDs, parse provider payloads, or activate vocabulary. A field absent from the source is submitted as `absent`; a
present but uninterpretable field is `unknown`. An import may write a note or priority only after the owner confirms
the value and the adapter submits the current annotation revision. Unchanged incoming values use `unchanged`; only
an explicit owner clear uses `clear`. Duplicate source admission returns `409`, stale correction returns `409`, and
same-key/body retry replays the original response. If an adapter cannot preserve a source timestamp's original value,
precision or zone knowledge, it leaves that evidence unsupported rather than coercing it. Omitted note/priority data
never clears or overwrites local edits.

Logical revision 0 becomes revision 1 only on the first authorized materializing write, atomically with native
resource grants and the account fence. Read authorization stays native; materialization permits no read-grant bypass.
Denied writes leave no storage. Opaque state references are discovery points, not permission or membership.

Stored personal subject IDs and Collection occurrences are immutable and never rewritten by identity resolution;
new writes address the terminal. Canonical views choose the live state with highest private `owner_write_seq` among
merged originals, show conflicts and retain every original fact, stored subject reference and accepted pin. They
union labels and keep copies/sessions separate. Browsing shows one card per canonical subject; the editor
preserves every curated occurrence, note and order.

### Native occurrence boundary moves

The single-occurrence `POST /v1/collections/{collectionId}/members/{memberId}:move` accepts `{after?: string | null}`:
omitting `after` moves to the actual Collection end, `after: null` moves to its actual start, and a string retains
the existing placement after that member occurrence. Unknown keys, malformed IDs, a null body and numeric/boolean
`after` remain refusals. The existing command kind and digest inputs for null/string placement, including historic
receipt replay, stay unchanged. Omission is a distinct end intent throughout transport, receipts and retries.
The native first/last neighbor seek excludes the moved occurrence, including singleton, already-terminal and
duplicate-subject cases. Existing authorization, owner/partition fences, no-effect evidence, session recording and
bounded order placement/repair remain authoritative; there is no global rank, scan or new index.

The curated editor offers explicit immediate Move to start/end actions for a disclosed occurrence only when
`collection_member.move` is exposed and current edit authority is available. Save or cancel metadata/member drafts
first. Arrows and dragging retain their staged loaded-page semantics and later-page first-row guard. One captured
occurrence, placement and immutable idempotency key blocks competing writes until resolved. An uncertain result
retains that exact request for explicit retry; page, authorization and actor changes fence its use. A definitive
refusal offers a current-page/access read before another move. A confirmed move refreshes one bounded native page
through the page callback, with only the source's existing one-time stale-cursor restart. A failed refresh retains
the acknowledged move and offers read recovery without issuing another mutation or claiming its global location
has been loaded. Intervening pages are never fetched.

### Owner state-write order

Latest state means a native per-account write sequence in the owner's partition. Each successful state set, state
clear and Undo restore increments that owner's counter row in the same authorized fact transaction with
`UPDATE ... SET seq=seq+1 RETURNING seq`. First-row initialization belongs to that write too, never GET. A live
entry stores the returned value as private `owner_write_seq`. All of one owner's entries share the owner partition,
so this totally orders that owner's state writes and confines counter contention to that person's writes. No
cross-partition coordinator, clock/UUID sorting, maximum of unrelated per-slot revisions or executor hook supplies
the order. This ordering rule supersedes those alternatives.

Private state-change history and explicit recovery are specified in [Library entry state history and recovery](library-entry-state-history.md).
Decision: retain at most 64 state-change rows per account and subject across entry incarnations; pruning marks affected
retained history partial, and entries already present at installation remain unknown until a real transition is captured.

Undo is a new state write and obtains a fresh higher `owner_write_seq`, even when native state, subject IDs,
accepted pin, source stamps and user dates are restored exactly. Existing native new-transaction and revision
rules still apply. The archive retains the original state snapshot, including its original sequence; archived or
deleted rows never compete as current live state. A clear advances the counter but keeps the exact retained-entry
and physical-delete contract, including public status/body/headers; it creates no live state tombstone to hold a
sequence. Physical payload purge and derived repair are not owner state writes.

Native receipt replay allocates no sequence. Failed, denied, stale, expired or occupied operations roll back any
counter change with the fact; branded `noEffect` cannot hide a persisted counter write. A successful state-setting
write still allocates when its value equals another row: equality is not an idempotent receipt replay. Counter and
stored sequence use native bigint without Number truncation or client-chosen values. Never reset or wrap the
counter; overflow explicitly fails and rolls back the write.

Existing values without authoritative sequences require explicit bounded migration, cutover and readiness gates.
Do not fabricate ordering from dates, transaction UUIDs, source-type positions or zero. Fresh supported writers must
store real sequences before their canonical capability is advertised ready; unsequenced existing values cannot
silently compete in a ready canonical view. The [native cutover plan](library-owner-queries.md#sequencing-cutover-bounded-cuts-and-native-proof)
requires complete authoritative state-write evidence and verified locators with bounded live-write cutover, or
explicit real owner reassertion. Independent complete presence/label/session/holding paths do not all wait on
unknown state order. This is a required producer, not a permanent launch exception. The native
[`allocateOwnerWriteSeq` and schema](../services/kernel/src/library/owner-write-sequence.md) are delivered: the live-execute,
same-owner allocator returns bigint, with private nullable positive sequence columns on live/archive entries and
an owner counter. Production set/clear/Undo binding, legacy NULL migration/cutover, epoch readiness and complete
terminal erasure remain missing producers. The primitive establishes no canonical runtime readiness.

The separate [`readOwnerFactVersion`](../services/kernel/src/library/owner-fact-version.md) reads one exact native owner
head; full changed-row UPDATE hooks are integrated. Missing metadata is `null` (unbuilt), never zero or ready
absence. It supplies neither authorization nor bootstrap, identity-epoch or whole-query coverage proof. Actual row
changes, including a separate sequence-stamp UPDATE, each pay automatic trigger work; never disable coverage or
manually duplicate head increments. This invalidation version is distinct from one allocator increment per
successful state write. Complete indexed owner plans and canonical/source/Content version integration remain open.

Canonical indexes are keyed by canonical ID. Source-scoped concurrent identity observation, publication and cursor
currentness cover the actual source and complete query dependencies, including excluded and order originals.
Relevant pending work yields preparing; changed relevant basis restarts the signed cursor. Disjoint jobs cannot
keep a finite unchanged owner source preparing. No global active marker, universal page gate, per-page identity-home
sweep or identity-basis protocol is required. The SAME existing `library-private-follow-counts` participant covers
EVERY Library canonical record,
including the OWNER candidate/support directory and concurrent first-apply rekey custody. Its ACK must cover every
prior removal/addition/fence and exact native transactionId/component/job/epoch/version/scope, current terminal/
account/source fences and stale destination rejection; follow-only completion is insufficient. No third participant
or independent ACK shortcut. The [native owner plan](library-owner-queries.md#shared-operational-identity-and-disclosure-producers)
links the semantic scoped concurrent closure and still-required native proof.
Epoch maintenance reads `owner_write_seq` and re-keys only derived data; it never allocates a state-write
sequence or rewrites originals. The counter is private ordering data, never permission, an account lifecycle
generation, a membership witness database or an aggregate count to disclose. Current authorization still covers
original support and terminal: a withheld original never becomes public because its terminal is readable.

## Destinations and actions

Decision: My Collections admits an optional string cursor of at most 4096 characters and only rows/previews layout
(default rows when absent); malformed addresses retain bounded escaped context and make no private list or pins
read until explicit GET correction or restart. Cursor correction/restart keeps a valid layout; layout correction
always starts page one because rows and previews have different page bounds. Native stale-cursor restart retains
its separate notice, and current viewer/address retirement applies through malformed-address recovery.

Decision: Collection owner pages, saved rules and publication preview/review refresh use authenticated read identity without CSRF; writes require a current token, uncertain retries retain their original sender, credential, key and operands, and publication previews exclude occurrence notes.

Decision: The embedded Subject Library slot, Copies, Labels, Following and private follow counts admit authorized
current-subject reads, detail, cursor navigation and read-only retry
without a CSRF token; commands require the actual current token, while uncertain retries retain their original
credential, sender, key and operands and token arrival never submits them automatically. Private follow-count
payloads retire with their session/exposure observation and require a fresh authorized read after renewal.
Decision: Malformed follow-count context offers accessible GET correction for existing subject, Collection or Space UUID
targets, while clearing returns to own outgoing counts; native authorization still decides target disclosure.

Copies admits only a UUID subject selector and an opaque page cursor of at most 2048 characters; an empty selector
means all copies. Invalid nonempty selectors or malformed/oversized page positions retain the requested URL and
perform no copy or subject read. Decision: address recovery uses explicit read-only GET correction or clearing;
correcting a selector starts page one, while correcting or restarting a page position preserves its valid subject.
The existing native invalid-cursor fallback remains bounded to one retry with the same subject and credentials,
and visibly announces that it restarted at page one.
Detail/edit return and page recovery keep that subject. Decision: changed drafts prompt before closure or internal
navigation; an unresolved command allows only Stay until its exact intent resolves.
Decision: A definitive Copy update/delete conflict blocks new commands until explicit current-detail review and acceptance; accepting replaces the draft under the existing discard choice, uses a fresh key, and never submits a write. A concealed or unavailable detail cannot be accepted; uncertain commands keep their exact original retry.

The destinations are **Library**, **Following** and **History**. Library contains a bounded Continue row, Everything,
Liked, pinned Collections and All Collections. Desktop uses a short pinned sidebar; phone uses a Collection selector
and a few pins. State is a tile chip in profile wording and a filter; state Collections may be pinned, never compulsory
navigation tabs. Following holds subjects, Collections and Spaces, with no following feed or public follower totals.
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

Decision: Web bulk add captures only the loaded selected canonical Subjects in first-selection order before destination choice; choosing a destination freezes its identity and revision independently of subsequent list refreshes.

Decision: Collection placement browsing retains the current page plus one previous cursor; Previous steps back once, and Restart explicitly rereads page one, so deep browsing never stores cursor history. The [Web placement journey](../apps/web/src/library/collection-placement-journey.md) owns bounded destination/anchor browsing, exact occurrence review, native transfer recovery and destination-only bulk-add reuse.

Decision: Web occurrence-removal review captures only loaded selected member IDs in first-selection order, retaining duplicate Subjects and the source Collection independently of later edits.
Decision: Inline bulk add recovery reads one native outcome page at a time; a new confirmation uses the preview's captured sender, credential and headers with its own key, and uncertain retries retain that entire command.

Web's public download controls admit a detached first-page capture of viewer, native metadata revision and exact
occurrences, then compare it with current native FULL reads at admission and terminal delivery. Each read uses the
existing 100-member page bound: two reads examine at most 200 returned members, two Collection headers and at most
four existing viewer-action/follow point reads. There is no cursor accumulation. The resulting ItemList retains
occurrence identifiers, permitted notes and order; cancellation retires delivery and retry keeps the same capture.
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
specified in [Personal archive annotation and journal recovery](library-archive-personal-fact-recovery.md).

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

# Native personal archive recovery

[Native archive recovery](library-copy-archive-recovery.md) owns the admitted v1 format, private holding evidence,
and reviewed progress recovery. Holdings never restore an Entry, entitlement, or financial fact. Progress recovery
creates one fresh Session per explicitly selected occurrence and uses current profile meanings and native commands;
it does not restore historical dates, History, or journal/reflection annotations. Frozen native growth and
whole-caller acceptance remain deferred.

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
