# Library and Collections

A person's library and their lists are one capability. Every vertical (books, anime, games, visual novels, recipes,
records) configures it through definitions; no vertical has kernel code of its own. This document adopts required
first-public behavior, not a claim of runtime completion. The [Library module](../services/kernel/src/library/README.md)
records actual implementation and remaining gaps. [Scope](scope.md) defers user-saved dynamic queries.

The shared owner contracts are [Dynamic Collections](dynamic-collections.md), [Collection source](collection-source.md),
[filtered lists](filtered-lists.md), [independent labels](library-labels.md),
[profile consumers](library-profile-consumers.md), and [deletion](deletion.md). Indexed evaluation and the shared
identity epoch below supersede older per-page proof/replay, whole-slot observation and identity-basis protocols in
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
  nothing to Everything. Content owns the indexed, owner-scoped reaction adapter; copying into a curated Collection
  creates independent occurrences.

One derived owner-level subject candidate index may serve built-ins. It is discovery data, never permission or a
new personal presence fact. Do not maintain per-built-in membership caches or copied exact-fact-witness stores.
Every qualifying producer must cover insertion; incomplete coverage returns preparing/readiness, never false empty.
Native current membership and disclosure reject stale positives immediately, including deleted label parents.
Bounded durable maintenance may prepare indexes; GET never repairs, creates headers/grants or enqueues work.

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
new writes address the terminal. Canonical views choose the owner's latest state write while retaining conflicting
records, union labels, and keep copies/sessions separate. Browsing shows one card per canonical subject; the editor
preserves every curated occurrence, note and order.

Canonical indexes are keyed by canonical ID. Serialized durable identity maintenance marks the shared identity
epoch pending, completes bounded mapping/index work, then publishes the epoch. Canonical reads return preparing
while pending, and cursors restart on epoch change. No per-page sweep of identity homes or identity-basis protocol
is required. Current authorization still covers original support and terminal: a withheld original never becomes
public because its terminal is readable.

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
identities share not-found. A suspended account's valid bearer receives `403 account_suspended`; `401` is reserved
for missing, invalid or revoked credentials.

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
entry/copy/follow removal alone is not whole-graph erasure.

## Acceptance and cost evidence still required

One capability suite varies definitions and fixtures across curated, Everything, state, public/unlisted/private and
mounted Zone surfaces. It covers membership, filtering, bulk, export, follow, mount, lifecycle and actual cost.
Examples are harem-tagged light novels, books strictly over 1,000,000 words (equality and absent counts excluded),
both together, sparse matches, and withheld harem under positive and NOT predicates. Catalogue owns concepts,
properties/mappings and fixture configuration; holding-derived game-platform filters and user-saved queries remain
deferred. Manual platform filtering uses the admitted catalogue contract.

Required membership/filter measurements cover actual first/deep pages at 1,000/10,000/100,000 subjects with duplicate
histories, stale labels and sparse filters. Charge private owner indexes, native fact points, catalogue/disclosure
anchors, rows, statements, buffers, bytes and bounded background/epoch maintenance; no account/history scan or free
witness work. Terminal measurements cover complete indexed child inventories and exact cross-store locators, bounded
child-before-parent pages/checkpoints and finite workflow segments. Completion requires every phase and store-owner
acknowledgement. Whole-graph crash/replay, public A/pending B, immediate concealment and no-resurrection evidence are
required. Runtime and these measurements remain incomplete; documentation adoption runs no native checks.
