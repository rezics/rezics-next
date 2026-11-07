# Account discovery source and Search handoff

This is the adopted Accounts-owned native boundary for mixed discovery. [Universal
search](../../../../docs/search-conditions.md) and [facets](../../../../docs/search-facets.md) remain the single
Search policy. Native Account production does not grant query admission or certify a physical Search generation.

## Delivered native boundary and remaining Search connection

`account-discovery-source.ts` exports:

- `accountDiscoverySource(pool)` with the adopted `read`, `page` and generation-census `count` shapes below.
  The factory needs no route key or caller policy. Text contains only current displayName and an exact active
  current handle claim. Each source call uses one database snapshot, including its foreign-key claim probes.
- `readAccountDiscoverySummaries(deps, ids, options?)`, using actual Semantic `SummaryReaderDependencies`,
  Content `readAvatarSummaries` and Semantic `readSubjectSummaries`. Account revision and exact claim are
  revalidated after foreign hydration; an intervening change withholds the whole candidate. Classified
  unavailability of an optional owner omits that owner's avatar/verification fields. Unexpected errors and
  the overall request deadline still fail the read, and native Account revalidation must succeed.
- `readAccountDiscoveryWitness(pool, partitions)` returns native `{revision, claimRevision}` heads for up to
  100 partitions, including empty/excluded populations. This remains a current writer witness; it does not bind
  a registered immutable whole-query capture. Its nonempty reads use the native reduction reader below.
- `readAccountDiscoveryBindings(pool, partition, ids)` returns native Account revision, the exact live claim's
  route/revision and consumed claim revision. A writer must match its snapshot's Account revision and consume
  at least that claim revision, otherwise redrive then resnapshot. These bindings are internal, not public wire.

`account-discovery-reduction.ts` exports `AccountDiscoveryReductionHead`,
`AccountDiscoveryReductionBinding` and
`readAccountDiscoveryReductionBinding(pool, partitions, {deadline})`. The immutable copied binding is
`{owner:'accounts', heads:[{partition, epoch, revision, claimRevision}]}` sorted by partition. Each call requires
1–100 deduplicated integer partitions in 0–4095 and uses one bounded native REPEATABLE READ snapshot: one
`readPartitions` full-key batch and one population full-key batch, with no Account/claim row join. Each requested
home must have current active ownership and installed positive Account and claim heads. Missing, partial,
uninstalled, fenced, moved and expired observations throw existing typed unavailability. There is no omitted
home, successful empty proof, truncation at 100, per-row expansion or foreign checkout inside the snapshot.

The shared registered Source enumerates its fixed configured **whole Account and claim domain** in bounded
caller pages, including empty/excluded, zero-hit, NOT, order and count populations. Selected Account partitions
cannot establish hashed foreign claim coverage. A native binding says nothing about whether a caller supplied
the complete domain. It is useful only when the actual shared Source retains it inside its registered immutable
capture and compares every head and exact home coverage against that **original** binding at start and final
observations. A current start/final match or later repair ACK cannot replace the original binding. Changed native
heads invalidate the old capture even when current hits/counts look equal again; a fresh capture after actual
repair can succeed. No structural binding supplied by a caller grants query authority.

Exact registered root AST, order/read definition, whole owner-domain closure and actual Source/Search physical
incarnation remain independently mandatory. `epoch` is the current kernel ownership epoch, not a physical
backup/engine incarnation. Unknown/restored Source incarnation stays unavailable at its owner until real
activation. This observation creates no readiness/ACK, permission mirror or retained Accounts query store.

`account-discovery-work.ts` exports `consumeAccountDiscoveryClaim({pool, clock?}, intent)`,
`redriveAccountDiscovery({pool, clock?}, partition, limit?)` and `registerAccountDiscoveryWork(context)`.
An intent is `{route, accountId, revision}` with a decimal revision string; foreign consumption verifies its
persisted source obligation before starting the separate Account-anchor command. The ordinary Accounts work
module installs event wakeups and a bounded partition sweep by default. Source delivery emits the real durable
`com.rezics.access.account-discovery-changed.v1` event with `{route, accountId, revision, source:'account'|'claim'}`.
Delivery atomically replaces the exact pending obligation with that event; it is never a Search repair ACK.

