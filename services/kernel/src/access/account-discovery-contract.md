# Account discovery source and Search handoff

This is the Accounts-owned concrete source contract and a **co-owner ABI proposal**. Root and Search must adopt
its shared types, planner integration and wire before production callers use them. This specification installs
no runtime export, query endpoint, registry entry, index mapping or permission grant. The native suites beside
it contain current primitive proofs and future native red handoff cases, not evidence of delivered discovery.
[Universal search](../../../../docs/search-conditions.md) and [facets](../../../../docs/search-facets.md) are the
single Search policy; their condition, ordering, privacy, count and physical budgets apply without alteration.

## Delivered evidence and precise gap

Read these implementations when adopting the proposal:

- `access/account-data.ts`: `readPublicIdentities` is requested-ID attribution; `readPublicAccountByHandle` can
  forward former handles. Neither enumerates discovery. `readAgentPages` enumerates sitemap handles, not text
  results, current exact handle claims or kind counts.
- `access/active-account-page.ts` and `.sql`: deployment enumeration only, active AND not fenced, at most 100
  `(route, accountId)` keys. `account_active_pages` is its native partial index. Handleless accounts participate.
- `access/account-public-read.sql`, `public-identity-page.sql`, `account-views-read.sql`, `account-handle-read.sql`
  and `agent-pages-page.sql`: different allowlists/predicates; do not substitute one for another.
- `semantic/search-source.ts`: actual `subjectSource(pool, routeKey?)` returns `SubjectSource`; `read(partition, ids)`
  accepts at most 256 routable Subject IDs and returns `SubjectSnapshot`. `count(partition)` counts visible,
  nonredirected Subjects with partition position in one repeatable-read snapshot. Relation facets are Subject-only.
- `search/source.ts`: `IndexedSubject` has Semantic type, visibility, redirect, securityRevision, labels, aliases,
  descriptions and statements. An account ID, handle or public identity is not an `IndexedSubject`.
- `search/http/routes.ts` hydrates through `readSubjectSummaries`; `semantic/summaries.ts` supplies only
  `SubjectSummary`, including Semantic types, creativeWork and cover. No Account summary union exists.
- `search/work.ts` assembles only `subjectSource` and Subject listing counts. `indexer.ts`, `document.ts`,
  `generations.ts`, `runner.ts`, `disclosure/check.ts`, `service.ts`, `facets.ts` and `live-facets.ts` consume that
  Subject-only shape. There is no Account source, writer, query/count population or mixed-kind native assembler.

The attempt brief's `.temp/goal/search/accounts-discovery-current-interface-status.md` was absent in this
checkout. The implementations above establish the interface status directly; absence of that report does not
turn a proposed export into an implemented one.

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

| Authority / use | Full key and native anchor | Current version / required custody |
| --- | --- | --- |
| Account live population, display name, automation, publication, verification | `access.account(route, account_id)`; route from UUID bytes 10–11, partition `route >>> 4`, 4096 partitions | `transaction_id`, native state/fence/floor; `public_changed_at` is presentation time, not an ordered security revision |
| Exact current handle | `access.handle_claim(route, normalized_handle)`; route is first 16 bits SHA-256 UTF-8 spelling; its partition may differ | native state, account_id, transaction_id; lifecycle reservation/hold operation binds cross-anchor publication |
| Verification pointer / approval | `access.agent_page(route, subject_id)` on Subject anchor; account's `agent_subject_id`, `agent_verification_receipt_id`; request `(route, request_id)` | pointer is checked against current account/receipt and currently disclosed Subject; reverse/unverify invalidates dependents |
| Avatar | account's `avatar`, same account route enforced by schema; Content media full key and avatar guards | current media lifecycle/version, not stored URL; derived image variants share erasure custody |
| Public activity flags | account's `public_views`, `speakers_listed`; `account-views-read.sql` point batches | current native row, never a permission mirror; underlying content still checks its own Access |
| Attribution | account full key; requested-ID `public-identity-page.sql` | independent allowlist; no discovery/count authority |
| Source progress | `core.partition(partition_no)` position; command/event position and account anchor | same-snapshot position and rows; transaction UUID and wall time cannot order deliveries |
| Proposed Account row version | account full key plus new Accounts-owned monotone `discovery_revision` | advance on every relevant mutation, including both sides of handle publication and restoration; never reuse after purge/restore |
| Proposed dependent work | owner source key `(owner, partition, route, id)` plus physical generation/incarnation and revision | durable indexed frontier/locator; bounded resumable work, not scanning receipts or account history |

