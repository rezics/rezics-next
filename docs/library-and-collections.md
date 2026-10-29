# Library and Collections

A person's library and their lists are one capability. Every vertical (books, anime, games, visual novels, recipes,
records) configures it through definitions; no vertical has kernel code of its own. This document adopts required
first-public behavior, not a claim of runtime completion. The [Library module](../services/kernel/src/library/README.md)
records actual implementation and remaining gaps. [Scope](scope.md) defers user-saved dynamic queries.

The shared owner contracts are [Dynamic Collections](dynamic-collections.md), [Collection source](collection-source.md),
[filtered lists](filtered-lists.md), [independent labels](library-labels.md),
[profile consumers](library-profile-consumers.md), and [deletion](deletion.md). Indexed evaluation and source-scoped
concurrent identity currentness below supersede older per-page proof/replay, whole-slot observation and identity-basis protocols in
those adoption surfaces and earlier research. Their ABI revisions belong to their owners; this adoption creates no
alternate mode, budget, API or authority document. The [library abstraction research](research/library-abstraction.md)
is background evidence, not implementation evidence.

## Personal facts and one Collection abstraction

For one account and stored subject there is at most one explicit exclusive entry state, independent labels, progress
sessions and copies (holdings). These are separate private native facts; ratings remain with ratings. Profiles in
immutable definitions releases supply state sets, progress modes/units, copy kinds/statuses and import mappings.
Stored accepted pins retain their immutable meaning after release activation or retirement. Missing profiles block
new profiled values, not historic reads, clearing or exact undo. Generic labels and curated occurrence edits need no
profile binding or lookup, and never invent a default state.

A Collection has one identity, curator, visibility, title/description, follow target, Zone mount and schema.org
`ItemList` surface. Curated membership stores ordered occurrences, each with its own ID and note; duplicates remain
editable. Dynamic membership derives unique subjects from native truth. One shared Collection members service and
page serves curated, Everything, state and Liked, with shared filters, sorts, summaries, cursors and actions.
Grid/list/table layouts are presentation only and do not change membership or authorization.

- **Everything** includes a subject with live explicit state, an effective live label assignment, retained
  session/history or retained holding. Removing one fact leaves membership while another survives. Empty entry
  shells, trash, follows, curated occurrences, ratings and published-log snapshots alone establish no membership.
- **State Collections** match explicit state by `(profileId, stateSetId, stateId)`. Only live entry, retained copy
  and session facts with actual accepted pins support an in-use state set and all its sibling views, including empty
  siblings. Labels and soft-deleted snapshots support none. No current or historical type is guessed from metadata.
  Support is derived representation, never a second authority; digest ordering is not semantic chronology.
- **Liked** derives from the owner's current SUBJECT `like` or `love` reaction. Switching between those preserves
  membership; clearing or another kind removes it. Thread/post reactions do not qualify. A reaction alone adds
  nothing to Everything or explicit state. Every account has a stable private logical Liked, including a genuine
  empty `200`. Content owns the owner-scoped reaction adapter; copying into a curated Collection creates independent
  occurrences. Logical identity, shared members integration and complete Content source-version coverage remain
  implementation requirements, not delivered Liked runtime.

The [native owner plan](library-owner-queries.md#native-candidate-support-and-complete-observations) owns the ONE
private OWNER candidate/support directory shared by built-ins and admitted owner queries, native indexed truth,
complete selective observations and finite repair. It is discovery data, never permission or a new personal fact;
no per-built-in membership caches or copied exact-fact-witness stores. That plan preserves the full required union.
Every qualifying producer must cover insertion; incomplete coverage returns preparing/readiness, never false empty.
Native current membership and disclosure reject stale positives immediately, including deleted label parents.
Bounded durable maintenance may prepare indexes. Logical Library/Collection list and detail reads stay pure;
they never repair indexes or create headers, grants, receipts or domain events. The common members GET alone may
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

Logical revision 0 becomes revision 1 only on the first authorized materializing write, atomically with native
resource grants and the account fence. Read authorization stays native; materialization permits no read-grant bypass.
Denied writes leave no storage. Opaque state references are discovery points, not permission or membership.

Stored personal subject IDs and Collection occurrences are immutable and never rewritten by identity resolution;
new writes address the terminal. Canonical views choose the live state with highest private `owner_write_seq` among
merged originals, show conflicts and retain every original fact, stored subject reference and accepted pin. They
union labels and keep copies/sessions separate. Browsing shows one card per canonical subject; the editor
preserves every curated occurrence, note and order.

### Owner state-write order

Latest state means a native per-account write sequence in the owner's partition. Each successful state set, state
clear and Undo restore increments that owner's counter row in the same authorized fact transaction with
`UPDATE ... SET seq=seq+1 RETURNING seq`. First-row initialization belongs to that write too, never GET. A live
entry stores the returned value as private `owner_write_seq`. All of one owner's entries share the owner partition,
so this totally orders that owner's state writes and confines counter contention to that person's writes. No
cross-partition coordinator, clock/UUID sorting, maximum of unrelated per-slot revisions or executor hook supplies
the order. This ordering rule supersedes those alternatives.

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

The destinations are **Library**, **Following** and **History**. Library contains a bounded Continue row, Everything,
Liked, pinned Collections and All Collections. Desktop uses a short pinned sidebar; phone uses a Collection selector
and a few pins. State is a tile chip in profile wording and a filter; state Collections may be pinned, never compulsory
navigation tabs. Following holds subjects, Collections and Spaces, with no following feed or public follower totals.
History contains consumption sessions and published logs while permitted by lifecycle policy.

Continue uses active-session or profile-active-state eligibility, ranked by session activity through a bounded native
read. It never loads the whole library for browser sorting. Until the dynamic runtime exists, an entry-only page is
named **tracked entries**, never Everything.

The same abstraction must support following a readable unlisted Collection, permitted ItemList export and mounting
into a Zone through the Semantic-owned [Collection source](collection-source.md) contract. Curated export preserves
permitted occurrence notes, order and multiplicity; dynamic export emits unique subjects. Neither export nor mount
discloses private predicates/facts or grants subject access. Common bulk preview and execution bind the same admitted
filtered or selected population, reject stale selection, prevent replay effects and retain inspectable partial failures.
This document invents no bulk/export ABI and does not make existing stub factories functional.

## Indexed filtering and disclosure

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
expose no totals/facets over unchecked candidates. Dynamic Collections are private until explicitly published and
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
The private owner counter and stored live/archive `owner_write_seq` belong to that inventory. T immediately fences
state writers; bounded participant cleanup erases ordering metadata after its dependent private facts. Late repair
must never recreate it. This adds neither account restore nor a public activity counter.

## Acceptance and cost evidence still required

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
