# Mixed Account and catalogue discovery integration

Status: implementation-ready Search proposal, pending the owner adoptions below. This is the missing
Account integration within the adopted universal-search scope. It does not expose a callable Account
search ABI, ship a producer, amend a frozen test, or establish a product, native or performance outcome.
The acceptance for this artifact is documentation formatting only, after integration.

[Universal search conditions](search-conditions.md) owns the product semantics.
[Search capabilities](goals/search.capabilities.md) records the remaining implementation evidence;
this proposal neither upgrades its evidence nor replaces that inventory.
[Accounts](accounts.md#public-identity), [Access public identity](../services/kernel/src/access/README.md#public-identity-read),
[Filtered lists](filtered-lists.md#budgets), [kind counts](search-facets.md#kind-count-exception)
and [deletion](deletion.md#account-erasure) retain their respective authority.
No topic is imported from the discussion repository.

## Selected boundary

An anonymous reader can enter one text/condition request and receive one ordered sequence containing
live accounts and configured catalogue kinds, with one confidential continuation. A catalogue Person,
its verified account, and an automated account's internal agent are different identities. A verification
link supplies context; it never collapses a Person into an Account or introduces an extra agent hit.
Existing Semantic eligibility continues to decide whether an internal agent is a catalogue candidate.

Select one shared derived public OpenSearch family, evolved from `subjects-gN`, with a fixed `kind`
field and a tagged document identity. Both Accounts and Semantic populate that family. All public
candidates are ordered by one engine query and ranking context. There is no Accounts text engine,
second public family, client federation, score normalization, quota or raw-score merge.
Native private plans remain at their existing owner boundaries; this slice adds no private producer.

Search owns the mixed request, registry assembly, documents, ordered engine execution, current-source
dispatch, generic hits, cursor, count certification and Search copy cleanup. Accounts owns discovery
eligibility, complete account population, active claims, public identity fields, lifecycle T, verification
truth and reductions. Content owns current avatar availability. Semantic owns catalogue truth and
released type metadata. Shared history owns receipt/event/work minimization through its existing fixed
participant; Search does not invent a new identity participant or new erasure coordinator.

The two whole implementation briefs below estimate respectively 1,150 and 1,450 changed implementation
and native-test lines. Those estimates describe complete slices, not a mandate to produce that many
lines. They include default wiring, failures, generated closure and native acceptance. No scaffolding
or isolated helper release counts as either brief's outcome.

## What is callable today

These declarations were read at this repository base; proposed interfaces below are distinct.

| Existing declaration or surface | Actual capability | Boundary it does not satisfy |
| --- | --- | --- |
| `SubjectSource.read(partition, ids): Promise<SubjectSnapshot>` in [source.ts](../services/kernel/src/search/source.ts) | Bounded keyed Subject snapshots; Semantic factory rejects more than 256 IDs | Account population or Account current discovery |
| `SubjectSource.count(partition)` | Subject population count and source position | Key-complete mixed population reconciliation |
| `IndexedSubject` / `SubjectSnapshot` | Subject type, visibility, redirect, security revision, texts and statements | Account identity or native Account disclosure T |
| `subjectSource(pool, routeKey?)` in [Semantic](../services/kernel/src/semantic/search-source.ts) | Native Subject implementation with partition snapshot | Account adapter; optional route key is not permission to omit default source fences |
| `readPublicIdentities(client, routes, accountIds)` in [account-data.ts](../services/kernel/src/access/account-data.ts) | Attribution for supplied IDs in request order | Enumeration; suspended-as-active attribution cannot establish discovery |
| `readPublicAccountByHandle(client, handle, at?)` | Active claim or live former-handle forwarding, then public profile | Active-claim-only search alias or exact-match evidence |
| `readPublicAccountByAgent(client, subjectId)` | Pointer plus current active verified account check | Population stream or proof that an account is unfenced |
| `pageActiveAccounts(client, {afterRoute, afterAccountId, limit})` | Deployment enumeration, limit 1–100, active and unfenced | Retained generation population cut, replay protocol or public ordered search |
| `readAgentPages(client, tokens, input, at?)` in `account-data.ts` | Public agent page feed with its existing projection | Search population certificate or ranked result producer |
| `readAvatarSummaries(client, ids)` in [avatar.ts](../services/kernel/src/content/avatar.ts) | Current media summaries, at most 256 IDs per call | Account profile eligibility or query-level reduction safety |
| `SearchService.search(principal, request, now?)` in [service.ts](../services/kernel/src/search/service.ts) | Current Subject search implementation | Mixed request, Accounts current-source composition or whole-query privacy proof |
| `SearchHit` / `projectHit` / `projectFacts` in [hits.ts](../services/kernel/src/search/hits.ts) | Subject labels/descriptions/facts | Generic Account hit with native current guards |
| `FilterRelease.types` in [filter.ts](../packages/filter/src/filter.ts) | Released catalogue types, bases and facets | A registry of enumerable Account kinds |
| `searchWorkModule` in [work.ts](../services/kernel/src/search/work.ts) | Default Subject index service registration | Accounts producer registration or complete mixed rebuild |

The current [mapping](../services/kernel/db/search/indices/subjects.json) is strict and has no `kind`.
Its payload parser requires a UUID `_id`; its templates request Subject partition/security metadata.
The current route fills Subject summaries after `service.search`. Extending only the DTO would leave
population, ordering, current disclosure and that final summary phase disconnected.
The current physical-generation discovery limits live generations to three. Keep that family and limit.

`readAgentPages` takes `{cursor?,limit?,viewer?}`, defaults to 1,000 and accepts 1–1,000;
its handle-only active-page feed is not the complete native Account source selected below.
None of these declarations is permission to call public profile lookup for every account during indexing.
Existing owner declarations and accepted work are trusted; this specification does not audit receipts,
calculate hashes, rerun foreign acceptance or make a native probe.

## Registry, identities and applicability

The proposed Search registry is an immutable assembled value keyed by its own meaning version plus the
pinned Semantic release. Do not add `account` to `FilterRelease.types`, forge Semantic statements,
or create a Semantic subject solely to make an account searchable.

```ts
// PROPOSED names; these exports do not exist.
type DiscoveryIdentity =
  | { family: 'subject'; id: string }
  | { family: 'account'; id: string };
type DiscoveryKind = {
  id: string;
  family: 'subject' | 'account';
  label: Record<string, string>;
  icon: string;
  summary: 'catalogue' | 'account';
  domains: readonly string[];
};
type DiscoveryRegistry = {
  meaning: string;
  semanticRelease: string;
  kinds: readonly DiscoveryKind[];
};
```

Choose one Account result kind, `account`, for both actor and organization identities. Preserve immutable
`actor`/`organization` in the account summary; automation remains `automated` plus `operatorId`.
Each configured catalogue type remains its own kind, using its existing type ID. Catalogue base/subtype
matching remains the meaning of `type`; kind selection is exact registry identity selection.
Registry assembly rejects an Account-kind/type-ID collision before publishing the new registry.
It never silently renames an existing type or adds a mapping field per kind.

The canonical document key is `subject:<UUID>` or `account:<UUID>`. `id` remains the routable owner UUID.
Deduplication uses family plus canonical ID; the admitted kind must agree with current owner type.
Catalogue redirects canonicalize only through Semantic's adopted identity machinery. Account IDs never
redirect through verified subjects or former handles. A type change is registry/identity-meaning work
under existing Search identity rules, not a second hit retained in the old kind.

The proposed `kind` leaf is `{kind:{in:["account","schema:Book"]}}`. It consumes one ordinary grammar leaf;
its `in` values consume the existing 64-value ceiling. Kind IDs are not SQL identifiers or field names.
The whole expanded tree retains 32 leaves, depth 4, OR 16 and four qualifiers per statement.
Saved filters and pinned agent-credit expansion retain the current owner contracts.

For Accounts, supported conditions are kind and the shared text request. Catalogue `type`, statements,
quantities, tags, Library presence, Collection members, Zone page populations and Realm discussed-subject
conditions are not applicable to Account hits. Their truth is unknown, including under NOT. Do not turn
an absent Account statement array into evidence of falsehood. All resource leaves are still resolved and
authorized before candidates, even if a kind branch or another OR branch already proves true.
An unrecognized condition is 422, distinct from a recognized leaf outside a kind's domain.

```json
{
  "text": "Mira",
  "filter": {
    "or": [
      {"kind": {"in": ["account"]}},
      {"and": [
        {"type": {"in": ["schema:Book"]}},
        {"statement": {"property": "schema:genre", "in": ["comedy"]}}
      ]}
    ]
  },
  "limit": 2,
  "languages": ["en"]
}
```

This selects matching Accounts through the first branch and matching Books through the second.
`NOT(type=Book)` alone does not select Accounts. `kind=account OR NOT(type=Book)` can select Accounts
through its proven kind branch; unknown does not override true. Eligibility is checked independently.

### Cost

- Touches: pinned release and registry, bounded expanded AST, resource authority and condition-domain dispatch.
- Bound: existing 32/4/16/64/4 grammar ceilings; all fixed work shares 16 points, 64 examined rows and the page statement budget. Registry assembly is once per meaning/release, not an uncharged per-request scan of all configured types.
- Growth check: 64/512/4,096 configured/source rows with request and returned metadata fixed; 32-leaf admission and 33-leaf rejection before candidates; unknown under NOT and authorization beneath true OR remain identical at every scale.

## Public document and comparable order

Use a new mapping/template format in the existing family. Rebuild before alias publication; do not edit
released immutable templates or reinterpret old `_id` payloads. Legacy Subject-only generations remain
readable only by their old format during transition. Mixed requests require a complete mixed-format target.

```ts
// PROPOSED closed projection; never deserialize an Account row into this type.
type IndexedAccountDiscovery = {
  id: string;
  handle: string | null;
  displayName: string | null;
  discoveryRevision: bigint;
};
type PublicDiscoveryDocument = {
  id: string;
  identity: string; // the tagged document key
  kind: string;
  family: 'subject' | 'account';
  partition: number;
  security_revision?: number; // required only for Subject documents
  account_revision?: string; // exact decimal bigint, required only for Account documents
  names: string[];
  descriptions: string[];
  name_sort: string | null;
  statements: string[];
  facts: SubjectFact[]; // existing document.ts type, not an Account statement schema
  active_handle?: string;
  relation_facet_overflow?: string[];
  public_collection_count?: number;
  rating_score?: number | null;
  rating_prior_epoch?: number | null;
};
```

For an account, `names` is the distinct non-null display name and CURRENT active handle; descriptions,
statements and facts are empty. `active_handle` exists only with an exact confirmed active claim.
It is a keyword using Accounts' lowercase ASCII lookup normalization. Preserve full display text.
Do not index biography, links, avatar URLs, verification pointers, public-view flags, credentials,
email, birth date, consent, controller, preferences, fence values/reasons or private lifecycle state.
Do not copy the full public profile and then blacklist fields.

The external version is the source partition position read with that source chunk. Account
`discoveryRevision` supplies the current-evidence comparison and must advance on every discovery-affecting
change. It is not a timestamp or a replacement for the partition log version. Store its exact decimal
value in fixed keyword `account_revision`; require Subject `security_revision` only for Subject hits.
Represent bigint versions exactly and reject unsafe numeric conversion at the existing sink boundary.

Use the existing `cjk_bigram_v2` and complete catalogue descriptions. Account handle/display name use the
same name fields and phrase boundaries. Do not substitute SQL ILIKE, `ts_rank` or biography text.
Keep the literal raw validated text bound to continuation: 512 UTF-8 bytes, depth 4, 64 text leaves,
32 phrase tokens and the current escape rules. Whitespace-only input remains 422 at `/text`.

Select comparator format `mixed-public-v1` with these native tuples:

| Sort | Comparable tuple |
| --- | --- |
| relevance | `_score DESC, id ASC, kind ASC, identity ASC` |
| name | `name_sort ASC missing-last, id ASC, kind ASC, identity ASC` |
| id | `id ASC, kind ASC, identity ASC` |
| collections | Existing Subject count/name/ID tuple, then kind/identity ties |
| rating | Existing Subject scored/unscored phases and all question/population/prior guards, then kind/identity ties |

ID precedes the new ties to preserve today's Subject tie order. Kind and tagged identity make even equal
UUIDs across families unambiguous. The key is per-hit and natively seekable using engine `search_after`.
Name normalization retains the 512-character normalized-key limit and null/missing-last behavior for
oversized keys; full names remain in source and searchable fields. Use the actual native writer path.

Retain exact-name boost 10 and phrase boost 3 from the existing template. Add a constant 10 exact active
handle clause to the shared query's optional boosts; it uses the entire valid lookup spelling from raw
text after lowercase lookup normalization, without trimming, dropping `@` or interpreting an expression
as a handle. It contributes only to Account documents with that current active claim. This is a proposed
additive ranking rule for owner adoption, not a claim about today's native sort output.

The same index observation supplies all candidate scores; there are no independently scored kind lists.
Use its actual common ranking statistics and bind their meaning to the identified observation. A shared
index alone does not prove that a reduction cannot affect another hit's order: refresh-visible repair
and scoring-statistics safety are part of the query-level ACK obligation below.

Collections/rating are Subject-domain sorts. Explicit selection of catalogue kinds, or a positive type
restriction proving only catalogue candidates, admits existing behavior. A default-all request asking
for either sort returns 422 `/sort`; Accounts do not receive fabricated zero ratings/counts or silently
fall out. This restriction does not disable ordinary mixed relevance/name/ID search.

### Cost

- Touches: one strict shared mapping, source chunks, common analyzer/name preparation, one shared engine query and native seek tuples.
- Bound: one public family and at most three live physical generations, independent of configured kinds; 256 IDs per source call and 64 envelopes per relay batch remain separate limits. A direct read shares `6s + 3ℓ + 3` candidates, `2ℓ + 4` index reads and the existing three refill rounds with all work.
- Growth check: 64/512/4,096 accounts and catalogue matches separately and together; fixed page size, long names, description-only Subject matches, CJK/phrase cases, same-name/same-UUID cross-family ties and deep native search_after; capture actual query-tree iterator steps rather than result count.

## Proposed Accounts ports

The following are complete proposed logical contracts. Accounts chooses native SQL/module placement on
adoption; Search cannot import these names until an actual committed declaration and default factory
exist. No type-only export, mock, attribution reader or list wrapper counts as implementation.

```ts
// PROPOSED. Methods execute native owner reads; no HTTP calls back into public routes.
interface AccountDiscoverySource {
  pagePopulation(input: {
    partition: number;
    after: string | null; // sealed opaque population position, never an account ID
    limit: number; // integer 1..100, reuses active-account page ceiling
  }): Promise<{
    partition: number;
    position: bigint;
    keys: string[]; // owner account UUIDs in traversal order
    next: string | null;
  }>;
  readProjection(input: {
    partition: number;
    ids: readonly string[]; // 0..100, all routed to partition
    atLeast: bigint;
  }): Promise<{
    partition: number;
    position: bigint;
    accounts: IndexedAccountDiscovery[];
  }>;
  readCurrent(input: {
    keys: readonly { route: number; id: string }[]; // at most 100
    context: PublicFilterConsumerContext; // existing type-only {deadline:number}, trusted composition
  }): Promise<{
    at: string; // authoritative native T, not caller-selected wall time
    results: AccountDiscoveryCurrent[]; // aligned, including explicit absent outcomes
  }>;
}
type AccountDiscoveryCurrent =
  | { id: string; outcome: 'absent' }
  | {
      id: string;
      outcome: 'live';
      revision: bigint;
      identity: {
        id: string;
        kind: 'actor' | 'organization';
        handle: string | null;
        displayName: string | null;
        state: 'active';
        automated: boolean;
        operatorId: string | null;
      };
      activeHandle: string | null;
      avatar: AvatarSummary | null; // existing Content type, after current profile/media guards
      verifiedSubject: { id: string; label: string; type: string } | null;
    };
```

`PublicFilterConsumerContext` is the existing type-only declaration in
[the Search consumer contract](../services/kernel/src/search/public-filter-consumer-contract.ts).
The proposed `accountDiscoverySource({pool,clock,tokens})` factory installs the actual native pool,
`KernelClock` and population cursor keyring once. `readCurrent` receives the original request deadline,
mints branded `AuthoritativeTime` with actual `mintReadTime` on its read connection, uses
`authoritativeTimeValue` for the returned T and releases that operational time in `finally`.
A caller timestamp is never accepted as T; a supplied account ID is never authentication evidence.
Public Account disclosure needs no fabricated Actor. Private preparation still requires its actual
verified request bridge. For commands, ordinary `principalCommandIdentity` and
`accessCommandAuthorization` remain unchanged. No action, client scope, grant or permission bypass is added.
All three methods carry internal actual work counters on success and on changed/unready/unavailable
outcomes through the composed read/worker context; exceptions do not erase already examined work.

### Population and snapshot rules

`pagePopulation` walks a durable per-partition Account discovery-key relation containing every account
that can require an index action, including ineligible rows needed for deletion/reconciliation. Use
an independent traversal ordinal allocated on account creation, unique within partition; index the
partition/ordinal prefix. Persist that ordinal in native ownership metadata, not in public documents.
It avoids account IDs in retained traversal cursors as required by deletion policy.

Do not use the existing active-only index as the sole complete population: an account fencing during
build could disappear from that walk while a stale document remains in the target. Read raw bounded
keys, then derive live projection; absent projection produces an explicit delete at the observed source
position. The active-account partial index remains useful for existing deployment commands unchanged.

A fresh generation captures per-partition start positions through existing finite rebuild machinery,
walks all owner key pages, then replays committed changes through the captured end frontier. Store the
walk position and source-log progress independently; never treat a key cursor as an outbox checkpoint.
An account created below a completed key frontier is impossible with monotonic ordinals; concurrent
updates/deletions are covered by replay. Reconciliation compares actual tagged key sets per partition,
including extra target keys, not just counts. Exhausted Accounts plus unvisited Subjects is incomplete.

Population reads use one repeatable-read snapshot per database/page. Projection `position` and rows
come from the same source snapshot, and must cover `atLeast`. Every returned key routes to the requested
partition, is unique, and is no larger than the admitted page. Source positions never derive from a
foreign DBOS timestamp, synthetic counter or index version.

`readProjection` accepts at most 100 account IDs; this is below Search's 256-ID source maximum and
reuses the Accounts batch ceiling. Chunk Account lists at 100 and Subject lists at 256, including
empty tails and failure/replay cases. No 100-ID limit becomes 100 candidates per kind per request.
Every chunk has its own source position; do not stamp later chunks with the first chunk's version.
A missing or ineligible key still has a source version and generates a delete, not a skipped action.

### Cost

- Touches: one partition/ordinal key page, current account full-key probes, partition position and durable population/replay frontiers; active-claim validation where a handle is projected.
- Bound: population pages and Account snapshots each accept at most 100 IDs; total walk follows finite Account keys, with no unrelated-history scan. Each maintenance step additionally fits 1,000 input keys, 1,000 result writes, one frontier write, 16 statements/backend, four engine searches and 4 MiB response bytes; split before any limit, not after fetching excess keys.
- Growth check: 64/512/4,096 unrelated accounts/history at a fixed page, and full populations at those scales; count raw keys, claim probes, rows, blocks, statements, bytes, writes and replayed input. Interrupt at each frontier and prove no more than one maintenance step is reread.

### Current discovery and summary guards

At native T, return `live` only for `state = 'active' AND NOT authn_fenced`. Pending, suspended, deleted,
erased, fenced and missing all yield the same internal `absent` result, with no reason or distinction
in public output, count, order or cursor. Attribution continues to return its existing public identity.
Never filter using the attribution reader's mapped `state: active`.

A non-null handle needs current `handle_claim.state = active`, matching account ID and the same current
account handle. Read that claim on its own anchor; no cross-partition join. Former/reserved claims,
`formerUntil`, `movedTo`, desired handle, pending reservation and old operation receipts do not qualify.
A non-null account handle with mismatched claim returns source-pending readiness, with no safe page;
it cannot be turned into a live null-handle summary or another account's claim. A genuinely null current
account handle is allowed. Current reduction safety prevents ranking on an obsolete projected handle.

Preserve the exact seven-field active public IDs identity item inside the summary. Do not add fence,
suspension reason, authentication floor or private operator/controller facts. Public `operatorId`
is permitted because it is already part of the IDs identity contract; an operator's handle/name requires
its own current read if ever rendered, and is not added in this slice.

Avatar is optional, taken through the active-unfenced profile guard and current Content media guard.
Missing, taken-down, malformed or unavailable media evidence gives no image; infrastructure failure
needed for safe query currentness gives readiness, never a stale URL. Do not trust `avatarUrl` or cached
image data from the public index. Charge media reads and availability reductions, even if no image survives.

`verifiedSubject` requires the current account to be active/unfenced, verified, naming that subject,
and the actual agent pointer to name this account. Semantic must still disclose the subject's label/type.
The effective predicate must equal the existing agent read, strengthened by discovery's unfenced rule.
A stale pointer alone proves nothing. A catalogue Person/Organization links to an Account only under
the same current guard. Reversal immediately removes badge and backlink before asynchronous pointer cleanup.
No Account biography becomes a catalogue description through this adapter.

An Account without an active handle remains eligible. Its generic canonical URL inputs are
`{family:"account", id, handle:null}`; Web must use the ID-capable account navigation fallback on adoption.
Do not fabricate `/@null`, use the former spelling, or suppress otherwise live public identity merely
because the current handle workflow is between anchors. A public ID read is existing functionality;
this proposal does not invent a new account HTTP route.

### Cost

- Touches: batched full Account keys, independently anchored active claims, optional current media, verified pointer and disclosed Subject context, all at trusted native read time.
- Bound: at most 100 account keys per owner call, 256 media IDs per Content call; these are chunk limits within the page's `16 + 8c` points, `64 + 16c` rows, six blocks/budgeted row and 12 statements/backend for one read. A port must coalesce by row kind/database; looping 100 single-row statements is not admitted.
- Growth check: 64/512/4,096 accounts, claims, pointer history and media with candidate keys fixed; native T races for fence, rename, reversal and takedown, across multiple homes, must retain the same point/row/statement/byte ceilings.

## Reduction, observation and custody protocol

This is a proposed extension of the existing owner reduction/currentness model, not an adoption of
superseded home-certificate, coverage-token or no-write settlement scaffolding.

Accounts must register discovery reductions in the SAME authoritative transaction as a fence, state
reduction, deletion/erasure, active-handle loss, display-name removal/replacement, verification reversal
or profile-image removal. Replacing a public string removes the old searchable/orderable string even
if the replacement is an ordinary addition. Treat removal half as immediate and addition half as
ordinary publication. Private edits with no discovery effect do not invalidate discovery.
Content avatar takedown and Semantic verified-label/target reductions register through their own native
owners; Accounts does not impersonate their authority. Foreign dependencies must reach Search repair.

The owner record identifies partition, source transaction/position, affected tagged identities and the
reduced field class, without copying profile text or a fence reason. Shared privacy-head registration
and an indexed unacknowledged/changed set supply complete partition coverage. There is no per-account
permission fanout, full 4,096-head request sweep or dependency walk on every hit request.

```ts
// PROPOSED Accounts append, using existing CommandTransaction/AuthoritativeTime types.
type AccountDiscoveryReduction = {
  partition: number;
  transactionId: string;
  time: AuthoritativeTime;
  identity: { family: 'account'; id: string };
  fields: readonly ('membership' | 'textOrder' | 'activeHandle' | 'avatar' | 'verification')[];
};
type RecordAccountDiscoveryReduction = (
  tx: CommandTransaction,
  reduction: AccountDiscoveryReduction,
) => Promise<{ head: PrivacyReductionHead; transactionId: string }>;
```

The selected proposed export is `access/account-discovery.ts:recordAccountDiscoveryReduction`.
It checks `currentCommand(tx)`, native partition/transaction/time binding and writes into the shared
per-home reduction registration in that transaction. Replay uses the command receipt; rollback leaves
neither revision nor reduction. No caller provides the future committed position as a claimed fact.
The executor finalization binds the log entry to the actual successful partition position.
One account mutation appends one bounded affected identity; reduction fields are exact-deduplicated.
The returned head is internal transaction-local evidence, never an engine ACK.

Reuse the ONE existing type-only `PublicFilterQueriedObservation`, `PrivacyReductionStart` and
`PrivacyReductionHead`; create no Account-specific observation certificate. Their native factories are
still prerequisites, not callable implementations. Propose a versioned mixed extension of the existing
Search `capture`, `query`, `repairStep`, `readStatus`, `closeObservation` operations, keeping those
method names and the canonical observation unchanged. Extend admitted capture meaning/input to the
registry and mixed AST; do not pass an Account kind as the existing catalogue `meaning.type`.
The consumer derives native registration/read-definition binding from both owner factories.

The shared source `readPrivacyReductionHeads` start/final results retain `all_native_homes`, the native
start cut, only pending/changed heads and routing completeness. Extend the common reduction log's cause,
affected dependency and impact unions with the Account identity/field classes above. Its existing
`readPrivacyReductionPage({partition,epoch,after,through,inputLimit})` remains the bounded worker port,
with `inputLimit <= 1000`, retained last-examined position and actual work on every outcome.
Search consumes Account entries through that same log, not a second request-time log walk.
These changes need Accounts/Semantic/Search adoption; they are proposed extensions, not existing ABI.
`repairStep` privately derives keyed native effects and ACKs; there is no public or caller-settable ACK
method. `readStatus` remains diagnostic and cannot certify safe disclosure by a Boolean assertion.

The canonical queried observation denotes actual immutable engine/PIT or prepared evidence. It cannot be a
made-up token over mutable state. Search owns actual refresh-visible repair and keyed sink success,
including all live/rebuilding generations and dependent summary/count/prepared copies. Accounts owns
its transaction/head registration and does not ACK an engine effect it did not perform.
ACK is monotonic and bound to a physical incarnation and covered queried observation, not only a name.

Request state machine:

```text
admit/authenticate static request and confidential cursor
  -> resolve current resource authority and identified registry/generation
  -> start whole-query safety observation
  -> execute ordered candidates and optional separately admitted kind counts
  -> batch current sources and project generic/owner summaries
  -> final safety validation after ALL summaries and counts
  -> disclose page and consumed frontier, or discard and return readiness/restart
```

A reduction committed between start and final invalidates the response even if Search has repaired and
ACKed it before final. Reexecute against a fresh safe observation only inside the original deadline and
remaining charged budget; otherwise return readiness. Never bless an old PIT with a new live ACK.
Do not commit a client frontier on a failed attempt. Current output reads do not certify excluded rows.

For text/relevance, ACK covers removal from membership, boosts, sort keys AND ranking statistics of the
queried observation. Engine delete/refresh is not assumed to remove a deleted document's statistics.
The mixed implementation must exercise that exact native schedule before it can claim safe relevance.
If a native observation cannot establish this safety, it remains unavailable and cannot be published as
safe; repairing a returned page or omitting counts is insufficient. This preserves the existing whole-query
privacy obligation rather than selecting a weaker scoring policy. Engine feasibility is future proof,
not an unresolved permission to use unsafe results or to change relevance without adoption.

Normal additions, fence lift and ordinary edits publish within 60 seconds healthy; lag over five minutes
returns readiness using actual source-to-searchable freshness. An owner write used in owner-local plans
retains next-read visibility. No account field discloses which authentication fence caused disappearance.
A registry/comparator/physical-generation/identity meaning change restarts an authenticated continuation;
ordinary row changes do not trigger a registry-wide restart.

### Cost

- Touches: native owner reduction registration, shared pending/changed-head indexes, actual dependent repair/refresh, exact observation evidence, start/final validation and current source work.
- Bound: page privacy observation shares the existing two-statement ceiling and `64 + 2 × (unacknowledged homes + changed homes)` examined rows across all 4,096 partitions; whole-page statements stay 12 for one read or `8 + 4R` composed. Repair uses the existing maintenance-step ceilings, not free background work or an extra per-kind privacy probe.
- Growth check: 64/512/4,096 unrelated data and increasing native reduction rates; delay and ACK between start/final, old PIT, foreign repair, crash and replay. Capture privacy subset plus inclusive page totals and served-read share; growing global permanent readiness fails the existing contract.

### Copy custody and erasure

Search registers each personal-data copy by exact locator and typed Account roles when the copy is
created, under [shared copy rules](deletion.md#account-erasure). The public Account document has one
subject-account role. A retained page/prepared result with Account summary or query text also carries
all typed roles actually copied; it cannot be discovered later by searching names in JSON.
Public operator ID is an additional role if copied. Keep it out of public index documents as selected.

Search owns `search-document` locators bound to physical index UUID plus tagged key, and any admitted
Search retained-result/cache artifact. Shared history owns copied receipt/outbox/durable-work bodies
through `command-receipt/v1`, `outbox-event/v1` and `durable-work/v1`. Native owner storage owns Account
rows, claims, key traversal metadata and reductions. The fixed Access participant handles
its native identity stores and shared history handles copied histories; no participant is added.

Before an external sink write, create a durable exact write intent and its ownership locator behind the
participant fence, without holding a DB connection during engine I/O. Settle only the exact keyed native
outcome after refresh visibility. A closed fence prevents new personal writes; a race or ambiguous write
opens a late item and remains unresolved until the exact physical copy is removed/minimized.
An enqueue intent alone is not proof that a DBOS artifact's locator was recorded.

Erasure immediately denies discovery at T. Cleanup enumerates owned locators across every live/building
physical generation and admitted retained copy, applies keyed deletion/minimization, drains pre-T effects
and resolves late items. A delete acknowledgement alone does not attest engine storage reclamation or
backup expiry. Report those through the existing custody protocol. A participant acknowledges only on
sealed complete coverage and indexed absence of unfinished work; `none` requires proof no copy applied.

Stateless encrypted client cursors are not server-retained Search custody, but are not erasure either.
Their 15-minute expiry never grants authority after T. Do not retain their plaintext in logs, histories
or caches without exact custody. Population/preparation traversal cursors use independent ordinals,
not encrypted or hashed account IDs. Public contributions surviving account erasure remain governed by
Semantic/Content de-identification policy; Search never rehydrates an erased account to label them.

### Cost

- Touches: exact physical-copy locators, write intents, participant fence/late items, owned engine deletes, retained-result minimizers and terminal existence probes.
- Bound: each cleanup/repair step uses at most 1,000 keys, 1,000 result writes, one frontier, 8 points/input, `64 + 16 × input` examined rows, 16 statements/backend, four engine searches, one connection/backend and 4 MiB response bytes. Shared-history discovery retains its separate fixed 4,096-partition walk, one partition/step; no deployment-wide JSON or name scan.
- Growth check: 64/512/4,096 unrelated accounts/artifacts and separately increasing copies of the erased account; exact locator progress, external-write ambiguity, post-fence event replay and unresolved late items must preserve bounds and prevent premature acknowledgements.

## Mixed response, frontier and kind metadata

Propose `POST /v1/search:query` as the mixed facade. It invokes the same public-family service, never a
separate engine or Accounts endpoint. Existing `/v1/subjects:search`, facets and suggestions remain
Subject-compatible adapters with an explicit catalogue domain; keep their current closed response keys
and frozen tests. They share the new family after cutover but do not suddenly return Account DTOs.
The universal facade and Search-backed page descriptor use one mixed contract after adoption.

```json
{
  "hits": [
    {
      "id": "00000000-0000-8000-8000-000000000011",
      "kind": "account",
      "kindLabel": {"language": "en", "value": "Account"},
      "title": {"language": "und", "value": "Mira"},
      "url": {"family": "account", "id": "00000000-0000-8000-8000-000000000011", "handle": "mira"},
      "summary": {
        "account": {
          "id": "00000000-0000-8000-8000-000000000011",
          "kind": "actor",
          "handle": "mira",
          "displayName": "Mira",
          "state": "active",
          "automated": false,
          "operatorId": null
        },
        "verifiedSubject": null
      }
    },
    {
      "id": "00000000-0000-8000-8000-000000000022",
      "kind": "schema:Book",
      "kindLabel": {"language": "en", "value": "Book"},
      "title": {"language": "en", "value": "Mira's atlas"},
      "url": {"family": "subject", "id": "00000000-0000-8000-8000-000000000022"},
      "summary": null
    }
  ],
  "next": null,
  "as_of": "2026-10-30T06:00:00.000Z",
  "kinds": {
    "values": [
      {"id": "account", "label": {"language": "en", "value": "Account"}, "icon": "account"},
      {"id": "schema:Book", "label": {"language": "en", "value": "Book"}, "icon": "book"}
    ],
    "next": null
  }
}
```

This is a closed proposed wire example with no claimed runtime ranking fixture. The full request uses
today's text/filter/sort/limit/cursor/languages/descriptions/properties options plus proposed kind-metadata
selection described below. The seven-field IDs item is preserved as `summary.account`; generic fields
are outside it. Account titles have `und` because Accounts stores no language tag. Catalogue language
comes from actual chosen labels. A missing display name falls back to the active handle, then a localized
Account/Organization label. Empty title maps are not a renderable generic base.
Optional `image` contains current public image data and an aspect class; omit it entirely if unproved.
Optional catalogue summaries/descriptions/facts retain their existing domain and language rules.
Unsupported kind summaries use generic base rather than triggering one read per hit in the client.

A continuation token is opaque in actual responses. `next:null` in the example assumes certified final
exhaustion. One global last-CONSUMED tuple records progress. Prefetched but unconsumed candidates do not
advance it. Consume rejected lookahead only when it reaches the ordered head; stop before an eligible
unreturned head. Supporting duplicates/rejects/lookahead/discards all consume the one shared work budget.

The one public engine already supplies the public head/EOF. Existing admitted private producers, if
participating under other contracts, must supply comparable native heads before any global consumption;
this slice cannot pretend they do by giving a viewer string to the Account source.
No per-kind frontier vector, returned-ID list, offset, round-robin or kind minimum is added.

The cursor binds original static request, viewer, language chain, sort, registry meaning, Semantic
release, comparator, physical UUID and queried observation/identity context through the existing
confidential profile. Preserve eight keys, 2,560 UTF-8 bytes/key, 3,072 aggregate string bytes,
3,584 serialized bytes, 4,864 token characters, 15-minute lifetime and two constant compatibility decode
attempts. Maximal actual rating keys must fit; do not append an unchecked ninth context key.
Authenticating static binding precedes dynamic reads. Invalid/mismatched is 400; authenticated expired
or changed meaning is 409; unsafe current evidence is readiness. No I/O during token decode.

Kind metadata is a bounded configured-order page, independently continued; missing metadata never
excludes kinds from default-all hit search. Choose a proposed transport `kindPage:{limit,cursor?}`,
limit 1–8, default 8, and `kindCountLeaf?:number`, the index of a direct top-level AND kind leaf.
Eight is a proposed metadata output size, not an increased read/engine allowance or adopted native proof.
Reject a count designation that is out of range or not precisely that leaf, before enumeration.
A metadata cursor binds request/viewer/registry/languages and never advances hit consumption.
Do not sort metadata by counts or construct count requests for all unseen kinds.

Counts are optional per metadata value, as `{value:N,exact:true|false}`. Remove only the designated kind
leaf for their population; all nested kind leaves and every other condition remain. Attempt counts only
on the initial hit request and within its remaining budget, using a separately authorized broader plan.
Bounded checked enumeration can certify a positive lower bound, or exactness on complete exhaustion.
Stop before exceeding shared work; omit unavailable counts and never manufacture zero. Native retained
preparation, when already admitted under the owner contract, can later supply complete counts; this slice
does not authorize anonymous retained state or a new public observation store.

The client retains the initial count presentation across hit continuation. A continuation response omits
counts rather than serializing a per-kind vector in the token or recounting. A response to later metadata
may omit counts. Existing property/value facets and public totals remain count-free, including compatibility
routes; unchecked OpenSearch totals are internal diagnostics only.

### Cost

- Touches: one ordered request, admitted candidate/current-summary work, confidential token, one bounded registry page and optional separately admitted kind-count population.
- Bound: standalone `s <= 100`, composed at most 16 distinct reads/128 slots; fixed bytes and points include metadata/counts. Request bytes are `64 KiB + 1 KiB × c`, response bytes `16 KiB + 4 KiB × c`; no count scan or extra eight engine searches follows from eight metadata values. Token limits remain literal above.
- Growth check: 64/512/4,096 kinds/matches/unrelated history with fixed metadata and output; first/deep/sparse pages, unconsumed prefetch, count-leaf transform, omitted counts, exact exhausted zero and maximal encrypted tokens. Capture inclusive counts and summaries rather than timing only the hit engine request.

## Owner adoption questions

These are exact decisions for adoption, not requests for another research round. The proposal chooses
an answer for each; owners either accept it or identify a concrete incompatible contract before dispatch.
No unlanded producer alone blocks the specification.

| Owner | Exact question and selected answer |
| --- | --- |
| Accounts | Will you own `AccountDiscoverySource` with the three proposed operations, literal active-and-unfenced predicate, native T/context and 100-key ceiling, instead of broadening attribution? Selected: yes; supply exact callable declarations in Access. |
| Accounts | Will you add per-partition independent discovery traversal ordinals and same-transaction discovery revisions/reduction registration to every relevant writer? Selected: yes; do not reuse active-only enumeration as completeness proof. |
| Accounts | Will you expose only handle/display name for indexed text and exact ACTIVE claim evidence, with no biography, links or former-handle aliases? Selected: yes; current summaries preserve the IDs item and current profile/agent guards. |
| Accounts and Search | Will a removal/replacement of handle or display name be an immediate text/order reduction, while additions and fence lift use normal publication? Selected: yes; no old string can remain a ranking/exclusion input after T. |
| Accounts and Content | Will native current batches coalesce Account/claim/avatar/verification reads per database and register foreign image reductions within the existing page budget? Selected: yes; absent image is allowed, stale image is not. |
| Semantic and Search | Will Search assemble Account kind metadata alongside released catalogue type metadata without changing `FilterRelease.types` into an Account schema? Selected: yes; preserve catalogue type/base semantics and distinct Person identities. |
| Search | Will the new mixed facade use one evolved `subjects-gN` family, tagged identity, comparator and exact active-handle boost, retaining Subject compatibility adapters? Selected: yes; no second per-kind query family. |
| Search and Accounts | Will repair ACK cover actual physical observation, current fields, exclusion/order and common ranking statistics, including reductions ACKed during a request? Selected: yes; refresh/delete alone is insufficient evidence. |
| Search and Performance | Will all Accounts, metadata, count, privacy and summary work fit existing shared page/step ceilings with no new allowance? Selected: yes; first native measurement determines whether a direct plan must prepare. |
| Search and Web | Will `POST /v1/search:query`, generic title/kind/url inputs, `kindPage` and optional initial counts be the mixed wire, including ID navigation when handle is null? Selected: yes; extend the existing Search descriptor after native adoption. |
| Search and shared history | Will exact Search physical-copy locators and all typed receipt/event/work roles use the fixed erasure participants, with no acknowledgement before sealed drain and late-item resolution? Selected: yes. |
| Acceptance owners | Will the frozen scenarios below become new native acceptance files, leaving all existing frozen files unchanged and reconciling any incompatible expectation through its owner? Selected: yes. |

After adoption, update the relevant owning contract with the decision and link this bounded implementation
plan; do not copy the entire plan into every owner document. This one-file specification does not edit
foreign authority or announce that owners have accepted proposed names.

## Whole implementation brief: Account projection and population

Outcome: the real default Search worker and production rebuild consume complete Accounts population,
produce only the approved public Account projection in the shared family, and remain safe through
lifecycle reduction, replay, competing writes and erasure. An isolated `readProjection` helper is insufficient.
Estimated implementation/native-test change: 1,150 lines, subject to minimal required generated output.

### Authority and adoption boundary

Consume the selected design above and the existing Accounts/Access lifecycle, handle and deletion contracts.
Adoption of native T/context, discovery ordinal/revision, reduction payload and copy locator ownership is
required before code imports them. This is an interface prerequisite, not a dependency on completing
unrelated Accounts functionality, foreign receipts or a second broad design review.
Trust accepted owners' native work. Do not independently rerun Auth/Accounts receipt checks to authorize
Search implementation. Add only scenarios exercising this slice's actual integrated boundaries.

Risk areas are authorization, disclosure, rights, deletion and account. Do not change credential validation,
consent policy, registration entitlement, membership formula or moderation decisions to make a fixture pass.
Use ordinary owner commands for account creation/rename/fence/verification/erasure in native tests.
SQL fixture seeding is limited to production-shaped growth background, not the user outcomes under test.

### Declared implementation paths and generated closure

Accounts owns proposed `services/kernel/src/access/account-discovery.ts` and its SQL files, discovery
revision/ordinal migrations, lifecycle writer hooks and `test/access/account-discovery.test.ts`.
Search owns `src/search/source.ts`, `document.ts`, `indexer.ts`, `runner.ts`, `generations.ts`, `indices.ts`,
`write-actions.ts`, `work.ts`, `db/search/indices/subjects.json` successor format and new immutable templates.
The brief's assignment must declare these account paths and all five risk areas; they are not automatically
opened by a Search-only path prefix. The product scope already authorizes this cross-owner implementation.

Generated SQL bindings belong with the changed SQL under the repository's normal generator configuration.
Native migrations generate `db/access/schema.sql` and any Search schema dump through the owning commands.
Do not hand-edit generated schema or dependency files. Do not edit `node_modules`.
No new public route in this brief means no new public OpenAPI/client method yet. If a shared exported source
type changes a generated consumer, include that consumer and generation command in the same implementation.
No separate ticket for a knowingly broken caller is permitted.

### Native persistence and creation inputs

Add the Account discovery traversal ordinal on the account's native partition, allocated during creation.
Use independent monotonic traversal identity, not Account ID, handle, name or hashed/encrypted identity.
Maintain an indexed `(partition, ordinal)` page and native account-key ownership mapping.
Backfill existing rows through a durable bounded key walk before declaring complete mixed population.
Backfill progress itself must satisfy cursor-erasure rules; use the owner's adopted ordinal cutover rather
than retaining an Account-ID cursor indefinitely. No production row is silently omitted because it predates
projection installation. Fresh deployments and upgrades both have explicit completion evidence.

Add a monotonic discovery revision separate from timestamps. Initialize it on account creation and advance
it in the SAME account-row transaction whenever indexed or guarded current presentation can change.
Allocate source versions through the existing core partition log/position. A discovery revision does not
replace a core transaction ID or change the log's type. The revision's value is never public output.

Inputs for the ordinary write hook are native old/new Account fields plus the committing partition position;
there is no caller-supplied `discoverable` Boolean. Output is either no discovery change or the exact tagged
identity, next revision and reduction field classes. For a display-name replacement it emits `textOrder`;
for a new non-null addition without removal it emits publication work. A fence always emits membership
reduction, including a temporary recovery fence while account state remains active.

### Native key and projection queries

A population page input `{partition:7,after:null,limit:2}` returns, for example:

```ts
{
  partition: 7,
  position: 241n,
  keys: [accountA, accountB],
  next: sealedPopulationPositionAfterOrdinal2
}
```

The page may include a deleted account key. It does not include any biography or a live identity item.
The sealed position binds partition and traversal format; an invalid/mismatched cursor fails before SQL.
Its independent ordinal is stable under rename, fence and erasure. `next:null` proves this key walk's
current end, not completion of replay or whole-generation reconciliation.

A projection input `{partition:7,ids:[accountA,accountB],atLeast:241n}` may return:

```ts
{
  partition: 7,
  position: 245n,
  accounts: [
    {id: accountA, handle: 'mira', displayName: 'Mira', discoveryRevision: 8n}
  ]
}
```

Search must write a version-245 Account replacement for A and a version-245 delete for B.
A response position below 241, foreign key, duplicate account, wrong partition or unsafe revision rejects
the entire chunk before any sink effect. Do not accept partial records and then checkpoint the batch.
The production Account query selects only approved public fields plus private guard/version columns needed
internally, constructing a closed projection before leaving the owner boundary.

Projection uses the same native active/unfenced and active-claim predicates as current disclosure.
Cross-anchor claim evidence is read independently under the owner protocol. If the claim changes during
snapshot assembly, do not certify a formerly active handle; retry within the bounded step or return
source-pending readiness. Only an actually null account handle projects a null handle. Never hold an account write lock across another
partition or external engine I/O. Current source reads do not become command permission.

### Event and writer closure

Account creation/activation, public update, display-name changes, rename publication/retirement, suspension,
reinstatement, authentication fence set/clear, terminal deletion, erasure, operator transfer and verification
completion/reversal must each be classified by effect. Account text depends only on handle/display name;
operator and verification changes still affect current summary/revision and copy invalidation.
Avatar change/removal is a current-field dependency, even though avatar is absent from the public document.
Private biography/link edits do not emit text work. Public-view preference changes do not add hidden fields.

Use exact existing event declarations from the owner's module when implemented. Do not guess an event
spelling and advertise it as shipped. Reuse `account-updated` and owner lifecycle effects where their actual
payload covers the operation; add a minimal owner-declared effect where a fence currently lacks one.
Every relevant command must register a reduction in its authoritative transaction, not later in a relay.
The ordinary relay may carry additions after commit. Native tests must distinguish these two timelines.

The complete Accounts population source is installed in the actual Search default starter. Keep
`KERNEL_WORK_MODULES` registration exactly once and the existing one-launch worker lifecycle. Search
startup, configured-off mode, failure after another starter and stop/drain all keep their native semantics.
A captured starter called by a test is useful unit coverage, not default composition evidence.

The CLI rebuild path and any one-off index runner must use the same native Account factory and canonical
route key as the default worker. No default can fall back to a no-op Account source or skip a missing
Account factory. Missing configuration/readiness must be explicit, preserving a safe prior alias.
Account batch/source limits are validated in production, not only in tests or public routes.

### Document construction and keyed sink rules

Add fixed `family`, `kind`, `identity`, `account_revision` and `active_handle` mapping fields in the new generation format.
Keep Subject statement/fact/relation-overflow fields unchanged. Account documents contain empty Subject
arrays and no fabricated Subject type, security semantics, rating or Collection-count field.
The source's discovery revision maps to exact decimal `account_revision`, not a lossy numeric Subject
security revision; do not rename the
private `authn_fenced` Boolean to a public keyword or expose a fence reason for debugging.

Tag sink keys before every write and delete. Validate returned bulk keys, operation type and physical index
against the requested action, with exactly one result per action. A successful HTTP status with an error
body, missing action, duplicate action or wrong key fails settlement. A 409 is not a refresh-visible winner
receipt. Resolve the actual superseding keyed winner and shard success before checkpointing.

Use the source chunk's exact external version and production name-normalization path. Oversized normalized
name keys become null/missing-last while full names remain searchable/current-displayable. Native ICU
behavior belongs in acceptance; a JavaScript approximation in a helper is insufficient.

Index input is finite but a 64-envelope batch can name more than one source chunk. Deduplicate affected
identities per family, partition and batch. Read all Account tails at 100 and Subject tails at 256; every
chunk produces its own positioned actions. Checkpoint only after all actual required effects are visible.
Later-chunk failure leaves the batch replayable even if early chunks already succeeded.

### Generation population and state transitions

The generation lifecycle is `allocated -> populating -> replaying -> reconciling -> ready -> active`.
A failed step remains at its last durable frontier and never publishes the alias. A cancelled build stops
scheduling, drains in-flight writes, then retires only its own target through the normal lifecycle.
Keep at most three live generations; concurrent rebuilds use existing admission/locking, not a fourth target.
The population state identifies actual engine UUID, mapping/comparator/registry formats and both producers.

For each of 4,096 partitions, walk all Subject and Account keys and retain their independent frontiers.
Replay each owner's native committed changes to the chosen finite end position. Compare actual tagged
source/target keys and versions, detect missing AND extra keys, and repair within bounded steps.
Equal counts are a useful diagnostic, never sufficient completeness evidence. Partition counts from
SubjectSource alone cannot certify a mixed generation.

Before atomic alias switch require both owners' complete identified population, current reduction safety,
actual refresh-visible keyed writes and compatible mapping/comparator. Empty Account source cannot stand
in for a missing producer. If no eligible Accounts actually exist, prove exhausted native population plus
replay and reconciliation; then the empty subset is valid.

Rebuild while an account fences: stale pre-fence reads cannot publish an eligible Account after T.
Generation repair must cover the rebuilding target as well as active reads. A lost metadata CAS does not
undo an external write. Preserve the existing identity-epoch/index fencing design against late writes,
including after native engine delete-version pruning. Do not add an unrelated safety-token store.

Alias change makes old authenticated mixed cursors restart. Old Subject compatibility cursors keep their
existing generation-change response. Retire old physical indexes after the existing activation grace,
then consumer checkpoints; failed physical deletion prevents claiming copy cleanup. No accidental auto-create
of a retired index may resurrect erased Account documents.

### Failure, rollback and replay table

| Injection | Required result and durable state |
| --- | --- |
| Invalid projection snapshot before I/O | No sink effect; no checkpoint; reject entire chunk |
| Source unavailable on tail chunk | Earlier effects may exist; batch checkpoint unchanged; replay all unresolved work |
| Engine wrong key or success-with-error | No success settlement; retain exact write intent and retry obligation |
| Winner exists but not refresh-visible | Wait/retry within owned worker operation; no checkpoint or privacy ACK |
| Crash after visible write before checkpoint | Replay same positioned action; no duplicate identity or lost tail |
| Crash after population frontier | Resume next bounded page; replay at most one uncommitted step |
| Account fences after source read | Immediate owner reduction invalidates public use; late effect cannot restore eligibility |
| Rebuild reconciliation mismatch | Do not switch alias; retain repairable target and exact discrepancy frontier |
| Physical index replaced under same name | UUID mismatch; reject old settlement/ACK and require current generation handling |
| Retired-index late write | Native fence refuses effect; no auto-created physical generation |
| Erasure while external response ambiguous | Open late item stays unresolved until exact physical copy is minimized/purged |
| Worker startup failure or stop | Drain owned relays and connections; do not stop another fixture's resources |

Rollback a source command by rolling back its own reduction/event/revision writes in the same native
transaction. Never send a sink action from an uncommitted source command. Rolling back an engine failure
means leaving durable repair work pending, not pretending to undo a previously accepted engine operation.
Replay always rereads current source state; an old event body cannot recreate old display text or handle.

### Frozen future native scenarios: population and source

These cases are frozen design examples to implement as real tests after owner adoption. They are not
imported modules or evidence of current execution. Keep the existing acceptance suites unchanged.

```text
File: services/kernel/test/access/account-discovery.test.ts
Case: only active unfenced rows project
  Given native pending, active, suspended, deleted and active-fenced accounts
  When readProjection reads all five routed keys at a covered partition position
  Then exactly the active-unfenced projection appears
  And every omitted key has an explicit delete when the real indexer applies the chunk
  And readPublicIdentities still presents suspended attribution under its own contract

Case: exact claim excludes former forwarding
  Given account A renamed old-mira to mira through ordinary lifecycle work
  When the old handle direct lookup still forwards
  Then Account projection contains only mira as searchable handle
  And old-mira supplies neither alias text nor exact active-handle evidence
  When another account later owns old-mira actively
  Then only that account can obtain its exact-handle boost

Case: current revision and native position are independent
  Given two changes to A and one unrelated write in the same partition
  When a projection chunk covers the committed obligation
  Then position covers all required log work and discoveryRevision covers A's presentation
  And source returns exact bigint versions without timestamp substitution

Case: enumeration includes ineligible deletion keys
  Given eligible A and ineligible B in the discovery-key relation
  When B fences while a generation population page is being read
  Then page/replay reconciliation never loses B's required delete
  And complete key coverage does not depend on active-only partial-index membership

Case: guarded summary never borrows attribution eligibility
  Given a suspended account whose IDs attribution is active
  When readCurrent runs at native T
  Then its aligned outcome is absent with no suspension reason
  And the public query cannot obtain its name, URL, count or cursor contribution
```

```text
File: services/kernel/test/search/account-population-native.test.ts
Case: native chunk tails and exact versions
  Given 257 Subject keys and 201 Account keys affected by committed events
  When the default indexer processes the captured work
  Then Subject reads are at most 256 and Account reads at most 100
  And every tail key receives the position from its own source snapshot
  And checkpoint follows visibility of all keyed operations

Case: later chunk failure and replay
  Given the second Account chunk fails after the first is refresh-visible
  Then the captured checkpoint does not advance
  When the native worker restarts
  Then all remaining keys converge without duplicate hits or missing tails

Case: native normalization and closed documents
  Given oversized display names, CJK names and biography-only sentinel text
  When default worker and production rebuild both write the accounts
  Then full approved names remain searchable and oversized sort keys are missing-last
  And the biography sentinel is absent from documents and search matches
  And credentials, fence state and verification payload never occur in documents

Case: competing sink winner cannot be guessed
  Given native conflicting writers and a delayed refresh
  When an old action receives 409
  Then no checkpoint or repair ACK advances until the real keyed winner is visible
  And wrong-key or success-with-error responses keep durable work unfinished

Case: default worker custody survives crash
  Given a recorded external-write intent and a lost engine response
  When erasure closes the participant fence and the worker restarts
  Then the exact physical key is removed or proven never applied
  And its late item resolves only after native cleanup, not on enqueue
```

```text
File: services/kernel/test/search/mixed-generation-native.test.ts
Case: population completeness is both producers and exact keys
  Given a rebuilding generation with one missing Account and one extra Subject
  And engine counts happen to equal source counts
  When production reconciliation runs
  Then the alias cannot switch until both discrepancies are repaired
  And the final certificate names actual physical UUID and both source populations

Case: concurrent fence and late older writes
  Given an Account population read paused before its sink action
  When the account fences at T and repair completes
  And native engine delete-version history is actually pruned
  When the paused old writer resumes and loses its core CAS
  Then the Account is not restored in any active or building generation
  And a new write to a retired physical name cannot auto-create it

Case: interrupted full population resumes
  Given bounded native population at the three required scales
  When stopped after each durable page boundary and restarted
  Then one step at most is reread and finite input reaches ready
  And replay plus source/target key reconciliation precedes alias publication

Case: physical incarnation and shutdown
  Given the normal default worker, rebuild and isolated fixture supervisor
  When a target is replaced under the same name or a later starter fails
  Then old UUID evidence cannot activate it and owned services drain
  And another concurrently running fixture keeps its own resources
```

### Native acceptance commands and delivery

After native ports and tests exist, run these commands from the repository root using the normal check
scheduler. These are real kernel check entry points; the named new files are future implementation outputs.
Do not run them for this specification artifact or invent empty passing modules with these filenames.

```sh
bun run --cwd services/kernel check test/access/account-discovery.test.ts test/search/account-population-native.test.ts test/search/mixed-generation-native.test.ts
bun run --cwd services/kernel check test/search/growth-account-population.test.ts
bun run --cwd services/kernel typecheck
```

The growth file must execute the axes and raw counters in the operation Cost sections, including native
source chunks, rebuild, copy cleanup and replay. Keep fixture-owned Auth/kernel SDKs in separate processes
as [the outcome harness](../services/kernel/test/search/README.md) requires. The real default worker,
not an injected starter/source/index response, performs convergence and rebuild.

SQL imports use Reylo content mapping; generated client declarations include required `.sql.d.ts` closure.
Validate new SQL through the existing compiler/analysis workflow and generate schema through derived. For a schema
change, `bun run --cwd services/kernel derived schema` writes dumps from its own migrated database;
`bun run --cwd services/kernel construct` validates normal kernel construction; it does not write contracts.
Use `bun run --cwd services/kernel analyse` for release SQL analysis; include its required release output
under the normal build policy, without pretending it generates a second handwritten binding layer.
Do not run database generators during this documentation task.

Deliver exact native declarations, writer/consumer closure, current-source default factory, schema/bindings,
new tests and measured outcomes together. State any native assertion not yet met as pending; a source export,
formatter, compiler or isolated storage test cannot stand in for default producer proof.
No `after` edge is needed for mixed request design, overlapping Search paths or unrelated owner completion.
The mixed request implementation needs the adopted native source/reduction interface to land before its
final integrated acceptance; that is the only code prerequisite introduced by this brief.

### Cost

- Touches: full Accounts writer/source/default-worker/rebuild/retirement closure and exact copy custody, including failed actions and replay.
- Bound: all population, current-source, generation and custody operation ceilings above apply cumulatively; no extra budget follows from a second owner or the 1,150-line estimate. At most three physical generations and one connection/backend/step, released before engine I/O.
- Growth check: `growth-account-population.test.ts` executes native 64/512/4,096 population/history/copy axes and first/tail/interrupted/replayed steps; publish raw rows, blocks, statements, keys, bytes, engine operations and frontier writes, not just elapsed time or helper call counts.

## Whole implementation brief: mixed request and current disclosure

Outcome: one real native request can search Accounts and configured catalogue kinds, return generic
renderable ordered hits, continue without loss, and apply current whole-query disclosure to membership,
exclusion, order, fields, counts and cursors. Subject compatibility and generic page consumption remain
closed and usable. Estimated implementation/native-test change: 1,450 lines plus generated contracts.

### Inputs and prerequisite closure

Consume the adopted registry, source and reduction contracts above and the landed callable declarations
from the first brief. Do not pretend `SubjectSource` can read Accounts by passing an Account UUID.
Do not implement a fake ready Account producer while waiting for native integration. Pure registry/parser
work and frozen test preparation can proceed without a dependency edge on unrelated Accounts delivery.

The only required new code prerequisite is the actual native Account population/current/reduction factory
and shared-family generation format. Existing Semantic, Content, Access and filtered-list contracts supply
their current native boundaries. Trust their declarations; if an integrated call reveals a real defect,
repair it minimally within declared risk ownership and include affected regression evidence.
Do not reopen product research, migrate discussion material or run foreign probes for this brief.

### Full call-site and generated closure

Search changes `source.ts`, registry assembly, `filter.ts`, `current-filter-plan.ts`, `current-leaf.ts`,
`query.ts`, `query-payload.ts`, `service.ts`, `hits.ts`, `disclosure/check.ts`, `cursor.ts`, rating cursor
integration, `http/routes.ts` and default server construction in `src/server.ts` and route mounting in `src/http/kernel.ts` as required.
Add immutable mixed search/template formats; preserve released Subject template files and their readers.
Use the actual source factory and route-key composition from the production worker/server.

The shared `packages/filter` grammar must recognize the new kind leaf without accepting Account fields as
Semantic properties. Its parser, validator, normalized AST, serializer, admission, positive-anchor logic,
current evaluator and all exhaustive visitors must remain total. Search-specific condition domains live
with registry admission; shared parsers do not invent permission or enumerate Account rows.
Saved/dynamic consumers must explicitly retain their current closed domains; recognizing a shared node
must not silently enable saved Account discovery or Resource recursion.

Search-backed page descriptors in `src/presentation/reads.ts` and registry/config schemas in
`packages/composition` must select the mixed operation only after the new contract is mounted.
Keep legacy Subject descriptors readable. Aggregate identical descriptors before dispatch and sum costs
across at most 16 reads/128 slots; never give each kind its own descriptor or read budget.
Update server response validation, operation catalogue and generated API/client types together.

`services/kernel/scripts/openapi.ts` and `scripts/client.ts`, invoked through
`bun run --cwd services/kernel derived`, generate the kernel OpenAPI and `packages/client` outputs.
Their exact outputs are `contracts/openapi.json` and `packages/client/src/kernel/**`. Include the
changed generated files in this implementation assignment. No hand-maintained client-only schema can stand in for a mounted route.
Web's generic renderer/caller and kind/count labels must consume generated types in its own adopted brief;
this native slice supplies recorded API responses but does not claim finished web stories or screenshots.

New native test files are `test/search/mixed-request-native.test.ts`,
`mixed-current-native.test.ts`, `mixed-cursor-native.test.ts`, `mixed-kind-counts-native.test.ts`,
`growth-mixed-discovery.test.ts` and `test/presentation/mixed-search-native.test.ts` in the kernel.
Existing `specs/search-outcomes.test.ts`, Subject native tests, facet fixtures and persona drivers stay frozen.
New cases may call existing real driver factories; do not edit assertions to fit a narrower implementation.

### Route and request admission

Mount the proposed mixed facade with the same authentication behavior as current public Search.
Authenticate a present bearer before route execution. Invalid, expired, revoked and pre-suspension bearers
return the existing 401/WWW-Authenticate forms; they never downgrade to anonymous. Anonymous valid public
reads remain allowed through ordinary mounted action/exposure policy. No new account authentication bypass.

Retain existing independent Subject global admission for Subject resources and the Accounts public-identity
policy for Accounts. The mounted mixed route uses the existing `subject:read` public route declaration for catalogue admission
and separately carries existing `account:read_public_identity` policy in its server-owned Account source
composition. Adoption must confirm operation-catalogue representation of both existing actions; no new
permission action is selected and `subject:read` alone is never Account authority.
Authorization of each requested resource leaf is independent of default kind visibility.
Do not authorize only returned candidates or use a viewer string as a private preparation credential.

Parse the raw bounded text and complete condition tree once. Exact-deduplicate only after all authorized
expansion. Reject unsupported fields, unsupported mixed sorts, unknown kind IDs and over-limit expansion
before candidates. Capture the pinned literal agent-credit OR roster; a release change cannot recalculate
that subtree under a continuing token. Preserve structural catalogue type bases without inventing an
Account subtype. Omitted kind means all registry-enabled producers, not a hardcoded Subject fallback.

The proposed closed request fields are existing Search options plus `kindPage` and `kindCountLeaf`.
`kindPage` is a closed object of `limit` integer 1–8 and optional confidential `cursor`.
`kindCountLeaf` is a nonnegative direct child index, valid only against a top-level AND and a kind leaf.
A cursor continuation repeats the original hit request; metadata continuation is independently bound.
Do not allow a free-form caller-provided source, comparator, observation, index name or timestamp.

### Native compilation and payload validation

Compile one shared engine query over all admitted public kinds. Domain-aware truth uses strong Kleene
logic: false AND unknown is false, true OR unknown is true, NOT unknown is unknown, and only true selects.
Build the native per-family predicate to match that logic, rather than relying on Elasticsearch missing-field
NOT behavior. Account documents having empty facts is not enough to implement domain semantics.

Catalogue positive/negative statement matching retains current same-statement qualifiers, quantities/units,
relation overflow and unknown semantics. Account kind predicates are exact; catalogue type predicates keep
released base/subtype meaning. All leaves remain charged even when the compiled candidate predicate can
optimize a branch after resource authorization. No raw `must_not` on a missing field broadens Accounts.

Payload validation requires the exact tagged `_id`, raw owner UUID, family, kind, partition, revision,
physical index and comparator-shaped sort tuple; Account revision is a canonical decimal bigint
keyword and Subject revision retains its existing safe-integer representation. Reject foreign/duplicate keys, wrong partitions, wrong
physical incarnation, nonfinite score, malformed null/name keys, wrong tuple direction and out-of-order
results before disclosure. A valid UUID `_id` alone is legacy Subject format, never an Account candidate.
Track native response completeness: shard failures, timeout or truncated/partial responses are unavailable.

Mixed relevance uses one query's scores with common statistics and the selected boosts. No per-kind engine
requests, score arithmetic or normalizing pass. Name/ID sorts seek their exact native tuple. Existing rating
phases remain Subject-only and all prior guards apply; mixed-inapplicable sort rejection happens at admission.
Do not silently consume an Account under a rating phase or encode a ninth cursor key for convenience.

### Current-source execution and generic projection

Begin safety observation before enumeration. In each bounded refill round, batch candidates across kinds
and reads by database/row kind, dispatching Subjects to Semantic and Accounts to the native current source.
Reuse current rows for summary projection. One round does not receive separate Account and Subject candidate
allowances. Capture source-unavailable errors as readiness for the whole response, not absence or Boolean false.

Check Account projected revision/current eligibility and active claim; independently check every Subject's
original/terminal eligibility, current source, Access, consent, tuple fences and foreign targets under its
existing contract. For stale candidate data, consume only after it reaches the common ordered head.
Revision equality cannot replace query-level reduction safety or authorize excluded rows.
A current field changing sort/text membership requires safe repair/reexecution, never local reranking.

Project the generic base with actual kind label, selected title language, public URL inputs and optional
current image/aspect. For Account summary, preserve exactly the seven-field live IDs item, then add only
guarded verification context. For Subject summary, use existing `readSubjectSummaries` with current
related-read eligibility. Do not call that Subject reader with Account IDs. Facts/descriptions requested
for the page apply only to catalogue hits; omitted Account descriptions are not biography snippets.

Move the final safety validation AFTER the route's current summary/image/verification work. Today's
`fill()` stage outside the service cannot remain an unobserved post-validation disclosure phase.
Either put the complete projection inside the service operation or pass a trusted projection callback
inside its start/final envelope. Selected implementation: service owns orchestration and a composed native
summary provider; the route only validates/serializes the already final-checked page.
No additional client read is required to render an unknown kind's generic base.

### Useful pages and consumed frontier

For direct reads, at most three refill rounds each ask at most `2 × remaining slots + 1`.
Count all candidates, duplicates, rejected revisions, foreign current checks, summaries and discarded
lookahead. A filled page may carry an opaque frontier only through the last actually consumed head.
A partial page succeeds only with certified final exhaustion. Failure to fill or prove exhaustion within
budget returns existing preparing/readiness behavior, never an empty successful continuation chain.

Unconsumed buffers are discarded and re-sought after the global frontier on the next request. Never record
the last fetched Account or Subject independently. If a private producer participates under another
adopted plan, it must provide a comparable head or EOF before advancing the global head; readiness from
one source cannot be treated as absence. This Account slice itself adds only the one shared public producer.

Native prepared execution may supply finite useful pages under the existing admitted plan. Each step reads
each relevant input once overall, rereading at most one step after interruption. Do not create anonymous
retained-result writes without the existing quota/global-cap/expiry/custody authority. If the necessary
retained plan is not admitted, return the existing explicit unsupported/readiness result before enumeration;
never advertise that as completed ordinary mixed query capability.

### Count and metadata execution

Read at most the requested configured metadata page; hidden metadata pages do not constrain hits.
Use the immutable registry's configured order and current language chain. Localized kind labels/icons are
configuration, never an engine count ordering. A metadata-only continuation cannot start another hit or
count enumeration. Its error/cursor binding follows the existing confidential Search profile.

Only initial query attempts counts. Copy the admitted normalized AST and remove exactly the designated
kind child of top-level AND. If that leaves no children, it is the complete authorized text population;
if no designated leaf exists, use the unchanged tree. Do not distribute OR, erase nested NOT or drop
all kind leaves. Reauthorize the broader request's resources within the SAME charged work, including
true OR branches. Counts use logical family/canonical identity, not index occurrence count.

Budget counts together with hits and metadata before executing. Capped fully current checked enumeration
can produce exact counts only when that entire admitted count population is exhausted. Otherwise a
certified positive lower bound may appear as `exact:false`; uncertified/unknown has no count member.
Exact zero requires complete authorized absence. A zero lower-bound member is always invalid.
Unchecked OpenSearch total/buckets, page lengths or diagnostic `gte` are never serialized as kind counts.

Do not recount on a hit continuation and do not retain a server count vector without separate authority.
Initial counts remain in client query state; a changed condition starts a new query. `as_of` describes
ordinary freshness, not privacy certification. Property/value facets and public total remain count-free.
All count/current-summary work must finish before final safety validation.

### Cursor and failure behavior

The actual encrypted token carries only admitted bounded comparator/observation state under the existing
Search profile. Bind static request/principal first; then validate current registry/release/generation,
physical UUID, identity meaning and query safety. A changed dynamic context is not an invalid static MAC.
Do not rebuild the binding with the new epoch and misreport authenticated context changes as 400.

A maximal name key uses actual UTF-8/control/non-BMP form and actual native score string representation.
Verify aggregate and serialized sizes through the real codec. Hashing the physical index or guard does
not recover the authoritative observation. Decode is constant-attempt, size-reject-before-decrypt, zero-I/O.
Secrets, rejected raw tokens and plaintext keys must not enter ordinary logs or diagnostic JSON.

| Failure | Required public behavior |
| --- | --- |
| Invalid bearer | Existing 401 form before execution, no anonymous downgrade |
| Malformed/unknown condition or kind | Existing typed 400/422 distinction at exact request pointer |
| Account-inapplicable mixed sort | 422 unsupported_query at `/sort`, zero candidates |
| Hidden resource under NOT/true OR | Existing concealed owner outcome before enumeration |
| Bad/tampered/request-mismatched cursor | 400 invalid_request, invalid_format at cursor pointer |
| Authenticated expired or changed meaning/generation | 409 search_restart_required |
| Missing Account factory or unsafe source state | Existing readiness/unavailable transport; never Subject-only success |
| Reduction during execution, even ACKed by final | Discard response and client frontier; retry only within remaining budget |
| Count evidence unavailable | Omit that count; preserve hit safety and no zero substitution |
| Optional avatar unavailable without unsafe dependency | Omit image under current field guard |
| Partial engine response or malformed tagged tuple | Unavailable; no partial page, count or token |
| Native source fails after some candidates | Whole response fails closed; no false EOF or consumed client frontier |

No rollback attempts to undo a user command or external engine effect from a read request. Retained
preparation, if admitted, commits its bounded frontier transactionally; failure before commit replays at
most that step. A returned readiness response must not reserve a hidden unbounded background job.

### Frozen future native scenarios: request and generic hits

```text
File: services/kernel/test/search/mixed-request-native.test.ts
Case: one default-all request and native order
  Given native active account A, catalogue Person P and matching Book B
  And A is currently verified against P through ordinary owner workflows
  When anonymous POST /v1/search:query supplies text Mira and limit 2
  Then its hits follow one actual shared-engine comparator across all three kinds
  And P and A remain distinct logical identities
  And continuation eventually returns the remaining eligible hit once
  And no kind minimum or round-robin is asserted

Case: exact active handle and description-only catalogue match
  Given A has active handle mira and unrelated display name
  And B matches only in its public catalogue description
  And A's biography alone contains a third sentinel phrase
  When native mixed text requests search each phrase
  Then handle and description matches retain the common analyzer/ranking rules
  And biography contributes no match or score
  And an expression or whitespace-padded spelling is not silently normalized as exact handle

Case: applicability beneath NOT and OR
  Given live Account A and catalogue non-Book P
  When filter is NOT type Book
  Then P may match and A does not match through unknown
  When filter is kind account OR NOT type Book
  Then A may match through its proven kind branch
  And a hidden Collection leaf beneath an independently true OR still conceals before candidates

Case: unsupported Account sort has no enumeration
  Given default-all kinds and sort rating or collections
  Then response is 422 at /sort before any candidate or count query
  When explicit catalogue kind/type restriction proves Subject-only population
  Then existing two-phase rating and Collection-count ordering remain unchanged

Case: generic base and compatibility
  Given an account with null display name and another temporarily without active handle
  And a configured catalogue kind with no specialized renderer
  Then each mixed hit has nonempty title, actual language, kind label and safe URL inputs
  And unavailable images are omitted
  And /v1/subjects:search, facets and suggest retain Subject-only closed envelopes
```

### Frozen future native scenarios: current disclosure and lifecycle

```text
File: services/kernel/test/search/mixed-current-native.test.ts
Case: every fence hides discovery without changing attribution
  Given native active, suspended, recovery-fenced, pending and deleted accounts
  When anonymous and ordinary authenticated mixed requests execute at native T
  Then only active-unfenced identities contribute membership/order/counts
  And no output distinguishes fence type
  And the existing IDs attribution behavior is unchanged
  When the native fence is lifted
  Then reappearance follows ordinary publication, with finite healthy convergence

Case: in-flight reduction with ACK cannot bless old observation
  Given native query execution paused after start and before final summaries
  When Accounts commits a fence or old display-name removal at T
  And the real worker repairs and ACKs before final validation
  Then the old queried page/count/cursor is discarded
  And no old PIT plus live ACK is accepted
  And a bounded fresh retry can serve only if all work remains within the original budget

Case: excluded Account and ranking-statistics privacy
  Given native relevance queries with an excluded Account affecting engine statistics
  When that account fences and its document delete is refresh-visible
  Then ACK does not assume deleted statistics disappeared
  And the served queried observation proves safe exclusion AND ordering
  And returned-ID checks, omitted counts and logical delete alone cannot pass the case

Case: native T rename and former forwarding
  Given A renames from old-mira to mira while Search indexing is paused
  When direct old-handle lookup still forwards
  Then mixed search cannot rank or label A using old-mira after the reduction T
  And no movedTo or former-handle alias enters the document or cursor
  And active-claim mismatch never supplies another account's public URL

Case: verification reversal before pointer cleanup
  Given P's agent pointer still names A
  When A's verification reversal decision commits but cleanup is paused
  Then both Account badge/context and Person-to-account link disappear immediately
  And P remains a distinct eligible catalogue record under Semantic authority

Case: avatar and foreign label reduction
  Given a live Account with current avatar and verified Subject context
  When native Content takedown or Semantic label/target loss occurs during a query
  Then the affected image/context is withheld and final safety detects foreign reduction
  And no cached public-index URL or stale label supplies the missing field

Case: erasure across active and rebuilding copies
  Given Account documents, admitted retained results and shared receipt/work copies
  When ordinary erasure confirms at T during a paused external write
  Then no new discovery response reveals the Account from T onward
  And late work cannot recreate any physical copy
  And terminal acknowledgement waits for sealed exact locator cleanup and effects drain
```

### Frozen future native scenarios: cursor, counts and composition

```text
File: services/kernel/test/search/mixed-cursor-native.test.ts
Case: consumed frontier preserves unconsumed prefetch
  Given interleaved Account/Subject heads, rejected stale candidates and duplicate supports
  When page size 2 leaves eligible lookahead prefetched but unconsumed
  Then the next token records only the last consumed global tuple
  And the lookahead remains reachable exactly once on continuation
  And rejected/duplicate/discarded work remains in the shared counters

Case: failure does not commit client progress
  Given current Account read fails after Subject heads are fetched
  Then no partial 200 page or next token is emitted
  When retried safely
  Then no candidate was lost through a failed request's frontier

Case: confidential static binding before dynamic state
  Given a native valid maximal mixed cursor
  Then wrong viewer/text/language/limit is 400 before dynamic source reads
  And authenticated generation/registry/comparator/physical-UUID change is 409
  And ordinary row publication does not cause a registry-wide restart
  And expired, tampered and oversized tokens follow the existing codec profile

Case: actual maximal native key capacity
  Given long normalized keys, control/non-BMP characters and native score forms
  Then encode/decode remain inside 8 keys, 2560 bytes/key, 3072 aggregate bytes,
       3584 serialized bytes and 4864 token characters
  And decode has at most two compatibility attempts and zero I/O
  And Subject rating cursor guards still fit without a ninth key
```

```text
File: services/kernel/test/search/mixed-kind-counts-native.test.ts
Case: designated direct kind leaf only
  Given top-level AND [kind account, OR [kind Book, another predicate], NOT kind Person]
  When kindCountLeaf is 0
  Then count query removes only direct child 0 and keeps the nested OR/NOT and all text/resources
  And no designation means unchanged count predicate
  And a designation naming a nested/non-kind/out-of-range node fails before enumeration

Case: certified counts and concealed resources
  Given complete current exhausted native count population
  Then exact logical Account/Subject counts and authorized exact zero may appear
  Given only a certified positive checked prefix
  Then only its positive lower bound may appear as exact false
  Given unavailable or unchecked engine evidence
  Then count is absent, never zero, estimated, occurrence count or page length
  And hidden references are resolved even under count-population true OR

Case: initial counts and independent metadata continuation
  Given more kinds than the bounded configured metadata page
  Then all enabled kinds remain searchable while metadata has one continuation
  And count attempts occur only on the initial hit request
  And hit continuation omits counts while client query state retains initial presentation
  And metadata continuation cannot enumerate hits or recount
  And changed conditions begin a new count attempt under a new static binding

Case: no public-total or property-facet backdoor
  Given native mixed and Subject compatibility responses
  Then no public total, type/property/value bucket count, estimate or row-length fallback appears
  And only the authorized kind-count members carry certified numbers
```

```text
File: services/kernel/test/presentation/mixed-search-native.test.ts
Case: real Search-backed composition shares budgets
  Given actual page descriptors containing 16 distinct reads and 128 total output slots
  Including Account/Subject mixed reads and duplicate descriptors
  When the native page endpoint executes through the default server
  Then identical reads deduplicate before dispatch and generic hits need no per-hit client fetch
  And all current sources/summaries/counts/privacy work is measured together
  And a reduction during a late summary prevents stale page disclosure
  And a page exceeding summed admission is rejected before candidates
```

### Discriminatory native scales and counters

`growth-mixed-discovery.test.ts` runs 64, 512 and 4,096 at ratio eight, not just tiny helper fixtures.
Run each population axis independently: Accounts, catalogue, matches, sparse nonmatches, unrelated revision/
claim/verification history, duplicate canonical supports, current source homes and privacy reduction rate.
Fix page size and its owned neighbourhood while growing unrelated data. Separately grow relevant finite
preparation input and verify linear total work. Reach deep pages through actual confidential continuations.

For each direct plan capture first/deep/sparse useful pages and eventual final exhaustion. For ready-result
plans capture `2s + 2` candidates and at most two index reads. For each admitted preparation step capture
all inputs/results/frontier writes and one-step replay. No empty-success chain or permanent readiness at
larger scales passes. The served share under increasing reductions must not decline across scales.

Record raw candidates including rejects/duplicates/lookahead/discards, actual output slots, Access and
dependency points, PostgreSQL rows including removed rows, shared blocks, statements and connections by
backend, request/response bytes, engine searches/seeks, and native iterator `next_doc_count + advance_count`
across the whole query tree and all shards. Record current-source/summary/count subsets and inclusive totals.
Source call counts alone cannot prove examined work. Index refresh time alone cannot prove pipeline freshness.

Use the existing privacy role attribution from Filtered lists, inclusive of query plus `readStatus`:
`/* semantic.privacy-start */`, `/* semantic.privacy-final */` and separate `/* semantic.own-rows */`.
Integrating Accounts into shared coverage does not grant two more statements. If a plan probes active XIDs,
measure 1/8/64 allocated native transactions independently; the bound has no active-XID growth term.
Do not require that axis from a layout whose actual execution does not depend on active XIDs.

At `s=20, ℓ=1`, derive rather than invent: `c <= 126`, index reads <= 6, points <= 1,024,
examined rows <= 2,080, response bytes <= 520 KiB, request bytes <= 190 KiB and 12 statements/backend.
At actual `c`, apply the formula, not the maximum as free spare work. At composition maxima use the
existing 816 candidates, 6,784 points, 14,080 rows, 72 statements/backend, 96 engine searches and one
connection/backend across the whole page. No per-kind term occurs in either derivation.

### Acceptance commands and final handoff

After owner adoption and implementation, run the actual kernel entry point from the repository root:

```sh
bun run --cwd services/kernel check test/search/mixed-request-native.test.ts test/search/mixed-current-native.test.ts test/search/mixed-cursor-native.test.ts test/search/mixed-kind-counts-native.test.ts
bun run --cwd services/kernel check test/search/growth-mixed-discovery.test.ts test/presentation/mixed-search-native.test.ts
bun run --cwd services/kernel check test/search/outcomes.test.ts test/search/relation-facet-outcomes.test.ts
bun run --cwd services/kernel typecheck
bun scripts/typecheck.ts
```

The last command covers generated/shared caller closure when several workspaces change; it is not a
substitute for native outcomes. The implementation manager selects additional affected frozen regression
files through the normal runner. Do not change frozen expectations in a worker to make a new route pass.
If shared kernel runtime changes, the owning Accounts/kernel full check requirement remains applicable;
focused commands do not waive it. Generate API/client output through `bun run --cwd services/kernel derived`
and normal workspace construction after the route is mounted, never during this specification attempt.

Native acceptance must use actual HTTP, current owner commands, real OpenSearch/source/default worker,
production rebuild and normal authorization. Controlled adverse-response injection supplements those paths;
it cannot replace them. Report checks on their actual commit and distinguish API/native/growth evidence
from format/types. UI stories and promoted product completion remain with their owners.

There are no necessary `after` edges for Web stories, unrelated Content/Accounts releases, foreign receipt
verification, broad research or overlapping file ownership. Native source/reduction factory and mixed-format
population from the first brief are required for final integrated execution. Pure request/schema/scenario
work can proceed alongside that implementation after the exact interface has been adopted.

### Cost

- Touches: the complete mounted mixed request, shared filter visitors, native engine/current-source/summary envelope, metadata/counts, confidential cursor, default server, generated clients and composed-page consumers.
- Bound: all direct/ready/preparation/composed ceilings above remain literal and cumulative; fixed metadata and source chunking confer no new numerical allowance, permission read or background-work exemption. Native inability to meet a direct bound requires the already admitted finite preparation path or a precise failed acceptance, never raised budgets.
- Growth check: the named native files execute all three-scale axes with raw inclusive counters, sparse/deep useful pages, in-flight reductions and real replay; API/default composition must be proven separately from generated-type and formatting success.

## Specification delivery boundary

This document supplies the bounded design, proposed exact owner interfaces, whole implementation briefs
and frozen future native scenarios. It supplies no executable Account port and no product completion receipt.
No existing frozen file or acceptance assertion is modified. Only this declared document is changed.
The initial-account text/domain choice, one Account kind, evolved shared family, native source/current
separation, tagged identity, ID-first ties, exact active-handle boost, Subject-only rating/count sorts,
independent ordinal traversal, optional certified initial kind counts and service-owned final projection
are explicit proposal decisions awaiting the owners named above.

No new outside research is needed to select this implementation boundary. The existing
[universal-search evidence](research/universal-search.md) supplies the topology/tradeoff rationale;
this proposal uses the current repository mapping/template/query/owner declarations rather than importing
reference code. The reference-project index was consulted; no external reference implementation is used
as an unverified runtime premise. Engine/scoring, source growth and disclosure feasibility remain the
future native assertions stated above, not facts inferred from documentation formatting.

In minimal specification mode, run no worker-check, acceptance, native, database, browser, host or remote
check. Documentation-only work changes no compiler workspace. After integration the artifact acceptance is:

```sh
bun scripts/worker-check.ts --local -- node_modules/.bin/oxfmt --check docs/search-mixed-kind-plan.md
```

A passing artifact check proves formatting/presence only. Product/native closure requires the two whole
implementations and their real acceptance; it cannot be obtained by replacing a producer with a stub,
calling attribution enumeration, forwarding an old handle or reporting a source export as a runtime outcome.