Recovery scheduling uses one serial worker for sweep and coalesced source-event wakeups, holding at most one
pool connection. It starts one second after service launch and yields while foreground checkouts are waiting
or only one pool slot remains. A full pass with no delivery or coverage progress sleeps for the named
`ACCOUNT_DISCOVERY_IDLE_MS` (15 minutes); a source event wakes its home without restarting that idle pass.
A productive pass continues catch-up. Decision: every failed step retains its exact home and sweep/wakeup origin,
and retries with exponential 1–60 second backoff, which events cannot bypass; success resets the delay.
Classified unavailability and unexpected defects have distinct bounded diagnostics containing only home,
origin, reason and retry delay, never raw errors, SQL, Account data or stacks. A failed step does not advance
the sweep frontier. Each retry rereads durable obligations and obtains current native command custody; no saved
revision or authority is reused. Stopping cancels recovery and drains an in-flight step even when that step fails.
Persisted intents remain the recovery authority until atomically replaced by durable events.
An empty home currently executes eight SQL statements: two intent reads, then coverage BEGIN, timeout setting,
owner read, enrollment-head read, pending read and COMMIT. Thus an empty 4096-home pass costs **32,768** statements;
the earlier 36,864 count does not match this implementation. Idle intervals execute none.
`test/access/account-discovery-work.test.ts` pins startup/pool admission, empty-pass idle and timed recovery,
event coalescing, pressure backoff/reset, fault-cleared recovery and shutdown with a fake clock and pool.
`test/access/account-discovery-source.test.ts` also pins an actual durable obligation across a failed delivery
transaction and subsequent recovery from its current revision. These are source acceptance scenarios;
worker workspace typing and controller-executed scheduler/native acceptance are separate evidence.

Migration `20261030161528_account_discovery.sql` takes an exclusive Account/claim/preferences install cut,
initializes all 4096 census rows and existing source revisions, queues existing source keys, then installs native
hooks before releasing writers. Every Account writer, preferences writer and claim writer participates, including
internal commands and direct native maintenance. Census and heads advance transactionally; sequence allocation
is nontransactional, survives row purge and consumes rolled-back allocations. Claim changes write only their own
anchor's intent/head; the Account command permanently records consumed claim-partition high water. New rows
contain keys/revisions only and are registered with the existing Access erasure discovery owner. Source intent
rows coalesce and are drained into the existing event log. Census rows contain no Account identity.

Accounts uses the delivered `AccountDiscoverySource` and `AccountDiscoverySummary` types from
`services/kernel/src/search/discovery.ts`. The actual mixed producer in `search/account-discovery.ts` uses the
native source, exact bindings and claim redrive. The additive reduction binding above is the Accounts-owned
seam for Semantic/Search to retain in that same shared registered immutable Source; its consumer comparison
and physical-incarnation activation belong to those owners. Accounts supplies no substitute adapter/ACK and
changes no SubjectSource or Search runtime. A restored database must receive Search's new physical
incarnation and external revision high water before activation; restoring sequence state from an old backup alone
is insufficient. These are real remaining foreign-code seams, not another Accounts research prerequisite.

The native writer audit reuses the existing installation and counters: Account INSERT/UPDATE/DELETE hooks
cover state, fences, operator, handle, display name and all other Account fields, even on excluded rows;
preferences dirty the Account revision; claim INSERT/UPDATE/DELETE hooks cover pending/active/former-reserved,
release and rename phases on their actual hashed homes. Administrative Account/claim TRUNCATE advances heads.
Allocation serializes on the existing partition population row and uses the noncycling native sequence. Native
mutation, counters and durable intents commit or roll back together; async redrive cannot substitute for the
immediate claim head. No new counter or baseline installation is needed. Repair must preserve these heads and
sequence high water, never reset them or infer them from consumed cursors or `core.partition.position`.
Missing baseline/history remains unavailable until actual native installation and bounded default catch-up;
metadata cannot fabricate restored physical readiness.

`test/access/account-discovery-reduction.test.ts` exercises native empty/excluded and name-order populations,
rollback, foreign claim transitions before consumption, restoration and real redrive, and unavailable/partial
homes. It proves the owner heads; the shared immutable query/physical engine assertions remain consumer-owned.

Existing attribution (`readPublicIdentities`), former-handle lookup (`readPublicAccountByHandle`), active deployment
paging (`pageActiveAccounts`) and sitemap (`readAgentPages`) keep their distinct contracts and are not discovery.

