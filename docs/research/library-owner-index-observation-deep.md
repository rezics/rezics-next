# Native owner candidates and complete observations

Research basis: `bae843d0b9e438ebba76a96b4b758d537808d64c`, inspected on 2026-10-29.
This is independent evidence for adoption, not an interface approval, implementation or runtime acceptance.
No sibling research report, reference clone, database, engine or provider was used; no external source was executed.
Repository sources are [AGPL-3.0-only](../../package.json). External documentation and its licence are listed below.

## Recommendation and authority

Keep native facts authoritative. Maintain one private owner candidate/support directory, with native indexed
existence/extremum access beneath it, and retain query-specific preparation only where direct work cannot fit.
The essential invariant is **complete covered inputs plus current observation**, not a positive support count.
Selective prepared-result reuse needs private dependency change metadata beyond the delivered broad owner head.
Do not activate canonical absence, prepared Liked, or mixed public/owner queries by interpreting missing producers as empty.

The authorities are [Library](../library-and-collections.md), [owner queries](../library-owner-queries.md),
[dynamic Collections](../dynamic-collections.md), [source integration](../collection-source.md),
[Continue](../library-continue.md), [filtered lists](../filtered-lists.md) and [deletion](../deletion.md).
Their fixed meanings require one shared Boolean grammar, viewer-self private facts, immutable original IDs/pins,
published canonical epochs, useful pages, current disclosure and bounded physical work. This report adds no precedence or budget.

Everything is the union of live state, effective labels, retained sessions/history and holdings; trash contributes nothing.
Labels work without a profile but support no state sibling. Entry/session/copy pins support their accepted siblings.
Reactions contribute only to Liked, never Everything/state; Liked is always logical, private, including empty `200`.
`NOT completed-session` within explicit presence differs from `NOT state`: clearing state leaves retained completion.
State chooses the highest live private owner sequence before matching; archived conflicts never win.

## What is actually committed

Paths below are relative to the repository root. Receipts and type names do not substitute for callable implementations.

| Producer and exact evidence                                                                                                                                                                                                                                         | Delivered capability and boundary                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [filter.ts](../../packages/filter/src/filter.ts), [owner-filter.ts](../../packages/filter/src/owner-filter.ts), [index.ts](../../packages/filter/src/index.ts)                                                                                                      | `FilterDocument`, `OwnerLeaf`, `parseFilter`, `admitFilter` and `walkFilter` include owner leaves. `owner: true` admission is structural, not authorization. Expand saved filters before dependency walking; walk NOT children too. The owner document's earlier claim that parsing is absent is stale.                                               |
| [owner-write-sequence.ts](../../services/kernel/src/library/owner-write-sequence.ts), [receipt](../../services/kernel/src/library/owner-write-sequence.md), `db/library/migrations/20261028182526_owner_write_sequence.sql` under `services/kernel/`                | `allocateOwnerWriteSeq(tx, accountId): Promise<bigint>` requires the live same-owner execute transaction. Two counter statements, positive bigint, rollback/replay protection; nullable positive live/archive columns. Native entry writers still do not call it at this revision.                                                                    |
| [owner-fact-version.ts](../../services/kernel/src/library/owner-fact-version.ts), [receipt](../../services/kernel/src/library/owner-fact-version.md), migrations `20261028003557_owner_fact_source_hooks.sql` and `20261028193813_owner_query_version_coverage.sql` | `readOwnerFactVersion(client, accountId): Promise<bigint \| null>` is one same-snapshot head point. All five UPDATE hooks compare entire rows, including lifecycle/activity, copy kind/status, parent labels and sequence-only changes. Each actual row mutation pays its own hook. NULL means unbuilt, never zero.                                   |
| [builtin-identity.ts](../../services/kernel/src/library/builtin-identity.ts), [builtin-reference-store.ts](../../services/kernel/src/library/builtin-reference-store.ts)                                                                                            | `builtinCollectionId` has Everything/state variants only. `readBuiltinStateReference` is one structural tuple point, not admission. `bindBuiltinStateReference` currently validates an entry witness and stores per-entry sources; it does not cover all siblings/session/copy support. Do not expand that witness table into the proposed directory. |
| [collection-source.ts](../../services/kernel/src/library/collection-source.ts), [collection-model.ts](../../services/kernel/src/library/collection-model.ts), [canonical-source-store.ts](../../services/kernel/src/library/canonical-source-store.ts)              | Factories throw dependency-unavailable; the model is stored/curated-header shaped. `20261028000646_canonical_collection_sources.sql` creates per-header generation/fact-witness storage, not the adopted owner directory. Historical sweep/probe scaffolding is not the new protocol.                                                                 |
| [collection-source-native.ts](../../services/kernel/src/library/collection-source-native.ts), its `-facts.sql`, `-probe.sql`, `-header.sql` siblings                                                                                                                | `readNativeCollectionMetadata`, `authorizeNativeCollectionMetadata`, `readNativeCollectionRawPage`, `probeNativeCollectionOriginal` implement narrower stored-header/raw-original operations. Exact original probes and reserved-label parent checks are useful primitives; they prove neither headerless production nor canonical completeness.      |
| [identity-epoch-contract.ts](../../services/kernel/src/semantic/identity-epoch-contract.ts), [contract](../../services/kernel/src/semantic/identity-epoch-contract.md)                                                                                              | Semantic epoch types and pending/published rules exist. Registered `semantic/identity-epoch-store.ts:identityEpochStore` and its bootstrap runtime are absent here. Never assume future call signatures are executable.                                                                                                                               |
| [public-filter-source-contract.ts](../../services/kernel/src/semantic/public-filter-source-contract.ts), [contract](../../services/kernel/src/semantic/public-filter-source-contract.md)                                                                            | Public Source2a projection/reduction interfaces only. Named `publicFilterSource`, `recordPrivacyReduction`, projection pages and behind-home observation have no implementation here. A public type does not deliver a native privacy port.                                                                                                           |
| [reactions.ts](../../services/kernel/src/content/reactions.ts), [reaction-slot.sql](../../services/kernel/src/content/reaction-slot.sql), `db/content/migrations/20261026202322_subject_reactions.sql`                                                              | Native actor-partition reaction mutation is real; `subject_reactor` is a target-side projection, not Liked authority. No raw Liked reader or `readLikedVersion` export is in this checkout. The owner-version receipt describes a delivered raw reader, but cannot supply its absent implementation.                                                  |

