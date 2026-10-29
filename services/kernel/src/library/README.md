# Library

Library is the kernel module for a person's shelves and reading state, and for the public projection of public Collection membership.

## Scope and implementation boundary

[Library and Collections](../../../../docs/library-and-collections.md) owns the capability. This README adopts its
required behavior and inventories native code; requirements below do not establish shipped runtime. The shared
[dynamic](../../../../docs/dynamic-collections.md), [Collection source](../../../../docs/collection-source.md),
[filtered-list](../../../../docs/filtered-lists.md), [label](../../../../docs/library-labels.md) and
[profile-consumer](../../../../docs/library-profile-consumers.md) contracts own their respective seams. Indexed
observations and shared source-scoped concurrent identity currentness supersede their older per-page proof/replay,
whole-selected-slot, universal-key-budget and identity-basis protocols. Shared owners revise their ABIs; Library
adds no alternate mode or budget. User-saved dynamic queries and holding-derived game-platform filters remain deferred.

Native curated Collections store ordered occurrences, including repeated subjects, notes and order. Entries, copies,
progress sessions/units/history, follows and published logs have production commands/readers. The public subject
listing stores public Collection pairs and counts; it is not personal membership truth.

Current implementation evidence is narrower than the capability:

- `collection-reads.ts` still reads stored headers and ordinal occurrence pages into curated-shaped DTOs. It does not
  supply logical built-in discovery, dynamic dispatch or canonical duplicate-free browsing.
- `collection-source-native.ts` supplies metered stored-header metadata, native authorization, raw fact/member ranges
  and original-subject probes. Headerless references and public/unlisted dynamic output return unavailable. These
  helpers do not implement the shared members service or the adopted complete indexed filter/identity plan.
- `builtin-identity.ts` deterministically derives Everything/state IDs. `builtin-reference-store.ts` binds exact
  entry witnesses; it does not prove copy/session-only whole-state-set support, all siblings or writer coverage.
  These helpers implement neither Liked identity nor its Content reaction integration.
- Pin/kind columns, retained-entry/due storage, labels/reservations, source-head hooks and canonical tables exist.
  `entry-store.ts` accepts private pins for entry insert/update and pin/kind for copy insert/update, with
  `readEntryFact`/`readCopyFact` native readers. `progress-store.ts` accepts session pins and exposes `readSessionFact`.
  Unpinned compatibility paths still constrain fixed values; DAO delivery is not complete production profile acceptance.
  Label DAOs provide
  metadata lifecycle and reservation admission, not HTTP commands, complete assignment undo/pages or automatic purge.
- The native [owner sequence allocator/schema](owner-write-sequence.md) and
  [owner fact invalidation ABI](owner-fact-version.md), including full changed-row UPDATE coverage, are integrated.
  `entries.ts` allocates and persists owner write order for entry set, retained clear and exact Undo.
  These primitives establish neither complete owner-query coverage nor dynamic/canonical runtime readiness.
- Shared `FilterDocument`/`OwnerLeaf` and `parseFilter`/`admitFilter`/`walkFilter` deliver structural owner grammar,
  including saved expansion. `owner: true` is not authorization or a native owner plan.