## Population and text

Canonical discovery identity is `(kind='account', account_id)`, never a handle, operator ID or verified agent
Subject ID. The Account summary distinguishes `actor` and `organization`; automation remains an actor with an
operator. A catalogue Person/Organisation and its verified Account are independent hits and independently counted.
Do not create an Account Semantic type or deduplicate by label, claimed handle or verification link.

At authoritative evaluator T, native `access.account.state = 'active' AND NOT authn_fenced` is necessary for
**every** membership, text contribution, ordering key, summary and count witness. Pending, suspended, deleted,
physically erased and unknown rows cannot contribute. Recovery, credential reset, consent reduction, session
revocation, operator transfer/removal, suspension and deletion fences have the same undisclosed outcome from T.
The producer never sends fence reason, kind, receipt or floor to the public wire. A fence is effective on native
commit, before a worker processes it. Authentication eligibility of principal and client is independent of
candidate eligibility; endpoint admission and every referenced resource's ordinary Access check remain required.

Text comprises only current `handle` and `display_name`. Biography, links, avatar URL, operator handle, verified
Subject labels, email, controller, birth date, private preferences and prior handles are excluded. Match/rank uses
Search's adopted analyzer and grammar. No substring SQL, title-only fallback, private corpus ranking or aliases
from handle history. A non-null searchable/emitted handle requires the **exact** native claim key below, state
`active`, account ID equality and equality to the account's current handle. A former, pending, reserved, expired,
missing or foreign-owned claim cannot contribute text or navigation. This does not conceal an otherwise eligible
handleless account: displayName may match and its summary has `handle: null`; Web renders identity without a
handle link. A claim mismatch suppresses the handle, not evidence about the account's live display name.

Summary profile fields use the current owner allowlist and guards: current active/unfenced account, usable
avatar through Content's `readAvatarSummaries`, publication settings through Accounts, and current verification
on the account plus current Semantic target disclosure. `agent_page` is only a pointer, never proof of verification.
Missing/hidden/withdrawn targets omit the verification link; missing/removed media omits the avatar. Do not leak
profile fields through an indexed summary, sort key or count. ID attribution and deleted `{id,state,kind}`
tombstones remain a separate contract; discovery never obtains membership from `GET /v1/accounts?ids=...`.

## Native key, partition and version inventory

| Authority / use                                                              | Full key and native anchor                                                                                                                             | Current version / required custody                                                                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Account live population, display name, automation, publication, verification | `access.account(route, account_id)`; route from UUID bytes 10–11, partition `route >>> 4`, 4096 partitions                                             | `transaction_id`, native state/fence/floor; `public_changed_at` is presentation time, not an ordered security revision          |
| Exact current handle                                                         | `access.handle_claim(route, normalized_handle)`; route is first 16 bits SHA-256 UTF-8 spelling; its partition may differ                               | native state, account_id, transaction_id; lifecycle reservation/hold operation binds cross-anchor publication                   |
| Verification pointer / approval                                              | `access.agent_page(route, subject_id)` on Subject anchor; account's `agent_subject_id`, `agent_verification_receipt_id`; request `(route, request_id)` | pointer is checked against current account/receipt and currently disclosed Subject; reverse/unverify invalidates dependents     |
| Avatar                                                                       | account's `avatar`, same account route enforced by schema; Content media full key and avatar guards                                                    | current media lifecycle/version, not stored URL; derived image variants share erasure custody                                   |
| Public activity flags                                                        | account's `public_views`, `speakers_listed`; `account-views-read.sql` point batches                                                                    | current native row, never a permission mirror; underlying content still checks its own Access                                   |
| Attribution                                                                  | account full key; requested-ID `public-identity-page.sql`                                                                                              | independent allowlist; no discovery/count authority                                                                             |
| Source progress                                                              | `core.partition(partition_no)` position; command/event position and account anchor                                                                     | same-snapshot position and rows; transaction UUID and wall time cannot order deliveries                                         |
| Proposed Account row version                                                 | account full key plus new Accounts-owned monotone `discovery_revision`                                                                                 | advance on relevant Account-anchor mutations and foreign-dependency re-projection commands; never reuse after purge/restore     |
| Proposed native generation census                                            | `access.account_discovery_population(partition_no)` on the same native partition                                                                       | exact active/unfenced count; delta and Account mutation commit together, read with partition position; not a text-query counter |
| Proposed dependent work                                                      | owner source key `(owner, partition, route, id)` plus physical generation/incarnation and revision                                                     | durable indexed frontier/locator; bounded resumable work, not scanning receipts or account history                              |