The raw Liked capability described by the assignment is stored-subject/actor-partition only, even when delivered elsewhere;
it cannot establish canonical order, coverage or privacy. A separate read-only inspection of `dev` at
`8090dc0848484babb0b81bef1abfd40230b26f70` found no `readLiked`/`readLikedVersion` implementation either.
Therefore obtain Content's exact committed reader receipt and the registered version-extension/DDL cutover receipt before
binding a consumer; neither an advertised extension nor this report invents its ABI. This is a local delivery distinction.
Native `entry-store.ts`/`progress-store.ts` adapters still omit accepted pins, and entry insert/update SQL omits sequence;
nullable pin/schema delivery and `profile.ts` descriptor helpers do not prove generic production writer coverage.
The [Library README](../../services/kernel/src/library/README.md) inventory also predates some delivered primitives;
executable sources above establish their narrower current boundaries.

## Weakest sufficient invariant

For owner O, published identity epoch E and admitted source population P, let S be all qualifying native original supports.
Coverage must prove that every support in P is represented at E, including supports currently unreadable or excluded by Q.
Each membership/exclusion/order decision is evaluated against a covered source snapshot and its complete dependencies.
A positive canonical result additionally needs a currently eligible supporting original AND eligible terminal;
the terminal alone never discloses a withheld original. The observation must detect reductions while execution was in flight.
A negative requires exhaustive covered native ranges, not failure of one remembered original or disappearance of one pointer.
Every request/continuation binds viewer-self and checks current native authentication, family scopes/gates and source authority.
Native suspension revokes the pre-existing bearer: expect `401 invalid_credentials` and the adopted invalid-token challenge,
not a fabricated suspended Actor. A structural builtin reference, source head or ready generation supplies no permission.

This is weaker than retaining every fact as a witness and stronger than maintaining positive counts.
An indexed complete native anti-existence probe can prove no entry/session for a key; a missing directory row cannot,
unless directory bootstrap, concurrent creation capture, epoch publication and source-change coverage are all established.
Likewise a complete native empty range can prove empty without a source-head row; NULL head alone proves nothing.
An observation includes the population, NOT branches, saved expansion, selected public qualifiers and ordering dependencies.
Checking only returned positives misses an excluded subject whose private completion disappeared or whose sort key increased.