- `command/operational.ts` and [Core's frozen contract](../command/README.md#operational-transactions) now provide
  the Accounts-owned additive event-free fenced transaction and same-client DBOS intent in source. Library's
  consumer/preparation/native custody implementation remains required pending; this is no readiness receipt.
- Every method of `createCollectionSource` and the canonical-source-store factories throws `dependency_unavailable`.
  Integrated tables, typed ports, outcome interfaces and missing-driver verifiers are not runtime completion.
- `work-module.ts` registers `work.ts` Collection listing effects only. `account-fact-purge.ts` exports
  `purgeAccountFactsPage` for entry/copy/follow, without a terminal whole-graph worker. It still omits most of that graph.
- Semantic identity STORE/mapping/participants/coordinator and whole-query Source2a remain contracts without
  runtime producers. Existing point Access/disclosure, `subjectSource` and projection checkpoints do not close them.
  Content reaction commands exist, but inspected worktree/dev has no `readLiked`/`readLikedVersion` implementation;
  obtain actual raw/version and DDL receipts rather than inferring delivery from an earlier receipt description.

### Scoped subject-search status

[Owner consumer requirements](../../../../docs/library-owner-queries.md#scoped-subject-search-consumption-required-runtime-pending)
adopt existing `subject.search` with Library/Collection scope plus all owner/catalogue/text conditions.
Search's sole `docs/subject-search-conditions.md` contract is pending adoption here; Semantic's one pure request
grammar producer follows its freeze. Verified request/logical-owner authorization bridges, native owner text
index/analyzer/ranking, complete Source2a/privacy/identity and runtime remain pending. The linked owner section
owns exact one-Library-scope preparation, Everything basis reuse, Cost and future native evidence requirements.

### Required built-ins and personal space

Use one Collection members service/surface for curated, Everything, state and Liked. Native personal facts remain
truth. The [native owner plan](../../../../docs/library-owner-queries.md#native-candidate-support-and-complete-observations)
owns the ONE private OWNER candidate/support directory, native indexed truth and complete selective dependency/
repair design, shared by Everything/state/Continue/Liked and admitted owner queries. No per-built-in membership
cache or copied exact-fact-witness store. Every qualifying producer must insert discovery coverage atomically or establish
readiness through bounded durable preparation. Missing coverage returns preparing, never false empty. Stale positive
candidates lose membership/disclosure immediately under current native checks. Logical Library/Collection list and
detail reads are pure: no repair, header/grant creation, receipt or domain event. The common members GET and the
precisely admitted subject-search consumer above may start the SAME bounded idempotent derived preparation and
work intent, keyed by actual viewer, Collection, validated
filter/sort and accepted release/meaning, under [Dynamic Collections](../../../../docs/dynamic-collections.md#model-and-identity).
It writes no domain state, header, grant, event or receipt. Members GET preparation returns `202 application/json`,
exactly `{preparing:true}`, `Retry-After` and owner-private `no-store`; retry the same validated URL and cursor.
No members, next, operation ID or partial data accompanies `202`. Genuine exhaustion stays
`200 {members:[],next:null}`; unavailable runtime/work stays `503`. Zone POST remains unchanged.
[Continue GET](../../../../docs/library-continue.md#http-contract) starts no work; the members exception does not apply.
The Accounts operational producer uses SERIALIZABLE/current deadline/contention retry, existing command gate,
request-mode actual Access/current-T finalization and actor-free work-step partition/up-to-two active/unfenced
account FOR SHARE fences. Atomic intent uses pinned DBOS `enqueueInTransaction` on the SAME pg client as derived
rows, no separate intent table/relay/new queue/second connection. Consumer uniqueness enqueues only newly created
preparation with deterministic workflowID, no deduplicationID, locators-only inputs and shared-history custody.
No receipt/event/write basis/position advance; existing DBOS recovers it and expires only terminal workflows.
Consume the actual Core API; ordinary `runCommand`/`noEffect` or enqueue after commit is not this transaction.

Everything is the unique subjects with live explicit state, effective live label assignment, retained session/history
or retained holding. Empty entry shells, trash, follows, curated occurrences, ratings and published-log snapshots
alone contribute nothing. Clearing state leaves other facts intact; removing the last qualifying fact removes presence.
Labels need no profile lookup or binding. Only live entry and retained copy/session facts with actual accepted pins
support an in-use state set and all sibling state views, even empty siblings. Labels and soft-deleted snapshots support
none. Do not infer a historical/current type. Accepted pins keep immutable meaning; support data is derived, never a
second source of authority.

For presentation and labels only, an unmaterialized PRIVATE state view selects the lexicographically smallest
currently supported accepted release digest containing that state. Discovery unions all supported sibling identities,
including empty states; each native fact retains its own accepted pin and meaning. Digest order expresses neither
chronology nor semantic compatibility. A materialized header keeps its accepted meaning, a completed public generation
keeps its own meaning, and an explicit owner rename wins. Public DTOs expose no private pins, predicates or digests.
[Dynamic Collections](../../../../docs/dynamic-collections.md) owns the detailed contract. Native selection requires
its own indexed support access path and later performance proof, never a scan over an owner's releases; that path
is not implemented.

Built-ins have stable deterministic identities and private defaults. Empty logical Everything and owner state
reference discovery need no stored header or write scope. Dynamic DTOs omit curated count, creation/update times,
order epoch and occurrence fields; no fake zeros. Every account also has a stable logical Liked that is always private, including
empty `200`; that adopted meaning does not establish implemented identity or members runtime. First authorized
materialization moves revision 0 to 1 atomically with native Collection resource grants and `shareAccount`, without a read-grant override. Denied writes create nothing.

Library contains Continue, Everything, Liked, pins and All Collections; Following and History are separate
destinations. State is a tile chip in the profile's wording and a filter; state Collections can be pinned, never
mandatory navigation tabs. Continue is a bounded native read using active-session/profile-active-state eligibility,
ranked by session activity, never full-library browser sorting. Liked uses current SUBJECT like/love reactions;
clearing or another kind removes membership. Thread/post reactions never qualify; reactions alone add neither
Everything nor explicit state. Content owns the owner-scoped reaction adapter; complete Liked source-version,
epoch/disclosure coverage and shared members integration remain missing. There is no following feed or public
follower total. An interim entry-only page is named tracked entries, never Everything.

Stored personal subject IDs and curated occurrences are immutable; new writes target the terminal. Canonical views
select the live state with highest private `owner_write_seq` among merged originals, show conflicts, retain every
original fact/reference/pin, union labels and preserve separate copies/sessions. Browsing emits
one canonical card; the editor retains every occurrence/note/order. Canonical-ID indexes establish browsing order
and uniqueness. Identity observation, publication and cursor currentness cover the actual source and complete query
dependencies, including excluded and order originals. Relevant pending work prepares; changed relevant basis restarts
the signed cursor. Continuous disjoint jobs cannot stall a finite unchanged owner source. No global active marker,
universal page gate, per-page identity-home sweep or identity-basis protocol. Original withheld support never becomes
public through terminal visibility; current original/terminal authorization remains required.
The SAME fixed `library-private-follow-counts` epoch participant covers EVERY Library canonical record, including
OWNER candidate/support directory and concurrent first-apply rekey custody. Its ACK binds exact native
transactionId AND component/job/epoch/version/scope and every prior removal/addition/fence, current terminal/
account/source admission and stale destination rejection. Follow-only completion is insufficient; no third
participant or independent ACK. Consume the semantic scoped concurrent closure through the
[owner plan](../../../../docs/library-owner-queries.md#shared-operational-identity-and-disclosure-producers);
actual native participant, whole-query Source2a and custody proofs remain required pending.

### Native owner state-write sequencing (required; runtime incomplete)

[Owner state-write order](../../../../docs/library-and-collections.md#owner-state-write-order) owns the rule. Entry
create/update, physical clear and Undo restore must increment one per-account counter in the owner's partition,
using `UPDATE ... SET seq=seq+1 RETURNING seq` in the same authorized transaction as the fact, receipt, source hooks
and outbox. Initialization is part of the first authorized write, never GET. Live entries store the result as private
`owner_write_seq`; all of an owner's entries share that partition and total order, with contention only among that
owner's state writes. Do not derive this order from a global coordinator, clock/UUID sorting, max of unrelated
per-slot revisions or an executor hook.

Native receipt replay skips allocation. Failed/denied/CAS-stale/expired/occupied operations roll back counter changes
with the fact; branded `noEffect` cannot persist a counter update. Successful state-setting writes allocate even if
their value equals another row. Use native bigint for counter and stored sequence, no Number truncation, reset,
wrap or client-selected value; overflow explicitly aborts the write. Physical payload purge and derived repair
allocate nothing. Epoch maintenance consumes `owner_write_seq` and re-keys only derived indexes, never originals.
The counter is private ordering data, never permission, an account lifecycle generation, a membership witness store
or a disclosed aggregate.

The delivered [`allocateOwnerWriteSeq` ABI and schema](owner-write-sequence.md) require a live native execute transaction,
same-owner attribution and matching partition. Private `owner_write_counter` storage and nullable positive bigint
`entry.owner_write_seq` / `entry_deleted.owner_write_seq` exist; null is legacy/unsequenced, with no default/backfill.
Production row adapters and set/clear/Undo binding, bounded migration/cutover/readiness, epoch consumer and complete
terminal cleanup remain missing producers. Existing unsequenced values must not be ordered by dates, transaction UUIDs, source-type positions or fabricated zero.
The [native cutover plan](../../../../docs/library-owner-queries.md#sequencing-cutover-bounded-cuts-and-native-proof)
requires complete authoritative native state-write evidence, exact verified locators and bounded live-write cutover,
or explicit real owner reassertion. Affected winner/NOT-state/Continue state stays unready; independent complete
original/presence/label/session/holding paths need not all wait. Fresh supported writers must set real sequences
before canonical readiness. Unknown chronology is a required producer gap, not a permanent launch exception.

The distinct delivered [`readOwnerFactVersion` ABI](owner-fact-version.md) reads one exact owner head in the caller's
native snapshot. Its bigint result is private invalidation metadata; `null` means unbuilt, never zero or ready absence.
It provides no authorization, bootstrap, identity-epoch or whole-query coverage proof. Full changed-row UPDATE hooks
are integrated for entries, copies, sessions, label assignments and label parents. Each actual row change, including
a separate sequence stamp, pays automatic trigger work; genuine no-change updates do not. Never disable coverage or
add a manual duplicate head increment. Multiple row changes can advance the head repeatedly while the state-write
allocator increments once per successful state write. Complete owner indexes/plans and canonical/source/Content
version integration remain required under [owner predicates](../../../../docs/library-owner-queries.md).

### Required filtering, actions and cross-owner dependencies

Evaluate complete identified catalogue or private owner observations. Admit filter, source and order together:
bounded direct plan, otherwise bounded prepared indexed results, otherwise `422` before enumeration. Pages are filled
or final, or preparing, never chains of successful empty pages. Use per-plan derived row/statement/buffer/byte
allowances including label parents, native authority and preparation; no universal candidate multiplier or 256-key
cap. Preserve shared grammar and pure matcher semantics, same-statement qualifiers, units and unknown under NOT.
Owner-only NOT state includes no entry; missing catalogue evidence never proves a property. Current disclosure covers
membership, exclusions, order and fields, including NOT; an index revision grants nothing. Healthy catalogue freshness
is <=60 seconds; >5 minutes behind returns readiness. Privacy reduction is immediate and owner reads see own writes.
Private facts never enter public indexes; unchecked public totals/facets are forbidden.

Follow a readable unlisted Collection through the same abstraction. ItemList export preserves permitted curated
occurrence notes/order/multiplicity and emits unique dynamic subjects without private facts. Mount through Semantic's
Collection source contract. Bulk preview/execution bind the same admitted filtered/selected population, reject stale
selection, prevent replay effects and retain inspectable partial failures. Existing stub factories satisfy none of these
runtime obligations; no new bulk/export ABI is defined here.

Use the [native persona contract](../../../../docs/library-continue.md#native-authorization-boundary): no valid
suspended bearer exists. Suspension advances the authentication floor/fences before Auth revokes sessions. The actual
pre-suspension token receives `401`, JSON `invalid_credentials`, and
`WWW-Authenticate: Bearer error="invalid_token"`. Correct-password sign-in receives `403 ACCOUNT_SUSPENDED` with no
session. Kernel's defensive `403` is not a fixture scenario; never invent SQL/token personas. Preserve missing,
invalid and revoked `401`, scope `403` with `insufficient_scope` challenge, and unknown/private concealment.
Invalid credentials never downgrade to anonymous on public/unlisted reads.

Capability acceptance uses the same scenarios across curated, Everything, state, public/unlisted/private and
mounted Zone sources, varying definitions and fixtures. Include membership, bulk, ItemList export, unlisted follow,
mount, lifecycle and actual cost, not membership alone. Real filters are harem-tagged light novels, books strictly
over 1,000,000 words (equality/absent counts excluded), both together, sparse matches and withheld harem under positive
and NOT predicates. The native runtime and cross-surface evidence remain incomplete; this adoption runs no native tests.

Unresolved producer dependencies are specific:

- **Semantic/Definitions:** immutable accepted pins and state-set meaning, current original/terminal disclosure,
  canonical mapping and source-scoped concurrent identity currentness, complete catalogue projections, and Zone composition
  through Collection source. The old digest/home-sweep ABI is superseded, not a prerequisite to reproduce.
- **Search and performance:** shared admission/preparation/freshness, per-plan measured allowances and public-safe
  disclosure dependencies; Commerce supplies owner-local indexed plans. Catalogue owns harem/light-novel concepts,
  word-count properties, mappings and fixture configuration, including manual platform filtering.
- **Content:** current owner-scoped SUBJECT like/love reaction index/read adapter, not a Library reaction mirror.
- **Accounts and shared store owners:** the terminal coordinator, account read/write fence, actual participant
  acknowledgements, minimal completion outside DBOS history, and exact receipt/outbox/work payload minimization.
  Library and financial Commerce are separate participants; payment retention stays with financial Commerce.
- **Web:** shared members rendering, preparation/restart UI, Collection navigation and bounded Continue consumption.

## Partitions

Everything personal lives in the owner's partition. That includes Collections and their members, entries, progress sessions, units and history, copies, follows and published logs. A partition is `route >>> 4`. It is not a physically partitioned SQL table.

Public Collection membership is copied to each subject's partition, carrying only `public_collection_count` and pair rows. A pair is one `subject_collection` row: collection id, collection route and multiplicity. Private and unlisted membership never write those rows. Nothing in a follow, entry, session or copy is written on the subject's partition.

Sitemap discovery is internal. It follows the [partitioned sitemap research](../../../../docs/research/partitioned-sitemap-feeds.md): a partition-major walk over immutable `(route, collection_id)` keys, resumed after the last candidate examined. `readSitemapCandidates` in `sitemap-discovery.ts` reads at most a caller-chosen budget of active, public Collection identities from one partition, in route then id order, with the exact stored `updated_at`, through `sitemap-page.sql` and the partial index `collection_sitemap_public_page`, which carries `updated_at` as an included column so a page needs no heap fetch and no other index is a cheaper way to read it. It adds no catalogue copy, trigger or write-path change. The result is a discovery hint, never anonymous disclosure authority: the caller still decides what an anonymous reader may see.

## Privacy

Private state never reaches public full text, counts or "who also read". Only public Collections and published logs are public. An unlisted Collection can be read by someone who knows its id, and it is not listed. A private Collection is disclosed only to a live grant-capable curator. Everyone else receives the same not-found result as an unknown id.

Events about private state use the account or Collection id as `subject`, never a subject id. Collection updated, deleted, member-changed and listing-changed events use the Collection id. Entry, follow, progress-session, copy and published-log events use the account id. A member-changed payload also carries the member id and the subject id. An entry or follow payload may carry an id in `data`. The public listing event `com.rezics.library.subject.listed.v1` uses the subject id because that projection is public. Follows are never counted in public. A published log shows the subject id, the session state, the start and completion times, and the owner's note. It does not show amount, cursor or the completed-unit set.

### Deletion and restoration (first public contract)

[Shared deletion policy](../../../../docs/deletion.md) is authoritative. This section specifies its first-public
Library application; terminal account erasure starts at T, independently of ordinary-record undo. The Cost section
below describes today's implementation, including physical deletes. The
retained-entry command and HTTP Undo preserve exact original meaning with current authorization. Collection deletion
DAOs exist, while automatic due-purge runtime, terminal account full-graph cleanup, public contribution provider
and a complete native deletion-outcome driver remain incomplete. Legal-hold support is deferred for first-public Library deletion: this slice specifies no hold authority,
route, destructive guard or release path and does not depend on one. User-saved dynamic queries remain deferred by
[scope](../../../../docs/scope.md); only built-in dynamic Collections are in scope.

Delete commits a tombstone at kernel command time `deletedAt`; `restoreUntil = deletedAt + 30 * 24 hours` in UTC.
An authorized undo is allowed only while kernel time is strictly less than `restoreUntil`: day 29 succeeds, the
exact day-30 boundary fails even if purge has not run. Client clocks, workflow start times, receipt times and a
legal hold never extend that interval. The ordinary delete route never physically purges payload. No early-purge
route or parameter is currently exposed. If one is added, it must require a separate explicit platform purge
permission on the exact target; ordinary owner/delete authority is insufficient. That permission/action binding is
missing, so existing delete routes must not be reinterpreted as early purge.

Takedown is a disclosure hold, not a delete: withhold the least covered field or the record when a smaller
withholding does not satisfy the notice, retain other fields as allowed, and do not schedule purge solely because of
the notice. A legal-order purge is a distinct platform-authorized operation. The shared policy also says legal holds
suspend automatic purge without restoring disclosure or extending an ordinary record's undo deadline; first-public
Library does not implement that hold workflow.

For the rows below, entry, copy, label, assignment and published-log writes require the current owning account and
their operation scope (`library_entry:delete`, `copy:delete`, `library_entry:update`, or `published_log:delete` as
applicable). Collection and member writes require the curator's current Collection resource permission
(`collection:delete` or `collection:update`). Each command binds the actor, action, stable target identity, canonical
input and applicable target revision or generation; member restoration also checks the saved occurrence identity
and current Collection order/capacity. Current account, scope and resource authority are checked before receipt
lookup. An authorized same-key replay has one effect; current authority missing on replay conceals retained payload.
A stale revision or changed identity conflicts without overwriting a newer fact.

| Record / existing supported mutation                                             | Required concealment, reference and undo                                                                                                                                                                                                                                                                                                                                                                                                                | Actual gap                                                                                                                                                                                                                                                                                                                                                                                             | Policy-window purge (specified, not implemented)                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exclusive `entry` / `DELETE /v1/libraryEntries/:subjectId?revision=…`            | The owner account hides the state fact immediately from all ordinary views. A permitted reference is only stable identity and deleted state. Undo restores the same owner/subject incarnation, exact state and accepted profile pin with a newer CAS revision. Copies, sessions, labels, follows and curated occurrences survive independently.                                                                                                         | Native clear retains the complete snapshot under its actual command transaction. HTTP Undo restores it only into an empty slot before the original deadline; current owner admission precedes receipt replay. Automatic due delivery remains separate.                                                                                                                                                 | The skeleton identifies one person's reading state, so erase the entire private fact/incarnation and profile pin.                                                                                                                                                                                                                                    |
| Holding `copy` / `DELETE /v1/copies/:copyId`                                     | The owner account hides the holding and private location/source/note/dates immediately. A permitted reference is only its stable identity and deleted state. Undo preserves copy ID, values and pins with a newer revision; it does not mint another copy.                                                                                                                                                                                              | `entry-store-copy-delete.sql` physically deletes. The route pre-reads the row and has no retained tombstone, client CAS delete contract or authorized absent-row replay path.                                                                                                                                                                                                                          | The owner/subject holding is personal; erase the whole row and its private fields/pins, leaving no account-to-subject skeleton.                                                                                                                                                                                                                      |
| Curated `collection_member` / member DELETE                                      | The authorized curator hides that occurrence, note and count/multiplicity contribution immediately, preserving duplicate siblings. A permitted public reference is only occurrence identity and deleted state; private occurrence existence stays concealed. Undo uses the same member ID, subject, note and original placement only if current Collection order/capacity permits it.                                                                   | `collection-store-collection-member-delete.sql` physically deletes and decrements parent count. There is no retained occurrence revision/expiry or undo.                                                                                                                                                                                                                                               | Minimize a public occurrence to its safe occurrence/parent/subject tombstone; erase a private occurrence whose skeleton is personal. The visible member count/multiplicity changes at hide, never again at purge.                                                                                                                                    |
| `collection` / Collection DELETE with revision                                   | The curator or currently authorized Collection editor hides metadata, members and every derived disclosure immediately. A permitted public reference is only Collection identity, kind and deleted state; a private Collection remains indistinguishable from an unknown ID. Undo preserves Collection ID, visibility, ordered occurrences, notes and pins, advances Collection revision/order basis, and never revives an independently deleted child. | `collection-store-collection-tombstone.sql` writes deletion and 720-hour expiry metadata; `collection-store.ts` exposes exact deletion metadata and revision/deadline-guarded restore DAOs. They are not integrated with a complete authorized restore route or purge worker. Reads check active state, but public pair/count cleanup is asynchronous and source-stamped through the listing workflow. | An ordinarily deleted public Collection is no longer an active public contribution. Erase title, description and personal attribution; retain only a safe structural tombstone and permitted relations/counts, including safe occurrence skeletons. Erase a private/unlisted Collection graph wholly, including previously-public personal remnants. |
| Label definition / label delete in the label contract                            | The owner hides the name and every assignment-derived fact immediately by current parent liveness/revision. A permitted reference exposes only allowed tombstone identity. Undo restores the same label ID/name and only still-valid assignments within the window, with a newer CAS revision.                                                                                                                                                          | `label-store.ts` provides native metadata CAS/delete/undo with original 720-hour deadlines and live-name uniqueness. The native catalogue commands and ordinary bounded purge are delivered; full HTTP/assignment caller integration remains separate. Recreation uses a new ID and can conflict with historic undo.                                                                                   | Erase the whole private definition and its personal assignments through bounded exact-episode pages; keep no permanent named tombstone or live-cap charge.                                                                                                                                                                                           |
| Label assignment / unassign in the label contract                                | The owner hides only this assignment immediately. A permitted reference exposes only allowed identity and deleted state. Undo restores the same assignment identity only if its definition is live and current name/capacity constraints permit; it never revives an unrelated definition.                                                                                                                                                              | Same-row IDs/slots and `label-assignment-store.ts` provide reservation admission and deleted-parent reclaim. Individual unassign/undo DAOs and ordinary purge are delivered; full authorized command/list/HTTP integration remains separate. Restore must reacquire live capacity; reclaimed children never auto-revive.                                                                               | Erase the whole private assignment and its fact-index link; its owner/label/subject skeleton is personal.                                                                                                                                                                                                                                            |
| `published_log` / `DELETE /v1/publishedLogs/:logId`                              | The owner retracts the public snapshot immediately using the current revision. A public reference exposes only `{id, deleted:true}`. Undo is bound to the exact deletion id and revision, preserves the original published values/times and note, and never recopies current session state. The original 720-hour deadline is fixed across retries and restores.                                                                                        | A retained in-place episode stores the deletion id, revision and deadline while keeping the original snapshot private for exact Undo. The registered Library worker discovers due episodes through the partition-leading due index and minimizes payload in place. Account terminal purge removes all remaining log rows in bounded pages.                                                             | At ordinary expiry, remove the owner, session, note, state and personal times; keep only the public log id and deleted marker. Account terminal erasure removes the row and cannot be reversed. Retraction advances fact visibility once; purge does not repeat the visibility decrement.                                                            |
| Session, units, change history, progress head / start, record, complete, abandon | The account owner reads these through existing progress commands/pages while the account is active. Completion and abandonment are factual transitions, not deletion. Entry deletion leaves them available to the owner and a session may continue to support a subject in Everything. Unit removal is an existing progress record with history. There is no independent deleted reference or undo operation for these audit/history rows.              | No session/history delete API is promised. Account deletion is terminal at T and must conceal the private graph; there is no account restore to reopen it. The account-private Library purge consumer is absent, and history is unbounded even with the 20000-unit cap.                                                                                                                                | Under account erasure, erase private units/history before sessions and heads. A removed progress unit follows existing correction history until account erasure; do not invent a separate history-row delete API.                                                                                                                                    |
| Follow / follow, unfollow                                                        | The owner controls only their outgoing follow. Unfollow is a subscription state change, not deletion or a reason to remove another person's inbound preference. It has no deleted tombstone or undo operation. Account deletion is terminal and immediately ends the owner's access to outgoing state.                                                                                                                                                  | `follow-store-apply.sql` retains unfollowed rows; the account-private purge consumer for every state/reason is absent.                                                                                                                                                                                                                                                                                 | Erase every outgoing private follow state/reason and account-to-target relation; do not remove another account's inbound follow preference.                                                                                                                                                                                                          |

#### Entry deletion identity and restoration

**Adopted requirements.** Keep `library.entry` as the live owner/subject slot with its existing primary key
`(route, account_id, subject_id)`. Each successful clear moves the complete typed persisted row into a separate
private `library.entry_deleted` row. Its primary key is `(route, account_id, deletion_id)`, and `deletion_id` is
the successful native delete command's `transactionId`. This is an opaque exact locator, not authority or a routed
subject/account ID: derive `route` and `account_id` from the authorized owner, never from the locator. Do not add a
live-slot foreign key or cascade, a subject uniqueness constraint, a generic trash/version-history engine, or an
archive union in ordinary reads. Every deletion occurrence remains independent; a refill creates a new live
incarnation and never changes retained rows.

The archive keeps the full pre-delete row: `route`, `account_id`, `subject_id`, `requested_subject_id`, `state`, the
source `revision`, `created_at`, `updated_at`, original `transaction_id`, `activity_at`, `finished_at`, `type_id`,
all `type_source_*` stamps, non-null `incarnation_id`, and the accepted `library_profile_pin` with its existing
`library.library_profile_pin_valid` validation and the existing pin nullability rules. The required snapshot also
retains the original `owner_write_seq`; its nullable positive bigint column exists, but writer binding is missing.
The retained schema also has `deletion_id`,
`deleted_revision`, `deleted_at`, `restore_until`, and generated
`partition_no = route >> 4`. The due index is exactly
`(partition_no, restore_until, route, account_id, deletion_id)`. The source revision remains `r`, the deletion
revision is `r + 1`, and a successful restore inserts the saved values at `r + 2` with a fresh higher
`owner_write_seq`; reject deletion without mutation when `r > 2,147,483,644`. Restore inserts only into an empty
live slot and consumes only the selected deletion after
the insert succeeds. Occupancy or stale/expired state conflicts and leaves that archive row available. User dates,
pin, stored subject/alias and source stamps survive unchanged; lifecycle time, the restore transaction and ordering
metadata are new command facts. Undo does not copy the archive's old sequence into live state. Clear advances the
owner counter without adding a live tombstone; archive/deleted rows never compete as current live state. Missing
historical profiles use the actual legacy-null pin handling until the profile owner completes
the retained-row cutover; never infer a historical accepting type from today's profile or shelf observation. A corrupt
or unavailable non-null pinned release fails closed rather than guessing.

DELETE keeps status `204` and an empty body. Its minimal native command outcome supplies
`Library-Entry-Deletion-Id` and `Library-Entry-Deletion-Revision`; the latter is `r + 1`. Do not add an expiry
header unless its owner explicitly requires and documents it. A new
`POST /v1/libraryEntries/:subjectId:restore` has operation ID `library_entry.restore`, accepts only the closed
body `{ deletionId, revision }`, uses its own
`Idempotency-Key`, and returns the normal entry response. `revision` binds the deletion revision in the header.
Register it with `customMethod` as required by the [HTTP contract](../../README.md#http-contract).
Restore uses the exact stored `subject_id` and current source-read eligibility; redirects affect eligibility only and
never rewrite `subject_id` or `requested_subject_id`. Reuse existing native scopes, gates and pin validation; add no
profile, permission or cache authority. Use the existing `library_entry:update` owner authority and `shareAccount`
barrier for restore; delete keeps `library_entry:delete`. The locator is not permission. Missing or foreign handles remain concealed; occupied,
stale or expired restores return `409`. A successful restore consumes exactly that archive row. An exact authorized
restore replay is acknowledgement of its committed result, never a second insert; a fresh key cannot restore a
consumed row. There is no unauthenticated receipt endpoint, latest-deletion search or trash list.

Current authorization and account fencing precede exact receipt lookup on delete, restore and replay. Remove the
ordinary live-row pre-read from DELETE admission so a same-key request can replay after refill or restore. An exact
authorized replay returns its original deletion ID/revision metadata without touching the current slot. A receipt
created by the pre-retention physical-delete path may still acknowledge `204` with an empty body, but cannot claim
archive metadata that was never written. DELETE receipts store only the descriptor needed for replay, not the deleted
entry or pin.
The retained-point lookup for undo is exact and owner-authorized; it is not a new public state reader. A missing
current profile does not prevent clearing or undoing the identical previously accepted pinned value, while a fresh
profiled value still requires current profile validation after receipt handling.

Take `shareAccount` in the command authorization path before receipt lookup for entry create, update, delete and
restore, so both fresh writes and authorized replay serialize with terminal account deletion. Due work selects at
most 100 raw archive keys before later eligibility filters and advances after the last examined key. The destructive
transaction rechecks the exact `(route, account_id, deletion_id)`, authoritative due time or terminal account time;
an absent or consumed deletion is a no-op. Purge removes only that retained snapshot, never a live row by subject,
and never applies a second live-counter decrement. Register it through existing shared durable work; do not add a
Library-local timer. Minimize actual Library receipt, event, outbox and workflow payloads at exact locators under
their shared owners' retention protocols. Open shared-store and external inventory gaps remain explicit; no broader
physical-erasure claim follows from empty Library tables.

For replacement-safe fresh writes, expose opaque `incarnationId` in entry reads and write results. A revisioned PUT
body and DELETE query carry `incarnationId` alongside `revision`; the spelling is consistent across both requests.
After the writer/backfill cutover, a fresh revisioned request missing this precondition conflicts with no effects.
A create without `revision` remains valid and allocates a real non-null incarnation through the existing `newId`
allocator; updates preserve their incarnation. Parsers may admit an omitted `incarnationId` only far enough to
authorize and find an old exact receipt. Preserve that receipt's old canonical digest/input branch; do not reject
it in the schema or run current profile/input validation before the receipt. Fresh commands enforce the strong
precondition after a receipt miss. Backfill at most 100 raw live primary keys per page before null/pending filters,
using CAS on the observed revision, transaction identity and `incarnation_id IS NULL`; preserve values, revision,
pins and timestamps. Do not stamp on GET. Enable the new ABI/writer only after new fills are non-null, bounded
backfill is exhausted, and the profile owner has completed the required retained-row readiness gate.

**Current implementation gaps.** The existing `Entry` model and response omit `incarnation_id`; insert SQL does not
allocate it; update/delete compare only the slot and revision; delete physically removes a limited projection that
omits the shelf, pin and incarnation columns. Both `entries.ts` preparation and `personal-routes.ts` currently
pre-read before receipt lookup. The retained-entry table/due DAO is not integrated into an ordinary delete writer or
restore route/command. No automatic due worker, terminal account full-graph consumer, public contribution provider
or complete exact-locator cleanup of shared receipt/outbox/workflow payloads is implemented. First-public Library
legal-hold support is deferred. A retained-row DAO alone does not supply the ordinary lifecycle guarantees.
Existing first-scope concealment, Everything support from other live facts, the 18 legacy outcome pairs, and
public/private policy stay unchanged.

A deleted fact or curated member must immediately disappear from **all** ordinary point/pages, entries, state Collections,
Everything and Continue, Search, ItemList exports, sitemap discovery/output, public membership pairs/counts and any
existing feed. Personal facts have no independent public projection. Everything keeps a subject only while another
live state, label, session or holding fact supports it; entry removal is not full erasure. Collection deletion hides
all descendants through the parent even while cleanup is queued. Export/search/web adapters must recheck source
liveness rather than trust cached positives. Deferred feeds and saved queries are not new launch surfaces.

Only the currently authorized owner or an explicitly authorized deletion-state reader can read retained payload
for undo; ordinary owner reads also conceal it. References return at most `{id, kind, state: 'deleted'}` where the
viewer may know that identity. They never include deleted title, note, state value, label name, pins or private
fields, nor reveal a private record's existence to strangers. Unknown and hidden identities share not-found.
The shared policy's legal-hold rule does not add a first-public Library hold mechanism. Retained public reads still
apply the viewer-native `subject:read`, Collection authority and platform gates to each emitted subject.

Every delete, restore and replay checks current account state/scopes, resource authority and applicable gate
**before receipt lookup**; a cached success cannot authorize a revoked, suspended, other-account or anonymous caller.
Every ordinary page rechecks current source liveness and viewer authority. Reuse `command-support.ts`/`runCommand`,
`shareAccount` and existing Collection Access checks, not a fake positive Access or the active-only `trustedAccount`
runner as an invented account restore path. Bind the receipt to owner, target stable identity/incarnation, action,
expected record revision or generation when one exists, and canonical input. Authorized
same-key replay has one effect; stale CAS fails without mutation. Missing current authority conceals payload even
on replay. Retained deletion metadata must be reachable without the ordinary live-row pre-read.

Every new owner write must also pass `shareAccount` in its command transaction, serialized against the terminal account
barrier. After T, the barrier rejects new owner writes. Account cleanup runs as durable system work bound to the
deleted account and T; it does not impersonate an active human or invoke an active-only trusted-account command.

Undo checks uniqueness and CAS atomically. An entry replacement at the same owner/subject key, occupied member
ordinal after reorder, recreated label name, full Collection (5000), or live assignment cap (32) returns conflict
without overwriting newer facts, repositioning silently or allocating another identity. It may be retried with a
fresh key/revision after the conflict is explicitly resolved within the window. Tombstones do not count as live
capacity; restore must reacquire capacity. Profile absence blocks only NEW profiled values: clearing and deletion
remain allowed, and undo of the identical old pinned fact uses its stored accepted release, not today's profile.
It grants no authority to introduce new values under a missing profile.

Cursors remain live across pages, not cross-page snapshots. Recheck source deletion/generation on every page and
invalidate changed ordered bases using the shared cursor protocol; old cursors or delayed positive observations
cannot resurrect deleted values or overwrite a restored newer generation. After account deletion, late positive
consumer deliveries must also recheck terminal account state so they cannot recreate private facts. The current
listing worker reads source then releases its connection before target apply, with no monotonic compare in
`listing-apply.sql`. A receipt digest and DBOS workflow ID do not close that race. Reuse the shared listing freshness
contract's stamps/zero tombstones and reverse cleanup; an asynchronous zero alone cannot satisfy immediate public
count concealment.

### Bounded automatic purge and shared authority gaps

For an ordinary record tombstone, personal/private payload is automatically due at `restoreUntil`, without a platform
action or a new user request. Terminal account deletion is the explicit first-scope exception: account-private Library
payload is due at T, with no 30-day wait or account restore lifecycle. Use existing shared command/effects, DBOS and
queue surfaces with owner-specific indexed page adapters. This does not request or depend on a generic deletion
engine, custody registry, lifecycle state machine or replacement of shared owner history. `work/retention.ts`
collects terminal DBOS history by age and does not erase Library records; `work.ts` registers listing effects only.

A native runnable intent must survive commit-before-enqueue. Source selection takes **1 <= P <= 100 indexed source
rows before later eligibility filters**, including retained/ineligible rows and lookahead candidates, or uses a
proven partial due/pending index ordered by `(dueAt, route, targetId, generation)`. Advance after the last examined
source key, including ineligible rows; retained, future-due or otherwise ineligible predecessors cannot starve later
due work. Retain separate parent and child cursors. Each writing page has
bounded bytes, at most 100 source rows/effects and a finite command deadline; effects, generation/phase/sequence,
checkpoint, receipt and continuation intent commit atomically. Workflow segments contain at most 100 pages. Crash
before commit retries; commit-before-enqueue/ack redelivery uses native receipts. No OFFSET, broad
account/principal/JSON/history scan, whole-account arrays/counts, default cascade or unbounded distinct-subject walk.
Existing maintenance session and history keyset readers are reusable surfaces, not a purge implementation. Prove
bounded actual rows, bytes, blocks and statements at the specified geometric populations; counting only changed rows
does not establish a bound.

Every destructive page rechecks the authoritative record tombstone or terminal account state/T and due time in its
writing transaction, including after a pause/retry. Ordinary record work also checks `restoreUntil` or an explicit
early-purge grant. Account-private cleanup is eligible immediately at T and needs no platform grant or synchronous
consumer wait. First-public Library legal-hold support and release handling are deferred under the shared policy;
they are not prerequisites for this slice. Exhaust session units/history before their session and head, member rows
and acknowledged remote listing cleanup before Collection parents, and producer/reservation/dictionary references
before their parents.
Shared-policy skeletons retain only permitted identifier/type/relations/counts and tombstone; a private fact whose
skeleton identifies reading/ownership must be removed entirely. Completion requires indexed exhaustion and native
receipts, not an empty ordinary read, outbox checkpoint or DBOS success.

Missing production adapters and code paths (policy timing is settled by the shared contract):

- **Accounts and Library work:** terminal account deletion at T is the first-scope behavior. Accounts publishes
  `account-tombstoned.v1`; Library has no consumer. Bind each page to the terminal account row and T under the
  authoritative account lock, and enqueue bounded cleanup durably without making account deletion wait. Do not add
  account restore, an account restore window, an account-generation counter or an account-restoration event.
  Ordinary owner writes must take the `shareAccount` barrier; purge work must not impersonate an active human or
  invent a `trustedAccount` bypass.
- **Kernel lifecycle/work and command owners:** use existing `shareAccount`, `runCommand`, `registerEffects`, event
  checkpoints, DBOS and queue registration. Library and other owners supply indexed page adapters and exact-locator
  minimization for their receipt/outbox/workflow payloads under existing shared retention protocols. No generic
  deletion-contract/checkpoint/page/registry engine or legal-hold authority is an implementation dependency.
- **Search/web/listing and subject-fact owners:** live generation/disclosure witnesses, active-only counters and
  bounded reverse pair cleanup/stamps covering every apply path. Existing listing freshness and shelf/bulk
  protocols are reused; missing shared subject-fact APIs remain explicit dependencies.

### Account deletion

Account deletion is terminal at T. The account-delete result for this contract contains only `deletedAt`; there is no
account restore, account restore window, account-generation counter or account-restoration event/port. Ordinary
private/unlisted reads, exports, counts and producers must be fenced immediately at T, including workers before
any effect. Accounts owns one erasure coordinator with a fixed versioned participant list: Access, Auth, Library,
financial Commerce, content/media, community/ratings/notices, Semantic/Zones, Search, Imports, and shared history and
delivery. Library acknowledges actual complete cleanup or no applicable data, never dispatch. Minimal completion
persists in PostgreSQL outside DBOS history to prevent late resurrection. Financial Commerce acknowledges its own
retention/minimization separately. Accounts emits `account-tombstoned.v1`; Library's registered worker has no terminal
consumer/coordinator integration. Current active-account command checks do not establish complete read/producer
fencing: direct unlisted Collection eligibility lacks a deleted-curator check, and publication/listing cutover is
incomplete. Cleanup is asynchronous: no consumer wait, platform grant or 30-day delay precedes the T fence or private
cleanup. The general policy's hold rule does not imply a first-public Library hold path, which is
deferred and not a prerequisite for account cleanup here.

Account-retention and child-before-parent outcomes drain actual durable cleanup at unchanged T. They inspect native
rows and persisted work state; advancing 30 days is not part of account-erasure eligibility. Crash tests arm the
failure before account deletion, then restart against the same durable stores. Ordinary per-record tombstones retain
their independent 30-day undo deadlines and can never reopen a deleted account.

The retained Collection set is **only active PUBLIC Collections at T**. These Collections remain visible with
stable Collection/member identities and de-identified account attribution; no ownership transfer or new account
identity is created. Private, unlisted and already-deleted
Collections are withheld and their personal/private payload is erased by bounded durable cleanup from T, including
previously-public Collections whose visibility is private or unlisted at T. Already-deleted Collection graphs are
erased and produce no public output. Freeze a public dynamic
Collection's LAST COMPLETELY PUBLISHED GENERATION A; discard pending B and never evaluate a fresh query at T over
undisclosed private facts. Erase private query/source data. Curated output freezes its last published
occurrences/notes; keep stable identities and de-identified attribution, with no ownership transfer or new
publication. No unlisted Collection is retained. Published-log payloads and private source sessions are erased by
bounded cleanup from T; do not revive an unpublished or retracted snapshot. Account deletion cannot be restored;
independent record tombstones keep their original deadlines but cannot reopen a deleted account.

The existing privacy contact remains the assisted removal/data-copy channel; add no legal timetable or self-serve
export. Native completion and overall evidence custody are separate claims. The inventory below lists required
cleanup, not an implemented guarantee. Logs, caches, exports, replicas and backups lack a complete Library-specific
custody inventory and enforced erasure deadline; do not make a blanket physical-erasure claim while those boundaries
remain open.

### Ordinary label expiry

`purgeLabelRetentionPage({pool}, {partition, limit, after})` is private maintenance, called by the single
Library WorkModule's registered `library.labelRetentionSweep` UTC schedule every ten minutes. It needs no user
grant. Service clock injection follows Core's native time adapter; neither a cursor cutoff nor request time can
make a row eligible for deletion. Each actual write uses the owning Core partition fence and current account
share fence before examining the exact deletion episode. Account T wins; ordinary cleanup cannot restore or
reconstitute an account, and leaves terminal cleanup to its existing owner.

Discovery walks the sixteen routes of one physical partition, seeking the existing partial
`personal_label_purge_due` and `label_assignment_purge_due` indexes by exact route, original deadline and tuple.
There are at most thirty-two empty index seeks per page. Raw discovery plus selected child keys is bounded by
`limit` (1..100); parent/fence/CAS/absence metadata points are additional fixed indexed work. A returned cursor
uses at most 2048 bytes and the entire result at most 4096. An empty partition returns an exhausted null cursor.
Internal base64url cursors contain only version, partition/route, source kind, native cutoff, exact technical
identity/revision/deletion timestamps and child highwater. They never carry a name or public list authority.

A captured parent is rechecked and locked exclusively before its owner/label child keyset is read. Child identity,
revision, slot and deletion timestamps are exact CAS predicates. A live child of the deleted parent, or an
independently expired child, is removed; a later independently deleted episode retains its original window. The
parent remains only until indexed child absence permits its exact physical delete. A later sweep retries skipped
children; restore/redelete and admission/reclamation defeat old captured episodes. No slot is released in another
row and no retained metadata is recreated. Purging already-hidden rows does not advance `fact_source_head` again;
the delete hooks still invalidate physically deleted live facts under a live parent.

No new persistent field, row or index is introduced. A sweep segment runs at most 100 page steps and checkpoints
its small cursor in existing DBOS history; a deterministic maintenance-queue continuation carries an unfinished
frontier. Commit before checkpoint is safe to retry: all SQL predicates recheck source truth, and only a real
physical deletion emits the minimal private `label.retention-purged` event. There is no user command receipt or
new permission on this internal path. Existing catalogue/assignment command receipts remain with their producers.
Shared copies added here are owner/label IDs in the Core outbox event and exact technical cursor keys in DBOS
workflow input, output and step history. The event declares the actual shared-history personal subject contract.
Their owners must minimize these private identities through shared custody; workflow age alone is not erasure and
missing durable-work custody stays pending. No new account-erasure participant or NoData acknowledgement is added.

Native tests cover original expiry, child pages, source/commit crash cuts, stale parent and assignment episodes,
slot reuse, account T and fixed-page growth including raw SQL, control, SDK, bytes and occurrences. These outcomes
prove ordinary local expiry; the terminal inventory below still owns all live/deleted rows and incomplete shared
custody. Full label HTTP/generated-client adoption belongs to the catalogue/assignment command slice.

#### Retention inventory

The account-owned native rows below live on the owner's route unless stated otherwise. Account deletion has no
account-wide Library cascade. The current schema and the shelf/bulk contracts include applied rows and planned
logical stores; a planned name without an applied table or exact locator is an implementation gap, not covered by
workflow history.

The applied private `owner_write_counter` (`seq`) and live/archive `owner_write_seq` fields are also terminal
inventory; their complete participant cleanup remains unimplemented. T fences their state writers immediately.
Bounded Library participant cleanup erases ordering metadata after dependent private facts; fenced late repair must not recreate it. This counter is neither an account
lifecycle generation nor a public activity total. Existing `fact_source_head` removal remains last after delete hooks.

This A5 inventory also includes every planned OWNER candidate/support directory and inverse, pin-set/sibling
support, private change positions and retained old/new/parent-range repairs, dependency registrations, bootstrap
frontiers/CAS controls, ordered prepared results, operational derived records/intents and identity first-apply/
OLD-removal/NEW-addition/fence/ACK custody. Native specifications must name each actual table/key and exact native
transactionId+component/job/epoch/version/scope and workflow/input/output locators, including all prior pages and
concurrent registrations. No invented table name or follow-only completion counts as whole-role coverage.
Fence every producer/apply at T; erase child work before parents and heads/counters after hooks cannot recreate them.
Core/DBOS intent artifacts belong to actual shared-history custody, not a Library JSON scan or extra intent store.
Missing native producer, redrive, reclamation or store-owner ACK proof stays pending; empty Library rows do not
establish shared payload erasure. Public complete A retains fixed membership/current disclosure; pending B cannot
complete from private facts. The [owner plan](../../../../docs/library-owner-queries.md#shared-operational-identity-and-disclosure-producers)
owns the design, while this inventory must gain exact native locators with each implementation cut.

| Native data                                                                                                                                                                        | Required cleanup and current gap                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collection`, `collection_member`, `collection_listing_history`                                                                                                                    | Classify only active-public output at T for de-identified retention. Erase private/unlisted/deleted graphs and obsolete listing history; historical public status never grants retention. Exhaust member/canonical/remote children before erased parents. Tombstone/restore DAOs do not provide terminal classification or cleanup.                |
| `entry`, `entry_deleted`, `copy`, `follow`                                                                                                                                         | Erase live and archived entry episodes, every copy and follow state/reason. Exact archive/due selectors exist, but no complete registered terminal adapter. Entry/copy/follow removal alone is not whole-graph erasure.                                                                                                                            |
| `progress_session`, `progress_unit`, `progress_change`, `progress_head`                                                                                                            | Erase active/completed/abandoned sessions, units, all history and heads, including orphan heads. Exhaust children before sessions/heads; maintenance pages alone are not purge.                                                                                                                                                                    |
| `personal_label`, `label_assignment`                                                                                                                                               | Erase definitions, assignments and all live/inactive reservations, children before parent. Retained metadata and assignment-admission DAOs do not implement account cleanup.                                                                                                                                                                       |
| `shelf_type_reservation`, `shelf_type_node`, `shelf_type_root`, `shelf_type_value`, `shelf_count`; `type_preparation_header`, `type_preparation_progress`, `type_preparation_slot` | Fence preparation/publication; erase all staging, partial/orphan tries, zero-use values, pins and counters. Progress/slots precede headers/values; nodes/roots precede values. No whole-graph terminal worker supplies this ordering.                                                                                                              |
| `builtin_collection_reference`, `builtin_state_reference_source`; candidate/support data                                                                                           | Fence late repair and remove source children before reference/support parents; erase private discovery data. A proposed candidate/support representation has no current complete producer/cleanup guarantee.                                                                                                                                       |
| `canonical_source_state`, `canonical_source_fact`                                                                                                                                  | Erase every obsolete, old, building and private generation, not only the current pointer. Keep only selected permitted published output A; pending B never survives. Tables exist but store factories throw and implement no cleanup.                                                                                                              |
| `subject_collection`, `subject_collection_version`, `subject_listing`, `subject_collection_source_fence`                                                                           | Use exact Collection reverse indexes on remote subject routes; remove/reconcile pairs, versions, counts and fences without touching other public contributions. Preserve necessary anti-replay evidence until late applies are fenced. Current listing work lacks terminal cutover.                                                                |
| `bulk_target`, `bulk_effect`, exact operation/selection locators                                                                                                                   | Erase manifests, request/target/effect/outcome and receipt payload for every owned operation. `pageBulkOutcomes` needs a known operation; current tables lack an account-leading complete locator. Planned operation/selection stores also need producer locators; JSON/history scans are forbidden.                                               |
| `published_log`                                                                                                                                                                    | Erase published and retracted snapshots and personal links/payload at T; no active log contribution is retained. A nullable source pointer is not terminal erasure.                                                                                                                                                                                |
| Shared receipts/outbox/editorial/work artifacts and cleanup state                                                                                                                  | Producers record exact receipt/event/workflow/payload locators; each store owner minimizes actual private payload and acknowledges completion. Remove nonminimal staging/checkpoints only after dependent phases finish; keep minimal terminal completion independently of DBOS retention. Dispatch or age-based history deletion is insufficient. |
| `fact_source_head`                                                                                                                                                                 | Remove LAST, after producer facts and derived work are fenced/exhausted: native fact-delete hooks can recreate this owner head. Its existence is not candidate completeness or permission.                                                                                                                                                         |

Cleanup must use bounded, indexed native phases with child-before-parent ordering and durable receipts/cursors; a Collection tombstone, terminal flag or empty account-local read is not proof that children and remote listing pairs are gone. Proposed page bounds have not been measured here. The [listing freshness contract](listing-freshness-contract.md#bounded-storage-purge-and-delivery) records the stale-positive projection race and fencing requirement.

Library cleanup does not run broad SQL over shared stores. `core.receipt` can retain command request/response payloads; `core.outbox` must keep tombstone and projection events deliverable until durable custody is established; `core.consumer_checkpoint` is a shared stream position, not per-account state. `editorial.write_basis` and DBOS status/input/output/step/event/message histories follow their owners' retention and minimization rules. Existing age-based workflow history collection does not establish Library erasure. Exact event, receipt, workflow and payload locators, account-specific cleanup and some consumer-custody acknowledgements are still missing; do not delete shared stores by broad principal or JSON scans. No claim extends beyond the demonstrated native locators. Logs, caches, exports, replicas and backups remain explicit custody gaps.

Logs, caches, exports, replicas and backups have no complete Library-specific inventory or enforced account-erasure deadline. These are explicit custody gaps. A tombstone, `state = 'deleted'`, or exhaustion of Library-native rows does not support a blanket physical-erasure claim while those gaps remain. See the [Access deletion policy](../access/README.md#account-deletion-policy) and [Access retention inventory](../access/README.md#retention-inventory) for the shared authority boundary and shared-store coverage; the detailed Library table/locator inventory remains here.

### Audit evidence and implementation handoff

The applied delete SQL, not method names, establishes the gaps above: `entry-store-entry-delete.sql`,
`entry-store-copy-delete.sql` and `collection-store-collection-member-delete.sql` issue DELETE; the member CTE decrements `member_count`. `collection-store-collection-tombstone.sql` only changes
state, revision, source generation, transaction/update time and deletion/720-hour expiry metadata.
`personal-routes.ts` pre-reads entries/copies before delete; `published-logs.ts`
snapshots session values and retains an exact private Undo episode. `collection-reads.ts`, `views.ts`, the member/entry/log page SQL,
`sitemap-page.sql`, `listing-source.sql`, `listing-apply.sql`, `listing.ts` and `work.ts` were inspected: Collection
reads gate active state, sitemap uses an active/public partial index, listing source/apply is asynchronous and
unstamped, and the registered worker has no restore/purge consumer. `maintenance-session-page.sql` and
`maintenance-history-page.sql` provide indexed page shapes, not deletion. The current label contract already
defines original-deadline undo and effective reservation capacity; labels have no profile pin. Its native DAOs do
not establish route/receipt integration or whole-graph cleanup.

`specs/library-deletion-driver.ts` specifies real production HTTP/native seams and persisted inspection/SQL evidence.
Every case in `specs/library-deletion-outcomes.test.ts` requires the exact absent-driver marker; pure fixture checks
live separately. The verifier proves only that missing-runtime acceptance is honestly red, never native success.
The retained-entry table/due DAO and Collection deletion/restore DAOs exist; ordinary lifecycle command/route wiring,
due-purge runtime, terminal account full-graph cleanup and the public contribution provider remain incomplete.
Measurements use 256/1024/4096 rows, actual examined source keys/SQL plans/shared blocks/statements, fixed P, and
ordinary retained/future-due/ineligible predecessor rows. Counting only returned/deleted rows is insufficient.
Native page receipts, child/parent checkpoints and stale-generation guards must remain inspectable after crash/restart.

Implementation follows the existing command/effects/DBOS surfaces with owner-specific indexed pages, never a new
Library deletion engine. The [native terminal review](../../../../docs/research/library-terminal-native-implementation-review.md)
is graph/locator evidence; its older retained-log recommendation is superseded here by published-log erasure.
Completion requires each phase and shared store-owner acknowledgement, not dispatch, empty ordinary reads or an
entry/copy/follow-only purge. Current coordinator integration, full native graph pages, public A freeze and exact
shared-payload minimization remain unimplemented.

### Projection freshness

The [listing freshness contract](listing-freshness-contract.md) specifies monotonic source stamps and public-history
zero tombstones for the existing public Collection projection. The
[account-retention report, steps 4–5](https://github.com/rezics/rezics-next/blob/a1d0b76e4975daa2cbdbd5f172d0f72039d91252/docs/research/library-account-retention.md)
records the delayed-positive race and later purge's reverse-index/fence needs. Never-public private/unlisted zeros
must leave no subject-partition holder state. The typed ports are proposals and the native outcome suite remains red
without its real driver; this specification does not change the implementation; the account section above fixes first-public retention.

## Bulk library operations

The common Collection bulk contract requires preview and execution to bind the same admitted filtered or selected
population, including curated and built-in/state sources and permitted mounted use. Reject stale selection; replay
cannot duplicate effects; inspectable private outcomes retain changed, unchanged and partial failures. No terminal
summary is valid while selection is incomplete or any target is unresolved. Public candidate totals are not a preview.

The existing [bulk contract](bulk-contract.md) specifies explicit targets and entry-query discovery, a frozen private
manifest and per-target receipts; its typed/storage surfaces do not establish the shared filtered-selection runtime.
Its discovery-time population alone cannot stand in for a bound common preview. Adapt that same durable operation
and the shared admitted source rather than adding another workflow, manifest or export ABI here. Browser layout,
sort and page cursor do not silently redefine the confirmed selection.

Bulk add skips a subject already present in the target Collection and appends at most one occurrence for each missing subject in that operation. Ordinary Collection membership still permits duplicates. Subject-based removal captures every matching occurrence before effects and removes only those member IDs; later additions survive. Removing an item from the library deletes only its entry. Progress sessions and history, copies, follows and Collection members remain. The confirmation says that only the library entry is removed; full erasure is a separate explicit action.

The operation is private. Its routes use the existing `personal_library` gate; operation reads also require `library_entry:list`. Status changes use `library_entry:update`, library removal uses `library_entry:delete`, and Collection membership changes use the target's `collections` gate, `collection:update` and the installed Collection permission. Collection additions also run the existing `subject:read` checks. Every target attempt and replay restores the captured durable initiator and rechecks current source and target authority. Enqueueing is not a completed outcome.

### Type filter identity

Shelf facets return `{types: [{type: fullCURIE, count}], next}` and shelf list/summary requests accept
`type=fullCURIE`. Web retains the exact CURIE/IRI in its URL and saved per-type preference; no extra resolution request
or public UUID key is needed. Unknown, foreign-account or stale values return `400 invalid_argument`, so web drops the
filter and rereads. A retained known value with zero entries remains valid: the list is empty and shown counts are zero.
Read lookup never allocates an identity.

Exact ASCII source values have no per-identifier character or byte cap. The release-wide size bound is not a type limit.
Full values live in unindexed private dictionary storage in the owner's partition. SQL predicates, counters and opaque
cursor bindings use a stable account-scoped UUID `typeId` resolved by exact equality. This internal identity is immutable,
one-to-one and never reused, including after its count becomes zero; it grants no authority and is never a public filter.
Digest hits require full-value equality; collisions use bounded exact chunk-trie edges, never digest aliases or an
unbounded collision scan. Facets seek by that private UUID and return every byte of each emitted CURIE, within both row
and response-byte budgets. See [the shelf contract](shelf-contract.md) for the resolver, continuation and erasure plan.

## Curated occurrence ordering

Ordering keys are fractional-indexing keys. Keys are generated within 32 characters and stored within 48. They are stored with `COLLATE "C"` and are unique on `(route, collection_id, ordinal_key)`. That unique constraint is deferrable. A respace happens when no generated key fits. A respacing in the same command increments `orderEpoch`, which makes earlier cursors stale. A new Collection starts at epoch 0. Member cursors seal `orderEpoch + 1` because the seal rejects epoch 0. A mismatch is `stale_cursor`.

## Shelf reads

These entry/shelf requirements are a compatibility surface, not the Everything or Continue implementation. State
filters are not mandatory navigation tabs. The shared Collection page replaces this surface only at an explicit
consumer cutover; profile consumers own retirement of the private type dictionary/trie/preparation machinery.

The [shelf UI study](../../../../docs/research/library-shelves.md) and
[backend activity report](../../../../docs/research/library-shelf-activity.md) support these module requirements.
[UI Shelves](../../../../packages/ui/README.md#shelves) owns controls and layouts. Adoption here establishes the
kernel contract; implementation completion and growth evidence remain separate work.

`GET /v1/libraryEntries` must serve a private, account-local page with progress for 48 cards in one read. Embed a
nullable active session using exactly the existing BASIC session DTO in [progress-routes.ts](./progress-routes.ts):
`id`, `subjectId`, `versionSubjectId`, `mode`, `unit`, `total`, `amount`, `locator`, `position`, `completedUnitCount`,
`state`, `revision`, `startedAt`, `completedAt`. Storage routing, account and transaction IDs are excluded. Preserve
decimal strings and nulls: `scalar_amount` retains amount and optional total; `cursor_position` retains its locator
and position without an invented total; `completed_units` uses the maintained sparse `completedUnitCount`, without
enumerating units or treating their largest identifier as a denominator. No mode requires history enumeration.
No active session means null, never a terminal session or fabricated zero progress.

Maintain `lastActivityAt` as the maximum of the entry change and that subject's progress change in the account
partition. A retained account/subject progress head survives entry deletion. Accepted start, record, complete and
abandon revisions advance activity, including accepted records with no net value change; receipt replay, rejected
CAS and rolled-back writes do not. Progress updates the head and at most an existing entry's activity atomically;
it never recreates deleted membership or changes entry state, revision or update time. Entry creation/recreation
combines its own change time with the retained head. Entry and progress commands share a head-first lock order and
monotonic maximum rule, so concurrent creation and progress cannot lose the later activity time.

Select the displayed session separately: among active sessions for the exact account and subject, choose the greatest
session change time, then session ID ascending. Multiple active sessions remain legal, and the winner need not be
the newest-started session. Terminal changes still contribute to `lastActivityAt` even when another active session
is displayed. Use an active-session index and bounded top-one probes for the page, rather than searching session
history. Historic abandonment times absent from storage remain unknown; migration time cannot stand in for them.

Last-activity, date-finished and date-added keyset reads need indexes matching the account, applicable status/type
filters and ordering. Status/type-filtered tab counts and facets use maintained private counters. Do not sort or
recount a growing library or progress history to serve a page. The shelf interface contract owns exact query names,
defaults, finish-date/null semantics and type projection details. Requests without shelf additions retain the
existing list envelope and fields. A source's primary type can change: its maintained type key follows anchored
source re-reads and source revision ordering, rather than a permanent snapshot. Raw `readItemTypes` grants no Access
permission; displayed subject summaries still use authorized summary reads. An unavailable summary does not justify
an unbounded search for replacement cards or deletion of private membership/progress.

Activity timestamps and ordering reveal progress even without embedded values. Shelf mode therefore requires both
`library_entry:list` and `progress_session:list`, and both `personal_library` and `reading_progress` gates, with live
own-account authorization. Existing entry-only reads retain their independent capability. Personal state stays out
of public full text, public counts and the subject membership projection, and shelf responses use private caching.

Read entry activity and active-session selection in one request snapshot. Preserve the exact stored timestamp
precision and stable subject ID in cursor positions; converting seek keys through JavaScript `Date` loses finer
precision. Pagination across requests is live, without a retained historical snapshot: moving keys may cause missed
or repeated subjects until refresh. Use the accounts-owned `src/tokens/list-cursor.ts` async
`encodeListCursor`/`decodeListCursor` API with the existing kernel token key ring and required kernel-clock `Date`.
Bind route, viewer and the entire effective query, including page size, as associated data, and retain partition
epoch validation. Library owns no cursor cryptography.

## Sitemap feeds

The [partitioned-sitemap research](../../../../docs/research/partitioned-sitemap-feeds.md) supplies the adopted
partition-major immutable seek design. `GET /v1/sitemap/collections` accepts `cursor` and `limit` from 1 to 1000,
defaulting to 1000, and returns `{items: [{id, lastModified}], next}` as defined by the shared content schemas.
This is a bounded JSON discovery feed; downstream sitemap generation consumes it until `next` is null.
The public route uses the shared public read rate limit. Omitting `cursor` starts a walk; an empty string is invalid,
as in the content feeds. Malformed, foreign or unauthentic continuations answer `invalid_cursor`.
Before discovering candidates, the shared collections-group admission checks the anonymous reader. A closed group
returns `{items: [], next: null}` without candidate discovery or a checkpoint, including for bearer callers.
Dependency and deadline failures propagate as unavailable responses rather than empty pages or candidate denials.

Walk partitions in numeric order and seek ascending `(route, collection_id)` within each partition's sixteen-route
interval, using the active/public partial index. IDs and routes are immutable seek keys; mutable timestamps, titles
and curator fields are not traversal keys. Public candidate discovery is only a hint. Before emitting each item,
require current active/public Collection flags and affirmative live anonymous Access, including its platform gate,
even when the caller supplies a bearer. Unlisted, private, deleted and closed Collections never qualify. Profile
Collections-view settings add no veto to an otherwise anonymously readable public Collection. Do not enumerate
personal library state or members.

For requested limit `L`, fetch at most `4L` candidate identities and visit at most four discovery partition intervals
per page. These are separate budgets; fetched lookahead and any unprocessed suffix consume the candidate budget.
Process candidates in seek order, advancing the checkpoint after each processed candidate, including rejections,
and stop at `L` emitted items or a budget. Resume after that processed prefix, never after an unprocessed prefetched
suffix. A short discovery batch proves exhaustion only when every fetched candidate has been processed; a full batch
does not prove exhaustion. Retain an explicit exhausted-partition marker so empty partitions still advance without
an unbounded per-address loop or a request scanning all empty partitions. Short or empty pages can carry `next`;
only established exhaustion of the final partition returns null. Preserve the checkpoint partition's epoch,
including on exhausted markers, and validate it on resume. Partition moves and unavailable authority retain normal
availability/stale-cursor behavior rather than being treated as empty partitions.
Revalidating a resumed exhausted marker counts toward the four visited partitions. An otherwise empty catalogue
therefore makes bounded progress over several requests; a non-null cursor does not promise a remaining item.

Return `lastModified` from the current `collection.updated_at` observed with disclosure. Existing Collection and
member write paths maintain it; this contract adds neither a new write update nor a synthetic generation timestamp.
It does not claim to cover every external subject-rendering change. Traversal is live across requests: insertion or
publication behind the checkpoint may wait for a fresh walk, and cursor replay can observe different current state.

Keep the complete seek position confidential through `src/tokens/list-cursor.ts` WebCrypto AES-GCM, using the shared
async API and required kernel-clock `Date`. Associated data binds `route: 'GET /v1/sitemap/collections'`,
`viewer: null` and the effective query including limit. Use the existing `KERNEL_SESSION_KEYS` rotation: the current
key issues cursors, retained keys decrypt them, and retirement invalidates cursors under that key. Anonymous
continuations are deterministic and timeless under the shared helper's `viewer: null` policy, including when
the request carries a bearer. The account-viewer lifetime does not apply to this feed. The trusted server decoder
recovers the checkpoint; confidentiality protects its representation on the wire and its associated-data binding.
Signed-only cursors and Library-local AES/HMAC wrappers do not satisfy this contract. `sitemap-position.ts` only validates and
maps the typed checkpoint through the shared helper; it implements no cryptography. This shared helper supersedes
the research's open token representation question. See [Opaque list cursors](../../README.md#opaque-list-cursors).

## Cost

These are derivations from the library commands, SQL, `db/library/schema.sql` and `db/library/migrations/`, not measurements or guaranteed PostgreSQL plans.
`N` is total rows of the relevant relation kind; `P` is rows of that kind in an anchor's partition.
`L(N) = O(log(2+N))` shared blocks for a B-tree probe, with constant rows examined for a unique key; `k` indexed changes cost `O(k L(N))` blocks.
Bounds distinguish rows examined (`R`), shared blocks (`B`) and SQL statements (`S`). A subsection excludes the command envelope and authorization unless it adds them.
Library primary keys are B-trees beginning with `route`.
`M` is the member count of one Collection and is at most 5000. Mounted pages use `s` at most 100. One progress record names at most 100 unit ids. A session's completed-unit count is at most 20000. History length is not capped by that number.
`listing-counts.sql` is the search reader. One statement probes `subject_listing` by primary key, `LIMIT 1`, once per supplied id in one partition. No library growth test measures that reader, so this Cost section does not cite it.
Where a named test does not call the operation, or does not grow the rows that operation can touch, the subsection says so. A bound the indexes do not support is stated as not derivable.

### Built-in membership and indexed filtering (required; runtime incomplete)

- Touches: private owner-partition candidate/native fact indexes, effective label parents, admitted catalogue indexes,
  current disclosure anchors, prepared results and canonical identity-epoch maintenance in bounded durable steps.
- Bound: derive each admitted plan's row, statement, buffer and byte allowances, including native authority, metadata,
  duplicate histories, stale labels, rejected candidates and background work. No account/history scan, free witness
  work, universal candidate multiplier or universal raw-key budget. Direct page-bounded execution, prepared indexed
  results or rejection before enumeration must preserve filled/final pages or preparing.
- Growth check: actual first/deep pages under
  [the shared three-scale checks](../../../../docs/filtered-lists.md#three-scale-checks), with duplicate histories, stale label parents
  and sparse filters are required. Native helpers and existing curated measurements below do not supply these
  results. Complete built-in/filter runtime and these measurements are missing; no native check ran for adoption.

### Terminal whole-graph cleanup (required; runtime incomplete)

- Touches: every indexed participant-owned child namespace in the retention inventory, exact cross-store private
  payload locators and fixed coordinator acknowledgements, including all old/building private generations.
- Bound: bounded child-before-parent pages/checkpoints and finite workflow segments through existing durable work;
  no cascade, broad principal/JSON/history scan or completion before all phases/store owners acknowledge. Remove
  `fact_source_head` last after delete hooks can no longer recreate it. The ordinary purge page bounds above remain
  requirements, not measured terminal execution.
- Growth check: native whole-graph exhaustion, immediate private/unlisted read/export/count concealment, crash/replay,
  public COMPLETE A versus pending B, producer races and no resurrection are required. Full graph/coordinator and
  exact shared-payload cleanup coverage are absent; entry/copy/follow-only evidence cannot establish them.

### Owner state-write order (required; runtime incomplete)

- Touches: one owner-partition counter primary-key update/lock plus the addressed entry/archive and existing account
  authorization, receipt, source hooks and outbox transaction; no global counter or owner-history scan.
- Bound: constant native counter rows/statements per actual state write plus indexed depth, including initialization,
  bigint fields, rollback and contention. Serializes only that owner's state writes; no free ordering metadata or
  hidden `noEffect` mutation. The [delivered allocator's cost and primitive captures](owner-write-sequence.md#cost)
  remain separate from whole-command evidence. Entry put, retained clear and Undo integrate the allocator;
  their whole-command measurements below include it.
  Every changed fact row also pays [automatic invalidation work](owner-fact-version.md#cost), including a separate
  sequence-stamp UPDATE. One allocator increment is not a bound of one head increment.
- Growth check: require native same-kernel-time writes across two merged originals, concurrent same/different owners,
  clear/Undo fresh order, denied/CAS/replay/overflow rollback and terminal no-resurrection, with three-scale
  owner/entry/history captures. The entry lifecycle checks below cover clear/Undo fresh order, rejected/replayed
  envelopes and live-slot contention. They do not establish every state writer or the terminal graph obligation.
  [Filtered lists](../../../../docs/filtered-lists.md) retains ownership of filter-plan numeric budgets.

### Command envelope

- Touches: Every library `runCommand`. An attempt starts a serializable transaction, sets the lock timeout and the statement timeout, reads time with `transaction_timestamp()` and no relation, runs authorization, and probes at most one `core.receipt` by `(partition_no, principal_kind, principal_id, command_kind, idempotency_key)`. The fence is one statement. It updates one `core.partition` primary key, inserts one `core.outbox` row per event, zero or one `editorial.write_basis`, and zero or one `core.receipt`. Library bodies emit one event, or two when a public Collection also emits `listing.changed` or an in-progress entry also follows. A matching receipt commits and skips the body and the fence. Listing sync supplies no receipt, write basis or authorization callback; source versions provide its replay ordering. Own-account, trusted-account and Collection commands set a 5 second deadline. Listing sync shares one 2 second deadline across command and operational attempts. Contention retries are deadline-dependent, not a fixed count.
- Bound: Here `k` is 1 or 2. Per attempt `R` is `O(1+k)`, `B` is `O((1+k) L(N))`, and `S` is `O(1)`. Replay omits the body and the fence writes.
- Growth check: `test/library/collections.test.ts`: `create cost stays constant as unrelated collections grow`. That check classifies the whole command, envelope included, as logarithmic rows and blocks and constant statements while unrelated Collections grow at 1, 8 and 64. It does not vary `k` or the deadline.

### Authorization

- Touches: `ownAccount` reads one `access.account` primary key and checks kind, active state, fence, authentication epoch and the request scope in memory. `trustedAccount` reads the same account row for `library:account-command` and does not consult a caller scope list. Collection create adds `parentCreationAuthorization` for `collection:create` on the curator account. That validation reads the account again, and one initialization statement writes access rows. The standing-grant list is empty. The statement inserts one `access.resource_initialization` row and one owner grant `library.collection.owner`. Collection update, delete and member commands use `resourceAuthorization` for `collection:update` or `collection:delete`. Prepare reads the Collection primary key through `visibleCollection` on another connection and runs the Access check. The command transaction then authorizes in memory. A private Collection is hidden from anyone who is not its curator. Entry, copy, follow, progress and published-log commands authorize by the account row and scope, not by a per-row grant. Several also call `readAccount` once before the command. Subject, Collection and Space reads use `subject:read`, `collection:read` and `space:read`. Listing sync passes no authorization callback. The permission-check shape is the Access cost in `src/access/README.md`. A subject resolve also uses the semantic read in `src/semantic/README.md`. This section does not re-derive those probes.
- Bound: Each account or Collection anchor point is `R` `O(1)`, `B` `O(L(N))` and `S` `O(1)`, plus the Access preparation and permission-check bounds for that invocation. Initialization is one statement and two result rows. The temporal owner-grant exclusion check is not a B-tree `L(N)` probe.
- Growth check: `test/library/collections.test.ts`: `create cost stays constant as unrelated collections grow`. The whole command includes own-account authorization and does not isolate Access probes. `test/library/subject-anchor.test.ts`: `subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow`. Resolve rows and statements stay constant and blocks stay logarithmic. Page cost grows with the input id count.

### Create Collection

- Touches: The curator's partition. Inside the command, parent-creation prepare runs on the writer pool, then one Collection insert, one creation-proof primary-key read that includes `xmin`, and one initialization statement. A public Collection emits `collection.updated` and `listing.changed`. Any other visibility emits only `collection.updated`. Both events use the Collection id as `subject`.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus parent-creation Access checks, own-account authorization and the envelope. The GiST exclusion check on the owner grant is not included in that block bound.
- Growth check: `test/library/collections.test.ts`: `create cost stays constant as unrelated collections grow`. Whole-command rows and blocks are logarithmic and statements are constant as unrelated Collections grow. The check does not separate the body from the envelope.

### Update Collection

- Touches: One active Collection primary-key read and one compare-and-swap primary-key update of title, description or visibility. `listing.changed` is emitted only when active-and-public listed-ness changes. The event subject is the Collection id. Members are not rewritten.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus Collection authorization and the envelope. Independent of `M`.
- Growth check: `test/library/collections.test.ts`: `update cost stays constant as unrelated collections grow`. Whole-command rows and blocks are logarithmic and statements are constant at unrelated scales 1, 8 and 64.

### Delete Collection

- Touches: One active Collection primary-key read and one tombstone primary-key update. Members remain. `listing.changed` is emitted only when the Collection was actively public. The event subject is the Collection id. This command does not delete pair rows.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus `collection:delete` authorization and the envelope. No member fanout in this command.
- Growth check: `test/library/growth-collections.test.ts`: `Delete Collection has constant rows and statements as collections and its members grow`. Whole-operation rows and statements are constant and blocks logarithmic at scales 1, 4 and 16, including authorization and the command envelope. Other accounts' and the curator's own other Collections and members, Access rows, receipts, outbox and write-basis rows grow by 500 x scale per partition; each probe Collection has 250 x scale members (250, 1000 and 4000). Every run uses a fresh probe and idempotency key.

### Add member

- Touches: Subject resolve starts before the command. Inside: one active Collection read, one neighbour read, and, when no generated key fits, one `listMembers` of at most 5000 rows and one respace statement. Keys are generated within 32 characters and stored within 48. The neighbour statement seeks at most one before key and one after key on the ordinal unique key, plus the named after-member when the position is after. Respace increments `order_epoch` when `member_count` equals the requested set and rewrites those members in the same statement. The insert statement then bumps `member_count` while it is below 5000 and inserts one member. The 5001st member writes nothing. The event subject is the Collection id. Respace does not itself emit `listing.changed`.
- Bound: Fitting key: library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus one subject resolve, authorization and the envelope. Respace of this Collection examines and rewrites `M` member keys, `M` at most 5000, so that path is `R` `O(M)` and `B` `O(M L(N))` on top of the fitting-key reads.
- Growth check: `test/library/growth-members.test.ts`: `Add member with a fitting key has constant rows and statements as its Collection and unrelated data grow` measures the whole command at scales 1, 4 and 16, seeding 250, 1,000 and 4,000 members in each probe Collection and 500 unrelated rows per touched library relation in both the measured and other partitions. `test/library/collections.test.ts`: `add cost stays constant as unrelated collections grow` also measures the command while unrelated Collections grow. `test/library/collection-store.test.ts`: `respacing 500 members rewrites one Collection in one statement and preserves order` covers the separate respace path. `test/library/subject-anchor.test.ts`: `subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow` covers subject resolve.

### Move member

- Touches: One active Collection read and one neighbour read. A fitting key updates one member primary key and touches the Collection primary key. When no generated key fits, the command lists at most 5000 members, respaces them, then lists at most 5000 members again to return the moved row. Keys are generated within 32 characters and stored within 48. The event subject is the Collection id.
- Bound: Fitting key: library body `R` `O(1)`, `B` `O(L(N))`, `S` 4, plus authorization and the envelope. The respace path adds two lists of `M` rows and one rewrite of `M` keys, `M` at most 5000, so `R` `O(M)` and `B` `O(M L(N))`.
- Growth check: `test/library/growth-members.test.ts`: `Move member with a fitting key has constant rows and statements as its Collection and unrelated data grow` measures the whole command at scales 1, 4 and 16, seeding 250, 1,000 and 4,000 members in each probe Collection and 500 unrelated rows per touched library relation in both the measured and other partitions. `test/library/collections.test.ts`: `move cost stays constant as unrelated collections grow` also covers a fitting-key move as unrelated Collections grow. `test/library/collection-store.test.ts`: `respacing 500 members rewrites one Collection in one statement and preserves order` covers the separate respace path.

### Note member

- Touches: One active Collection read, one member primary-key note update, and one Collection touch. The note is at most 1000 characters. The event subject is the Collection id. Listing rows are unchanged.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus authorization and the envelope.
- Growth check: `test/library/growth-collections.test.ts`: `Note member has constant rows and statements as collections and its Collection's members grow`. Whole-operation rows and statements are constant and blocks logarithmic at scales 1, 4 and 16, including authorization and the command envelope. Other accounts' and the curator's own other Collections and members, Access rows, receipts, outbox and write-basis rows grow by 500 x scale per partition; each probe Collection has 250 x scale members (250, 1000 and 4000). Every run uses a fresh probe and idempotency key.

### Remove member

- Touches: One active Collection read and one statement that deletes the member primary key and decrements `member_count`. The event subject is the Collection id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus authorization and the envelope.
- Growth check: `test/library/growth-collections.test.ts`: `Remove member has constant rows and statements as collections and its Collection's members grow`. Whole-operation rows and statements are constant and blocks logarithmic at scales 1, 4 and 16, including authorization and the command envelope. Other accounts' and the curator's own other Collections and members, Access rows, receipts, outbox and write-basis rows grow by 500 x scale per partition; each probe Collection has 250 x scale members (250, 1000 and 4000). Every run uses a fresh probe and idempotency key.

### Collection read

- Touches: `collection:read`, with public eligibility. Eligibility reads the Collection primary key once into a sink, and the load does not read it again when that sink has seen the row. A repeatable-read transaction may also read the viewer account. Public and unlisted rows are returned. A private row is returned only to a live grant-capable curator.
- Bound: The Collection point is `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the account read when the viewer is an account, the Access check, and begin and commit.
- Growth check: `test/library/growth-collections.test.ts`: `Collection read has constant rows and statements as collections and its members grow`. Whole-operation rows and statements are constant and blocks logarithmic at scales 1, 4 and 16, including authorization. Other accounts' and the curator's own other Collections and members, Access rows, receipts, outbox and write-basis rows grow by 500 x scale per partition; each probe Collection has 250 x scale members (250, 1000 and 4000). Every run uses a fresh probe.

### Curator list

- Touches: One `readPublicViews` account probe outside the page transaction hides the list when Collections are off, except for the existing live curator identity check. A hidden list skips the page read. Otherwise, the partition epoch read and `collection-reads-curator-public.sql` on `collection_curator_public_page`, or, for a live grant-capable curator with `collection:read`, the account read and `collection-reads-curator.sql` on `collection_curator_page`. Both statements page active Collections by `updated_at DESC, collection_id DESC`; the public statement also requires public visibility. Their literal predicates match the partial indexes under a generic plan. Each of the two `LIMIT` branches is one index range scan, at most `s + 1` rows, `s` at most 100. The final timestamp order allows a lazy merge of the branches; the exact UTC text remains the cursor key. The repeatable-read transaction still reads the partition epoch. `collection_curator_listing` remains for the store helper ordered by `collection_id`.
- Bound: `R` `O(s)`, `B` `O(L(N) + s)`, `S` constant, including the partition read, begin and commit, and the account read when a full view is considered. For `N` Collections in the partition, the bound is independent of how many Collections the curator has in any visibility or state.
- Growth check: `test/library/growth-curator-list.test.ts`: `a curator's public Collection page examines a constant number of rows as the curator's private, unlisted and deleted Collections grow`; `test/library/growth-curator-list.test.ts`: `a curator's own full Collection page examines a constant number of rows as the curator's deleted Collections grow`. Set-based seeding grows one curator's Collections at scales `[64, 256, 1024]`, one quarter each public, unlisted, private and deleted. `checkGrowth` measures the public first and cursor pages as another account and the curator's full first page, all at limit 20 with the default warm-up, constant rows and statements, and logarithmic blocks.

### Account public Collections

- Touches: One `readPublicViews` statement (one account primary-key probe) outside the page transaction, then, when the view is public, the partition epoch read and `collection-reads-curator-public.sql` on `collection_curator_public_page`: two `LIMIT` branches, each one index range scan of at most `s + 1` rows, `s` at most 100. Every viewer, including the curator, uses this public page directly, without a full-view account read. When the view is off, the existing curator identity check allows the curator's public page and everyone else gets an empty page without a page read. `view=FULL` adds the curator's public summary read, as on `GET /v1/collections`.
- Bound: Rows `O(s)`, blocks `O(L(N) + s)`, statements constant. Independent of the account's private, unlisted and deleted Collections and of other curators.
- Growth check: `test/library/growth-curator-list.test.ts`: `a curator's public Collection page examines a constant number of rows as the curator's private, unlisted and deleted Collections grow` measures this public first and cursor page statement at limit 20 and scales `[64, 256, 1024]`, with constant rows and statements and logarithmic blocks. The added account probe is covered by `test/access/growth-account-public-views.test.ts`: `public view flags for 20 accounts across 4 partitions stay bounded as accounts grow`, at scales `[256, 1024, 4096]` with constant rows and statements and logarithmic blocks.

### Members page

- Touches: The Collection load, then one ordinal keyset on `collection_member` ordered by `ordinal_key`, `member_id`, fetching `s + 1` rows. The unique key is `(route, collection_id, ordinal_key)`. The cursor carries `orderEpoch + 1`. `readableSubjects` then filters at most `s` ids, with concurrency 4. Unreadable subjects are omitted from the page. The extra row only decides the next cursor. FULL display resolves each distinct returned subject id, deduplicated by `ViewReader`: each live resolve includes a pre-wait identity/authorization snapshot, projection freshness probes, fresh Access preparation outside Source RR, and a fresh final authorized Source recheck. An authorized redirect adds one original preflight before the survivor is independently resolved. These points occur per distinct resolved id, not once per page; all SQL, control and catalog statements remain counted.
- Bound: The member statement is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1, plus the Collection load and up to `s` subject resolves. Those resolves cost linear rows, blocks and statements in the id count.
- Growth check: `test/library/collection-reads.test.ts`: `reads keep the same statement count as unrelated Collections, members and pairs grow` uses limit 1 and compares statements. `test/library/collection-store.test.ts`: `member page, insert and neighbour read have constant row and statement cost at three scales` keeps a limit-1 member page, one insert and one neighbour read at constant rows and statements and logarithmic blocks, against unrelated Collections. `test/library/subject-anchor.test.ts`: `subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow`.

### Subject page

- Touches: One subject resolve, one exact public-count probe from `subject_listing`, one partition-epoch read, one `subject_collection` keyset on `(route, subject_id, collection_id)` with limit `s + 1`, then one Collection primary-key read per pair on the page. Pairs whose Collection is not active and public are dropped. The mounted page uses `s` at most 100. The pair helper itself accepts a limit through 5000 and is called here with `s + 1`.
- Bound: The count probe reads at most one row. The pair keyset is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1. The projection adds `S` of `O(s)` Collection primary-key reads, each `R` `O(1)` and `B` `O(L(N))`, plus one subject resolve. A limit-1 sample does not show the `O(s)` term.
- Growth check: `test/library/collection-reads.test.ts`: `reads keep the same statement count as unrelated Collections, members and pairs grow` calls the subject page at limit 1 and compares statements. `test/library/subject-anchor.test.ts`: `subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow`.

### Entry put

- Touches: One subject resolve, then own-account `library_entry:update`. A missing revision inserts one `entry` primary key. A supplied revision compare-and-swaps that primary key. State `in_progress` also runs one follow upsert in the same command and may emit a second event. The event subject is the account id.
- Bound: Planned insert or update: library body `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the resolve, authorization and the envelope. In progress adds one follow upsert, so the body is `S` 2, and `k` is 2 when the follow changes.
- Growth check: `test/library/entries.test.ts`: `put, delete and list statement counts stay equal at three scales of unrelated account entries` keeps `planned` put statements equal at 1, 8 and 64. It does not measure blocks and does not follow. `test/library/entry-store.test.ts`: `entry write, entry page and copy page touch the same rows and statements at three scales` updates one entry at scales 1, 4 and 16 with 500 x scale seeded rows per relation (500, 2,000 and 8,000), with no planner setting: one statement, constant rows, logarithmic blocks and no sequential scan.

### Retained entry clear

- Touches: Native actor admission and personal-library gate before owner checkout, current owner share/authorization
  before receipt, one exact live PK/CAS, optional legacy NULL-incarnation stamp, one retained snapshot/due-index
  insert, one owner sequence allocation, native fact hooks and one deletion event/envelope. Exact replay skips the body.
- Bound: Constant keyed rows/statements; logarithmic live, archive, counter and receipt index blocks. Clearing needs
  no source or active-definition lookup. Copies, sessions, labels and follows remain independent.
- Growth check: `test/library/entry-retained-delete-growth.test.ts` captures whole admitted commands, rejection and
  replay at 256/1024/4096 native live/archive, account/counter/source and immutable-definition populations.

### Original entry restore preparation

- Touches: Native admission/gate, one addressed archive in a short owner read-only RR, then immutable original pin
  and original/terminal source authorization after owner release. Fresh errors are deferred past current-authorized
  exact receipt lookup; owner admission failures are immediate. Historical unmapped legacy facts carry no reference.
- Bound: Constant indexed archive and immutable-meaning points plus the bounded Semantic source resolver. No history,
  active-profile lookup or nested owner checkout. Native T and the caller's finite deadline bind each attempt.
- Growth check: `test/library/entry-restore-preparation-growth.test.ts` charges all pools for ready, rejected, denied
  and replayed preparations at 256/1024/4096 native populations, including denial before private archive reads.

### Exact entry Undo and HTTP

- Touches: Preparation and normal owner/receipt boundary, one locked exact archive witness with native SQL expiry,
  empty-live-PK insertion and addressed consumption, one new owner sequence/stamp, existing fact hooks and one update
  event/envelope. Original fields remain in native INSERT SELECT; no old meaning is revalidated against active definitions.
- Bound: Constant keyed rows/statements, logarithmic live/archive/counter/receipt blocks; strict original 720-hour
  retention. HTTP formats safe entry DTOs and receipt-bound deletion headers without database work.
- Growth check: `test/library/entry-restore-growth.test.ts` charges successful, occupied/stale/expired/missing/foreign,
  owner-denied and replayed commands at 256/1024/4096 native populations; it also covers concurrent arbitration and
  sequence commit/replay/rollback. `entry-undo-http.test.ts` proves the real caller and published contract. Automatic
  due delivery and complete library deletion-driver coverage remain separate.

### Entry read

- Touches: A repeatable-read snapshot, one account admit, and one `entry` primary key. A missing or foreign row is not found. There is no write.
- Bound: The entry point is `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the account read and begin and commit.
- Growth check: `test/library/growth-personal-reads.test.ts`: `Entry read has constant rows and statements as entries grow`. Whole-read rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the reading account's entries, other accounts' entries in its partition and another partition, Access accounts, receipts, outbox and write-basis rows grow by 500 rows per population times scale.

### Entry page

- Touches: A snapshot, an account admit, a partition-epoch read, and one keyset. The unfiltered order uses `entry_account_updated` on `(route, account_id, updated_at, subject_id)`. A state filter uses `entry_account_state`. Two `LIMIT` branches fetch at most `s + 1` rows, `s` at most 100. The cursor is bound to the account and the selected state.
- Bound: `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 for the page, plus the admit and the partition read.
- Growth check: `test/library/entries.test.ts`: `put, delete and list statement counts stay equal at three scales of unrelated account entries` lists with limit 20 and compares statements at 1, 8 and 64. `test/library/entry-store.test.ts`: `entry write, entry page and copy page touch the same rows and statements at three scales` pages entries with limit 1 at scales 1, 4 and 16 with 500 x scale seeded rows per relation (500, 2,000 and 8,000), with no planner setting: one statement, constant rows, logarithmic blocks and no sequential scan.

### Bulk operation summary and outcome page

- Touches: The summary reads one source-owned operation row with fixed counters; it does not count manifest rows. An outcome page reads at most 21 immutable operation ordinals from the operation/ordinal keyset for a page size of 20. Target receipt reconciliation uses the exact receipt key. Counters change with one unique terminal target transition.
- Bound: Summary work is `R O(1)`, `S O(1)`, with logarithmic index blocks. The outcome page is `R O(21)`, `S 1` for target rows, with logarithmic seek cost. The manifest and target evidence grow with the number of selected items; these per-operation bounds do not claim constant total operation cost. Discovery cost and its indexes are specified separately in [`bulk-contract.md`](bulk-contract.md).
- Native outcome paging: `pageBulkOutcomes` uses the caller's source repeatable-read client after independent authorization and exact operation-owner proof. One statement seeks `bulk_target_pkey`, or `bulk_target_state` for an exact state, with route/operation/account predicates. It fetches at most 21 rows, emits at most 20, and continues after the last emitted decimal ordinal only when lookahead exists. State is current at the page snapshot. The outer reader owns encrypted cursors and private not-found behavior.
- Native growth check: `test/library/growth-bulk-outcome-page.test.ts`: `outcome pages have bounded rows and statements as operation targets grow` measures first and deep pages in both branches as the same operation's targets, mostly nonmatching states, other operations and other owners grow. It checks constant examined rows and statements, logarithmic blocks and no sequential scan without planner settings.
- Growth check: `specs/library-bulk-outcomes.test.ts`: `progress is bounded truthful and outcome pagination does not repeat or expose the manifest on summary` checks bounded operation resources and pages; `specs/library-bulk-outcomes.test.ts`: `growth axes retain indexed admission replay summary and fixed outcome pages without manifest recounts` checks admission replay, summary and fixed outcome-page reads as unrelated histories grow. These checks are acceptance requirements, not measured product results in this repository yet. Discovery cost and index expectations are specified separately in [`bulk-contract.md`](bulk-contract.md).

### Session start

- Touches: Per-attempt trusted preparation calls `readLibraryProfileSource` for the original and optional version
  subject at native T, releasing each source/Global connection before owner checkout. It charges account admission,
  subject resolution, native Access, anchored source/partition reads, primary type and active immutable release
  lookup. Owner authorization and exact receipt lookup precede fresh capability validation. The body ensures the
  exact owner/subject `progress_head`, inserts one pinned session, touches that head and raises an existing entry's
  activity. Entry absence does not create an entry. The event subject is the account id.
- Bound: Body `S` 4, `R` `O(1)`, `B` `O(L(N))`, plus preparation, authorization and the envelope. Session insertion
  and a changed entry each pay their own `fact_source_head` trigger upsert (one fixed owner point per changed row).
  All helper and nested trigger statements are charged; there is no owner/history walk or free metadata work.
- Growth check: `test/library/session-shelf-activity.test.ts` measures the actual prepared start/record/complete/
  start/abandon journey with `checkGrowth`, explicit `rule: series`, at 64/512/4096 unrelated same-owner sessions,
  heads and history rows. The capture includes Core, Access, source/profile, helpers and nested trigger SQL.

### Session record

- Touches: Trusted preparation reads one owned session/pin in an owner snapshot, releases it, resolves the original
  immutable release and observes current subject/profile admission at the attempt's T. The body point-reads the
  immutable subject, ensures its head before the typed `(route, session_id)` `FOR UPDATE`, then rereads/CASes the
  session. It validates only incoming values against both original meaning and current admission. Stored total,
  start, units and history are never reinterpreted or repinned. NULL-pin rows retain the temporary explicit legacy
  parser. Optional unit remove/add statements each name at most 100 exact keys combined. Every accepted intent,
  including equal scalar/sparse no-net values, increments revision and appends one exact change row. Head/entry
  activity follows the successful write/history in the same transaction. Errors roll it all back; replay skips it.
- Bound: Scalar/cursor body `S` 8, `R` `O(1)`, `B` `O(L(N))`, plus preparation, authorization, envelope and one
  `fact_source_head` upsert per changed session/entry. Unit writes add at most two statements, `R` `O(u)` and
  `B` `O(u L(N))` for `u <= 100`. Neither sparse cardinality nor history is scanned. The 20000-key cap remains.
- Growth check: the native journey above measures all actual statements at 64/512/4096 background rows, with
  constant rows/statements and logarithmic indexed blocks. Existing legacy growth fixtures are not profile proof.

### Session complete

- Touches: One subject point read, head ensure, typed session lock, reread and CAS, then head touch and existing
  entry raise. Completion alone sets `completed_at` and completion evidence. No new profile value is supplied,
  so current profile absence does not prevent this lifecycle operation. No unit or history write occurs.
- Bound: Body `S` 7, `R` `O(1)`, `B` `O(L(N))`, plus authorization, envelope and the changed session/entry's
  fixed owner-head trigger upserts. Stored profile pin and user entry identity/revision/timestamps remain unchanged.
- Growth check: the same actual native three-scale journey includes completion, with every trigger charged.

### Session abandon

- Touches: The same ordered point/head/lock/reread/CAS and activity work as completion, without adding completion
  evidence. It preserves immutable session meaning and needs no current profile. No unit or history write occurs.
- Bound: Body `S` 7, `R` `O(1)`, `B` `O(L(N))`, plus authorization, envelope and changed-row owner-head triggers.
- Growth check: the same actual native three-scale journey includes abandonment, with every trigger charged.

### Session read

- Touches: A repeatable-read snapshot, one account admit, and one session primary key. A missing or foreign session is not found.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the admit and begin and commit.
- Growth check: `test/library/growth-personal-reads.test.ts`: `Session read has constant rows and statements as sessions grow`. Whole-read rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the reading account's sessions, other accounts' sessions in its partition and another partition, Access accounts, receipts, outbox and write-basis rows grow by 500 rows per population times scale.

### Session page

- Touches: A snapshot, an admit, a partition-epoch read, and one keyset on `progress_session_account_subject` `(route, account_id, subject_id, started_at, session_id)`. Two `LIMIT` branches fetch at most `min(100, s + 1)` rows. When `s` is 100 and the page is non-empty, a second limit-1 probe runs, because the first fetch is capped at 100. The cursor binds the operation, the account and the subject.
- Bound: `R` `O(s+1)`, or `O(s+2)` when the extra probe runs. `B` `O(L(N)+s)`. `S` is 1 or 2, plus the admit and the partition read.
- Growth check: `test/library/growth-personal-reads.test.ts`: `Session page at a fixed limit has constant rows and statements as sessions grow`. Whole-read rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the reading account's sessions, other accounts' sessions in its partition and another partition, Access accounts, receipts, outbox and write-basis rows grow by 500 rows per population times scale. The first session page keeps its limit of 20 and its first 21 neighbours fixed.

### Unit page

- Touches: The same snapshot, admit and session primary key, a partition read, and one `progress_unit` keyset on `(route, session_id, unit_id)`. The first fetch is `min(100, s + 1)`. A non-empty page at `s` = 100 issues a second limit-1 probe.
- Bound: The page is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 or 2, plus the session read, the admit and the partition read.
- Growth check: `test/library/progress-store.test.ts`: `unit add, unit page and change page touch the same rows and statements at three scales` pages units at limit 1 at scales 1, 4 and 16 with 500 x scale seeded rows per relation (500, 2,000 and 8,000), with no planner setting: one statement, constant rows, logarithmic blocks and no sequential scan. `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` lists units at limit 1 and compares statements at 1, 8 and 64.

### Change page

- Touches: The same session load and snapshot as the unit page, then one `progress_change` keyset on `(route, session_id, change_no)`. The first fetch is `min(100, s + 1)`, with the same extra probe when `s` is 100 and the page is non-empty. A cursor seeks to `change_no`. It does not walk from change 1.
- Bound: The page is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 or 2, plus the session read, the admit and the partition read.
- Growth check: `test/library/progress-store.test.ts`: `unit add, unit page and change page touch the same rows and statements at three scales` pages changes at limit 1 at scales 1, 4 and 16 with 500 x scale seeded rows per relation (500, 2,000 and 8,000), with no planner setting: one statement, constant rows, logarithmic blocks and no sequential scan. `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` lists changes at limit 1 and compares statements.

### Copy create

- Touches: An account admit, one subject resolve, and one `copy` insert in the owner partition. The event subject is the account id. The payload carries the copy id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the admit, the resolve, authorization and the envelope.
- Growth check: `test/library/copies.test.ts`: `statement counts stay equal at three scales of unrelated copies`. Create keeps statements and rows constant and blocks logarithmic at 1, 8 and 64, with no sequential scan on `library.copy`.

### Copy update

- Touches: An account admit, then a body of three statements: `FOR UPDATE` on the owned copy primary key, one primary-key read, and one compare-and-swap update. A foreign or missing row is not found. The event subject is the account id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus the admit, authorization and the envelope.
- Growth check: `test/library/copies.test.ts`: `statement counts stay equal at three scales of unrelated copies`. Update keeps statements and rows constant and blocks logarithmic at 1, 8 and 64, with no sequential scan on `library.copy`.

### Copy delete

- Touches: The same admit, lock, primary-key read and revision check as update, then one primary-key delete. The event subject is the account id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus the admit, authorization and the envelope. The same shape as update, with a delete in place of the update.
- Growth check: `test/library/growth-personal-writes.test.ts`: `Copy delete has constant rows and statements as copies grow` checks the whole command at scales 1, 4 and 16 while the owner's copies, other accounts' copies in the same and another partition, Access accounts, receipts, outbox events and write-basis rows grow by 500 × scale per relation.

### Copy read

- Touches: A repeatable-read snapshot, one account admit, and one `copy` primary key. A missing or foreign row is not found.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the admit and begin and commit.
- Growth check: `test/library/growth-personal-reads.test.ts`: `Copy read has constant rows and statements as copies grow`. Whole-read rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the reading account's copies, other accounts' copies in its partition and another partition, Access accounts, receipts, outbox and write-basis rows grow by 500 rows per population times scale.

### Copy page

- Touches: A snapshot, an admit, a partition-epoch read, and one keyset on `copy_account_created` `(route, account_id, created_at, copy_id)`. The first fetch is `min(100, s + 1)`. When `s` is 100 and that fetch does not already show a further row, a second limit-1 probe runs. The cursor is bound to the account.
- Bound: `R` `O(s+1)`, or `O(s+2)` with the probe. `B` `O(L(N)+s)`. `S` is 1 or 2, plus the admit and the partition read.
- Growth check: `test/library/copies.test.ts`: `statement counts stay equal at three scales of unrelated copies` lists with limit 1 and classifies statements and rows as constant and blocks as logarithmic. `test/library/entry-store.test.ts`: `entry write, entry page and copy page touch the same rows and statements at three scales` pages copies at limit 1 at scales 1, 4 and 16 with 500 x scale seeded rows per relation (500, 2,000 and 8,000), with no planner setting: one statement, constant rows, logarithmic blocks and no sequential scan.

### Copy list by subject

- Touches: A snapshot, an admit, a partition-epoch read, and one range of `copy_account_subject_created` for `(route, account_id, subject_id)`. The page fetches at most `limit + 1` rows. At the maximum limit, it uses the same one-row probe as the unfiltered page when the first fetch has no extra row. The stored subject id is matched directly, and the cursor is bound to it.
- Bound: `O(limit)` rows and statements per page, independent of the account's copies of other subjects and other accounts' copies of the same subject. `B` is `O(L(N)+limit)`. The page uses one statement or two with the maximum-limit probe, plus the admit and the partition read.
- Growth check: `test/library/copies.test.ts`: `subject-filtered copy page keeps statement counts equal at three scales of unrelated copies` keeps statements and rows constant and blocks logarithmic at 1, 8 and 64, with no sequential scan on `library.copy`.

### Follow

- Touches: An account admit, then a target resolve. A subject uses `subject:read`. A Collection is one primary-key read and must be active and public, unlisted, or curated by the actor. A Space uses `space:read` and one Space read. The command then upserts one `follow` primary key and reads it back. An unchanged row aborts before the receipt. The event subject is the account id. Follows are not counted in public.
- Bound: The follow body is `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus the admit, the target resolve, authorization and the envelope. The Space and subject resolves add their own Access and semantic bounds.
- Growth check: `test/library/follows.test.ts`: `statements per follow, membership step and page stay equal as unrelated follows grow`. Explicit Collection follows keep statement counts equal as unrelated follows grow. Blocks are not classified. `test/library/follow-store.test.ts`: `apply and page statement counts and examined rows stay constant as unrelated follows grow` applies intent `follow` as unrelated follows grow: one statement, one `library.follow` row, no sequential scan, constant rows and logarithmic blocks.

### Unfollow

- Touches: The same admit, target resolve, follow upsert and read-back as follow, with intent `unfollow`. A string target first reads the existing row so the stored target type is kept. An explicit unfollow is not overridden by a later implied follow. The event subject is the account id.
- Bound: The same body as follow: `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus one extra primary-key read when the caller passes only an id, the admit, the resolve, authorization and the envelope.
- Growth check: `test/library/growth-personal-writes.test.ts`: `Unfollow has constant rows and statements as follows grow` checks the whole command at scales 1, 4 and 16 while the owner's follows, other accounts' follows in the same and another partition, Collection targets, Access accounts, receipts, outbox events and write-basis rows grow by 500 × scale per relation.

### Membership follow

- Touches: `trustedAccount` for `library.follow.membership`, then the same follow upsert and read-back, with implied intent and reason `membership`. The library command does not resolve the Space. Community's join step is the caller. An explicit unfollow is preserved by the upsert predicate. The event subject is the account id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus trusted-account authorization and the envelope. No subject, Collection or Space read inside this command.
- Growth check: `test/library/growth-personal-writes.test.ts`: `Membership follow has constant rows and statements as follows grow` checks the whole command at scales 1, 4 and 16 while the owner's follows, other accounts' follows in the same and another partition, Access accounts, receipts, outbox events and write-basis rows grow by 500 × scale per relation. `test/library/follows.test.ts`: `statements per follow, membership step and page stay equal as unrelated follows grow` still checks membership statement counts at 1, 8 and 64.

### Maintain source follow replacement metadata

The forward `follow_count_source` migration installs `follow_count_source_change` on `library.follow` itself.
Explicit follow/unfollow, entry-implied follow and the trusted membership owner command keep their existing
SQL, DTOs, receipts and private `{targetId}` event. Previously prepared SQL also fires the storage hook. There is
no Access trigger or write in an Access transaction. Ordinary writers retain their native `shareAccount` barrier;
the hook reads only the keyed current `access.account` state/fence as eligibility data, never grant/role authority.

`library.follow_count_source` has primary key `(route, account_id, target_type, target_id)`, positive native bigint
`revision`, `source_following`, `desired_eligible` and nullable `pending_since`. This is one current replacement
per original, including negatives after physical DELETE; raw `follow` remains truth. Original identity and owner
route cannot be updated. Every actual changed row increments its revision, including reason-only changes; an
identical row UPDATE, implied conflict, explicit no-op or receipt replay does not. Reinsert advances the retained
revision. `desired_eligible` is raw following AND current account active AND not fenced; a missing account is
ineligible. This saved value is never delivery authority. Every future delivery must reread native account/follow
under the account barrier before applying, including a positive first application.

`library.follow_count_owner`, keyed `(route, account_id)`, holds native bigint `observed_live_count` and explicit
`bootstrap_complete=false`. Missing owner/pair metadata is unbuilt, never ready zero or revision zero. The count
is the sum of raw following states **already represented** by source rows, independent of incoming eligibility.
It becomes the outgoing live total only after a separate bounded bootstrap proves complete coverage. The hook
never declares any owner complete, even one first seen after migration. It locks this owner point before reading
the pair's previous `source_following`; its delta is current raw following minus previously represented following
(absent means unrepresented, not absent raw truth). Thus first-touch legacy UPDATE incorporates current live state,
first-touch legacy DELETE records a negative without subtracting unknown coverage, and concurrent first/last
changes cannot lose or double-count a represented edge. Native bigint overflow aborts source, metadata, counter,
receipt and outbox together; it never wraps or resets.

Cutover is transactional DDL plus a `SHARE ROW EXCLUSIVE` lock on `follow`: pre-existing source mutations finish
before installation, and later mutations, including old prepared statements, cannot bypass the hook. This proves
all-writer coverage after cutover, not legacy population coverage. Existing follows are deliberately unseeded.
A reader snapshot predating installation proves no baseline, and an absent head is not version zero. Future
bootstrap must start in a fresh native transaction after observing installed coverage, take the same account
writer barrier and owner counter lock, then page original follow keys, arbitrating each pair under its primary-key
lock. Insert a missing pair at revision 1 from current native truth and add its raw live state exactly once;
already represented pairs retain their revision unless current truth changes. Hooks behind the cursor represent
their own changes. Only complete exhaustion under this arbitration may establish coverage. No chronology is
inferred from `updated_at`, UUIDs or a global stamp; bootstrap and acknowledgement code are not delivered here.

`pending_since` uses database statement time, retains the minimum uncompleted age across coalescing and starts
again only after a future acknowledgement clears the current revision. The partial index
`follow_count_source_pending(route, account_id, pending_since, target_type, target_id)` supports owner-local oldest
work. Partition/global health reduction and discovery remain separate required producers; this owner-leading
index alone is not a global health sampler. Retain negative rows/revisions while the account is active; no GC,
TTL or revision reuse. Terminal erasure must fence writers and acknowledge target withdrawals before deleting
source payload/head. This migration supplies no terminal withdrawal, cleanup completion or identity participant ACK.

Source runtime reconciliation, bounded bootstrap, account maintenance/effect admission ports, current-source
delivery, target replacement/support/total, canonical identity/rekey, terminal fences/erasure, maintenance readiness,
count HTTP and the frozen full outcome driver remain unbuilt. Account effect work must preserve event time and
unprocessed age through queued/pending/ERROR/lost work; readiness must include effects consumerReady and consumer
lag, never heartbeat freshness. Suspension must change incoming eligibility through that later maintenance,
not raw outgoing intent or this counter. No count becomes publicly exposed by this storage slice.

- Touches: One original follow and fixed owner-local source/counter/index points in its same native transaction;
  one keyed account data read. The hook executes five SQL statements on a live delta, four otherwise. The outer
  statement and command envelope remain as above; nested trigger statements are additional work.
- Bound: Constant changed rows/statements per edge and indexed depth `O(log N)`, with one-owner counter contention.
  No follower/target/history scan, global clock ordering, fanout, full backfill or owner/global COUNT. Count reads,
  maintained canonical support and full native API costs require their own evidence.
- Growth check: `test/library/follow-count-source-storage.test.ts` uses the shared `checkGrowth` series rule at
  scales 256, 1,024 and 4,096, with one warm-up and five measured repetitions per scale. The selected native owner
  and hot partition stay fixed while unrelated source owners/targets and own negative history grow. Every run
  has a fresh released subject and idempotency keys, with its negative follow prepared through ordinary commands
  outside captures. Both measured follow/unfollow replacements include ordinary command, Access, receipt, outbox,
  write-basis and nested hook work. Constant rows/statements and logarithmic blocks use the shared kernel bounds;
  each repetition additionally requires positive source/counter work and zero sequential scans on those relations.
  The local `growth.json` evidence retains populations, every repetition and the actual series verdict;
  `plans.json` retains the actual auto_explain documents, including nested plans, rows/removals, loops and buffers.
  Synthetic negative growth cardinality and isolated rollback/overflow/DDL invariants remain primitive-only,
  separate from native positive fixture/HTTP/owner-command evidence. Calibrated acceptance remains unverified:
  the focused native check failed during `pg_dump` schema preparation before executing tests, so it produced no
  calibrated series verdict.

### Follow read

- Touches: One `follow` primary key for the caller and the target. The read is a single autocommit statement. Another account receives no row. There is no public count.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1. No envelope, because this read is not a command.
- Growth check: `test/library/growth-personal-reads.test.ts`: `Follow read has constant rows and statements as follows grow`. Whole-read rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the reading account's follows, other accounts' follows in its partition and another partition, Access accounts, receipts, outbox and write-basis rows grow by 500 rows per population times scale.

### Follow page

- Touches: One keyset on `follow_account_page` `(route, account_id, state, updated_at, target_id)` for `state = following`. The command page is one statement. The HTTP page also reads the partition epoch. Its first fetch is `min(100, s + 1)`. When `s` is 100 and that fetch does not already show a further row, a second limit-1 call runs. The cursor is bound to the account.
- Bound: The page statement is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1. HTTP at `s` = 100 adds the probe, so `S` is 1 or 2, plus the partition read. No command envelope.
- Growth check: `test/library/follows.test.ts`: `statements per follow, membership step and page stay equal as unrelated follows grow` lists with limit 20 and keeps statement counts equal as unrelated follows grow. `test/library/follow-store.test.ts`: `apply and page statement counts and examined rows stay constant as unrelated follows grow` pages with limit 1 as unrelated follows grow: one statement, one examined follow row, no sequential scan, constant rows and logarithmic blocks.

### Publish

- Touches: Own-account `published_log:create`. The body reads the owner's session primary key and inserts one immutable `published_log` in the owner partition. The event subject is the account id. Nothing is written on the subject partition.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus authorization and the envelope.
- Growth check: `test/library/growth-published-logs.test.ts`: `Publish has constant rows and statements as published logs grow`. Whole-operation rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the account's own and other accounts' published logs, progress sessions, receipts, outbox, write-basis and Access account rows grow by 500 x scale per population in the owner and other partitions.

### Retract

- Touches: Own-account `published_log:delete` and one primary-key delete matched to the owner account. The event subject is the account id. The session is left in place.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus authorization and the envelope.
- Growth check: `test/library/growth-published-logs.test.ts`: `Retract has constant rows and statements as published logs grow`. Whole-operation rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the account's own and other accounts' published logs, progress sessions, receipts, outbox, write-basis and Access account rows grow by 500 x scale per population in the owner and other partitions. Each run, including warm-up, retracts a fresh snapshot.

### Published log read

- Touches: A repeatable-read transaction and one `published_log` primary key. The read is public, including anonymous. There is no account admit. A missing row is not found.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus begin and commit. No authorization read.
- Growth check: `test/library/growth-published-logs.test.ts`: `Published log read has constant rows and statements as published logs grow`. Whole-operation rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the account's own and other accounts' published logs, progress sessions, receipts, outbox, write-basis and Access account rows grow by 500 x scale per population in the owner and other partitions.

### Published log page

- Touches: A repeatable-read transaction, one partition-epoch read, and one keyset on `published_log_account_page` `(route, account_id, published_at, log_id)`. Two `LIMIT` branches fetch `s + 1` rows, `s` at most 100. There is no second probe. The cursor is bound to the account. The page is public.
- Bound: `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 for the page, plus the partition read and begin and commit.
- Growth check: `test/library/growth-published-logs.test.ts`: `Published log page at a fixed limit has constant rows and statements as published logs grow`. Whole-operation rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the account's own and other accounts' published logs, progress sessions, receipts, outbox, write-basis and Access account rows grow by 500 x scale per population in the owner and other partitions. The first page has a fixed limit of 20.

### Member listing effect

`library_member_listing` consumes actual member events. It observes the source partition epoch/position and
Collection/public-history/member truth on the same repeatable-read client, then releases that client before a
single subject-home command. Unavailable/moved/fenced source ownership fails instead of supplying zero.
`listing-apply.sql` replaces one version and positive pair using monotonic bigint source stamps. Old observations
are ignored; an equal-stamp payload conflict aborts. Public-history zero versions survive withdrawal and deletion,
including a withdrawal delivered before the first positive. Never-public private/unlisted zero observations retain
no target record, receipt or event. Duplicate occurrences contribute one Collection, independently of multiplicity.

Pair/count changes and the existing `{subjectId}` listed event commit together. A newer source stamp with unchanged
multiplicity rolls back the command attempt, then updates only derived ordering metadata through the existing fenced
operational transaction. It changes no count, public revision or event, and never conceals writes in `noEffect`.
Registered work reuses its native WorkClient; direct callers own a short-lived client on the supplied pool.
There is no receipt: the retained source version supplies replay ordering, including public/private/public
cycles. It reads neither personal Library facts nor curator labels.

The source examines only occurrences of this subject in this Collection through `collection_member_subject`
(at most the existing 5000 live occurrences); apply uses point keys on version, fence, pair and subject aggregate.
Statements and examined rows are constant plus this bounded multiplicity, with B-tree depth in storage size.

### Listing-change workflow and publication visibility

Visibility changes/deletions keep the existing source-local command and atomic `collection.listing.changed` event.
The registered default Library effect enqueues `library.collectionListing` using the event ID. Each
`library.syncCollectionPage` uses at most 100 indexed successor seeks to distinct subject IDs; duplicates are skipped
by seeking strictly after the previous subject, rather than scanning a DISTINCT population. It releases its source
connection before syncing each affected subject home. A segment executes at most two pages, then persists a
continuation in the existing DBOS workflows queue with only Collection ID, last subject ID and root workflow ID.
Retry/recovery repeat against current source truth. No additional worker, queue or domain write in GET exists.

The maintained exact count becomes visible after publication finishes, not synchronously in the Collection command.
A page that encounters a withdrawn positive returns dependency-unavailable readiness instead of certifying its stale
count. Subject reads retain one maintained subject-key count and a fixed candidate page; they do not count Collections
or enumerate all subject pairs. Current active-unfenced account public-view discovery filters public list candidates;
known-ID public/unlisted readability remains separate native Access authority.

One page costs one indexed subject-keyset statement plus two source statements and one apply statement per subject,
with the native transaction envelopes. A stamp-only advance pays a rolled-back apply plus one operational apply;
a concurrent public change retries in the command envelope within the original deadline.
Total finite work follows only the changed Collection's distinct subjects
and their occurrences, never unrelated Collections, subjects, member history or partitions.
`collection-publication-growth.test.ts` exercises actual commands, default work-module effects, retained observations,
zero-first/reverse delivery, retries, duplicate occurrences, deletion, finite continuation, native rows/blocks/statements
and three-scale growth. `collection-reads.test.ts` retains the fixed-statement subject-read regression and awaits
actual effect/workflow completion before asserting the new published count. `collection-http.test.ts` uses native
Auth registration/suspension to prove old bearer401, no-session sign-in refusal, anonymous known-ID readability and
current curator discovery. This slice makes no terminal erasure or legacy rollout-completion claim.

### Collection sitemap candidate discovery

- Touches: one partition-local route/id partial B-tree range, at most `B` active/public candidates, `B <= 4000`; no member or private-state relation and no all-partition enumeration.
- Bound: `O(B)` rows, one statement, `O(log N + B)` blocks independent of private/unlisted/deleted population. This is candidate discovery; the eventual feed separately budgets partitions and live anonymous authority checks.
- Growth check: `test/library/growth-sitemap-discovery.test.ts`: `Collection sitemap discovery cost stays bounded as public and hidden Collections grow`, `[256, 1024, 4096]`, first and continuation pages, no planner pins.

### Collection sitemap page

- Touches: At most four partition-interval partial-index seeks yielding at most `4L` candidates, bounded partition epoch reads and existing anonymous disclosure/gate probes per candidate. No member, subject, progress, copy or private-state population scan.
- Bound: `O(Q + L)` rows and statements and `O((Q + L) log N)` blocks, with `Q <= 4` and `L <= 1000`, independent of the total Collection, member or curator population. Sparse traversal work carries across pages.
- Growth check: `test/library/growth-sitemap.test.ts`: `Collection sitemap page cost stays bounded as Collections and hidden candidates grow`, first and continuation pages with listed, filtered and denied candidates grown separately, including empty partitions and routes. Rows and statements stay constant; blocks stay logarithmic. The shared growth classifier counts catalog probes.

### Private Collection pins

[Library pins](../../../../docs/library-pins.md) owns the wire and preference rules. `pin-routes.ts` mounts
`library_pin.list`, `library_pin.put` and `library_pin.delete` under `personal_library`; scopes are
`library_pin:list` and `library_pin:update`. `pins.ts` uses the native prepared own-account runner and common
Collection point reader. A new target's read is prepared before owner checkout; exact receipts precede fresh
business failures. Existing pins remain reorderable/removable without target permission. No Collection grants,
materialization, owner fact sequence or Everything source version is written.

`library.collection_pins` has one `(route, account_id)` row containing at most 100 UUIDs and a retained list
revision. GET never initializes it and resolves only the returned IDs after releasing the owner snapshot.
The cursor uses the shared codec, owner/limit binding and revision/ordinal position. Work is one bounded owner
record plus O(returned limit) native Collection and Access points and their output bytes; off-page targets and
personal histories are never read. This is a bounded point-read implementation, not a three-scale growth proof.

Retention inventory/handoff: erase the entire `library.collection_pins` row by its exact `(route, account_id)`
primary key during terminal Library account erasure, including an empty retained revision. Unpin has no archive
or restore period: it is preference state. The native owner share fence holds through commit and prevents late
writes. Shared receipt locators are `(partition_no, principal_kind='account', principal_id=account_id,
command_kind IN ('library.pin.put','library.pin.delete'), idempotency_key)` in `core.receipt`; response is only
`{revision}`, but request digests and keys are private evidence. Each effective change emits exactly one
`com.rezics.library.pin.updated.v1` event, `subject=account_id`, `{collectionId}`. Its native exact locator is
`(partition_no, position, event_seq)` in `core.outbox`, recorded by the ordinary command envelope.
These private IDs/evidence follow shared history minimization and delivery custody; this module adds no
participant acknowledgement and does not claim complete account erasure. Built-in pin integration remains
separately required through the common Collection reader and its frozen native suite.