The new row revision, generation census and dependency custody are **required native additions**, not columns supplied by this SPEC.
`account_active_pages(route,account_id)` admits active/unfenced enumeration at limit 100; `account_agent_pages`
also requires non-null handle but does not prove claim validity. Neither is a text index or an exact query counter.
Source must validate route/partition and owner before I/O. Unknown owner/kind is an admission error, never routed
by trying Semantic then Accounts or interpreted as zero. Missing/unknown full keys are omitted uniformly.

## Adopted minimal typed boundary

These definitions belong to the one shared Search boundary. The concrete native Account shapes are delivered;
the shared Search type module must supply the imports. Reuse actual `IndexedSubject`, `SubjectSummary`, `AvatarSummary`,
`SubjectSource`, `SubjectSnapshot`, `KeyRing` and verified request/deadline types rather than shadowing them.
All internal bigint positions/revisions stay off JSON. This is a discriminated union, not an extension of
Semantic `type` or a fabricated Account-as-Subject.

```ts
type DiscoveryKey =
  | { owner: 'semantic'; kind: string; route: number; id: string }
  | { owner: 'accounts'; kind: 'account'; route: number; id: string };
type IndexedAccount = {
  id: string;
  accountKind: 'actor' | 'organization';
  handle: string | null; // exact active claim only
  displayName: string | null;
  revision: bigint;
};
type AccountSnapshot = {
  partition: number;
  position: bigint;
  accounts: IndexedAccount[];
};
interface AccountDiscoverySource {
  read(partition: number, ids: readonly string[]): Promise<AccountSnapshot>;
  count(partition: number): Promise<{ partition: number; position: bigint; count: number }>;
  page(
    partition: number,
    after: { route: number; id: string } | null,
    limit: number,
  ): Promise<AccountSnapshot & { next: { route: number; id: string } | null }>;
}
type DiscoveryDocument =
  | { owner: 'semantic'; kind: string; value: IndexedSubject }
  | { owner: 'accounts'; kind: 'account'; value: IndexedAccount };
type AccountDiscoverySummary = {
  id: string;
  accountKind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
  automated: boolean;
  operatorId: string | null;
  avatar: AvatarSummary | null;
  verifiedAgent: { id: string; label: string; type: string } | null;
};
type DiscoverySummary =
  | { kind: 'subject'; value: SubjectSummary }
  | { kind: 'account'; value: AccountDiscoverySummary };
type DiscoveryHit = { key: DiscoveryKey; summary: DiscoverySummary };
type KindCountEvidence =
  | { kind: string; value: number; exact: true }
  | { kind: string; value: number; exact: false } // strictly positive
  | { kind: string; unavailable: true };
type DiscoveryKindMetadata = {
  id: string;
  labels: Record<string, string>;
  icon: string;
  count?: KindCountEvidence;
};
type DiscoveryPage = {
  hits: DiscoveryHit[];
  kinds: { values: DiscoveryKindMetadata[]; next: string | null };
  next: string | null;
  as_of: string;
};
type DiscoveryRequest = SearchRequest & {
  representation: 'discovery-v1';
  kindCursor?: string;
};
```

`read` uses full keys, at most 100 accounts in a partition, in one repeatable-read snapshot per actual database.
Reject nonroutable/foreign-partition keys. Deduplicate input; unknown, erased or ineligible rows are omitted.
Read exact claims by grouped full keys on their actual databases with no cross-partition SQL join. The shared
whole-query observation must cover claim and Account authority together and revalidate before disclosure; a
per-database snapshot alone is insufficient across a rename. `page` is worker bootstrap, not a text result API:
partition-bounded partial-index keyset, limit 1..100, lookahead charged, next proves remaining eligible input.
If a candidate's claim is invalid it still contributes an eligible handleless row; do not lose the page frontier.
The new `count(partition)` is exclusively the Account generation census required by today's `generations.ts`
consumer, read from the fixed native population row with `core.partition.position` in the same snapshot.
Native writers maintain +1/-1 only when active/unfenced membership changes; replay and rollback cannot double-apply.
Bootstrap initializes this finite census and catches up deltas before activation. It is not a general query count:
handle/displayName predicates require Search's separately certified population evidence. No discovery kind count
is `page.length`, `count(*)` over arbitrary text matches or `SubjectSource.count`.