## Minimal physical access derivation

Use a single owner directory with candidate rows keyed by `(owner, canonical subject)` and structural support ranges keyed
by `(owner, canonical subject, support scope, original subject)`, plus inverse `(owner, original subject, scope)` access.
Scopes distinguish native family and accepted query dimensions; they are shared across built-ins and arbitrary filters.
Retain only existence cardinalities, seek extrema/locators, maintenance generation and coverage/dirty state needed for access.
Do not copy session/copy bodies, label assignments, pins, source revisions/transactions or per-fact exact witnesses into it.
One million sessions with the same original/profile/lifecycle occupy one structural existence scope, not one million directory rows.
Facts and their ordinary native B-tree indexes retain independent identities; structural counts accelerate discovery, never grant access.

Add native range indexes for accepted dimensions missing below, then maintain first/last existence and top extrema by
indexed seeks. Native per-original extrema feed indexed canonical support extrema; replacing a top item must seek its next
native item, then its next structural supporter, rather than sorting history or probing every alias.
Use equality scope prefixes followed by the actual requested order and stable tie-breaker; an index matching only a
different order is not sufficient. PostgreSQL documents why matching [B-tree ORDER BY/LIMIT](https://www.postgresql.org/docs/18/indexes-ordering.html)
avoids processing all matches. These are relational requirements, not proposed runtime exports.

| Step                          | Existing native source/index and minimum extension                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enumerate originals/bootstrap | `entry` PK `(route,account_id,subject_id)`; `copy_raw_source` and `progress_session_raw_source` from `20261028003557_owner_fact_source_hooks.sql`; label assignment owner/subject/reserved source indexes from `20261027234813_label_reservation_source.sql`. `entry-store.ts`, `progress-store.ts`, `label-assignment-store.ts` are native truth, not query completeness. Capture concurrent old/new keys while bounded keyset phases build coverage. |
| State winner/conflicts        | One live entry per original; ordered structural state-support locators use native `owner_write_seq DESC`, with native entry revalidation. A same-value new sequence changes the winner key. Retain other originals/pins; conflict enumeration is separately paged. A requested matching state cannot drive winner selection ahead of a newer nonmatching state.                                                                                        |
| Session existence/display     | Native session table plus owner/original/profile/lifecycle range; existing `progress_session_active` in `20261027103142_library_shelf_core.sql` already orders stored-original active sessions by `last_changed_at DESC,session_id ASC`. Extend accepted-dimension access, not history scans. `shelf-active.sql` demonstrates LIMIT-one lateral seeks, but not canonical/profile completeness.                                                         |
| Holding predicates            | `entry-store.ts` copy methods and raw source index; add owner/original/accepted-profile and kind/status seek variants needed by admitted shapes. Both qualifiers must match the same native copy. Maintain bounded wildcard/specific existence scopes from one changed copy; do not AND unrelated copy summaries.                                                                                                                                      |
| Label effectiveness           | Assignment tuple PK and `(route,account_id,label_id,subject_id)` inverse index in `20261027190250_personal_labels.sql`; reserved source and 32 slots/original above. `label-assignment-lifecycle-store.ts` preserves native identities/CAS. Read current same-owner parent; soft-deleted assignment/parent never supplies support.                                                                                                                     |
| Presentation/siblings         | `resolveLibraryProfilePin`, `hasEntryState`, `progressUnit` in `profile.ts` resolve immutable accepted descriptors. Maintain distinct supported digest scopes and lexical digest seek containing the requested state. Include all sibling identities from live entry/session/copy pins, not just the current entry state. Labels/trash supply none.                                                                                                    |
| Continue activity             | `shelf-heads.ts:createShelfHeads/createProgressActivity`, `shelf-head-touch.sql`, retained `progress_head`, and native session `last_changed_at` are reusable storage mechanisms. At this commit session commands do not call those head helpers. Canonical active-role membership/order and proactive writer integration remain missing.                                                                                                              |
| Ordered candidate pages       | Directory shared indexes or retained prepared-result B-trees keyed by validated order plus canonical subject. Existing raw member `(route,collection_id,subject_id,member_id)` index orders stored originals only: `[a,c,z]` with `a→z` must become `[c,z]`, not first-seen deduplication.                                                                                                                                                             |

Keep original subject keys and pin payloads unchanged. The directory is a derived view; epoch rekeying operates on its
structural support ranges, not on millions of original session/copy records. Native indexes beneath each original remain reusable.
Even structural distinct scopes can be large: epoch/support maintenance is bounded background work with durable frontiers,
not a 4096-original sweep on reads or synchronous writes. Account for every visited scope; do not call it constant per group.

First support atomically creates/marks a candidate; last support removal removes it only after covered replacement checks.
Concurrent first/last updates serialize the affected native original and directory keys under the owner transaction;
unique keys and native revision/CAS prevent double increments. Derived bootstrap cannot race an unnoticed source insertion.
Writers modify bounded old/new scopes and mark affected generations dirty; they never enumerate all owner's facts/results.
If replacement requires broad repair, preserve a dirty structural range and resume background work before serving it as ready.
Bootstrap needs writer participation, not repeated head comparisons: serialize each native family frontier/page with
its source writers. For immutable `(original,fact ID)` seek keys, a writer applies old/new structural deltas immediately
on the covered side, including new behind-frontier insertions; uncovered-side facts are counted by the later page.
Commit page counters and frontier CAS together, so replay cannot double-count. Finish coverage under the same boundary;
every post-completion write then maintains it. No copied per-fact witness is necessary. Parent-wide invalidations and epoch
changes retain their separate dirty gates. Producers must prove this source-write integration before declaring bootstrap complete.

Deleted label parents illustrate the limit: deleting one parent may affect millions of assignments.
The parent mutation invalidates its private dependency key in the same transaction; it does not synchronously visit children.
Background uses the existing label→subject seek, retains inactive locators for restoration, and updates shared support ranges.
While delayed, a current parent point rejects stale positives, but cannot prove all missing/replacement candidates complete.
An affected Members query prepares; a proactive Continue dependency stays not-ready under its own read contract.
PostgreSQL [partial indexes](https://www.postgresql.org/docs/18/indexes-partial.html) cannot predicate on a different table's
live parent or current permission. A cached live count or cross-table partial-index proposal does not close this gap.

Current-readable-original selection needs a structural eligible-support ordering bound to a covered observation/generation.
Build/repair it by bounded original-support traversal, retain excluded originals for inverse repair, then seek an eligible
supporter and revalidate its actual native support, original and terminal authority. This selection is never cached permission.
If its last eligible alias loses disclosure, query-wide reduction observation invalidates the generation before reuse;
neither a positive aggregate nor a readable terminal can substitute. Sparse disclosure may require preparation, not refill forever.
The missing producer is Semantic's implemented population/foreign repair observation, not a new private public-log key.

Compile the shared expanded AST into ordered scope-range union/intersection/difference or native exact probes; do not
introduce another Boolean interpreter. NOT is relative to the admitted source population, preserving catalogue unknown.
For holdings, maintain only the bounded combinations of supplied profile/kind/status dimensions; sessions use profile/lifecycle.
General Boolean/saved/order shapes use retained preparation when a selective ordered driver cannot meet direct bounds.
Preparation advances relevant indexed input ranges once, with sparse repair; it may visit population-sized relevant input,
as filtered-lists explicitly permits, but never performs an unbounded upfront owner scan or match-linear read-time sort.
Everything's own ordered candidate index needs no complete owner enumeration before its first useful page.
Preparation stores ordered canonical results under the validated query, not separate Everything/state/Continue caches.

Sibling lookup also needs a maintained tuple→opaque-reference directory from supported accepted state sets, independent
of an Everything visit. The existing entry-specific reference binder is insufficient. Register distinct supported sets,
then maintain required sibling references in bounded proactive work; do not synchronously fan out an arbitrarily large
descriptor or retain per-entry witnesses. Commerce must deliver this structural recognition before headerless siblings activate.

For Continue, resolve the chosen state pin's actual `role: active`, not literal `in_progress`; independently accept an
active session by its own pinned mode/unit. Activity is the maintained native maximum, with SQL timestamp precision.
The most recently changed active session wins display; completing it exposes the indexed next one. Preserve BASIC session IDs.
Maintain this before a first Continue request, including never-visited Everything. Current release/type cannot reinterpret pins.
Materialized headers/public completed meaning remain fixed; owner rename wins. Lexical current supported digest is presentation only.

## Selective preparation and covered snapshots

The broad private head is a lossless alarm, not a selective dependency system.
Two histories can advance it identically while one changes Q's label and another changes an irrelevant copy note;
native current rows cannot reconstruct a removed key or reveal which already-covered range changed.
Thus indexed truth plus bounded retained preparation suffices only with additional atomic private change/dirty metadata
or equivalent indexed affected-result invalidation. Rechecking all owner facts or rebuilding every result on each head bump fails.
Direct complete native seeks need no retained result, but still need snapshot, bootstrap, epoch and authority evidence.

Recommend private per-key monotone change metadata and an indexed dependency→prepared-result registration, not fact mirrors.
Keys cover source population, state-winner scope/sequence, label parent/assignment, session profile/lifecycle/activity,
holding profile/kind/status, accepted descriptor meaning, identity epoch, and every admitted order/public dependency.
Record old AND new keys and deletion/zero-crossing information atomically with the native write; retain disappearance tombstones.
Same-value sequence writes invalidate state winner/order dependencies; parent deletion invalidates all queries registered to it.
The broad head still advances through existing full-row triggers, including irrelevant updates; do not disable or double-count them.
Private keys stay in the owner home; public Search/per-home reduction logs contain only their adopted public source keys.

Register the expanded full query and observe its key versions in one serialized owner-home transaction before scanning.
Every writer atomically records relevant changes, so registration either precedes a captured change or sees its newer basis.
Retain keyset input frontiers, settled result ordering, covered dependency cuts and indexed repair obligations behind the frontier.
Concurrent source changes repair only affected ranges/results; new behind-frontier input is not silently skipped.
Per-key monotone heads can coalesce repeated changes, but pruning retained dirty work requires all live consumers covered or expired.
The bounded result quota limits retained consumers, not legal population; index routing avoids scanning all definitions on each write.

Finish with an owner-home CAS proving the build covers its dependency cuts, bootstrap and published epoch, then revalidate
current request admission and native/public observations around delivery. A stale completion cannot replace a newer result.
The initial facts/head use one caller-owned snapshot. PostgreSQL [Repeatable Read](https://www.postgresql.org/docs/18/transaction-iso.html)
keeps that snapshot: rereading its head inside the same transaction cannot detect later commits. Final observation needs a new
snapshot/serialized completion boundary; a global version comparison after unrelated changes must not discard all settled progress.
Owner writes make affected results unready before their next read; unrelated private changes preserve settled coverage.
Count serialization failures and retries as work, and retain progress across retries; a deadline/readiness flag alone is no proof.

Public current facets additionally need selected-statement projection, original/terminal source, membership, exclusions,
order, selected-but-ineligible internal repair locators and foreign source dependencies, exactly as filtered-lists requires.
Committed `semantic/search-source.ts:subjectSource` reads native source snapshots (batch cap 256),
`semantic/statement-disclosure.ts` supplies native statement audience/read machinery,
`semantic/disclosure.ts:readCandidateDisclosure` is a disclosure point explicitly not authorization,
and `content/source-fences.ts:readFences` supplies bounded source-fence points (100 tuples).
These do not implement whole-query behind-home observations, source-key selective foreign repair or ACK barriers.
`search/current-filter-plan.ts:compileCurrentFilter` and `search/current-leaf.ts:holdsCurrentStatements` are narrower matching tools.
Search refresh/checkpoint completion alone is not a physical-target/incarnation/meaning-definition privacy ACK.

Consequently public or foreign-dependent plans stay gated individually until the Source2a producer delivers commit-visible
start/end observation and indexed behind/changed-home access. A reduction repaired and ACKed during Q must still be detected.
Do not enumerate all home heads, publish private dependencies, or infer a complete native privacy port from its interface.
The precise Semantic question is which implemented source observations cover this population and its excluded/order inputs,
and how complete foreign registration/repair is fenced against old-snapshot or delayed positive applies.

## Adversarial traces

| Trace                                                                                    | Required outcome and physical reason                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No entry, retained own completed session; Bob has a different completion                 | Complete native state range makes `NOT state` true; own completed-session range makes `NOT completed` false. Bob's partition never enters the query. Explicit presence restricts the population separately.                                                                      |
| Two aliases; newer state equals its old value but receives a new sequence                | Native successful set changes sequence and source head. Winner key changes even if value comparison says no change; return no older matching state. Clear removes only its live row; Undo allocates fresh order with the exact restored pin/dates.                               |
| A million sessions on one subject; newest active completes                               | Native active/profile ordered seek finds replacement; structural extremum update seeks the next supporter. Neither progress-change history nor all sessions nor all aliases is sorted/scanned synchronously.                                                                     |
| Last readable original A becomes private; B was always withheld, terminal Z stays public | Counts may remain positive. Current A fails, Z cannot authorize B; query-wide observation dirties the eligible-support/result generation. Repair decides empty/alternative from complete original support, never returns a leaked Z.                                             |
| Parent label deleted with child cleanup paused                                           | Parent key invalidates before next read. Current parent defeats each stale positive; complete negative/replacement waits for covered indexed repair, without parent-delete fanout.                                                                                               |
| Build scans past C; own completion inserted then removed while build continues           | Old/new dependency keys and retained repair work cover C despite final truth resembling the initial truth. Completion CAS cannot certify a cut it missed; no broad restart and no head-equality-as-permission.                                                                   |
| Delayed first positive apply starts before merge gate, commits after it                  | Epoch contract's native home gate must either capture a pre-gate apply in rekey inputs or reject it after the gate. A pre-read global epoch cannot fence its later write. Re-read current native source/map/account before first apply; never relabel a saved positive with E+1. |
| Merge then unmerge while owner maintenance is delayed                                    | Original facts/pins remain unchanged. Pending mapping is not a self-mapping; derivative generations publish only after bounded receipts cover rekey plus concurrent changes. Old epoch cursors restart; delayed E work cannot attach to the later epoch.                         |
| Continue is first request; newest state is nonactive, older alias is active              | Proactively maintained chosen state defeats old active state; independent accepted active session can still qualify. Missing coverage is not an empty Continue page and GET cannot start repair.                                                                                 |

The epoch contract fixes participant identities to `search-canonical-index` and `library-private-follow-counts`.
It does not explicitly receipt owner candidate/support coverage. Semantic must answer whether an existing participant's
receipt includes that directory and its concurrent first applies, or whether the adopted participant contract must change.
Do not silently add a participant or treat follow-count completion as canonical membership completeness.
Registered store/bootstrap delivery must also establish coverage for concurrently created subjects, not only existing mappings.

## Members GET and native work integration

The adopted exception permits only idempotent derived preparation record plus durable work intent, keyed by actual
viewer/Collection/validated query+sort/meaning. No receipt, domain event, grant, header or user-visible resource state is permitted.
Return exact `202 {"preparing":true}`, `Retry-After`, the same validated URL and cursor on retry, and `private, no-store`.
Do not return partial members/operation URLs; exhausted ready output is `200 {"members":[],"next":null}`. Unavailable work is 503.
Continue GET has no such exception; its index must be maintained proactively from native source changes and bootstrap.

Actual [work registry](../../services/kernel/src/work/registry.ts) composes one DBOS runtime with caller-owned pools and registered modules.
[library/work.ts](../../services/kernel/src/library/work.ts) already registers steps/workflows and deduplicated event-driven
listing enqueue; it releases the Collection connection before subject work. Extend that infrastructure, not a new scheduler.
`library/shelf-maintenance-ops-contract.ts` effectful methods all throw; its typed intent is not an operational transaction.
`content/work.ts:createContentOperationClient` verifies an existing domain operation AND receipt in a read-only transaction
before enqueue; it cannot persist lawful GET preparation. `access/organization-close-work.ts` similarly models domain cleanup.

There is an actual integration conflict requiring Root/Core resolution before this GET path can be implemented:
`command/command.ts:runCommand` requires an event unless branded `noEffect`; the [command contract](../../services/kernel/src/command/README.md)
explicitly says `noEffect` cannot hide coordination writes or registered work. Its optional receipt does not solve that restriction.
`access/account-share.ts:shareAccount` requires a live CommandTransaction and locks the account `FOR SHARE`, checking active/unfenced.
`library/command-support.ts:createLibraryCommandRunner` supplies real owner authorization but also normal command semantics.
None of these exports is the event-free operational-intent transaction the Members exception needs.
Minimum Core question: what supported native transaction persists only derived prep+intent under the partition and terminal
account fence, without receipt/events or forged Actor/CommandTransaction? Define/deliver that narrow capability before consumption.
Its intent must survive enqueue failure and recover through existing work registration; quota/eviction must apply atomically.
Use filtered-lists' 32 private results/owner and 24-hour idle expiry, with current admission rechecked on read and worker apply.

## Legacy cutover and terminal custody

NULL `owner_write_seq` is unknown ordering, not zero, time, UUID, digest or source-type position.
`library/profile-migration-page.ts:pinLegacyFactsPage` provides bounded entry/session/copy pin pages (limit 100), but no chronology.
Inventory NULL live/archive rows through native owner-key seeks, register concurrent writes, and retain per-owner/domain cutover
coverage. Production set/clear/Undo must first use `allocateOwnerWriteSeq` inside their native authorized transaction;
successful equal-value set and Undo allocate, replay/failed CAS/expired Undo allocate nothing, and clear leaves no live tombstone.
Preserve archives' original nullable sequence, exact dates/pin and existing native restoration/incarnation semantics.

A bounded historical reconstruction is permissible only with a complete authoritative native owner-state-write order and
exact locators, plus a producer-approved counter/live-write cutover. No such reconstruction export is committed here.
An arbitrary enumeration assigned increasing counter values fabricates winners; background repair cannot call the live allocator.
Minimum producer question: which retained source proves total order for these pre-counter live states, including clear/Undo,
or must unresolved originals await actual owner reassertion? Reassertion is a real native state command, never automatic migration.
While unanswered, original fact reads, independently complete presence/label/session/holding predicates and logical empty Liked
can work without inventing state order. Canonical competing-state choice, its Boolean consequences and affected Continue ordering
stay not-ready. A direct original singleton does not prove an alias group has no other unsequenced state.

At terminal T fence every normal writer, prep enqueue/apply, epoch repair and delayed first apply against the native account.
Child-first bounded cleanup removes private facts/archives, labels/reservations, sessions/units/changes/heads, copies,
candidate/support/query-dependency/prepared work and private references; counter and source head are removed last.
The final native points are `library.owner_write_counter` and `library.fact_source_head`, each `(route,account_id)`.
Fact deletion triggers can recreate the head until then. Cleanup retries cannot resurrect it after completion.
`library/account-fact-purge.ts:purgeAccountFactsPage` currently covers only entry/copy/follow with native receipts/events;
it is neither the complete terminal participant nor the event-free GET mechanism. Completion must outlive DBOS history.

Each producer records exact receipt/event/workflow/payload locators at creation; Core/Events/editorial/work owners minimize
their actual shared payloads and acknowledge custody. Never erase shared stores by account-wide JSON scans or assume
Library-native exhaustion erases logs/caches/exports/backups. No new legal-hold/custody engine or financial retention is inferred.
An active PUBLIC completed generation A at T can survive as its fixed membership; pending B does not finish using private
facts, and private/unlisted/deleted outputs are erased under the adopted contract. No public GET executes a fresh private query.
Retained A still requires current subject disclosure; its completed membership is not permission.

## Evidence and independently bounded implementation cuts

Retain the complete native suites: `specs/dynamic-collections-{contract,outcomes}.test.ts`,
`specs/library-profiles-outcomes.test.ts`, `services/kernel/test/library/{continue-user-cases,released-profile-user-cases,
released-library-population,owner-state-order-api}.test.ts`, and shared filter/native source suites named above.
Allocator/DAO/schema passes do not replace released profile, first-public, dynamic, Continue or complete owner-query outcomes.
Add user journeys for label-only unprofiled presence, every sibling pin source, same-value winner/conflicts, independent copies,
own-vs-other completion, saved/NOT/order closure, withheld originals, foreign repair, first Continue and terminal A/B races.
Use actual accepted released roles and the recipe vegetarian/time≤30 plus presence/NOT-own-completed example;
retain exact expected quick/edge/other-owner-completed results and unknown facet exclusions from owner queries.
Specifically retain `{R-quick,R-edge,R-other-cooked}`; own cooked remains excluded after state clear.
Use two actual accepted release digests for pin/meaning changes; a generic fixture or current release alone is insufficient.

Measure 64/512/4096 minimum largest-scale growth independently across population, matches, sparse exclusions, labels,
aliases, owners, sessions/history, index depth and reduction arrivals; include millions of sessions on one subject.
4096 is not a population cap; the identity group's 4096-original cap is a separate admitted identity rule.
Count raw visited inputs, removed rows, current authority probes, alias work, lookahead, expanded query dependencies,
statements including triggers, points, rows, blocks, bytes, background input/result writes, retries and pool checkouts.
One home/backend connection at a time; release it before foreign reads/work. `database/pool.ts:withConnection` guards nested ownership.

Use existing filtered-lists ceilings, not new budgets: direct `c≤min(600,6s+3)`, ready `c≤2s+2`, bounded owner seeks/refills;
per-step preparation ≤1000 inputs/1000 result writes, one frontier, 16 statements, four engine calls and 4 MiB.
Also prove its points/rows/bytes/block limits, whole-read ≤12 statements/backend, composed bounds and shared privacy observation.
Admit direct only shapes with a matching selective ordered path; admit preparation only with finite retained coverage/repair.
Reject unsupported shapes before enumeration with adopted 422. A legal large admitted input needs monotone bounded steps,
not repeated restarts, population caps, empty-success chains or a walltime excuse. Continuous adversarial churn is counted explicitly.

Each following cut must be ≤400 changed production lines and ≤8 changed paths, including SQL/DDL and test paths;
split before implementation if its measured diff exceeds either. These are scopes against real exports, not promised new ABIs.

| Repeatable cut; planning ceiling (production lines / paths) | Concrete boundary and required proof                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native sequence set; 300 / 6                                | `entries.ts`, `entry-store.ts`, entry insert/update SQL and two native test paths use the existing allocator. Clear and Undo are separate equally bounded cuts after their real native producers exist. Keep `owner-state-order-api.test.ts`/profile assertions intact; prove rollback/replay.       |
| One native scoped range; 300 / 6                            | One migration, `progress-store.ts` or `entry-store.ts`, at most two SQL paths and two native test paths. Prove same-copy qualifiers or history-independent LIMIT-one/anti-existence; repeat by family, without bundling all predicates.                                                              |
| One directory family; 400 / 8                               | Directory schema/module, at most two seek SQL paths, one native writer/module pair and two tests. Consume native facts/profile helpers, not `canonical_source_fact` or reference witnesses. Prove first/last races and indexed extremum replacement; bootstrap is a separate cut.                    |
| One epoch/bootstrap phase; 350 / 7                          | One adapter consuming delivered Semantic runtime, at most three frontier/seek SQL paths, one workflow path and two tests. Preserve original keys; prove concurrent first apply or bounded rekey in separate cuts. Missing participant semantics must be resolved first.                              |
| Private invalidation; 400 / 8                               | One migration, one metadata module, at most three old/new-key or registration SQL paths, one source-writer integration and two tests. Then a separate same-ceiling frontier/repair cut uses `readOwnerFactVersion` as alarm only. Prove NOT/order/behind-frontier changes and unrelated-write reuse. |
| Native operational intent; 350 / 7                          | Core first delivers its supported event-free fenced transaction. Library consumer: one preparation module, at most two intent SQL paths, work registration, members route and two tests. GET exact response/no-domain-effects proof remains separate from worker completion/recovery.                |
| One Continue source; 350 / 7                                | `sessions.ts` or `entries.ts`, native activity/support module, at most two SQL paths, one migration and two tests. Preserve full Continue/released suites. A separate Liked consumer waits for Content's raw+version receipt; neither claims readiness from DAO proof.                               |
| One foreign or terminal phase; 350 / 7                      | One Source2a consumer OR `purgeAccountFactsPage` phase, at most three keyed SQL paths, one work integration and two tests. Separate foreign ACK from terminal custody integration. Preserve complete A/cancel B without fresh private reads.                                                         |

The shared source pattern is indexed native truth, explicit coverage, bounded resumable maintenance and independently fenced
authority. Adopt the directory plus private selective invalidation direction; obtain the narrow missing Semantic, Content and
Core producer answers before activating their dependent shapes. The report-presence acceptance establishes evidence only.

External primary references: PostgreSQL 18 [ordered indexes](https://www.postgresql.org/docs/18/indexes-ordering.html),
[partial indexes](https://www.postgresql.org/docs/18/indexes-partial.html), [transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html),
and [PostgreSQL License](https://www.postgresql.org/about/licence/), accessed 2026-10-29; paraphrased, no code copied.