The new row revision and dependency custody are **required native additions**, not columns supplied by this SPEC.
`account_active_pages(route,account_id)` admits active/unfenced enumeration at limit 100; `account_agent_pages`
also requires non-null handle but does not prove claim validity. Neither is a text index or an exact query counter.
Source must validate route/partition and owner before I/O. Unknown owner/kind is an admission error, never routed
by trying Semantic then Accounts or interpreted as zero. Missing/unknown full keys are omitted uniformly.

## Proposed minimal typed boundary

These definitions belong to the eventual shared Search boundary after Root/Search adoption. Names below are
proposed, not imports callers can use today. Reuse actual `IndexedSubject`, `SubjectSummary`, `AvatarSummary`,
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
  page(partition: number, after: { route: number; id: string } | null,
       limit: number): Promise<AccountSnapshot & { next: { route: number; id: string } | null }>;
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
type DiscoveryPage = {
  hits: DiscoveryHit[];
  kinds: KindCountEvidence[];
  next: string | null;
  as_of: string;
};
```

`read` uses full keys, at most 100 accounts in a partition, in one repeatable-read snapshot per actual database.
Reject nonroutable/foreign-partition keys. Deduplicate input; unknown, erased or ineligible rows are omitted.
Read exact claims by grouped full keys on their actual databases with no cross-partition SQL join. The shared
whole-query observation must cover claim and Account authority together and revalidate before disclosure; a
per-database snapshot alone is insufficient across a rename. `page` is worker bootstrap, not a text result API:
partition-bounded partial-index keyset, limit 1..100, lookahead charged, next proves remaining eligible input.
If a candidate's claim is invalid it still contributes an eligible handleless row; do not lose the page frontier.
No discovery count is `page.length`, `count(*)` over arbitrary text matches or `SubjectSource.count`.

Keep the existing SubjectSource methods unchanged for catalogue-only callers. Introduce a discriminated source
registry with an explicit `accounts` entry supplying this source and current summary hydration. Adapt at the
shared query boundary; `kind` for Semantic entries is the actual configured catalogue type. The Account domain
supports text and kind; subject relation/Library/Realm/quantity leaves retain Search's not-applicable semantics.
Account facts under NOT never become a broadened complement through a made-up false value.

Search must own a native mixed query/count/summary assembler with verified request/deadline custody, one global
cursor, comparable native sort/seek, configured kind metadata and final whole-query privacy. No new per-Account
search endpoint is proposed. Adopt a versioned universal request/response around the existing Search transport;
retain catalogue endpoint compatibility. `DiscoveryPage` is the proposed output, **not** today's `subjects` wire.
The exact new wire/version and comparable relevance-key implementation require Root/Search adoption; all other
population and disclosure choices in this document are selected. No production caller may cast today's result
to this type. Account summaries are current native hydration, not an indexed profile copy. Missing summaries
withhold the hit and require bounded refill; never disclose a shell hit with a null summary.

Count evidence uses the exact same canonical Account eligibility and current text/claim basis as hits, including
rows excluded from the selected page. Search owns the broader designated-kind-leaf count plan under its sole
policy; actual `count(partition)` is a generation Subject count, not that interface. Existing raw facet buckets
cannot populate `KindCountEvidence`. Preserve exact zero, positive lower bound and unavailable distinctions and
never add a public total. Small exhausted mixed native populations must have exact counts; large populations
may use admitted maintained evidence or capped witnesses, never a match-linear aggregation.

## Writer and caller adoption inventory

| Owner and actual surface | Required change before activation |
| --- | --- |
| Accounts `lifecycle.ts` registration/pending/activate/claim/rename/redirect/expiry/tombstone | version + event/locator on every population/text reduction and restoration, replay-safe and atomic on its native anchor |
| Accounts `lifecycle.ts` raiseFence/advanceAuthenticationFloor/completeConsentBarrier/clearFence; `session-revocation.ts`, `recovery-completion.ts`, `auth-barriers.ts` | persistent native fence remains authority; both transient and persistent barriers dirty the actual queried populations at T |
| Accounts `suspension.ts`, `reinstatement.ts`, `operator.ts`, `operator-fence-work.ts` | suspend/reinstate/operator lowering and restore cannot resurrect stale identity; dependent steps use current revision and native eligibility |
| Accounts `preferences.ts`, lifecycle profile update, `agent-verification.ts`, `agent-verification-work.ts` | current summary withdrawal; label/verification changes locate affected Account copies by full key |
| Semantic `account-agents.ts`, current Subject moderation/fences/identity and summaries | invalidate verified-target presentation with native dependent repair; no account discovery through automatic agent Subjects |
| Content avatar/media lifecycle and erasure | invalidate avatar summary and all derived variants by media key; do not copy Content SQL into Accounts |
| Search `work.ts`, `runner.ts`, `indexer.ts`, `document.ts`, `indices.ts`, `generations.ts`, `reconcile.sql` | registry, Account bootstrap/current deltas, discriminated documents, keyed deletes, version conflict custody, complete activation and verification |
| Search `query.ts`, `service.ts`, `disclosure/check.ts`, `hits.ts`, `live-facets.ts`, `facets.ts`, `source.ts` | native mixed page, current excluded-row/count safety, source/owner validation, Account-domain admission; Subject relation facets remain Subject-only |
| Search `http/routes.ts`, `service-scope.ts`, `scope-source.ts`, `rating-subject-source.ts`, `rating-source.ts` | versioned transport and summary union; scopes/rating remain subject-domain; do not reinterpret account kind as a catalogue type |
| Web `search/search.tsx`, `search/results.tsx`, `search/suggestions.ts`, `search/search-queries.ts`, `search/search-params.ts`, `search/search-request.ts`, `routes/search.tsx` | consume adopted wire, key by kind+ID, render generic unknown kinds and Account identities, preserve one query/cursor, count unavailable vs zero |
| Web `media/summary.ts`, `features/pages/account-read.ts`, `features/pages/account.tsx`, `routes/@{$handle}.tsx`; generated `packages/client` | Account summary adapter/current handle navigation; no extra per-hit profile lookup, no Subject cover/type assumptions or former-handle search aliases |

These are adoption obligations, not assertions those files already support Accounts. Search suggestion results
must apply the same native Account truth if Accounts are enabled there. Account-only sitemap/speakers remain
native consumers of their existing contracts, not replacement query producers. Search owns the test-only native
handoff assembly described below; Web owns real recorded API stories after that assembly exists.

## Atomicity, late writers, rollback and restore

On each Account anchor, revision, native public mutation, durable event and reduction/dependency intent commit
or roll back together. Cross-anchor handle lifecycle already has reserved/held/publication phases: only exact
active claims can supply handle text. Each phase which changes either native side dirties the affected source
key before it can become public. No distributed SQL transaction or duplicated claim authority is introduced.
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

| Copy / custodian | Locator, reduction and erasure obligation |
| --- | --- |
| Native account/claims, lifecycle handle operations/effects and registration work (Accounts) | account anchor + exact claim key, immutable receipt/operation locators; deletion/retirement rules and bounded native purge retain only owner-authorized tombstones |
| Outbox/events/receipts, producer checkpoints, failed/retry payloads (Kernel + Accounts) | source key/revision and partition position; index intent contains keys rather than biography/private identity; retained payloads join existing deletion inventory |
| Public Account index current/building/retiring generations, replica segments, refresh/PIT/search caches (Search) | source-key-to-physical-generation locator; remove text, keys, ranking fields and stale summaries across all generations; old PIT remains blocked; physical reclaim/expiry is durable work |
| Exact query counter/witness/dependency rows, source coverage and privacy observation data (Search) | query population and source full key; atomic reduction invalidation, bounded reclamation, no permission mirror or reason-coded counters |
| Retained/prepared results, sort/text positions, cursor server state, frontiers and abandoned jobs (actual owner) | owner/output/generation + Account source key; participant registration and bounded locator work; encrypted cursor payload still has finite lifetime and no reusable authority |
| Summary/Web response/session caches, recorded fixtures and telemetry (Search/Web) | no persistent profile cache proposed; ordinary public cache invalidation/expiry must obey current disclosure; never log handle/displayName/text as reduction diagnostics |
| Avatar variants/CDN and verified Semantic label copies (Content/Semantic) | existing native owner erasure plus Account dependent locator; do not erase the independent catalogue Person merely because an Account is deleted |
| Backups/restore and late producers (each custodian) | retained deletion ledger and incarnation fence; restore scrub before serve, late item registration and purge through existing erasure coordinator |

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
Missing assembly fails explicitly; the native future cases are intentionally red until co-owner delivery.

The assembler controls only infrastructure it starts: pause/resume worker, capture/replay a real producer batch,
retain an actual immutable query observation, force a rollback at native mutation, restore its own backup and
report actual copy/erasure locators and physical cost. Principal/client denial controls alter real native grants
and client scopes independently. It can seed catalogue Person via ordinary Semantic writes; account fixtures
remain Accounts native writes. Its source read is the adopted native Account source, not `readPublicIdentities`.
Each case's assertions require useful settled output; a permanently unavailable implementation cannot pass.

Root/Search adoption decisions: shared discriminated registry/source/document/summary/count types; versioned
universal wire; native comparable sort/seek/rank implementation; whole-query Account/claim/target reduction
custody; writer/activation/rollback and erasure participation; test assembler plus Web/generated-client migration.
Accounts selects the population, text, exact-claim guards, version and native key inventory here. There is no
remaining Accounts product-policy question and no new research prerequisite.