Keep the existing SubjectSource methods unchanged for catalogue-only callers. Introduce a discriminated source
registry with an explicit `accounts` entry supplying this source and current summary hydration. Adapt at the
shared query boundary; `kind` for Semantic entries is the actual configured catalogue type. The Account domain
supports text and kind; subject relation/Library/Realm/quantity leaves retain Search's not-applicable semantics.
Account facts under NOT never become a broadened complement through a made-up false value.

Search must own a native mixed query/count/summary assembler with verified request/deadline custody, one global
cursor, comparable native sort/seek, configured kind metadata and final whole-query privacy. The concrete wire
proposal is opt-in `representation: 'discovery-v1'` on existing `POST /v1/subjects:search`; omission retains the
current catalogue response. It uses the same text/filter/sort/limit/cursor/languages/properties fields. Add the
closed `{kind:{in:string[]}}` leaf to that version's existing Boolean grammar; preserve `{type:{in:string[]}}`
and every released Subject meaning. The test assembler's `kinds` shorthand builds one designated kind leaf under
top-level AND, never a second selector authority. `kindCursor` resumes configured metadata only, without hit/count
re-enumeration. Its fixed page size remains subject to the existing policy's measured metadata bound; it is not a
new request-controlled allowance. Registry records contain canonical ID, owner source, supported domains,
localized labels/icon and summary discriminator; unknown entries cannot dispatch an unregistered owner.
`DiscoveryPage` is the proposed output, **not** today's `subjects` wire. Root/Search must adopt this exact
versioned wire and implement comparable relevance keys before activation; the native measurement and adoption
are engineering prerequisites, not unresolved Account product policy. No production caller may cast today's result
to this type. Account summaries are current native hydration, not an indexed profile copy. Missing summaries
withhold the hit and require bounded refill; never disclose a shell hit with a null summary.

Count evidence uses the exact same canonical Account eligibility and current text/claim basis as hits, including
rows excluded from the selected page. Search owns the broader designated-kind-leaf count plan under its sole
policy; actual `count(partition)` is a generation Subject count, not that interface. Existing raw facet buckets
cannot populate `KindCountEvidence`. Preserve exact zero, positive lower bound and unavailable distinctions and
never add a public total. Small exhausted mixed native populations must have exact counts; large populations
may use admitted maintained evidence or capped witnesses, never a match-linear aggregation.

## Writer and caller integration inventory

| Owner and actual surface                                                                                                                                                       | Required change before activation                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts `lifecycle.ts` registration/pending/activate/claim/rename/redirect/expiry/tombstone                                                                                   | version + event/locator on every population/text reduction and restoration, replay-safe and atomic on its native anchor                               |
| Accounts `lifecycle.ts` raiseFence/advanceAuthenticationFloor/completeConsentBarrier/clearFence; `session-revocation.ts`, `recovery-completion.ts`, `auth-barriers.ts`         | persistent native fence remains authority; both transient and persistent barriers dirty the actual queried populations at T                           |
| Accounts `suspension.ts`, `reinstatement.ts`, `operator.ts`, `operator-fence-work.ts`                                                                                          | suspend/reinstate/operator lowering and restore cannot resurrect stale identity; dependent steps use current revision and native eligibility          |
| Accounts `preferences.ts`, lifecycle profile update, `agent-verification.ts`, `agent-verification-work.ts`                                                                     | current summary withdrawal; label/verification changes locate affected Account copies by full key                                                     |
| Semantic `account-agents.ts`, current Subject moderation/fences/identity and summaries                                                                                         | invalidate verified-target presentation with native dependent repair; no account discovery through automatic agent Subjects                           |
| Content avatar/media lifecycle and erasure                                                                                                                                     | invalidate avatar summary and all derived variants by media key; do not copy Content SQL into Accounts                                                |
| Search `work.ts`, `runner.ts`, `indexer.ts`, `document.ts`, `indices.ts`, `generations.ts`, `reconcile.sql`                                                                    | registry, Account bootstrap/current deltas, discriminated documents, keyed deletes, version conflict custody, complete activation and verification    |
| Search `query.ts`, `service.ts`, `disclosure/check.ts`, `hits.ts`, `live-facets.ts`, `facets.ts`, `source.ts`                                                                  | native mixed page, current excluded-row/count safety, source/owner validation, Account-domain admission; Subject relation facets remain Subject-only  |
| Search `http/routes.ts`, `service-scope.ts`, `scope-source.ts`, `rating-subject-source.ts`, `rating-source.ts`                                                                 | versioned transport and summary union; scopes/rating remain subject-domain; do not reinterpret account kind as a catalogue type                       |
| Web `search/search.tsx`, `search/results.tsx`, `search/suggestions.ts`, `search/search-queries.ts`, `search/search-params.ts`, `search/search-request.ts`, `routes/search.tsx` | consume adopted wire, key by kind+ID, render generic unknown kinds and Account identities, preserve one query/cursor, count unavailable vs zero       |
| Web `media/summary.ts`, `features/pages/account-read.ts`, `features/pages/account.tsx`, `routes/@{$handle}.tsx`; generated `packages/client`                                   | Account summary adapter/current handle navigation; no extra per-hit profile lookup, no Subject cover/type assumptions or former-handle search aliases |

These are integration obligations; native Account hooks and hydration above are delivered, while Search and Web retain their own connection work. Search suggestion results
must apply the same native Account truth if Accounts are enabled there. Account-only sitemap/speakers remain
native consumers of their existing contracts, not replacement query producers. Search owns the test-only native
handoff assembly described below; Web owns real recorded API stories after that assembly exists.

## Atomicity, late writers, rollback and restore

On each Account partition, revision, native public mutation, population-census delta, durable event and reduction/dependency intent commit
or roll back together. Cross-anchor handle lifecycle already has reserved/held/publication phases: only exact
active claims can supply handle text. Each phase which changes either native side commits its own keyed reduction intent and partition-position
custody on that side. A claim command cannot increment an Account row on a foreign partition in the same
transaction. Its durable intent schedules an idempotent Account-anchor re-projection command, which advances
`discovery_revision` and records the consumed claim key/position before an index writer may publish that handle
version. Account source reads still check the live exact claim; a changed foreign dependency immediately
invalidates old query safety even while this command is pending. A writer must match both the Account revision
and consumed claim dependency position to its source snapshot, or resnapshot after the re-projection command.
This prevents two claim states with one Account revision from overwriting one another. No distributed SQL
transaction or duplicated claim authority is introduced.
The Search whole-query observation must reject an old immutable index/PIT after reductions on **either** anchor,
including NOT, zero-hit, order and broader count populations; checking returned IDs is insufficient.

Every derived write carries `(source key, source revision, partition position, physical incarnation)`; deletions
retain the winning revision until stale writers are impossible. Redelivery is idempotent, delayed lower versions
cannot overwrite or recreate, worker rollback cannot advance checkpoint, and partial bulk success cannot certify
activation. Initial backfill enumerates bounded native active keys, snapshots current rows and catches up events
before atomic activation of a complete generation. Failed activation keeps the previous safe incarnation; it
cannot serve stale unsafe observations. Deployment rollback disables the Account registry entry and writer
atomically with its wire capability, invalidates affected cursors and retains reduction/erasure custody until
all copies are reclaimed; never roll native fences or revisions backwards to match an old binary.

Lifted fences require current native active/unfenced truth and a new revision. An old recovery receipt cannot
clear a later fence. Additions may wait for index catch-up, but a settled restored generation must discover the
account again. A restored database/index backup receives a new physical incarnation, replays durable reductions
and erasures, repairs all dependents and catches up **before** activation. A tombstoned/erased account never
returns through backup replay, late bootstrap or old claim publication. Retained former-handle attribution is
not permission to reindex the old text. Restoration does not rewind erasure progress or identity epochs.

## Physical growth and all-copy custody

Use existing limits, not a new allowance: source pages/batches 100, exact claim full-key batches charged to actual
homes, current Subject source/summary maximum 256 only for those existing calls, sitemap maximum 1000 only for
sitemap. Count and summary work share Search's existing selected-page physical envelope; the proposed mixed
planner constants in the sole Search policy are not measured bounds. Account source/bootstrap cost is one
partial-index seek plus O(page) native rows and grouped exact-claim probes; its total backfill work is linear in
eligible finite input. Source progress never walks fence receipts, old handles, event or lifecycle history.
Current hydration has O(selected keys + explicitly bounded dependencies) rows, logarithmic native index blocks,
one connection per database and no per-kind connection/query loop. Actual engine iterator/shard work, Access,
bytes and denied/rejected/refill input count too. Text seek/rank growth must be measured by Search's native
engine harness, not inferred from partial-index EXPLAIN or a short result array.

The named growth suite fixes selected page at three and independently grows unrelated live accounts, excluded
accounts and history at 64/512/4096. It captures actual SQL rows, blocks, statements and native index names for
current primitives. Future native cases also grow text matches, corpus, configured kinds and copies independently,
with exact mixed small-population counts and native count unavailability at large populations. It must record
shared query cost, denied attempts, old immutable observations after live repair, restore and erasure cleanup.
No result-size or elapsed-time-only claim establishes a physical bound.

| Copy / custodian                                                                                                 | Locator, reduction and erasure obligation                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native account/claims, lifecycle handle operations/effects and registration work (Accounts)                      | account anchor + exact claim key, immutable receipt/operation locators; deletion/retirement rules and bounded native purge retain only owner-authorized tombstones                        |
| Outbox/events/receipts, producer checkpoints, failed/retry payloads (Kernel + Accounts)                          | source key/revision and partition position; index intent contains keys rather than biography/private identity; retained payloads join existing deletion inventory                         |
| Public Account index current/building/retiring generations, replica segments, refresh/PIT/search caches (Search) | source-key-to-physical-generation locator; remove text, keys, ranking fields and stale summaries across all generations; old PIT remains blocked; physical reclaim/expiry is durable work |
| Exact query counter/witness/dependency rows, source coverage and privacy observation data (Search)               | query population and source full key; atomic reduction invalidation, bounded reclamation, no permission mirror or reason-coded counters                                                   |
| Retained/prepared results, sort/text positions, cursor server state, frontiers and abandoned jobs (actual owner) | owner/output/generation + Account source key; participant registration and bounded locator work; encrypted cursor payload still has finite lifetime and no reusable authority             |
| Summary/Web response/session caches, recorded fixtures and telemetry (Search/Web)                                | no persistent profile cache proposed; ordinary public cache invalidation/expiry must obey current disclosure; never log handle/displayName/text as reduction diagnostics                  |
| Avatar variants/CDN and verified Semantic label copies (Content/Semantic)                                        | existing native owner erasure plus Account dependent locator; do not erase the independent catalogue Person merely because an Account is deleted                                          |
| Backups/restore and late producers (each custodian)                                                              | retained deletion ledger and incarnation fence; restore scrub before serve, late item registration and purge through existing erasure coordinator                                         |

Search must join the actual versioned erasure participant/locator protocol before the first Account copy is written;
no empty acknowledgement or declaration of no data substitutes for cleanup. Completion waits for late items and
all retained frontiers; exceptions have explicit purpose/expiry under deletion policy. Measure heap/TOAST, indexes,
text positions, MVCC/WAL, engine replicas/segments, retained generations and cleanup storage. Grow unrelated
history separately from current input and holders separately from accounts; reclaim steps remain bounded and
total work linear in the finite located copies.

## Executable native handoff

`test/access/account-discovery-contract.test.ts` uses real lifecycle registration, exact claims, rename phases,
fences and native public primitives. `growth-account-discovery.test.ts` uses the repository's physical capture.
Their future cases require Search to supply `test/search/support/account-discovery-native.ts`, exporting
`openAccountDiscoveryNative` with the test-only interface declared in the contract suite. This is a proposed
native test assembly, **not** a production export or a stub implementation supplied here. It must use the actual
kernel HTTP routes, worker/index, Accounts source/current hydration and actual Access principal/client controls.
It must never fabricate indexed hits, inject synthetic population arrays or hand-compute production counts.
Its test `query` result normalizes the adopted wire's kind metadata into a count evidence array; that convenience
is not the proposed public response. Native error responses normalize to empty hit/count arrays with their actual
HTTP status, not a successful unavailable page. `physical` returns native counters for the last query and `grow`
creates ordinary native fixtures for its named independent axis; it cannot return precomputed cost receipts.
Missing assembly fails explicitly; the native future cases are intentionally red until co-owner delivery.

The assembler controls only infrastructure it starts: pause/resume worker, capture/replay a real producer batch,
retain an actual immutable query observation, force a rollback at native mutation, restore its own backup and
report actual copy/erasure locators and physical cost. Principal/client denial controls alter real native grants
and client scopes independently. It can seed catalogue Person via ordinary Semantic writes; account fixtures
remain Accounts native writes. Its source read is the adopted native Account source, not `readPublicIdentities`.
Each case's assertions require useful settled output; a permanently unavailable implementation cannot pass.

Remaining Root/Search delivery: shared discriminated registry/source/document/summary/count types; the adopted `discovery-v1` wire; native comparable sort/seek/rank implementation; whole-query Account/claim/target reduction
custody; writer/activation/rollback and erasure participation; test assembler plus Web/generated-client migration.
Accounts selects the population, text, exact-claim guards, version and native key inventory here. There is no
remaining Accounts product-policy question and no new research prerequisite.

## Native public-filter maintenance

Account and handle-claim triggers publish the internal Account-domain pending key
in the original Semantic Source home in the same authoritative transaction. The
Account population and Source head use a consistent lock order. Rollback removes
both the native revision change and its pending work. Preference invalidation,
old and new claim identities, deletion and reset retain their original native
revision and terminal-account guards. Native Account revisions remain separate
from Semantic privacy-log positions.

The default Account discovery worker advances the retained Source reverse-key
frontier after its ordinary intent work. Each receiver applies its coverage
summary and registration generation in its own committed transaction before the
Source home advances its frontier. Sending an intent or applying a summary does
not acknowledge repair. Unknown receiver custody retains the pending interval; a
later enqueue survives retirement of an earlier captured interval.

`enrollAccountDiscoveryHome` retains the original native tuple and compiler-key
frontier under the same writer locks. Its receipt proves only that home enrollment
step. It does not certify population repair, a complete baseline, physical
publication or public-filter readiness. Population reads retain their existing
fail-closed guards until the original complete Source handover is available.

The returned `AccountDiscoveryEnrollment` keeps the native `epoch`, `revision`
and `claimRevision` separate from `sourcePosition`, the original creation/change
`creationPosition` and the Account-domain `enqueueRevision`. `keyDigest` binds the
complete compiler closure; nullable `receipt` remains absent until the retained
key frontier completes. A step inserts at most 900 keys, leaving room for native
control and receipt work within the existing maintenance allowance. Replays of a
sealed receipt retain its original positions and tuple rather than current heads.

`semantic/public-filter-coverage-baseline.ts` resolves that exact committed owner
receipt after releasing its writer home, then adopts it in the registration home.
The predecessor/root chain advances one home at a time. The original covered
generation is pinned before the first home; only the contiguous 4096-home chain
can seal the Source bootstrap. Existing enrollment rows without these original
receipts stay unknown. Each adopted baseline records its own outstanding repair
obligation on the existing home summary. Enrollment never copies an older
baseline's ACK or changes an immutable covered cut. Native Source settlement now combines the original
independently verified Subject and Account/claim window chain with genuine Search mixed physical
settlement. Each funded step acknowledges only one original baseline prefix on the same coverage
summary locked by apply, recording its actual observation/execution/settlement locator. It rechecks
original native authority around foreign work and retains later enqueue/revision/claimRevision
obligations. ACK does not change the registration change generation or an old covered/start cut.
The original terminal retains crash-resumable home progress after that ACK commit; Source pending
retirement still requires complete captured registration apply receipts and home/key revision CAS.
The bounded maintained population reader and complete response root remain sequential work;
current serving stays unavailable until those native bindings replace the old head sweeps.

The internal `advanceNativePublicFilterPreparation` handoff locates the actual
Source factory body without changing public Source method/result signatures. It
returns the original persisted bootstrap with incomplete preparation, allowing
Search to persist its ordinary registration repair job. Each job step resumes
that exact bootstrap and one retained home/key frontier. It cannot substitute a
new bootstrap, grant an ACK or open a PIT before the original complete seal.
Recovery distinguishes a sealed, genuinely begun bootstrap with no PIT yet from
an uncertain physical adoption; an adopted observation is always recovered by its
original native custody. Independent bindings without the native factory body
retain their existing public behavior.
