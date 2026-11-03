# Search

Search owns the subject search projection, indexing consumers, disclosure checks, query API, freshness and index
generations.

The first released subject search slice, generic public hit bases and bounded kind metadata are built but
closed behind `search` platform grants. Advanced filters/scopes, facets and rating remain behind
`search_advanced`. Complete population/privacy, physical incarnation, erasure and native growth proofs remain
deferred; this closed slice does not complete the Search Goal.

`subjectConsumer` and `discoveryConsumer` construct native checkpoint names from the exact admitted prefix, a
positive safe generation and an explicit family (`subjects` or `discovery`). Ordinary names that already fit the
63-character native consumer domain stay byte-for-byte. Longer admitted identities use a deterministic hashed
fallback in that domain. A prefix containing `subjects` cannot rewrite the discovery family. Ambiguous legacy
discovery identities created by replacing `subjects` inside the prefix are not inherited or copied; recover them
through the existing unavailable/rebuild path.

The optional `languages` request field is the reader's language chain, in priority order. Search follows semantic's
label choice rule for hit labels, requested descriptions and item fact labels, returning one entry per nonempty map.
Omitting `languages` keeps every language.
Subject search, facet and suggestion entry copy bounded public request JSON (query, filters, language order, properties
and cursors) before the first await so later caller mutation cannot change the admitted invocation or continuation
binding. Live Access, read-context and release objects stay by identity.

## Review-backed question admission

The mixed request parser now recognizes the closed `{ratingQuestion:{id:UUID}}` leaf. It counts every
occurrence against the shared tree limits before deduplication. Catalogue and stored/saved definitions
reject it; clients cannot supply revisions, witnesses or authorization flags. This parser addition does
not install native mixed-query execution or the feed query parameter. The existing engine compiler rejects
the leaf explicitly until the native selected-population branch is installed, including under NOT or OR.

`rating-question-condition.ts` exports `resolveRatingQuestionConditions(deps, filter, context)`,
`assertCurrentRatingQuestionConditions(deps, conditions, context)` and
`qualifyRatingQuestionConditionWitnesses(deps, conditions, questionId, candidates, context)`.
Resolution takes the expanded admitted request, reparses a private bounded copy, and resolves every distinct
question using original Global `definitions:read` before enumeration. Boolean truth never skips a resource.
The opaque request-bound result retains the complete frozen tree and exact native
`{kind:'reviewQuestion',question,revision}` keys with canonical decimal revisions. Final assertion repeats
metadata and authority; qualification delegates to Content's existing native witness reader, at most 160
positional primary/witness pairs. A refused witness is not complete nonmembership or a complement.

Resolution adds at most 32 native question authority/metadata reads; final assertion repeats those reads.
Qualification retains Content's native disclosure cost in addition to Source work. No execution budget is
inferred from the number of leaves or raw feed candidates. Compose the documented finite native producer
bounds as constants with the retained Source bounds; no runtime price or prepaid funding protocol is needed.
The question key is currently a standalone native bridge type, not a covered Source dependency. Default
Source population, local baseline enrollment, reduction routing and all-lane feed binding remain necessary
before public activation. No substitute Source or observation is introduced.

The approved [public facet discovery contract](../../../../docs/search-facets.md) is the single owner of the
count-free continuation wire, with types in `facet-discovery-contract.ts`. The public service consumes
`facet-discovery-runtime.ts`: it admits the entire request, authenticates per-property confidential cursors,
resolves immutable native captures and requests one atomic native sibling page. It never calls the sampled
`countFacets` helper. Required `next` represents eligible native lookahead or proved exhaustion; current labels
and native ascending keys are preserved. Captured observation/build/generation locators stay encrypted.

Trusted composition supplies `createSearchService({ facetProvider })`. The provider supplies the actual registered
Source definition, complete pinned meaning, Search generation and `FacetNativeOperations` from
`facet-discovery-native.ts`. `captureFacet({plan}, context)` returns existing `PublicFilterConsumerCapture`;
`pageFacets({reads}, context)` owns shared START/FINAL, complete retained preparation, current original/terminal/
contributor/target checks and eligible lookahead across all reads. Its `ready` branch is native evidence, never a
callback that the HTTP caller can provide. Capture must deduplicate persisted jobs and resume the finite native
frontier. The continuation runtime deliberately admits prepared snapshots only; direct execution stays closed.
Missing native composition returns `503 index_not_ready` with `Retry-After: 1`, never preview values.

`createFacetDiscoveryStorage` in `facet-discovery-storage.ts` implements Search's derived value preparation/storage.
Its `prepareFacetStep(plan,queried,context,meter,textObservation?)` consumes the actual Source binding and finite
population, exhausts complete projections, folds the shared three-valued predicate, canonicalizes item targets,
stages and indexes distinct native keys, and commits effects/frontier by version CAS. Text preparation requires
the shared lifecycle's actual immutable PIT, checked through the same Source definition and native version;
there is no local string matcher. One building/current generation, deadline leases, 24-hour idle expiration and
bounded retired-row cleanup survive process loss. No caller can turn these derived rows into Source coverage.

`readFacetCandidates(read,context)` returns private ordered candidates and their original/terminal support rows;
it returns no public ready verdict or continuation. The native `pageFacets` executor must retain ALL siblings in
its actual execution, share one START/FINAL and validate current contributor/target/foreign dependencies before
turning those rows into `FacetNativePageResult`. `expireFacetStep(context)` reclaims at most 999 derived rows per
step after marking the generation unavailable. These storage operations introduce no capture/bootstrap, Source
mirror, scheduler or ACK writer. Shared native consumer capture/repair remains the sole lifecycle owner.

Composition still requires the actual shared consumer/native facet executor and Semantic producers. The selected
resolver is Source's `PublicFilterSourceBinding.resolve/join`, never another reader. Its exact constructor and
closed declarations are adopted in the Semantic owner document; the current clearly provisional binding adapter
returns typed unavailability. The sole Semantic finite population factory is now delivered:
`createFacetPopulationSource(config: Parameters<PublicFilterSourceFactory>[0])`, with
`readFacetPopulationPage({population,frontier,inputLimit,capture})` and types in `facet-population-contract.ts`.
Its native traversal remains unavailable until the binding/key-page producers are delivered. Default composition
fails closed until native handoff and activation; it cannot claim a native product pass or eventual readiness.

## Trending searches

The selected read is `GET /v1/trendingSearches`, with a language and a limit from 1 through 10, returning only
`{ trendingSearches: [{ query, display }], next: null }`. Search owns terms; Content owns Realm discovery.
Until this operation is delivered, Web must not infer a trends endpoint or fabricate trends.

The aggregation window is the preceding seven days at authoritative request time. Publication requires at least
ten distinct currently eligible signed-in Accounts for each term. Each Account contributes at most once per term
per UTC day; multiple days never make one Account count as multiple contributors. Caller input cannot change the
window or threshold. Expiry, Account erasure/opt-out and source withdrawal must remove or minimise contributions
through registered owner work, with current native barriers preventing late replay from restoring removed data.

Only an explicitly submitted, unscoped, positive literal search that exactly matches a currently publicly
disclosed catalogue label or alias is eligible. A Concept qualifies through that same current catalogue authority.
The displayed term comes from that public source; the returned query must parse as a literal of the same term
under the closed Search grammar. Advanced, negated, owner, Realm, private and scoped searches, autocomplete
keystrokes and private recent-history text never contribute. Arbitrary free text is excluded; a PII regex does not
establish public meaning or privacy. No IP/device identifier or sensitive query text belongs in storage, outbox
events or telemetry. Contributor identities and counts are never public response fields.

Native maintained window/cohort/rank state must bound candidate, SQL, Access and byte work within the existing
Search budgets. Publication must revalidate both the current public label/source and ten distinct contributors'
current native eligibility and reduction state, including the shared scoped observation. Missing, changed,
withdrawn, erased, opted-out or uncertain evidence omits the term; a stored count or index checkpoint cannot
establish eligibility. Per-read query-log scans, cross-partition authoritative joins and unbounded grouping are
not admitted execution plans.

The route, typed client, shared-shell consumer, private native projection and bounded cleanup commands are
implemented. Publication and ingestion currently return `preparing` (`semantic_not_ready` at HTTP) because the
actual registered native identity/definition and Account reduction/opt-out binding is absent. This is an explicit
provisional composition adapter, not an empty successful response or a qualified-publication claim. No Source
implementation is copied or replaced. The existing
[Source factory](../semantic/public-filter-source-contract.ts) and
[consumer operations](public-filter-consumer-contract.ts) are the agreed signature handoff; their diagnostic
status and reader-only types cannot substitute for the missing
[runtime binding](../semantic/public-filter-source-contract.md#required-integration-schedule-not-yet-frozen).
Activation must replace the adapter with that actual owner binding, current native Account and catalogue reads,
and the shared scoped observation covering the maintained population/order, including excluded terms. No callback
Boolean can activate it. Account tombstone and subject withdrawal events already register bounded minimisation;
they are eventual cleanup, not current publication permission. An Account opt-out owner hook must invoke the same
withdrawal command before activation. There is no new public writer or opt-out authority.

Search retains at most sixteen contributors per term and ranks that bounded sample by distinct current eligible
contributors, with a digest tie break. Excess contributors are not recorded. The retained per-Account timestamp
is the first submission of its latest UTC day; repeating a submission that day cannot extend the window. The
projection retains only the source-derived public label, language, source key and private member keys/timestamps,
not submitted query strings. Withdrawals retain only minimal identity barriers to reject late deliveries;
restoration alone never clears those barriers. A future native restoration admission must revalidate the actual
owner state before allowing fresh contributions; old contributions never return.

- Touches: one Search-owned native home, maintained term/member indexes, ordinary command executor/events,
  existing worker effects, one typed API/BFF call per Search opening, and the existing Search frame.
- Bound: seven exact indexed rank pages (10–16), each returning at most ten live terms ordered by latest expiry
  then term key, merge into a ten-term candidate page. Ten exact member probes read at most sixteen rows each.
  Reduction handles at most 160 private keys and ten labels, returns
  at most ten pairs and emits no counts. Labels are at most 256 UTF-8 bytes and must round-trip the closed grammar.
  One write locks one term and touches at most sixteen members. Each cleanup transaction removes at most ten terms
  and their 160 members, or ten Account members; indexed barriers block replay before subsequent pages.
  Current Source/Account/Access/dependency costs still require the real owner binding within existing caps;
  these storage bounds do not establish publication feasibility or raise Search budgets.
- Verification: focused projection/reduction/consumer cases and actual-shell preparing/unavailable stories.
  Qualified native publication and visual review remain integration work, not evidence supplied by these stories.

## Mixed-kind foundation

[discovery.ts](discovery.ts) is the shared type home for `AccountDiscoverySource`, `AccountSnapshot`,
`IndexedAccount`, the owner-discriminated registry/document/summary unions, `KindCountEvidence`, and the opt-in
`DiscoveryRequest`/`DiscoveryPage` (`representation: 'discovery-v1'`). It reuses native Subject, avatar, reader
deadline/authorization and token types. The [Accounts source contract](../access/account-discovery-contract.md)
continues to own eligibility, current-T exact claims and the native census. Source reads/pages are bounded to
100 Account keys; `count` is generation census only and cannot supply query kind-count evidence.

`createDiscoveryRegistry` in [discovery-registry.ts](discovery-registry.ts) registers the pinned release's actual
catalogue type IDs and the reserved `account` kind. Each entry carries its owner source, current summary hydrator,
localized labels/icon, summary discriminator and supported domains. Account supports text/kind; Subject domains
retain their meanings. `evaluateDiscoveryCondition` consumes an expanded, admitted planner tree with domain-tagged
leaves and preserves `not_applicable`/`not_proven` through NOT. It is predicate evaluation, never permission:
resource authorization and current whole-query/native eligibility remain mandatory outside this pure boundary.

The shared filter package exposes separate `parseDiscoveryFilter`, `admitDiscoveryFilter`, validation and
visitor functions. Only this opt-in grammar accepts the closed `kind.in` leaf. Saved catalogue filters still
expand through the catalogue parser, so they cannot introduce Account predicates. All expanded leaves retain
the existing global limits. [discovery-filter.ts](discovery-filter.ts) compiles both truth polarities into one
registry-bounded native predicate and specializes them for the current catalogue matcher. An Account has neither
truth polarity for a catalogue-only leaf; negation cannot turn that unsupported domain into membership.

The native [consumer factory](public-filter-consumer.ts) now consumes the same closed mixed compiler and strict
result decoder. Its full operations view adds `captureDiscovery`/`queryDiscovery` on the existing consumer; legacy
Subject callers retain their original operations view. Mixed capture requires the fixed registry, a complete native
generation with exactly its configured kinds, the immutable mixed mapping/comparator and the current physical UUID.
The actual [Source binding](../semantic/public-filter-source-binding.ts) remains a provisional typed-unavailable
adapter. Current returned-row checks and Account witnesses cannot substitute for its immutable whole-query
observation, including excluded rows, order and counts. Missing owner composition returns readiness.

[discovery-documents.ts](discovery-documents.ts) constructs bounded actions from an already authorized source
snapshot, without additional source enumeration or profile reads. Ordinary projection may request a Subject's
current released kind together with retained `discovery_copy` kinds for the same ID: the matching kind indexes at
the snapshot position and every other requested kind deletes at that position. Account keys that share the UUID
remain a separate native identity. Account projection copies only native ID,
account kind, current claim-approved handle, displayName and revision plus internal identity/position fields.
A null handle retains displayName. Revisions and snapshot positions remain exact bigint internally and canonical
decimal strings in documents. `discoveryBulkBody` serializes the exact native signed-bigint external version as
raw NDJSON; do not send that string through the legacy `OpenSearch.bulk` JSON-value serializer.

The inert [discovery.json](../../db/search/indices/discovery.json) defines one strict native family with the existing
`cjk_bigram_v2` analyzer. Mapping `_meta.discovery_document_format = 1` pairs with `_source.document_format = 1`
and native `_id = discovery-v1:<encodeURIComponent(kind)>:<canonical UUID>`. `discoveryDocumentId`,
`parseDiscoveryDocumentId` and `parseDiscoveryHitIdentity` share that identity contract; the mixed parser rejects
owner/kind/route/document disagreement and legacy raw UUID receipts. Mixed-public-v1 ties use `id, kind, identity`.
`validateDiscoveryDocument` enforces per-owner field allowlists that the union mapping alone cannot enforce.

The immutable successor [discovery-mixed-v1.json](../../db/search/indices/discovery-mixed-v1.json) requires complete
rebuild before activation. Both owner families supply shared names/descriptions/name sorting. The native consumer
uses one comparable ranking and consumed frontier, complete-response decoding and retained windows; mixed service
assembly supplies current owner hydration, bounded refill, confidential continuation and final whole-query status.
The existing search route opts into this response only with `representation: 'discovery-v1'`. Omission preserves
SubjectSource and the legacy Subject wire. These implementations do not establish default Source readiness or a
native product pass before actual owner composition and activation.

## Deletion lifecycle

[Deletion](../../../../docs/deletion.md) governs user-owned data; [first public scope](../../../../docs/scope.md)
includes Search, facets and discovery. The public subject index is a disposable projection, never a second
authority for personal or private source state. [Semantic](../semantic/README.md) owns subject/contribution truth,
[Content](../content/README.md) owns content and moderation, and [Accounts](../access/README.md) owns account erasure.
Those source owners enforce soft deletion, the 30-day restore window, legal holds and least-data purge, including
private-data removal and retained public-contribution de-identification. A hold preserves source evidence, not public
disclosure. Search neither starts a second restore clock nor preserves hidden data as evidence.

Search's account-erasure inventory follows the actual stores and producers:
The version-1 `search` account-erasure wakeup is registered in the existing work module before the optional
indexing-config return. It validates native envelopes, rereads the exact Access obligation, persists Search's
account-home progress and enqueues the stable maintenance workflow. Missing configuration stays pending even
when indexing is disabled. This is not final participant closure. The
[implementation contract](../../../../docs/search-index-erasure-plan.md#brief-actual-account-erasure-participation-and-all-copy-closure)
requires owner inventory with source-disposition and receiving receipts, plus the existing identity
participant's durable writer guard. The delivered native Source page and terminal-proof ports are consumed
from their canonical module paths. `SubjectSource.read/count`, Semantic local erasure and callback
coverage hooks cannot supply those proofs. The worker performs native copy work independently; the final ACK
requires the actual sealed all-home Source terminal proof in addition to page custody, retained-copy cleanup
and native writer drain. The proof reader needs only the pool and optional clock; full Access/route configuration
is used only by the page factory, bound through the existing kernel Access composition.

`stepRetainedObservationErasure(pool, {partition,registration,observation,incarnation}, search, context)`
is the native finite cleanup primitive for inventory-located observations. It validates the original retained
UUID, closes observation admission, yields while a use lease remains, then removes one lease, PIT or execution
per step. PIT removal requires its exact native successful receipt; missing configuration or ambiguous cleanup
retains custody. Prepared generations enter `erasing` before their duplicate payload is scrubbed, preventing
late recapture of that immutable generation. The observation's own payload is removed child-first, including retained repair effects and page intents
before their execution parent. Reusable
registration definitions and other observations survive; owner inventory must separately locate any applicable
definition or sibling copy. `removed` describes this one observation, never sealed population or account erasure.
Expired leases do not certify unknown first-apply requests: source receiving and the writer guard still own
their reconciliation. This primitive supplies no retirement or alternate ordinary writer.

Retained PIT cleanup validates the exact native `pits[].pit_id` and `successful:true` receipt before releasing
custody. HTTP success alone, a generic 404, a missing receipt or another PIT's result leaves cleanup unresolved;
OpenSearch reports shard cleanup failure inside an HTTP 200 response. This local receipt is not a participant ACK.

Search stores distinct record classes:

| Class                        | Actual custody and erasure disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Physical subject copies      | `document.ts` copies labels and aliases into `names`, descriptions, `name_sort`, selected public statement values and nested facts/qualifiers, subject IDs, security revisions, public Collection counts and published rating figures. Account-agent names and public personal facts really enter these documents; no actor column does not imply no personal data. Replace/remove each exact affected document in active, rebuilding and grace generations, including copies no current API returns. Keep eligible public contributions with de-identified attribution (`Deleted account`); erase private, unlisted and already-deleted material and account-personal copies. Source owners decide and minimize truth; Search repairs their exact derived copies. |
| Pending external writes      | Source snapshots, prepared bulk bodies and requests already dispatched to the engine can outlive T. Resolve the real write/winner and drain or reject ambiguous late effects in every applicable generation before acknowledgement. An old source version can write again after native delete-version pruning; a lost checkpoint CAS cannot undo it.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Platform generation metadata | Physical index identity, aliases, mapping metadata and `core.consumer_checkpoint` partition progress describe platform generations, not an account's payload. Retirement removes an old physical index before its checkpoints. Account cleanup cannot delete a whole index to erase one account or infer completeness from checkpoint completion.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Existing coverage metadata   | `db/search/schema.sql` has `index_prefix_control`, `index_incarnation` and `index_home_coverage`, including bounded population frontiers and attempt/home observations. These are existing platform maintenance metadata, not an account ownership inventory. Their presence supplies no erasure certificate, all-role locator or foreign-write drain; this contract does not revive the retired home-certificate ABI or its CAS-only proof.                                                                                                                                                                                                                                                                                                                       |
| Stored templates             | Versioned query scripts installed by `query.ts` are platform configuration, not saved personal queries. Released template IDs/source remain immutable and installation does not expire older scripts; no per-account script purge applies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| In-process/request state     | Source snapshots, hit hydration, request/filter plans and outgoing bodies are transient; the service retains at most four generation freshness readers and four kind-digest snapshots by LRU (presentation cache cardinality, covering the three live generations), and definitions cache schema patterns. Eviction drops cache ownership only: pinned KindSnapshot objects and in-flight generation readers keep working. Search has no account payload cache to enumerate. Current request disclosure must apply T, and worker snapshots/bulk bodies remain pending external-write obligations until settled, rather than becoming a new durable private fact store.                                                                                             |
| Cursors                      | Search/rating continuations are stateless encrypted, principal/request/generation-bound tokens held by the caller. There is no server-side stored cursor payload deletion job. Disclosure and continuation fences still apply at use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Future preparation/retention | No Search-owned saved personal query, prepared result population or retained personal observation store currently exists. Inventory a physically introduced store and its producer-owned locators before release; do not claim deletion of hypothetical stores. Existing progress metadata is covered above.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Shared artifacts             | Receipts, outbox events, editorial provenance and DBOS workflow/step payloads belong to shared-store minimizers under [Deletion item 4](../../../../docs/deletion.md#account-erasure) and their native exact-locator contract. Search producers must enroll exact personal-copy locators atomically; Search cannot attest those shared payloads erased, scan their JSON or replace their owner's minimizer.                                                                                                                                                                                                                                                                                                                                                        |

### Native account participant

Search must register a durable effect through the actual default `searchWorkModule` on
`com.rezics.access.account-tombstoned.v1`, using validated `data.accountId`, including when no per-account data
applies. Existing event validation, `effectWorkflowId` identities, retries and one-command/one-partition rules
remain in force. Mechanical cleanup runs under narrow platform authority bound to the committed obligation;
it never restores the deleted initiator. Search-disabled configuration alone cannot attest that no historical
projection or prepared resource exists.

Final cleanup commits **before** calling
`acknowledgeErasure({ pool }, { accountId, participant: 'search', outcome: 'erased' | 'none' })`.
That Access function opens its own command transaction in the account's partition. The permanent acknowledgement
is immutable and independent of effect dispatch, workflow history and checkpoint completion. `erased` means actual
cleanup; `none` means actual no-data applicability. Known incomplete or unknown cleanup, unfinished Source
minimization, unresolved custody or an external write keeps Search **pending** and permits neither false outcome.
This participant is one obligation of the shared coordinator, not proof of the whole launch gate, backup expiry,
restore, legal-hold or retention-engine implementation.

Every actual account role and provenance copy needs an indexed native locator owned by its producer: author,
editor, uploader, delegate, operator, member, acting human and any other actual role. The derived
`accountAgentId` is one actual locator; it proves neither all-role coverage nor verified-terminal and foreign
completeness. Discover affected subjects/dependencies only from the account's indexed raw keys and exact copy
locators. No name search, account-wide JSON scan, global subject scan, arbitrary delete-by-query, whole-index
account purge, central ownership graph or permanent soft tombstone substitutes for those producer relations.

The native all-role affected-subject/dependency locator and minimized-source completion export does not exist yet.
The Source/queried-observation closure likewise provides no live cleanup or foreign-drain capability. Current
source suppression is not physical deletion. The independent
[late-write-pruning acceptance](../../test/search/late-write-pruning.test.ts) retains four physical-resurrection
reds despite API suppression; this participant contract does not replace that obligation with another fence,
store or Source design. Runtime implementation waits for these real producer ports and their accepted native
cases. This adoption makes no Source readiness or acknowledgement claim. `searchWorkModule` currently registers
only the indexing service, with no tombstone effect.

The [native participant acceptance](../../test/search/erasure-participant.test.ts) freezes default-module
registration (also with no Search configuration), actual Auth step-up approve/execute through `deletePersona`
using the same `PersonasOptions` as `createPersonas`, effects draining and real `readErasureStatus`. It uses one
owned kernel fixture, real credentials, Access, native subjects/Source and the full default worker in a separate
SDK process. It observes exact fixture-owned document locators across grace/active/rebuilding generations and
original public APIs, eligible public contribution/provenance minimization, an old native transport request and
native delete-version pruning, final acknowledgement and immutable replay. Missing producer capabilities remain
concrete prerequisites; a pending outcome alone is not a passing cleanup case. The broader all-role, verified
terminal, foreign dependency and private/unlisted minimization matrix remains unclosed until real producers exist;
no fake callbacks or manufactured locator/Source/ACK ABI fill it.

### Account participant cost

- Touches: native account obligation/event, producer-owned affected-subject and copy locators, each bounded live
  generation, native Source minimization/current dependencies, real sink visibility/drain and separate account ACK.
- Bound: keyset pages follow only the account's own indexed raw keys and explicit byte limits, children before
  parents. Release each database connection before another partition or engine I/O. Existing Source chunks accept
  at most 256 IDs; generation admission caps the live set at three. Total cleanup grows with actual account copies
  and external writes, never unrelated subjects. Bulk success, refresh, authentication denial and checkpoint/CAS
  completion alone do not discharge that work.
- Growth check: native all-generation/current-disclosure/replay/barrier cases first. Actual three-scale locator,
  cleanup and shared-store costs remain mandatory after the real producer exists; a timing-only or bounded-output
  result supplies no cost proof.

Template startup validates every required released version with one native PUT followed by one exact keyed GET.
Only HTTP 200 with the complete native `{ "acknowledged": true }` receipt admits readback. Readback must be HTTP
200, identify that version, report `found: true` and contain the exact released language, source bytes and compiler
options representation. OpenSearch's `StoredScriptSource` emits string sources verbatim and omits empty options;
these releases use strings without options. No whitespace, escaping, params or total-count semantics are normalized.
Installation passes a fresh request clone so transport mutation cannot change later installs or expected readback.
Any incomplete, contradictory, failed or lost receipt makes the invocation unavailable. Genuine partial native
installs may remain; the next ordinary invocation repeats and validates the whole fixed set without discovery,
an installed-version registry or internal retries. This proves adapter installation only; population, Source and
permission readiness retain their separate gates.

The native representation follows OpenSearch 3.9.0's
[`StoredScriptSource`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/script/StoredScriptSource.java)
and [`GetStoredScriptResponse`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/action/admin/cluster/storedscripts/GetStoredScriptResponse.java).
Native controls also substitute compiler options while preserving the released source and retain an already
installed `subjects-search-v1` across failed installation and repeated recovery. Older versions remain untouched;
they do not expand the fixed required installation set.

`disclosure/check.ts` rejects missing, hidden, redirected or security-revision-mismatched candidates and evaluates
current filter evidence in the existing partial implementation; hit data is projected from the current source snapshot. Suggestions
and item facet labels also use current source checks. This suppresses stale results while relay repair catches up,
subject to the pending real-source/composition proof in [Indexed membership, current disclosure and convergence](#indexed-membership-current-disclosure-and-convergence).
It does **not** establish immediate count privacy: general search totals and facet bucket counts can still include
stale source subjects despite current hit/value checks. The initial Search public response omits all totals,
including verified rating lower bounds. Unsafe engine totals and facet counts must be omitted under [Filtered lists](../../../../docs/filtered-lists.md), without approximate/as_of, zero or row-length fallback. The immediate suppression authority remains
[Deletion](../../../../docs/deletion.md), whose immediate suppression requirement remains authoritative. The existing
relation-facet lower-bound behavior does not resolve general totals or bucket counts.

Source delete, takedown and restore must publish the source changes consumed by `indexer.ts`. The relay re-reads
current state rather than replaying old bodies: a missing/hidden/redirected subject produces an engine delete, and a
visible subject produces a replacement document. Source restore advances the source partition position; the new
snapshot position becomes the external version for reindexing in every live generation. Earlier writes lose while
the engine retains that version; native delete-version pruning still requires the pending-write resolution above. Search does not restore documents independently of source eligibility. Complete
invalidation and default-worker convergence remain pending proof under the [outcome harness contract](../../test/search/README.md).

Physical cleanup uses existing operations only; there is no separate Search 30-day personal-data purge job:

- Per-subject bulk delete/replacement is bounded by the deduplicated affected IDs in one default 64-envelope batch
  (`b <= 64,000` for command-produced logs), one action per ID per live generation. See [Document build, bulk and erasure](#document-build-bulk-and-erasure)
  and [Outbox batch](#outbox-batch); this is asynchronous projection repair, not a source purge deadline or a promise
  about immediate reclamation of engine storage.
- Discovery defaults to every five seconds. Older generations remain live for the default 15-minute grace measured
  from the active generation's activation timestamp, then retirement issues one whole-index DELETE and one SQL
  deletion of at most 4,096 checkpoint rows per generation. Engine work scales with that index's stored data; SQL
  work is the [Retire](#retire) bound, not constant whole-index erasure. Failures retry on later discovery; absent
  activation timestamps and newer unfinished generations are retained. Rebuild admission caps generations at three;
  it does not impose an expiry on an active or unfinished generation.

This specification adopts the missing participant without implementing cleanup or changing existing operations.
The participant bound above and existing indexing Cost bounds below remain separate obligations.

## Indexed membership, current disclosure and convergence

[Filtered lists](../../../../docs/filtered-lists.md) owns the shared list contract. Search owns compilation,
preparation and freshness over existing OpenSearch/PostgreSQL machinery. Semantic supplies complete public facet
projections and disclosure dependencies; Commerce owns owner-local private plans; Performance sets numeric budgets.
State, labels, progress and holdings never enter public Search. The shared pure matcher remains the conformance
reference; mandatory request-time raw-fact replay is superseded. Typed, parameterized SQL ranges/qualifiers may
execute the same released semantics. Same-statement qualifiers, datatypes/units and unknown under NOT remain.

`current-filter-plan.ts` exports the pure native hook `compileCurrentOwnerFilter(filter: FilterDocument):
CurrentOwnerFilterPlan`. `CurrentNativeLeaf` is `Readonly<{ kind: 'catalogue'; clause: FactClause }> |
Readonly<{ kind: 'owner'; leaf: OwnerLeaf }>`; the plan exposes `leaves: CurrentNativeLeaf[]`,
`indices: Map<string, number>`, `positive: Set<number>` and
`evaluate(values: readonly RelationFacetMatch[]): RelationFacetMatch`. It shares the catalogue compiler's one
three-valued AND/OR/NOT interpreter. Both accept already admitted, saved-expanded filters, reject remaining saved
nodes and require one exact native `true`, `false` or `not_proven` per deduplicated leaf before evaluation.
Wrong cardinality, holes and unsupported evidence reject even with a true OR branch; unknown under NOT stays
`not_proven`. First occurrence orders leaves; `positive` records any occurrence under an even number of NOT nodes.

`currentOwnerClauseKey(leaf: CurrentNativeLeaf): string` tags catalogue and owner namespaces. Catalogue keys reuse
`currentClauseKey`; owner presence/state/label/session/holding keys retain every exact profile, state-set, lifecycle,
kind, status and ID pin, normalizing only the set-valued `state.in`. Existing `compileCurrentFilter`, its `FactClause`
leaves and keys stay compatible and reject every owner predicate before I/O. Neither compiler reads a Source,
SQL, an engine or raw private fields. Scalar owner evidence is not permission: native callers must bind viewer-self,
current source and identity, resolve and authorize every leaf before evaluation, and supply definitive false only
from complete native absence. Commerce owns native matchers; full scoped70/excluded/order/population observations
remain required. Compilation changes no HTTP grammar/admission, public Source scope, owner source/preparation
readiness, scope guard or execution budget, and implies no readiness.

Membership uses a complete, identified index observation for the admitted population/predicate, not a sample or
possible-witness hint. Ordinary catalogue edits become filterable within 60 seconds in healthy operation. More than
five minutes of actual source-to-searchable lag gives readiness. Engine refresh alone is not pipeline freshness.
Owner writes appear on the owner's next read. Privacy reductions, takedowns, consent/source revocation have no lag.

### Query-level privacy safety

Current disclosure covers membership, exclusion, order, fields, source metadata and cursor-visible information.
Check current source/Collection authority, original AND terminal eligibility, Access, consent, foreign targets and
tuple fences. An index revision, prepared result or completed identity epoch is never permission.

Query-level privacy-reduction invalidation and acknowledgement is required **in addition to candidate checks**.
Local reductions invalidate public use in their authoritative transaction. Foreign source-fence, target, consent
and Collection reductions invalidate affected public use immediately. Acknowledgement covers actual refresh-visible
projection repair including dependent foreign repair. Observe required current safety state before execution and
revalidate before disclosure. Unsafe, changed, missing or pending acknowledgement means preparation/readiness,
never stale exclusion/order/results. Ordinary checkpoints, `securityRevision`, complete ordinary generations,
returned-ID checks and omitted counts cannot certify this seam.

Withholding a harem tag must protect positive harem results and **NOT harem**: returned-row checks miss the subject
excluded by a stale tag. Paused-indexer negative/order/count cases must stay preparing until acknowledgement covers
the local reduction and all affected foreign repair. This is a required abstract producer/consumer contract, not a
certificate store, safety-token ABI, new permission authority or global identity/home sweep. Current native ports
do not yet implement the complete seam. Omit unsafe engine totals/facet counts over unchecked populations; neither
approximate/as_of labels nor zero/row-length substitutes repair privacy.

### Scope and composed-page admission

Admit filter + source + order together. The prose plan names are direct catalogue index, direct owner index,
prepared public result and prepared owner result; they are not new executable discriminants. A direct plan requires
a page-derived work bound, including engine work. Otherwise use bounded retained preparation on existing stores and
durable work, with finite input progress, quota and expiry; otherwise reject with 422 before enumeration. A composed
Zone page has aggregate admission, at most 16 distinct reads and 128 TOTAL output slots. No LIMIT or timeout proves
an engine bound. Current source checks remain required for ready results.

Successful pages fill the requested size or are genuinely exhausted final pages. If admitted work cannot establish
either, return explicit preparation/readiness. Sparse matches must produce useful pages after finite preparation;
no successful short/empty-page chain over raw nonmatches and no permanent preparing on finite ready input. Preserve
settled work after crash/replay; an essential unknown cannot become false, EOF or a silently skipped interval.

The service-bound Scope runtime must use the same real Search service/compiler and immutable released meaning,
including pin A after activation of B. Collection candidates are not fabricated Search Hits and Commerce does not
supply a second interpreter. `createSearchService` registers only its own returned object with the resolved pool,
client, prefix, Source and release reader. `createSearchScopeForService(service, options)` reuses that runtime and
passes the actual `LeafOptions` unchanged to `createSearchScopeSource`. Clones and injected services cannot bind.
This enables released-filter admission; constructor ownership does not establish native readiness.

`scope-ordered.ts` publishes the additive native output contract, re-exported by `scope-source.ts` on that same
service-bound Scope. `ScopeNativeOrder` is `name | collections`; `collections` means the actual public
`public_collection_count`, descending with missing zero, followed by `name_sort`/canonical routed UUID ascending.
`name` uses `name_sort`/UUID ascending. The exact readonly tuples are `[name:string|null,id:string]` and
`[count:number,name:string|null,id:string]`. Counts must be integers in 0..2147483647 without coercion. Names retain
the actual normalized key (at most 512 UTF-16 units/1536 UTF-8 bytes), including empty strings and native null
missing-last. Shared cursor encoding preserves null as `z` and empty as `s`, with at most 1537 bytes per encoded
name. It does not truncate, hash, replace or re-sort keys using display labels or locale comparators.

`prepare(filter, {nativeOrder, pageSize, allowance, ...})` requires size 1..100 and the existing caller allowance,
validated before I/O. A size without a native order is invalid. Output order and size are immutable capture, query,
basis and preparation definition material, separate from the structural `order` below and Library input sort.
The same factory adds `orderedPrefix(prepared, {order, after, quota, budget, allowance})`. Its order discriminates
the matching tuple in both the request and `SearchScopeOrderedPrefix`, whose hits retain real SearchHit fields
with the exact tuple sort, basis, covered frontier, exhaustion and
`usage:{candidates,work:WorkReceipt,public:PublicFilterCost}`. The canonical Semantic public cost is the native
public/engine breakdown of caller-root settlement, never a second charge, refund or authority. `work(prepared)`
remains the root preparation receipt; the native implementation must charge actual ordered preparation there.

Ordered preparation extends the existing structural worker. Public preparation retains the actual native
consumer observation, replayable population frontier and settled canonical hits in one revision-fenced write.
Ready reads seek the retained byte keys and revalidate the old observation, actual execution start and current
original/terminal Source before disclosure. Keyed native queries use the versioned count-free PIT template,
complete-shard validation and the existing iterator profiler. They never sort a UUID-limited response page.
Missing native Source proof remains `semantic_not_ready`; these algorithms do not establish native readiness.

Owner input still runs through the existing Collection source and current native matcher. Only an actually
exhausted bounded input admits the direct native output path. Larger owner results require Library's admitted
owner/namespace preparation. Its current `MembersPreparationWorkDefinition.definition` has only filter,
structural sort and release; it needs retained `nativeOrder: ScopeNativeOrder` and `pageSize: number` plus an
admitted native ordered frontier/result read/write port. `CollectionKindWorkDefinition` additionally lacks the
retained filter/output definition itself. Search does not persist those private memberships in its public result
store, restore an Actor, substitute generic Source locators for admission or modify Library's native bodies.

One ordered owner step admits quota 1..99 and quota+1 <= budget <= 100, within the supplied candidateKeys
reservation. Every raw key, duplicate, reject, lookahead and reread is charged; unused lookahead never advances
coveredThrough. All [filtered-list budgets](../../../../docs/filtered-lists.md#cost) still apply: direct
`min(600,6s+3)` candidates and at most three refill rounds, ready `2s+2`, composed 16 reads/128 total slots, with
their independent work axes. The returned receipt settles the actual supplied root once. Native Source
availability and Library's missing admitted preparation fields/ports remain explicit integration dependencies.

`service-scope-order.ts:createSearchScopeOrder({pool, options: LeafOptions, clock})` is the internal ordered
Source adapter. `SearchScopeOrder` is `{kind:'id', source?: NativeSourceIdentity} | {kind:'ordinal',
source: NativeSourceIdentity}`. These are native locators; they confer no authority. `prepare(order, allowance)`
returns `{collection, work}` with the complete `CollectionSourceObservation` and native prepared Source.
`rawOrdinal(collection, after: NativeOrdinalKey|null, limit, allowance)` returns the canonical Library
`RawOrdinalCollectionPrefix`; `prefix` and `contains` preserve the native ID APIs and actual work receipts.
`contains` also accepts the native optional `CollectionAliasProgress` as its fourth argument.
The adapter adds no public Search sort and manufactures no Search Hits from Collection rows.

`createSearchScopeForService(service, options)` remains the sole resolved-service boundary with the original two
arguments. `prepare(filter, {releaseDigest?, order?, allowance?, type?})`, `prefix` and `evaluate` retain their
existing calls. `sourcePrefix` returns actual canonical Collection candidates; `ordinalPrefix` returns canonical
subject/order locators with a native ordinal frontier. The exact requested/saved-expanded filter, immutable release,
projection profile, full native source/sort, authenticated reader and full committed scoped observation bind each
factory-local handle. Indexed plans also bind the real physical name/UUID/generation. A pure native owner Collection
plan instead binds `nativeOwner:{source,observation}` and never discovers a public index or invents its generation.
Mixed plans retain indexed authority and a separate actual public projection capture; every final scope comparison
revalidates both captures. Native owner evidence delegates to Library's complete-original closure and current
native points before using the shared Boolean interpreter, and is reread before settlement. A clone or a handle from another factory cannot execute.

`scope-preparation.ts` advances complete public structural capture or Library native custody and the agreed
`createIdentityScopedObservations(pool)` registration/revalidation protocol. The existing Search WorkModule runs
bounded capture steps and discovers sixteen due locators per tick. A request can advance one step with its actual
deadline and shared allowance. Capture progress is durable; neither raw count, allocated epoch nor an empty prefix
makes it ready. Expired work retains unknown native custody instead of disposing it; a later reader renews the
retained locator and resumes its native frontier. No consumer arms identity
attempts or constructs receiving receipts. A current native scoped observation is checked before and finally
around prefix, evidence evaluation and ready preparation, including empty/exhausted results.

Curated ordinal input includes deleted and excluded rows. Current reader steps retain a finite raw frontier and
canonical DISTINCT order keys before output selection. Every original and terminal is resolved through native
membership/current evidence; the one shared current-filter matcher/interpreter handles catalogue leaves. Output
uses the retained ordinal index before LIMIT, then repeats native current membership/evidence and the complete
scope guard. A sparse unfinished scan returns readiness, not a short successful page. Reader authority is never
serialized into work; background capture work holds only native structural locators.

`scope-execution.ts` shares one root allowance across source, alias, metadata, leaf, refusal, replay and lookahead
work. Candidate keys and native dimensions remain independent; leaf calls use at most 101 remaining keys, and
witness revalidation uses the original `LeafOptions`. Partial facts never prove absence. Native progress keeps the
exact subject, leaf ordinal, composite basis and separate retained native leaf basis; unfinished native membership
keeps its own `CollectionAliasProgress`. Both resume through their original producers. The resolved engine transport
also consumes actual UTF-8 request/response bytes and the same absolute deadline from this root. There is no copied private fact store,
second interpreter, replacement client or Boolean authorization callback.

`scope-work-context.ts` owns the server-only `ScopeWorkContext` union. Curated Members work uses
`{kind:'members-preparation',tx,locator}` and its original Library episode getter. Native Kind work instead uses
`{kind:'collection-kind-preparation',tx,locator}` with the exact `CollectionKindPreparationLocator` and whole
`CollectionKindWorkDefinition` from `library/collection-kind-work-admission.ts`. A Kind preparation ID never
becomes a Members episode ID. Both branches require live Core work-step resources, the same pool/client, current
command time and the exact fenced owner/partition before calling their actual native admission and getter.
Core liveness is necessary, not permission. The Kind producer owns verification of the COMMITTED preparation or
repair intent, namespace, current source generation, pinned release, current Type audience, observation, repair
receipt and source custody. Search also checks the returned source/observation/custody bindings and repeats the
whole native result comparison before settlement. Neither getter data nor a successful admission scalar grants
reader access.

The Members branch retains the entire native `{definition,sourceIdentity,observation}` result in its factory-local
handle. Caller filter, release and structural order are exact compatibility checks. Search rereads the immutable
release on the admitted operational client, compiles with `compileCurrentOwnerFilter`, and uses
`evaluateScopeSubjects` and Library's existing native fact points and owner matcher. It never constructs a reader
Actor or runs ordinary read permission to admit background work. Pure owner plans use the exclusive native
`ScopeBasis` branch, with the actual native source and Collection observation; they have no public index,
generation or UUID. A plan requiring public catalogue evidence refuses `dependency_unavailable` before opening
OpenSearch or another checkout. Native owner truth cannot supply that independent public authority.

`scope-members-work.ts` reads the actual `library.canonical_source_scope.capture_id` and `committed_revision` on
that same client, at the complete current canonical generation and exact source fence. The complete native
identity, Collection basis and capture/revision digest must agree. Semantic revalidation receives the live `tx`.
Original-to-terminal mapping comes from the actual READY scoped enrollment's forward directory and ticket,
including its original, registration and capture; Search creates no association, History position, custody or
physical release. A complete bounded canonical original group supplies Library's shared owner-fact evaluator.
The terminal original is included even when it has no stored occurrence. Historical profile predicates read
their actual immutable accepting releases. Full raw fact windows and incomplete groups remain `not_proven`.

Members ID continuation uses the existing native `sourcePrefix`. Ordinal continuation consumes one fixed raw
window, advances past deleted and rejected positions, and returns the earliest live occurrence of each canonical
group. It never refills to fill output. Unknown evidence stops before its raw slot and cannot establish exhaustion.
Raw group keys and leaf progress remain private to this live factory/transaction; supplied continuation is
validated against the native composite basis and never restores a verdict. A fresh factory reconstructs the
bounded group from the real source instead of trusting a serialized alias list. Members uses no retained Search
preparation, ordinal table, pooled progress read or save. Admission, complete definition/source observation,
Scope70 and the native owner-fact fence are reread after dependent work and before any result is used. A changed
episode, release, source/capture, deadline or completed transaction refuses and requires fresh preparation.

Every Members operation transfers the remaining caller original across all eight work axes. Native definition
SQL is metered on the same transaction before dispatch, including locking reads and repeated admission. Existing
Source operations receive a disjoint allowance while native admission retains its own declared ceiling. Narrow
Search SQL, scoped metadata, original mapping, raw groups, fact points, pinned releases and final rereads reserve
their physical bounds before I/O. Dispatched failures settle their full bound; repeats add to the same receipt.
Cold release projections first read their native size and conservatively require the maximum expansion bound for
compressed data; a warm immutable cache still checks existence on the same client. Unknown native admission SQL
without a declared footprint refuses before dispatch. The opaque result and additive receipt grant neither
Commerce admission nor final episode completion. Commerce still owns its independent final fences and storage.

`test/search/members-native-scope.test.ts` authors real configured Members admission, useful ID/ordinal owner
evaluation, rejected/deleted positions, hostile hints, stale/expired admission, transaction reuse, final currentness
and cumulative cost controls, plus unrelated owner data at 1/10/100. Connected/native/growth execution remains
UNRUN under the minimal source-delivery policy. The current explicit Members producer stub remains an exact
activation refusal; these Search bodies do not substitute a ready certificate for genuine producer delivery.

Whole-query publication has its own additive `{kind:'collection-publication',tx,locator}` branch,
`CollectionPublicationWorkContext`. It imports the original `CollectionPublicationLocator`,
`CollectionPublicationWorkDefinition`, `admitCollectionPublicationStep` and
`readCollectionPublicationWorkDefinition` from `library/collection-publication-work-admission.ts`.
`readCollectionPublicationScopeWorkDefinition` requires the genuine live work-step client, original deadline,
pool, partition, fenced owner and command time before calling both native functions on that client.
It compares the entire returned locator, pinned definition, immutable rule, original creation source,
private input, target, Source/identity observation, repair receipt and custody. The actual input is the same
Collection's `private_working_source` / `private_builtin`, even when complete A remains selected.
Output B must remain building with no complete receipt; A cannot supply B's input or exhaustion proof.
Search compares the committed creation data and its commitments without rebuilding it or restoring an Actor.

Publication dispatch pins the complete filter/release and ID order in the existing Scope compiler and Source
path. Whole native data is detached for comparisons, reread after foreign evidence and before progress settlement,
and kept only in the factory-local work handle. Private owner rows never enter public Search storage.
Public clauses still require independent physical/query proof. These guards do not implement Library's
unavailable native publication episode/admission/getter, same-client owner closure or scoped leaf producer;
they establish no native completeness or C5 proof. The final ordinary reader still checks current Access,
original/terminal subjects, Source and identity. Accounts' final `collection:update` authorization, restored
initiator at the actual command time, write basis and Library's atomic complete publication remain separate.

Kind dispatch uses the existing Source preparation, plan compiler, evaluator and ledger. It selects the native
pinned release and exact ID-ordered source; the Kind default predicate remains Library-owned. Private predicates
stay within the admitted owner/source namespace; a public-output source cannot select private owner leaves.
A pure owner plan uses the actual native source basis. Mixed public clauses still require the real index and
separate current public Source capture. Local Source preparation holds no additional checkout when foreign public
evidence runs. A final same-client native comparison includes the whole audience/episode/source/custody result.
Kind leaf continuation stays private to the factory-local work handle; it never writes an Actor, transaction,
permission verdict or native result into retained Search state. Ordinary readers continue to use full current
source, original/terminal subject and scoped-identity checks.

`library/native-source-output-types.ts` owns the public-output identity and immutable activation locator, re-exported
by `native-source-custody.ts`. Its public branch has no account ID. Current source generation, immutable activation
source generation, output generation and canonical decimal Core position remain distinct. The existing account
custody adapter refuses that branch before account predicates; only the actual public-output producer can prove
its complete selected output and committed activation. These consuming declarations do not implement activation,
output storage or frozen custody.

The native Members and Kind episode producers are absent in this checkout and their original adapters explicitly
report unavailability. Kind dispatch reaches the same native Source adapter; its metadata/canonical readers
still require their same-client work body. Getter data cannot construct a ready Source or replace current Type
audience evidence. Native traversal, owner closure, public capture and leaf completeness require their original
producers; no empty result, sampled evidence or synthetic index stands in for them. Declaration and dispatch coverage do not establish native readiness.

The agreed Semantic scoped observation/public capture declarations are installed with typed unavailable producers
until their native bodies integrate. `readScopeLeafEvidence` still reports native not-ready; the complete Collection
Source body and Library current owner-leaf authorization/evidence remain integration dependencies. Owner filters
cannot obtain a ready handle while that authorization boundary is absent, including under true OR/NOT. Public
Source binding also remains typed unavailable. These dependencies do not certify public catalogue capture through
Library metadata or point mappings. Native outcome/growth verification remains integration work; compilation alone
asserts no native readiness.

Existing code and frozen tests remain until replacement
native acceptance permits removal. The old universal 256 raw-key ledger, whole-selected-slot observation,
one-pending-leaf final replay and bans on derived query/index state or typed SQL are removed as list rules.
Unrelated native batch/string/byte/cursor limits remain in force.

### Canonical lists and transport

Maintain canonical-ID indexes, one public terminal document and unique prepared result rows per generation and
canonical ID. The shared identity epoch stays pending throughout serialized durable merge/unmerge/repoint work;
lists prepare while pending and cursors restart after publication changes. Group admission is at most 4,096
originals before effects, with direct published redirects to active terminals. Do not walk all aliases or repeat
all-home identity-basis sweeps at request time. Original and terminal disclosure still applies. Stored personal
IDs/notes/multiplicity remain; canonical browsing and occurrence editing have distinct obligations under the
[identity authority](../semantic/README.md#identity).

Preserve Search's encrypted cursor profile, stable request/viewer binding, exact native tuples and fresh-start
behavior for unusable Zone POST progress. Reauthorize the principal and sources on every continuation. Zone POST
uses the existing transport: complete common page 200, explicit preparation 202 `{next}`, or no-progress/unavailable
503 Problem + Retry-After without cursor. No partial common page. Web follows at most four 202 steps then renders
private/no-store preparing with continuation retained. Progress names retained preparation/current generation,
never cached permissions, per-leaf verdicts or a client result vector. No schema/codec/status change is selected.
The [Search supervisor](../../test/search/support/outcome-supervisor.ts) calls `createSemanticDriver` in the
[Semantic outcome driver](../../test/semantic/outcome-driver.ts), which creates its own named `suspended` account,
issues an ordinary Auth bearer, then calls the real `createSuspensionCommands.suspend` with an authenticated
governor and native Access. The [Pages outcome driver](../../test/presentation/outcome-driver.ts) wraps that driver.
None calls `createPersonas`; the canonical [personas fixture](../../test/support/personas.ts) demonstrates the same
native suspension contract with a separate builder and account instance. These drivers do not synthesize SQL
suspension state or tokens. Accounts suspension advances the
[authentication floor](../access/authenticate.ts) before session revocation
([suspension command](../access/suspension.ts)), so Search and Pages reject the pre-suspension bearer with JSON
401 `invalid_credentials` and `WWW-Authenticate: Bearer error="invalid_token"`; it never downgrades to anonymous.
Auth mints active accounts only. A correct-password sign-in for a suspended account returns 403 `ACCOUNT_SUSPENDED`
without issuing a session, while a wrong password remains ordinary 401; Accounts owns that native producer case,
pending its native acceptance receipt. Kernel 403 `account_suspended` for a hypothetical verified suspended bearer
is a defensive branch, not the native suspended-persona outcome.

Owner-document adoption supplies no native pass. The prior native acceptance ran once and failed inherited
default-module startup and the Pages deadline; those failures remain required evidence. The prior root typecheck
recorded exit 0. No native, full or root check is rerun for this adoption; the full main/root gate remains unproven.
Native closure still requires all original cases and actual new persona/sign-in receipts, with no skips.

The [integration audit](../../../../docs/research/semantic-integration-audit-zone-composition.md) establishes the
resource substrate, not actual membership/page/default execution or Zone-specific withholding/purge/account/
scheduler completion. Typed schemas, loaders, cursor capacity and helper setup prove their own boundaries only.
Preserve native two-release pins, canonical cross-page ordering, current grant/source/fact revocation, cursor
restart/session/cache, persona/API/default composition and growth requirements. Old SAME256, final replay,
alias-window and home-certificate remedies in evidence reports are superseded by indexed/prepared/epoch behavior.

## Global rating order

The first public rating sort is limited to the public aggregate for the Global population and standard question.
[First public scope](../../../../docs/scope.md) defers Realm rating sorts; private Realm figures never enter the
public Search index. [Rating](../rating/README.md) owns the score formula, disclosure thresholds and privacy rules.
Search uses the published score and does not recompute or reinterpret that policy.

The rating source is the current public figure for a subject, read with that subject from the same anchor partition
and the same repeatable-read `core.partition.position`. A missing figure means unscored only after a complete,
successful source read. Source failure is unavailable evidence and fails closed. The current figure proof must also
confirm that the figure remains publicly eligible and that its score/revision still matches the indexed candidate;
an indexed score or matching epoch alone is not current eligibility proof. The runtime composition and its proof
remain pending, so this section records the contract rather than claiming production support.

The eligible Global prior has one frozen epoch identity. Below its 50-vote eligibility threshold the native state is
known ineligible and the selected epoch is null; an unavailable native read is an error, not null. Eligible epoch
identities are never reused after invalidation. The index publishes the epoch and score together from one public
figure. It accepts only one positive safe-integer epoch and one finite scalar score from 0 through 10; the mapping
uses a `long` epoch and a `double` score without coercion. Field existence is not a scalar-data validator, so the
source/document boundary enforces these invariants. Unscored state is absent/null; no numeric sentinel or
`null_value` substitutes for it.

For the common admitted search predicate `F`, let `P` mean that the selected epoch is non-null, the indexed figure
epoch equals it and `rating_score` exists. Phase A searches `F AND P`, ordered by score descending, normalized
`name_sort` ascending with missing last, then unique `id` ascending. Phase B searches `F AND NOT P`, where the
entire conjunction `P` is one complement clause, ordered by `name_sort` ascending with missing last, then `id`
ascending. A known null epoch makes A empty and B all of F. A real score of zero belongs to A; stale scores and
missing/null epochs or scores belong to B. The common query remains identical in both phases. This native order is
equivalent to scored-first ordering only for a fixed indexed state and the validated scalar-field invariants; it
uses no per-match rating script or fetched-prefix reranking. See the pinned OpenSearch 3.9.0
[field sort implementation](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/sort/FieldSortBuilder.java#L410-L449).

Resolve and pin one concrete physical generation before either phase and use it for both phases, count-only searches
and every refill, including searches returning zero hits. Read the selected native epoch before discovery, keep it
fixed throughout the response and read it again before returning. An observed epoch or active-generation change
restarts with HTTP 409; unavailable evidence fails closed. A null epoch at both ends proves only that the current
ordering rule is unscored at both reads: it does not prove that no eligible interval occurred between them. No
transition-history field is introduced.

The existing phase implementation below retains its native request quotas; these do not admit a complete list
plan or replace Performance allowances. Each refill round uses at most two native searches, including any count-only search. A shared raw-hit budget
`q = min(200, 2 * remaining_page_slots + 1)` applies across A and B; the page uses at most three rounds and 600
raw hits. Search advances from the last consumed native hit, including stale or rejected hits, and leaves an
acceptable lookahead unconsumed. Do not advance through an unconsumed A hit, strip the score from an A tuple to
make a B tuple, or synthesize a sort sentinel. A's raw tuple is `[score, name_sort|null, id]`; B's is
`[name_sort|null, id]`. Preserve the engine's null exactly. An engine short or empty response proves exhaustion only for that phase after its tuple; the API must still fill the requested page, establish final exhaustion or return preparation/readiness; timeouts, failed shards, partial responses or early termination do not prove
order or exhaustion. OpenSearch checks tuple arity against the selected sort and preserves returned null sort values
([`SearchAfterBuilder`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/searchafter/SearchAfterBuilder.java#L124-L149),
[`SearchSortValues`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/SearchSortValues.java#L70-L110)).

Current-source rejection consumes and drops an unsafe hit; Search never exposes its old score, relabels it as
unscored in place or reranks it. This phase behavior alone does not establish query-level privacy or complete
current-native order; the required safety observation and acknowledgement govern disclosure. This existing phase implementation does not prove current top-N or complete canonical traversal. Adopted lists require canonical cross-page uniqueness and epoch restart, with preparation where the direct plan cannot establish useful pages. A/B phase totals are internal indexed observations under a
fixed-state theorem only. The initial public response has no rating total, including `lower_bound`; neither live
phase counts nor a disclosed-hit row-length fallback supplies a safe aggregate. A future separately proved safe
aggregate contract may admit counts. A subject can move between phases between searches even when epoch and
generation are unchanged.

Keep released `subjects-search-v2` source and ID unchanged. Reuse it if the fixed server-built phase filters, sorts,
physical target and zero-size count request fit its existing template contract; introduce a new template version
only if the stored source must change.

## Confidential cursor and bounded name sort

The Search cursor contract uses the shared encrypted list-cursor Search profile with AES-GCM. Its authenticated
binding covers the route/operation, canonical request hash and viewer. The viewer is a real lowercase account UUID
or null for anonymous readers. The encrypted position carries the concrete generation, selected Global question
and epoch, operation/sort-template version, phase and last consumed native tuple; authenticate the original request
first, then restart with HTTP 409 on a valid cursor whose current rating context has changed. Do not change the
authenticated request hash to the current epoch. All search positions use fresh random salt,
15-minute expiry including anonymous viewers and a 60-second future-time allowance. Profile cross-decode fails.
The service factory accepts the kernel's optional domain clock, defaulting to the actual system clock. Search
and facets sample it once at their request boundary; an explicit numeric `now` keeps its existing meaning and
bypasses that default. HTTP search (including rating order) and facets pass the resolved kernel clock to the
service. Cursor lifetime comparisons remain inclusive at 15 minutes and 60 seconds of future skew. Facets
currently return values without continuation tokens. Source timestamps and `as_of` remain native observations;
authorization evidence and wall-time request deadlines keep their existing clocks and guards. Sampling the clock
adds no SQL, engine request or Source read.

There is no HMAC-readable position or legacy plaintext fallback. The Search adapter still needs the encrypted
profile migration and outcome proof; this contract does not claim that runtime work is complete.

The bounded profile accepts at most 8 tuple keys, 2,560 UTF-8 bytes per key, 3,072 aggregate string bytes,
3,584 serialized bytes and 4,864 token characters; the HTTP cursor limit derives from this profile, with no legacy
4,096-character cap. Native tuples preserve exact type and value using the profile's `s` string, `n` finite-number
and `z` null encodings. Phase and tuple arity are validated; score zero remains a number, and neither tuple values
nor names are truncated, hashed or reconstructed from display data. Base64 inspection cannot recover a hidden sort
key or subject id. If an acceptable B hit is lookahead before any B hit is consumed, retain the last consumed A
tuple; the next request may confirm A exhaustion and request B within the same two-search budget. The cursor changes
to B only after a B hit is consumed.

For native name ordering, Search stores the full normalized name key only when it is at most 512 UTF-16 code units;
missing and oversized keys use null with native missing-last behavior and unique `id` ties. Do not truncate or hash
the key. Full names and `names.exact` remain unchanged. The index's `name_key` normalizer is applied to the complete visible name in a
bounded write-side `_analyze` pass before bulk indexing: deduplicate distinct nonnull raw names and send one
`_analyze` request per name, with at most 16 requests in flight. Do not send hidden or deleted action names to
analysis. Keep one bulk action and its anchor external version
per subject; if normalization fails, do not partially bulk or advance the checkpoint. Mapping `ignore_above: 512`
is only a defense: OpenSearch checks raw string length before applying the normalizer, so a short input can expand
past the normalized bound. See the pinned OpenSearch 3.9.0
[keyword mapping implementation](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/mapper/KeywordFieldMapper.java#L1023-L1031).
Existing oversized indexed keys require replay into a real new generation before bounded-read readiness; a mapping
update does not rewrite existing terms.

## Cost

This inventory describes existing native components and their partial implementation bounds, not admission of a
complete list plan. Old refill/drop behavior, sampled facets and counts described as current below do not satisfy
[Filtered lists](../../../../docs/filtered-lists.md). Production list admission must bind the actual internal cost
object, shared harness counters, useful-page behavior and query-level privacy acknowledgement before acceptance.
Native batch limits keep their units; there is no universal 256-key page allowance.

These are derivations from `src/search/`, `src/events/`, the called Access SQL, `db/search/` and the core/semantic
schema, not measurements or guaranteed PostgreSQL plans. Search owns the engine candidate and recheck contract.
Semantic owns relation-facet witness selection, current statement and fence truth, durable repair metadata, rebuild
work and its SQL cost derivation; the [semantic relation-facet design](../semantic/relation-facets-design.md) is the
authority for those details. Semantic source/worker composition and its final real-source claim remain pending.

The criterion is a bounded anchor neighbourhood per query, hit or change, with about changes × index depth work;
kernel enumeration and source reads are bounded as described below. OpenSearch query, sort and count work can grow
with matching documents and shard merges; these request and candidate limits establish no O(1) engine-work or
latency guarantee.
`N` is total subjects, `P` rows in an anchor partition (including history and other consumers where relevant), `H`
outbox rows in one partition, `b` event changes in a batch, `h` candidates examined on a page, `s` requested results,
`d` page depth, `C` checkpoints for one consumer (at most 4,096), `k` rows/documents changed by an operation, and
`M` the number of activated vertical manifests in the active release together with the bundled catalogue. `F` is
facet-capable facts per indexed subject and `Q` qualifiers per fact. `ell` is the number of admitted filter leaves
(`ell <= 32`); each `IN` has at most 64 values. A relation facet has at most 128 distinct sampled values per
declared property. A source point call accepts at most 256 probes.

Write `L(x) = O(log(2+x))`: a unique B-tree probe examines constant rows and logarithmic shared blocks; a range
returning k rows costs `O(L(x)+k)` rows/index work and blocks on an indexed path. The partition map has 4,096
entries, routes map by `route >>> 4`, and checkpoint/outbox keys are `(partition_no,consumer)` and
`(partition_no,position,event_seq)` respectively.

Search uses the default 64-envelope limit; commands cap events per envelope at 1,000, hence `b <= 64,000` for
command-produced logs (the outbox DDL itself has no upper event-count check), and distinct changed subjects are at
most b. Search validates `1 <= s <= 100` (default 20); a page makes at most three rounds of
`min(200, 2 * remaining + 1)` hits, hence `h <= 600`; suggest returns at most 10 results from at most 20 candidates.
Search groups source work by anchor partition, sends no more than 256 relation probes per call, admits at most 32
leaves and 64 values per `IN`, and never scans relation degree or expands qualifier combinations per request.

Unless stated otherwise, an operation writes nothing, and rows/blocks mean kernel SQL examinations/shared blocks,
not merely returned rows; constant request counts exclude no hidden per-hit source SQL guarantee. Growth checks below
separate existing call-count assertions from SQL row/block checks; grow the total by adding unrelated subjects, then
grow the anchor partition independently while fixing its selected neighbourhood, payload sizes, consumer/generation
count and other named inputs. Test references identify coverage and verification requirements; they are not claims of
new measurements or passing tests.

Relay discovery, freshness, reconciliation and retirement use cross-partition SQL on a shared pool. Their fixed
4,096-partition cardinality does not make them executable on separately placed partition databases.

### Install and validate released templates

- Touches: one PUT and one exact keyed GET per required released template, using bounded native response bodies
  and immutable literal comparison. No document, Source or SQL reads are involved.
- Bound: O(fixed template count and bytes), independent of native document/script population. The first failure
  stops that invocation. Each later invocation repeats the same fixed set; there is no inventory or hidden retry.
- Growth check: `test/search/query.test.ts` installs with 64, 512 and 4,096 unrelated native documents and scripts,
  retaining exact paths, request bodies/bytes, completed native receipts, failed readback and independent retries.
  Its native first/middle/last controls cover acknowledgement/readback failures, lost responses, actual substitution,
  mutation isolation and legitimate existing releases. Original query and generation suites run after genuine recovery;
  `test/search/template-installation.test.ts` retains the independent negative native acknowledgement boundary.

### Consume one engine response

- Touches: `opensearch.ts` reads the original native HTTP response stream once, with one reader and abort
  controller per request. Request/query/bulk serialization and engine operation counts are unchanged.
- Bound: At most 4 MiB of observed response bytes may enter the retained buffer before UTF-8 decoding and JSON
  parsing, including chunked and error bodies. An honest oversized Content-Length can refuse at headers; every
  received chunk is still counted when the length is absent, invalid or smaller. Retained bytes use one fixed-capacity
  buffer, processing is O(bytes), and refusal aborts/cancels the producer and releases the reader. The deadline covers
  headers and the entire body. Internal constructor tests may lower the ceiling but cannot raise or disable it;
  no public request or environment setting changes this budget. HEAD and empty responses retain undefined bodies.
  Malformed successful JSON fails unavailable; bounded native 4xx JSON retains internal `OpenSearchError` diagnostic
  metadata, while printable messages omit response payloads and native failures have no credential-bearing cause.
  Gateway failures (502/503/504), network loss, abort and oversized responses remain unavailable.
- Growth check: [native transport acceptance](../../test/search/opensearch.test.ts) checks actual byte counts and
  one native request at three unrelated engine populations, exact/boundary+1 bytes, split multibyte UTF-8, length
  faults, error bodies, deadlines, cancellation, cleanup and subsequent native recovery. Successful query/bulk/search
  responses come from the check's real OpenSearch node. The frozen
  [oversized-response acceptance](../../test/search/bounded-opensearch-transport.test.ts) covers the production
  ceiling. This is transport accounting, not proof of whole-engine physical work, heap peak, Source composition
  or private-data safety; original operation/candidate limits still apply.

### Relay discovery

- Touches: `events/scan-partitions.sql` runs one statement per live consumer each tick (default 100 ms), reading the
  whole `core.partition` map and checkpoint `(partition_no,consumer)` probes, plus one `outbox_pkey` probe at
  `(partition_no, checkpoint + 1, 0)` for each of the `A` partitions ahead of the consumer to order them by the
  `recorded_at` of their first pending envelope, oldest first; returns at most 4,096 partitions and reads no
  subject/history. Grow N/P with C and consumer count fixed.
- Bound: Rows `O(4,096 + A)` with `A <= 4,096`; indexed blocks `O(4096*L(P) + A*L(H))`, one statement per
  consumer, independent of H/b; sort is `O(A log A)`. This is periodic global coordination, not a scan per change.
- Growth check: [test/relay-effects.test.ts](../../test/relay-effects.test.ts): “effects relay discovery stays within
  its bound as outbox history grows”.

### Outbox batch

- Touches: `projectBatch` reads one partition head by PK, generates at most 64 consecutive positions after the
  checkpoint, and reads every event at those positions through the outbox PK; no read from position zero. Grow H/N/P,
  fixing b, envelope count and selected payloads.
- Bound: `O(64+b)` rows, `O(64*L(H)+b+L(4096))` blocks, one log statement; parsing/deduplication is linear in b,
  and sorting is bounded batch data rather than history.
- Growth check: [test/growth-events.test.ts](../../test/growth-events.test.ts): “Batch log stays within its bound as
  H grows”; “Full batch log reads only the batch's outbox rows at every partition history” uses histories `[32, 256,
  2048]`.

### Checkpoint snapshot and advance

- Touches: `ensure-checkpoint.sql`, `lock-checkpoint.sql` and `compare-advance-checkpoint.sql` insert one
  `(partition_no,consumer)` row if absent, lock it with SKIP LOCKED, then compare-and-set after projection. One
  partition only; the snapshot transaction releases before source/engine calls. Grow N/P/H, fixing one consumer and b.
- Bound: Constant rows read and `k <= 1` row changed; `O(L(P))` blocks per probe/mutation. A successful nonempty
  batch uses six statements including BEGIN, ensure, lock, log read, COMMIT and CAS; busy/empty paths do less; retry
  repeats the batch.
- Growth check: [test/growth-events.test.ts](../../test/growth-events.test.ts): “Batch checkpoints stays within its
  bound as C grows” and “Batch log stays within its bound as H grows”.

### Source snapshot

- Before listing, normalization or engine writes for a chunk, `indexer.ts` validates the returned observation
  against that exact request: its home must equal the requested/envelope partition, its position must be a bigint
  within the existing external-version safe integer range and at least the captured batch's final envelope position,
  and every returned record must have a unique requested key in that home. Subject state, visibility, redirect,
  security revision and projection payload must satisfy the existing Source contract, including records that would
  produce deletes. A missing requested key in a valid observation is absence; missing or malformed evidence and
  observations predating captured work reject and leave the checkpoint unchanged. The adapter never guesses a
  position, drops extra records or turns an unavailable read into an empty snapshot. Source advancement between
  chunks is valid: each chunk retains its own observed version, while the checkpoint acknowledges only captured
  envelopes. A later invalid chunk may leave an already visible prefix; the same consumer retries normally.
  This is request/observation custody, not permission by UUID, foreign Source provenance, complete query privacy,
  physical index incarnation safety, erasure or identity proof. The native Semantic Source and current-disclosure
  producers retain their own obligations; sink response validation remains in the shared receipt writer.
- Request hydration uses `request-source-snapshot.ts` for both `checkHits` and facet value labels. Each observation
  must name the actual requested home and a native nonnegative bigint position. All returned IDs must be unique,
  routable and exactly requested by that call; extra keys, duplicate bodies and malformed metadata reject even
  when the record would otherwise be hidden or rejected. Custody, visibility, routable redirect and nonnegative
  safe-integer security revision are validated for the entire observation before current facts are used. Terms,
  statements, facets and overflow markers must have their existing Source shapes. A valid observation may omit
  requested IDs: only that is ordinary absence. Request validation imposes no indexer envelope obligation or
  external-version upper bound on the native position. `SearchUnavailableError` crosses `sourceRequest` as retryable
  503 `index_not_ready`; a later invalid observation fails the whole response, without publishing a partial page.
  The service's overflow/rating observer validates before examining any facts too.
- Request cost: for `k` distinct routable keys grouped into homes, each helper makes exactly
  `sum(ceil(keys_in_home/256))` Source calls, zero for empty input. Chunks in one home are sequential; home concurrency
  remains bounded (eight by default). Validation keeps an O(k) requested-key set and examines the bounded returned
  payload without another Source, SQL or engine operation. Hits retain input order and duplicate candidates; facet
  labels retain first-requested order. Missing and rejected candidates remain in the actual read charge, while
  existing full Boolean rechecks deduplicate and charge every required relation probe in batches of at most 256.
  No per-hit read, enumeration, count restoration, permission mirror or identity authority is introduced.
  [Request boundary coverage](../../test/search/disclosure.test.ts) uses real Access writes and native semantic
  observations, cloning executed snapshots only for corruption controls. Fixed-key native hydration measures
  SQL plans, examined rows, statements, blocks and wire bytes with the shared growth harness at 64/512/4096 unrelated
  records and history; it counts actual calls, keys and rejects. Native fixtures use the existing descriptive genre
  facts: the base semantic Source has no relation probe method. Controlled overflow with that missing port fails
  closed; the existing overflow suite separately counts every adapter probe without claiming native Source authority.
  These adapter controls do not establish
  whole-query privacy, Source runtime or default composition closure. The frozen wrong-home negative and the
  original real-source batching suite remain independent acceptance input.

- Touches: Indexing calls `SubjectSource.read(partition, ids)` in chunks of at most 256 deduplicated IDs in one
  partition. For `u` requested anchors, `c = ceil(u/256)` calls are made, with zero calls for `u = 0`; the ordinary
  64-envelope/1,000-event command bounds give at most 64,000 event anchors and 250 source calls per batch. Every
  call is its own native repeatable-read snapshot and returns that chunk's partition position. The snapshot pairs
  the partition position with subject state, labels,
  aliases, descriptions, adopted Global descriptive statements and relation facets. Only outgoing relation
  properties declared as facets for the subject's current type contribute to the existing `statements` and nested
  `facts` fields; nonfacets and incoming edges do not. Each declared relation property contributes at most 128
  distinct visible values, with an overflow property marker when more values exist. Descriptive values keep their
  prior behavior. Relation qualifiers can remain stored data, but role/episode qualifiers are not relation-facet
  predicates; a qualified relation filter is invalid, while descriptive qualifiers keep their existing meaning.
  Semantic's visible-at-build witness pointer stays internal and is not a Search field. Semantic's source, witness,
  fence and SQL costs are owned by the linked design rather than restated here.
- Bound: For `u` distinct requested anchors in one partition, indexing makes `c = ceil(u/256)` source calls,
  at most `c` listing reads and at most `c` actual bulks; all are zero when `u = 0`. Every index/delete action uses
  exactly the partition position from its own chunk snapshot as its external version. Chunks are processed so each
  bulk is refresh-visible before checkpoint advance; no DB client or transaction spans engine HTTP. A later chunk
  failure prevents checkpoint advance, and normal replay handles any visible prefix. The separate shared
  visibility-409-winner proof is not implemented by this chunking. Counts and native facts retain their input and
  history costs. Relation membership probes are capped at 256 per call. The relation projection is bounded by 128 distinct values per declared property, not the source's
  full relation degree; a missing value from a truncated sample never proves absence. A temporarily underfilled
  snapshot is also not evidence of complete absence. Treating nonoverflow snapshot absence as complete requires the
  integration proof described above. Semantic source and durable rebuild work still require their real-source
  verification; this README does not claim that composition or its measurements are complete.
- Custody cost: one temporary requested-key set and returned-record map for this chunk, `O(k + records)` key work
  for `k <= 256`, plus linear validation of the existing record payload. Invalid observations perform no listing,
  normalizer or engine work for that chunk. Validation adds no SQL, Source or engine calls, count, enumeration,
  partition scan, proof store or queue. The original 64-envelope batch limit and each native chunk's version remain.
  [Native adapter custody tests](../../test/search/indexer-source-batches.test.ts) hold the two requested keys fixed
  at 0, 8 and 96 unrelated command envelopes, drain history through ordinary 64-envelope relays, and assert exact
  requests, zero invalid-observation projection calls, unchanged checkpoints, real visible documents and successful
  same-consumer retry. A 257-key case retains the visible prefix after a later wrong-home empty read, then proves
  real 409 replay and a source advance between retry chunks. The frozen
  [wrong-home test](../../test/search/source-snapshot-custody.test.ts) independently covers the empty-read defect.
  These boundary fault injections do not manufacture Source authority; the unchanged real-source batching suite
  below supplies actual Source operations, Access, per-chunk statements and count oracles.
- Growth check: Search projection coverage: [test/search/relation-overflow-mapping.test.ts](../../test/search/relation-overflow-mapping.test.ts),
  “the document keeps all 128 sampled relation values and omits empty overflow markers”. Semantic verification
  requirements (not completed measurements): [test/semantic/relation-facet-source.test.ts](../../test/semantic/relation-facet-source.test.ts),
  “a snapshot includes visible adopted outgoing relation facets but no nonfacet or incoming relations” and “a bounded
  witness probe suppresses hidden evidence and schedules finite rebuild convergence”; [test/semantic/growth-relation-facet-source.test.ts](../../test/semantic/growth-relation-facet-source.test.ts),
  “relation facet source and point probes stay bounded as relation degree grows” at `[64, 512, 4096]`, one warmup
  and three repetitions, and “relation facet witness rebuild stays bounded per durable page as degree and history
  grow” at `[64, 512, 4096]`, one warmup and three repetitions. Existing snapshot cost coverage remains
  [test/semantic/growth-search-source.test.ts](../../test/semantic/growth-search-source.test.ts): “Source snapshot
  stays within its bound as P grows” and “Source snapshot stays within its bound as a subject's history grows”,
  both at `[8, 64, 512]` with three repetitions; [test/search/indexing.test.ts](../../test/search/indexing.test.ts):
  “cost per batch is one snapshot read and one bulk request at every batch size” describes the existing <=256 case
  and proves request counts only. The ControlledSource/provider-boundary suite is [test/search/indexer-source-batches.test.ts](../../test/search/indexer-source-batches.test.ts): “one admitted event envelope with more than256 subjects converges through bounded source chunks and checkpoints only after every visible write” and its “later transport failure and genuine retry” case. The real Semantic source regression is [test/search/source-batching-native.test.ts](../../test/search/source-batching-native.test.ts): “native event anchors use exact chunk snapshots through later transport failure and replay”. Control-plane acceptance recorded all eight tests in that native file passing, including the six target-size cases. These call-count assertions are not end-to-end growth measurements; Semantic native SQL growth checks remain separately scoped.

### Document build, bulk and erasure

- Touches: `documentActions` builds one action per requested ID in its anchor partition; visible nonredirected
  subjects index into `subjects-g<generation>` by `_id`; missing, hidden, taken-down or redirected subjects delete by
  `_id`. External version is the snapshot partition position. After the subject snapshot, indexing reads public
  collection counts once per chunk for visible, nonredirected subjects it will index (one primary-key statement, at
  most 256 rows; no read when none will be indexed). At most one `_bulk?refresh=wait_for` request per nonempty chunk
  (none without relevant IDs),
  at most 2b NDJSON lines; no target traversal or SQL write. Grow N/P/H with b and subject payloads fixed.
- Bound: At most b root documents written/deleted. Each indexed subject costs 1 + F Lucene documents: the root
  plus one nested document per facet-capable statement. A relation property's contribution is at most 128 distinct
  values plus its overflow marker; repeated relation witnesses for the same pair do not multiply indexed facts.
  Bulk size still includes each fact's Q qualifiers, existing descriptive/name payloads and the subject's declared
  property set. For `c` nonempty source chunks, each indexing batch adds at most `c` listing reads, each one
  primary-key statement for at most 256 rows, constant in N stored subjects and number of Collections. There is no
  listing read when no documents will be indexed. Requests stay `c` snapshot reads, at most `c` listing reads and
  at most `c` bulks whatever F. No SQL writes.
  Kernel work is linear in selected fact/value bytes except sorting each subject's labels; there is no document byte
  cap, so growth checks fix payload sizes. Bulk item validation is `O(b)`; failure prevents checkpoint advance. The
  document adds an overflow property list only when needed and one integer listing-count field.
- Acknowledgement binds every native item, in submitted order, to the action's operation, `_id` and selected
  physical `_index`. A successful index/delete must return exactly the submitted safe external `_version`, a
  consistent status/result pair (`201/created`, `200/updated`, `200/deleted`, `404/not_found`), safe native sequence
  and primary-term metadata, and complete successful shards with no failures. Optional `forced_refresh` remains
  native metadata; ordinary `refresh=wait_for` success does not require that field. Success with an error, wrong or
  missing identities, duplicate/reordered/partial items, partial shards and contradictory top-level `errors` fail
  the entire batch. A native missing-document delete proves a delete operation, rather than a generic 404 success.
- A keyed `409/version_conflict_engine_exception` retains the actual engine error shape, including its physical
  index and shard identity. It has no winning version or success shard metadata. Only this native failure is
  accepted, followed by the existing whole physical-index `_refresh` and explicit complete shard validation.
  Neither the error text nor a guessed winner body is interpreted as proof. No per-document Source reread or new
  database relation is introduced. Malformed responses, native failures and response loss leave `projectBatch` at
  its old checkpoint; genuine replay can conflict with already executed writes and settles only after visibility.
- Added adapter cost: inspect the submitted actions and aligned native response once, `O(b)` items and response
  bytes with fixed native fields per action. One bulk plus at most one existing conflict refresh per chunk;
  no target-population or historical-receipt traversal. Explicit refresh still performs native engine work.
  [Native receipt tests](../../test/search/bulk-visibility.test.ts) record full request/result identities and parsed
  response byte/call accounting at unrelated populations `[4, 32, 256]` with fixed actions, multi-key conflicts,
  rejection and response-loss/replay. This measures the adapter request bound, not Lucene ingestion cost or timing.
  [Checkpoint recovery tests](../../test/search/indexer.test.ts) include the original indexing/source-chunk suites
  and real PostgreSQL failure/replay schedules, including partial native item failure and response loss after write.
  Their controlled Source isolates this boundary; it does not certify Source completeness, Auth/Access, disclosure,
  physical incarnation or prevention of resurrection after native delete-version pruning.
- Growth check: [test/search/indexing.test.ts](../../test/search/indexing.test.ts): “cost per batch is one snapshot
  read and one bulk request at every batch size” and “a later takedown deletes the document and replays are harmless”;
  [test/search/relation-overflow-mapping.test.ts](../../test/search/relation-overflow-mapping.test.ts): “relation
  markers stay on the source subject document and keep external versions” and “the document keeps all 128 sampled
  relation values and omits empty overflow markers”.

### Listing counts

- Touches: `subjectListingSource(pool).read(partition, ids)` runs `listing-counts.sql` once, selecting `subject_id,
  public_collection_count` from `library.subject_listing` by primary key `(route, subject_id)` for the ids in that
  partition. An id without a row is absent. Grow N and the number of Collections, fixing b.
- Bound: One statement per call: primary-key lookups of at most b rows, constant in N stored subjects and in the
  number of Collections. The document gains one integer field, `public_collection_count`, and no field per
  Collection.
- Growth check: [test/search/listing-source.test.ts](../../test/search/listing-source.test.ts): “the production
  listing source reads counts in the subject's partition”.

### HTTP authorization

- Touches: Search adds one `subject:read` check on the Global Context per request.
- Bound: One `subject:read` check on the Global Context per request. Its rows, blocks and statements are the Access
  bound in [src/access/README.md, Cost](../access/README.md#cost). Search adds no further authorization SQL and
  inherits Access's uncapped Global grant/denial and organization-membership neighbourhoods.
- Growth check: [test/access/growth-permission.test.ts](../../test/access/growth-permission.test.ts): “Permission
  preparation stays within its bound as O grows”; [test/access/growth-evaluator.test.ts](../../test/access/growth-evaluator.test.ts):
  “evaluator rows/statements are constant in G and blocks logarithmic at fixed K” and “evaluator rows/statements/blocks
  are at most linear in admitted K through cap1000 at fixed G”.

### Search planning and engine page

- Touches: Route validation, `text.ts`, `filter.ts`, `query.ts` and `subjects-search-v2` compile named clauses. The
  existing non-rating path sends one alias `_search/template` request per round, at most three per page. The Global
  rating path uses native phases A and B against one pinned physical generation, at most two requests per round.
  Existing index fields are `search_text`, `names.exact`, `names`, keyword type/statements and nested `facts`; the
  current sorts are `_score` then id (relevance), `name_sort` then id (name), id, or `public_collection_count`
  descending with missing as 0, then `name_sort` and id (collections). The Global rating sort is described above.
  `_source` selects partition/security revision; ordinary totals track to 10,000. Relation positive and negative
  overflow clauses are compiled as safe candidate supersets. A named outer clause keeps exact-value and marker-only
  matches in the same matched-query lineage. Grow N/P/d, fixing s, query and current hits.
- Bound: A filtered request adds one active-release lookup (pointer read; release cached by digest); no lookup
  without a filter. Admission is linear in expanded leaves (`ell <= 32`) times the returnable types' bases; the
  all-types facet union is computed once per release. `O(h)` hit mapping, at most 600 hit documents, and at most
  three searches for the existing non-rating path; a rating page has at most six native phase searches and 600
  returned raw hits, with the 200-hit budget shared across phases per round. Native sorting and counting remain
  match-dependent engine work. Valid text is <= 512 bytes/64 leaves/depth 4; filters <= 32 leaves/depth 4, OR <= 16,
  `IN` <= 64 (bounded scalar sizes). Parsing rejected raw input still depends on input length. Nested leaves touch
  candidate subjects' facts only. Text syntax errors remain typed 422 errors. Qualified relation facets return 400
  `invalid_request` at the filter qualifier pointer; descriptive qualifiers retain their existing meaning. Code
  facets cost what item facets cost, minus value-subject reads. `descriptions` and `languages` project from the
  subject the final check already holds (no read; per hit, work linear in that subject's labels and descriptions,
  each description cut to 200 grapheme clusters).
- Growth check: [test/search/filter-overflow.test.ts](../../test/search/filter-overflow.test.ts): “overflow candidate
  queries retain true positive and negated matches beyond the sampled prefix” and “overflow candidate queries
  preserve boolean grouping and same-statement qualifiers”; [test/search/relation-qualifier-admission.test.ts](../../test/search/relation-qualifier-admission.test.ts):
  “qualified relation facet filters are 400 invalid_request without reaching the engine” and “unqualified relation
  facets and descriptive qualifiers retain their semantics”; [test/search/service.test.ts](../../test/search/service.test.ts):
  “each request makes at most three index requests and reads only the partitions of examined hits” for the existing
  non-rating path; rating phase runtime outcomes remain pending. [test/search/overflow-service.test.ts](../../test/search/overflow-service.test.ts):
  “overflow service work stays bounded at stored degrees 128, 512 and 2048”.

### Search hit facts

- Touches: The hit subjects the final check already returned (no new read for them); the request's single
  active-release lookup, shared with filter admission; and item targets of the page's kept values: at most
  `s × P × 3` distinct ids (`s <= 100`, `P <= 4` requested properties, at most 1,200 ids). `discloseFacetValues`
  deduplicates by anchor, then chunks each home to at most 256 IDs. For home `p` with `u_p` targets, it makes
  `sum_p ceil(u_p/256)` source calls; homes run with concurrency <= 8 and chunks within each home are sequential.
  No target read when no kept
  value is an item.
- Bound: Rows and statements are constant in N and P (partition rows) at fixed s and property count. Each source
  read has the Source snapshot bound at fixed ids; blocks are logarithmic. A same-home 320-target label operation
  makes two source calls; 1,200 hit-property targets in one home make five when admitted by the product. Multi-home
  input uses the sum of per-home ceilings, not a ceiling over the total. Empty input makes no calls; a later source
  failure rejects the operation. Chunking creates neither a privacy/absence certificate nor a cross-chunk
  transaction. Per hit, one scan of its statements.
- Growth check: [test/search/growth-facets.test.ts](../../test/search/growth-facets.test.ts): “Search hit facts stay
  within their bound as N grows” at scale units `[1, 4, 16]`. Native `next_doc_count+advance_count` is summed from the
  actual template-search profile; unrelated Recipe engine documents grow with N while the Book neighbourhood stays
  fixed; admitted, denied, empty and deep continuation share that capture, and neighbourhood history is grown on a
  separate axis.

### Facet counts

- Touches: existing aggregation machinery samples matching subjects and reads item value labels through the native
  source. Those label checks do not check every contributing subject or fact.
- Bound: the initial public Search wire omits all totals, including verified rating lower bounds. Omit unsafe engine
  totals and facet counts over unchecked populations. Existing sample/overflow lower-bound behavior describes
  partial implementation, not a privacy-safe aggregate; approximate/as_of and zero/row-length substitutes are not
  permitted. Future safe aggregates require separately admitted complete disclosure dependencies
  and query-level privacy acknowledgement. The adopted count-free discovery wire is owned by
  [Public facet discovery](../../../../docs/search-facets.md); it does not make this preview complete.
  Malformed counted facet replies stay on `countFacets`/`admitFacetPayload`; `service.facets` uses the discovery
  provider, not this parser.
- Growth check: existing facet/overflow tests retain their scoped evidence. Native paused-indexer local/foreign
  reduction, NOT and order/count cases and three-scale engine/native captures remain required before safe aggregate
  claims; the shared matrix in [Filtered lists](../../../../docs/filtered-lists.md#shared-acceptance-matrix) owns outcomes.

### Disclosure and result projection

- Touches: current source/Collection, original and terminal eligibility and Access; complete fact/source/target/
  consent/fence dependencies; summary fields; query-level safety observation before execution and before disclosure.
- Bound: derive per admitted direct/prepared plan, charging duplicates, rejects, lookahead, rereads, all dependency
  points and backend work. Existing per-call Source caps remain. The current `checkHits` sampled-witness/drop/refill
  path is partial implementation; it cannot certify query exclusions/order or useful pages. Missing, changed,
  unsafe or pending privacy acknowledgement means preparation/readiness. No cached permission or mandatory whole
  raw-fact replay is required by the replacement contract.
- Growth check: actual native/API first/deep/sparse pages at three scales, current fact/source/grant revocation,
  paused indexer with NOT/order/counts, dependent foreign repair, current cursor reauthorization and all owner pools.
  Existing relation-witness tests remain scoped evidence, not proof of the new complete list contract.

### Cursor and continuation

- Touches: The adopted Search contract uses the shared AES-GCM list-cursor Search profile, binding route/operation,
  canonical request hash and viewer, and encrypting generation, Global rating context, phase and last consumed native
  tuple. Each page uses `search_after`; no OFFSET, preceding-page enumeration or database cursor. See [Confidential
  cursor and bounded name sort](#confidential-cursor-and-bounded-name-sort). The runtime adapter migration and
  encrypted-token outcome proof remain pending.
- Bound: Zero SQL or engine I/O in the cursor codec; at most 8 tuple keys, 2,560 UTF-8 bytes per key, 3,072
  aggregate string bytes, 3,584 serialized bytes and 4,864 token characters. Position encryption uses a fresh random
  salt, a 15-minute lifetime including anonymous viewers and a 60-second future allowance. Codec and tuple size are
  independent of page depth; page consumption is `O(h)`. No kernel `O(d*s)` read from the start. Only settled result positions advance; an unresolved interval requires retained preparation/readiness.
  Acceptable lookahead stays unconsumed.
- Growth check: [test/search/service.test.ts](../../test/search/service.test.ts): “pages continue through signed tokens
  bound to the request and the principal” and “each request makes at most three index requests and reads only the
  partitions of examined hits” for the existing path. Encrypted-profile confidentiality and native phase cursor
  outcomes remain runtime proof requirements.

### Global rating phases

- Touches: Each page resolves one physical generation and brackets its native epoch context; each refill round sends
  at most two phase searches, including count-only work, then checks current figures in bounded source batches.
- Bound: At most 200 combined raw hits per round and 600 per three-round response; current-figure reads are batched
  by anchor partition, at most 256 figure IDs per source call. The initial public response omits totals, including
  verified `lower_bound` ratings. OpenSearch sort and count work is match-dependent;
  no SQL, latency or O(1) engine-work claim follows from these request bounds.
- Growth check: [test/search/growth-rating-query.test.ts](../../test/search/growth-rating-query.test.ts): “native rating
  candidate delivery remains within shared phase quotas as the real indexed matching population grows”. The test is
  present; its runtime pass status is unverified here. It records whole-tree `next_doc_count+advance_count` at 64/512/4096
  without converting match-dependent engine sort/count into a constant bound. Its native phase request and returned-key
  quotas do not prove default worker/native vote composition, the current disclosed total, PIT/live top-N behavior, or
  constant engine postings, sort or latency work.

### Ordinary native hit receipt admission

- Touches: `query-payload.ts` admits the complete bounded ordinary hit page before `query.ts` returns candidates
  to current Source disclosure or continuation signing. Every root has an exact canonical physical index name,
  a positive safe generation matching the requested generation when supplied, and a unique UUID aligned with its
  final sort field. Invalid receipts throw `SearchUnavailableError`; the service returns `503 index_not_ready`
  without a page or cursor. Direct malformed `after` tuples reject before engine I/O.
- Ordering uses the actual native fields: relevance score descending then id ascending; name ascending then id;
  collections count descending (missing zero), name ascending then id; or id ascending. Keyword comparison uses
  unsigned UTF-8 bytes, with missing names last. Each adjacent tuple strictly increases and the first strictly
  advances beyond a supplied frontier. Normalized-name ties, null-name ties resolved by id, and empty pages remain
  valid. Rating phases and cursor encoding retain their separate existing contracts.
- Bound: One identity set and adjacent tuple comparisons over `k <= 200` existing hits, `O(k)` identities and work
  linear in returned tuple bytes. No extra engine, SQL or Source request, per-hit I/O, refill round or fetch limit.
  Native sorting/counting work remains match-dependent; admission does not establish whole-index privacy.
- Evidence: `test/search/keyset-receipts.test.ts` retains direct duplicate-root, identity, order and frontier rejection.
  `test/search/query.test.ts` executes native ordinary keysets and corrupts only clones of their actual receipts;
  `test/search/service.test.ts` proves rejection before current Source or signing, valid keysets/refills/empty pages,
  and fixed returned-hit bytes, calls and Source rows at 64/512/4096 unrelated roots and overwritten native versions.
  Requests, original replies, mutations and counters are recorded in check output. Controlled Source counters prove
  this admission boundary only; native permission, Source privacy, physical population and erasure remain separate.

### Bounded native name sort

- Touches: The helper deduplicates distinct nonnull raw names and sends one `_analyze` request per name before bulk;
  hidden/deleted action names are not analyzed. Each subject keeps one bulk action and its anchor external version.
  Normalization failure prevents bulk and checkpoint advancement. The existing integration and batch contracts are
  covered by `test/search/bounded-sort-indexer.test.ts` (“default index relay and rebuild bound native sort values
  before visible writes and do not checkpoint failed normalization”) and `test/search/canonical-coverage.test.ts`
  (“source cap stays 256 and publication waits for every real source chunk and checkpoint outcome”); their pass
  status is unverified here.
- Bound: The helper permits at most 16 concurrent analysis requests and validates each single token's position and
  offsets; it does not infer alignment from multi-text output or cap its action set at 256. Helper work is
  `O(distinct names and their bytes)`, with one request per distinct name and zero SQL. Any eventual source chunking
  is a separate batch-contract bound. Retain only a complete normalized key of at most 512 UTF-16 code units; larger
  results use null. Display and exact names stay unchanged, and read-side sorting remains match-dependent with
  missing-last plus unique id.
- Growth check: `test/search/bounded-sort-keys.test.ts` (“native normalization bounds complete name sort values on
  writes while preserving full names and stable null pagination”) exercises the native helper; its pass status is
  unverified here. Pinned-engine/runtime evidence for overlong normalization becoming null, ordinary 250-CJK names
  retaining their full key, and replay repairing existing values before bounded-read readiness remains separate and
  pending. Source/replay/default-worker/native API readiness requires its own integration/runtime evidence.

### Suggest

- Touches: GET validates 1–64 code points (<= 128 UTF-16 units), limit 1–10 (default 8); `subjects-suggest-v1`
  queries `names.typeahead` and its 2/3-gram fields in one pinned physical-generation template request. Reads <= 20 hits, then the same
  partition-grouped disclosure, projection, generation and freshness paths. Grow N/P with limit, text and selected
  facts fixed.
- Bound: One engine search, `h <= 20`, <= 20 source reads with concurrency <= 8; no own SQL. Each source read is
  one `subjectSource.read` with the Source snapshot bound, so rows and statements stay constant and blocks stay
  logarithmic at fixed ids. Not a separate per-hit authorization query.
- Growth check: [test/search/service.test.ts](../../test/search/service.test.ts): “typeahead suggests only subjects
  that pass the final check”; [test/search/disclosure.test.ts](../../test/search/disclosure.test.ts): “partitions are
  read once each with bounded concurrency”; [test/semantic/growth-search-source.test.ts](../../test/semantic/growth-search-source.test.ts):
  “Source snapshot stays within its bound as P grows” and “Source snapshot stays within its bound as a subject's
  history grows”.

### Discovery generation custody

Suggestions and property/type facets resolve and admit the active native generation before querying, then admit
that physical index's supported mapping format. Every native discovery operation uses that concrete index;
current grouped Source disclosure and the existing freshness reader complete before a fresh, request-owned final
alias observation. An observed generation change returns `409 search_restart_required` without discovery payload.
Missing, malformed, partial or unsupported generation/mapping metadata returns `503 index_not_ready`. Empty native
results retain the pinned generation; they never infer a generation from hits or read freshness for a later alias.
`as_of` always comes from the queried generation's consumer. This does not establish physical incarnation or
population completeness, or expand the existing preview's disclosure guarantees.

- Touches: two bounded native resolve requests, one concrete mapping request, one existing suggestion/facet query,
  existing grouped Source disclosure and one freshness observation for the pinned consumer. Start observations may
  coalesce across concurrent calls; final observations never coalesce with them.
- Bound: three metadata calls independent of population, at most three physical generation records per resolve;
  charge every metadata response byte. No new SQL, Source enumeration or per-hit request. Existing per-call
  Source256 and page point/row/block/byte/read bounds remain unchanged.
- Growth check: [query generation tests](../../test/search/query-generation.test.ts) execute both native callers
  with 64, 512 and 4096 unrelated documents and retained outbox history, recording every native path, metadata byte
  count, Source key group and consumer. The same suite covers distinct real generation watermarks, empty results,
  switches after start/query/Source/freshness, concurrent in-flight start observations, malformed actual metadata at
  start/final and unsupported mapping formats. Controlled Source isolates this lifecycle; existing real Source
  discovery suites remain separate evidence.

### Freshness

- Touches: `freshness.sql` left-joins all partition heads to one consumer's checkpoints; each behind partition
  probes exactly `(partition_no,checkpoint+1,event_seq=0)` in outbox for its timestamp, then aggregates min/count.
  One statement per read; each `current()` call is answered from a read that began after the call, at most one read
  runs per reader and calls made while it runs share the next read. Rebuild polls default 500 ms until caught
  up/deadline (default 1 hour). Grow H/N/P with C and lagging partitions fixed.
- Bound: Constant 4,096 heads plus <= C checkpoints and <= 4,096 timestamp rows; indexed blocks
  `O(4096*(L(P)+L(H)))`, one statement, no H scan. The consumer-leading checkpoint index keeps the checkpoint
  lookup bounded. Behind without a retained next envelope fails. Statements per
  process and generation are at most `min(request rate, 1 / statement time)`. Polling repeats per interval, not per
  change.
- Growth check: [test/search/freshness.test.ts](../../test/search/freshness.test.ts): “the reader answers each call
  from a read that began after the call”; SQL: [test/search/growth-query.test.ts](../../test/search/growth-query.test.ts):
  “Freshness stays within its bound as H grows” (rows/blocks, also P/N).

### Generation discovery and bootstrap

- Touches: Runner resolves `subjects*` at startup and by default every 5 s, reads active mapping activation time,
  and restarts partition relays when the live generation set changes. Empty deployment: PUT index, PUT mapping, POST
  alias. Each listing resolves and pins the active generation, reads its bounded-sort mapping format, and resolves
  the alias afresh after all query, Source, cursor and freshness work, including empty results. Only concurrent start
  observations coalesce; the final observation belongs to that request. Grow N/P with generation set fixed.
- Bound: One resolve plus <= 1 mapping read per discovery; bootstrap adds three requests; zero SQL except
  separately listed retirement. At most three generations per prefix, so discovery enumerates at most three; no
  subject-document enumeration. Definition uses one shard/zero replicas; that does not prove kernel locality.
- Growth check: [test/search/indexing.test.ts](../../test/search/indexing.test.ts): “the runner creates the first
  generation, feeds every generation and follows pause and new generations”; no new SQL check for metadata-only
  requests.

Runner pause marks intent immediately, suspends automatic discovery and relay schedules, and drains the already
admitted discovery chain and projection before settling. Explicit `refresh()` remains legal while paused: it may
read discovery metadata, ensure mappings and replace the live generation set, but replacements start paused before
their first partition scan. Resume waits for the pause drain and resumes the actual current set once; a later pause
cancels a queued resume. Stop seals admission immediately and shares one drain promise across repeated calls,
including when a native response fails. It waits for admitted discovery, replacement and projection; later refresh
or resume cannot create work. These controls do not close the supplied pool, Source or engine.
Discovery indexing uses that same latest-intent drain: in-flight maintenance and relay pauses finish, then the
current pause, resume or terminal stop is applied to every retained or newly created relay. One serialized
maintenance chain and one schedule stay owned; stop drains owned work once and a delayed pause or resume cannot
schedule or revive it.

The [native lifecycle controls](../../test/search/runner-discovery-lifecycle.test.ts) hold actually executed discovery,
bulk and conflict-refresh responses before delivery, and hold controlled Source reads. Real PostgreSQL outbox and
checkpoints plus engine visibility establish drain order and external-version replay. At 64, 512 and 4,096 unrelated
history envelopes, two explicit paused refreshes make exactly four metadata requests and no projection scans or
checkpoints; one resumed envelope across two generations makes two partition scans, Source reads, bulk requests and
checkpoint updates. Controls add no per-subject native request, population count or polling while paused, and drain
only the existing serialized discovery chain and bounded relay work over at most three generations. The controlled
Source isolates lifecycle behavior; this is not Semantic Source, permission or privacy proof.

Native metadata admission requires HTTP 200 and complete object/collection shapes. Resolve accepts at most three
unique exact `subjects-g<positive safe integer>` physical names, at most one exact `subjects` alias with one target
in that observed set, at most one allocator-created `{physical}-writer-{32 lowercase hex}` alias bound to each
observed generation, and no data streams. Physical attributes must describe an open index, optionally hidden;
closed, frozen and data-stream indices are unavailable. Native omission of an empty per-index `aliases` field is
valid, including legacy generations without writer aliases; inventory never mints a missing writer alias. A present
public or writer alias must agree in both the physical index's aliases and the alias receipt. Foreign names,
duplicate records (even identical ones), contradictory memberships, malformed or missing fields and oversized sets
raise `SearchUnavailableError` before admitting a query or rebuild. Empty namespaces and bounded initial,
rebuilding and retained older sets without an active alias remain valid discovery observations. Read helpers issue
no creation requests.

A concrete mapping response must contain exactly the requested physical name, an object mapping and object
properties. Missing legacy `_meta`/format or a well-formed unsupported nonnegative integer format yields no supported
format; malformed metadata is unavailable. The existing supported format check remains mandatory before queries and
rebuild publication. Mapping admission inspects metadata structure, not every field's schema or document population.

The native controls in [generation tests](../../test/search/generations.test.ts) and
[query generation tests](../../test/search/query-generation.test.ts) clone actual executed responses and retain raw
and corrupted receipts in the check log. They cover refused query starts with no native search or Source work,
refused final observations with populated and empty native hits, rebuild refusal, valid lifecycle states, physical
query pinning and restart409 after alias switches. Metadata observation uses one resolve, or one concrete mapping
request, with work linear in returned bounded metadata; unrelated index populations of 1, 4 and 16 add no requests.
This structural proof does not establish complete physical incarnation population, same-name/new-UUID safety,
source key equality, copy completeness, late-write pruning or erasure. No name/UUID cache supplies that proof.

### Rebuild replay and activation

- Touches: Explicit `rebuildSubjects` invocation creates/resumes a generation, refreshes runner, replays outbox from
  zero checkpoints using the batch paths, polls freshness, reconciles, then PUTs activation mapping and atomically
  switches alias with one POST. Existing live generations also receive each change. Mapping changes, including the
  fixed overflow field, reach a running deployment through replay/reconcile into a new generation and alias switch.
  Grow H/N, fixing batch size and generation count.
- Bound: Whole-index maintenance: `O(H)` replayed event rows per partition over the run, `O(ceil(H/b))` batches
  for fixed batch occupancy plus their indexed probes; not `O(1)` per rebuild. Two activation writes and two fresh native observations (physical mapping and final generation/alias resolve), zero
  activation SQL. At most three generations per prefix, so the runner feeds at most three; rebuild exclusion uses a
  PostgreSQL session advisory lock keyed by alias, with two lock statements on one held connection; alias switching
  is delegated to OpenSearch and is constant-size.
- Growth check: Batch calls: [test/search/indexing.test.ts](../../test/search/indexing.test.ts): “cost per batch is
  one snapshot read and one bulk request at every batch size”; SQL replay: [test/growth-events.test.ts](../../test/growth-events.test.ts):
  “Batch log stays within its bound as H grows” and “Full batch log reads only the batch's outbox rows at every
  partition history”.

### Reconcile

- Touches: Per explicit rebuild, default <= 5 rounds: `reconcile.sql` reads native heads/checkpoints before and
  after one Source count snapshot per observed nonempty partition (<= 4,096, concurrency 8) and one physical
  generation `_search` with size 0 and partition terms aggregation size 4,096. Newly observed partitions receive
  one count for diagnostics and remain pending until a later round. No history scan or hits enumeration is added.
- Admission: Each Source receipt contains exactly a bigint position in PostgreSQL's nonnegative bigint domain
  and a nonnegative safe integer count. Missing or malformed evidence is unavailable. Quiet means both native
  head/checkpoint observations and that same Source position agree. Stale or moving observations remain pending
  and exhaust the existing busy bound; a quiet count disagreement is mismatch. Real zero counts remain valid.
  The native aggregation must have integral zero `doc_count_error_upper_bound` and `sum_other_doc_count`, unique
  valid home keys and safe counts, with complete shards and no timeout/termination. Missing/incomplete evidence
  is unavailable, including on an empty generation.
- Activation: After certification, write activation metadata on the exact physical generation, read it back with
  the same sort format/timestamp, then atomically switch the alias and resolve the final bounded native generation
  set. Even acknowledged writes require these observations. Negative, malformed or lost replies can succeed only
  when a fresh definitive observation establishes their actual effect. Otherwise return unavailable without retrying
  the write or rolling back a concurrently changed alias. An unavailable result can therefore leave an applied
  alias switch; subsequent discovery/rebuild uses the actual native state. This optimistic per-round proof does
  not claim that concurrent writes cease globally at switch or establish complete Source key equality.
- Bound: Two reconciliation SQL statements: `O(4096)` rows, indexed `O(4096*L(P))` blocks; one engine aggregation;
  <= 4,096 Source count calls per round. Each native `subjectSource.count` reads one `core.partition` position and
  one `semantic.partition_subjects` row by primary key: constant rows/statements, logarithmic blocks. Activation
  adds constant native metadata requests and retains the original advisory lock and generation limits.
- Growth check: [rebuild-custody-native.test.ts](../../test/search/rebuild-custody-native.test.ts) captures actual
  rebuild SQL rows/blocks, engine requests/bytes, exact Source keys and eight-count concurrency at 64/512/4,096
  unrelated histories and separately nonempty partitions. Its controlled body/count adapter includes native core
  position reads; Semantic count/indexed maintenance cost is additional, owned by
  [growth-search-source.test.ts](../../test/semantic/growth-search-source.test.ts). Actual runner replay and external
  version writes, receipt rejection, interleavings, native activation effects and recovery are tested separately
  from growth. These controlled receipts do not prove native Semantic publication, permission or whole-query deletion.
  Existing [generations.test.ts](../../test/search/generations.test.ts) and
  [growth-indexing.test.ts](../../test/search/growth-indexing.test.ts) retain lifecycle and metadata growth coverage.

### Retire

- Touches: Each discovery after default 15-minute activation grace deletes each old generation by index name, then
  `retire.sql` selects <= 4,096 checkpoints by consumer and deletes matching PKs; failures retry at later discovery.
  Newer generations/no activation timestamp remain. Grow unrelated N/P and other consumers, fixing retired consumer
  and `k <= C` checkpoint rows.
- Bound: One engine DELETE and one SQL statement per generation; k rows deleted with `O(k*L(P))` indexed mutation
  blocks. The consumer-leading index examines the retired consumer's k checkpoints in `O(k + L(C))` rows and
  blocks. Engine index deletion is whole-generation erasure, not per-hit work.
- Growth check: [test/search/retire.test.ts](../../test/search/retire.test.ts): “an older generation is retired
  after the grace period with its checkpoints, and the active one keeps indexing”; [test/search/growth-indexing.test.ts](../../test/search/growth-indexing.test.ts):
  “Retire stays within its bound as P grows” (unrelated consumers' checkpoint rows, selected k fixed).

### Search and facet counts across manifests

- Touches: `search` and `facets` each call `activeRelease`: one backward probe of `definition_activation_pkey` for
  route 0. The process cache is keyed by digest and stores the validated, frozen body, so a hit does not read
  `semantic.definition_release`. Admission uses the filter's type and that type's facets and bases. The all-types
  facet union is computed once per release object, not once per request. This shape sends one
  `subjects-search-v2` request and one `subjects-facets-v1` request; the immutable
  [subjects-search-v1 template](../../db/search/templates/subjects-search-v1.json) remains available. Item values are
  read back through the source port. Freshness is one coalesced read per request. Grow M; fix the filter, facet list
  (at most 8), sample and hit neighbourhood. A changed digest reads the release body once, absorbed by the
  unmeasured warm-up.
- Bound: Rows, statements and engine requests are constant in M. Blocks follow the activation pointer and are
  logarithmic in activation history. Release-sized work happens once per digest per process.
- Growth check: [test/search/expansion.test.ts](../../test/search/expansion.test.ts): “filtered search and facet
  counts stay within budget at 1, 10 and 100 vertical manifests”.

### Subject mapping across manifests

- Touches: [subjects.json](../../db/search/indices/subjects.json) is a strict mapping with fixed fields (`type`,
  `statements`, nested `facts`, and one `relation_facet_overflow` keyword field). Indexing any vertical writes those
  shared fields. There is no mapping field per relation property; sampled values use the existing statement/fact
  fields. Activating manifests does not change the mapping. Mapping changes still use replay/reconcile/new-generation
  alias switch.
- Bound: Mapping field count is constant in M; relation sample contribution is at most 128 distinct values per
  declared relation property plus the one fixed marker field.
- Growth check: [test/search/expansion.test.ts](../../test/search/expansion.test.ts): “indexing every vertical adds
  no mapping field”; [test/search/relation-overflow-mapping.test.ts](../../test/search/relation-overflow-mapping.test.ts):
  “overflow markers are fixed keyword fields and declared relation values retain statement and qualifier matching”.

### Scope direct and prepared plans

- Touches: named indexed matching streams or ready unique result rows, generation/control/epoch and privacy safety
  state, current source and disclosure dependencies, summaries, preparation frontier/result writes when needed.
- Bound: derive page work for filter + source + order, then aggregate the composed page (16 distinct reads,
  128 total output slots). Each page/step supplies the internal cost object and harness evidence specified by
  [Filtered lists](../../../../docs/filtered-lists.md#cost). Otherwise use admitted bounded preparation or reject
  before enumeration. No raw candidate256 or fixed-home sweep requirement is carried forward.
- Growth check: [growth-query](../../test/search/growth-query.test.ts), [growth-indexing](../../test/search/growth-indexing.test.ts),
  [growth-facets](../../test/search/growth-facets.test.ts) and [growth-rating-query](../../test/search/growth-rating-query.test.ts)
  record the Cost counters at three scales. Filter+source+order pages measure native iterator steps on the existing
  template-search path; matching-population rating iterator steps are recorded without a constant engine-work class.
  Existing Scope admission/reservation tests describe superseded scaffolding and do not prove native execution.

### Hit label choice

Search hits, item facts, facet values and suggestions use the same label choice.

- Touches: the labels, descriptions and `schema:inLanguage` fact of subjects the final check already holds.
- Bound: no read, statement or engine request added; per returned subject, work linear in R ranges (at most 8) times its labels and descriptions.
- Growth check: none; no read changes. `test/search/facet-counts.test.ts`: "facet value labels follow the reader's language chain" and `test/search/service.test.ts`: "typeahead labels follow the reader's language chain" prove the choice.

## Useful-page iteration and native recovery handoff

`collectRetainedUsefulPage` consumes the native consumer's required retained raw window. Its
`positions` align with filtered hits; `examined` charges every raw duplicate, reject and unused
lookahead. A filled page consumes through the last used position plus one. An unfilled page
consumes all examined positions. Only `consumed === examined && exhausted` proves native EOF;
returned length, totals and repair settlement cannot establish it. An empty filtered window can
still retain raw progress. Refill sends only `{execution, consumed, size}` to the native producer,
which derives keys from retained execution state and preserves unconsumed suffixes.

Direct reads share three rounds and `min(600, 6s+3)` raw work. Prepared reads share two rounds and
`2s+2` raw work. These are combined allowances across ordinary/rating phases and all rejects;
the native producer additionally owns the lower operation, SQL, point and byte ceilings and
retains root accounting across requests. Every useful capture sets `pageSize` to public `s`,
separately from its derived batch size (at most 200). Legacy two-argument queries remain valid.

`public-runtime.ts` orchestrates actual capture/query/repair/status methods. Default composition
binds prepared capture through the native factory, so a sparse page retry observes actual
preparation rather than reserving another direct allowance. The standalone orchestration also
defaults to prepared capture; a trusted direct planner can select PIT. Admission and finite
preparation belong to the actual producer.
A preparing capture delivers its actual repair locator through the host's existing durable
preparation store, or advances one bounded native step when used without that delivery port.
Sparse allowance exhaustion requests actual prepared capture and delivers its native job, discarding partial
page values. Neither settlement nor the existence of that job produces ready output. Only a
subsequent captured observation and successful query can do so. Native retention owns quota,
24-hour idle expiry, replay and progress; there is no service-local result/job store.

The service seals actual observation, execution/consumed locator, native repair locator and
last public tuple inside the existing confidential request/principal/language-bound cursor.
Rating continuation also retains and compares its Global question/population/prior context.
The public envelope remains count-free. Expired tokens, changed generations and lost retained
observations require restart; temporary dependency loss preserves the token for retry.

Summary completion runs inside `search` before exact-execution `readStatus` calls. Every batch,
including zero-hit executions, must pass final native status after all response source work.
Native end evidence never authorizes disclosure. Exhausted observations close only after final
status; filled observations remain with the native owner for continuation and expiry.

Default server construction uses the existing registered runtime composition. Retained
continuations resume the current Subject factory without recapturing the observation or resetting its
allowance. Request close releases only the request handle; filled observations remain with that
factory until exhaustion, replacement or shutdown. The current producer module is explicitly provisional and returns unavailable until
native mechanics land. Historical isolated services omitting the runtime retain their existing
query fixtures and collector. Those fixtures and the pure orchestration cases supply no
native/default-worker preparation or privacy evidence. No Source mirror, matcher or storage
writer is introduced by this orchestration.

## Producer integrity and remaining native delivery

[Identity writer custody](identity-epoch-participant.md) documents the native ordinary-writer enrollment installed
by the runner, its structural close, generation-publication barrier and bounded copy/recovery exports, and the exact remaining
owner support/receiving dependency. The fixed
canonical participant still refuses completion at that boundary; this guard is not canonical/prepared coverage,
privacy-reduction acknowledgement or whole-identity publication.

The discovery consumer components are `discovery-request.ts` (closed mixed admission and count population),
`discovery-query.ts` (one native query and complete mixed comparator validation), `discovery-current.ts`
(shared current row reads and nonnull owner summaries), `discovery-hydration.ts` (actual Semantic/Accounts
reader assembly), `discovery-frontier.ts` (one consumed head and the existing three-round allowance) and the
discovery codec in `cursor.ts`. They consume the existing `discovery.ts` registry types. They do not authorize
publication or activate the HTTP representation independently of native whole-query safety.
`disclosure/discovery.ts` places final native Source validation after the complete projection, consuming
the canonical consumer execution and its retained start rather than a diagnostic status or per-hit verdict.

The existing POST `/v1/subjects:search` accepts `representation: 'discovery-v1'`, `kindPage` and
`kindCountLeaf`, returning the closed owner-tagged `DiscoveryPageSchema`; omitted representation retains the
Subject wire. `createDiscoverySearch` composes admitted capture, the same native consumer's `queryDiscovery`,
current owner hydration and final `readStatus` plus Source validation for every contributing execution. Its confidential cursor
retains the actual execution, consumed raw prefix and native repair-job locator, not an engine frontier. Native exhaustion requires the
required retained window and consumption through `examined`; empty filtered output is never end evidence.
Three rounds share `min(600, 6s+3)` raw candidates; sparse direct output advances actual repair and returns readiness.
Kind metadata uses only positive bounded current witnesses on the initial page, otherwise unavailable; source
census is never a query count. Removing a designated count leaf currently yields unavailable count evidence.

`DiscoveryConsumerCaptureInput`, `DiscoveryEngineHit` and `DiscoveryConsumerQuery` live in `discovery.ts`;
`public-filter-consumer-contract.ts` adds `captureDiscovery`/`queryDiscovery`, optional refill and required windows
while preserving two-argument Subject calls. Root AST/text/meaning/principal/source registration stay immutable;
every derived batch retains its own execution/start/own rows under the root allowance. The native factory fixes
its registry at construction and must reject incomplete mixed generations, never fall back to Subjects.

The mixed-public-v1 successor is [discovery-mixed-v1.json](../../db/search/indices/discovery-mixed-v1.json),
`document_format: 2`. Both owners carry the actual tagged `identity`, shared names/descriptions/name_sort and
native id/kind/identity comparator ties. Accounts use only eligible displayName and active handle, with empty
descriptions. Both owners use the existing native ICU normalized512/missing-last preparation. Format-1 documents,
mapping and helpers keep their meaning; mixed execution requires a complete rebuild into format 2 before activation.

Production provider assembly still requires native implementations behind `semantic/public-filter-source.ts` and
`search/public-filter-consumer.ts`; their current modules are explicitly provisional unavailable adapters. Kernel's optional `discovery` dependency
accepts the completed consumer adapter; without it the opt-in operation returns `index_not_ready`. No Subject-only
capture, callback ACK, Account census or returned-row check substitutes for those exact integration boundaries.

The prior identity-home certificate/coverage storage, coordinator and no-write settlement exports are superseded
scaffolding, not the authority for the adopted indexed/prepared/identity-epoch lifecycle. Existing code and frozen
acceptance remain until reviewed native replacement acceptance permits removal. No repeated 8192-row basis sweeps,
per-page original walking or cancelled certificate ABI is required. Storage observations, helpers and format/type
checks do not prove complete identified population, current query privacy or actual default composition.

The following producer gaps remain required, independent of that superseded architecture:

- Complete Source chunking at **at most 256 IDs per native call**, including every tail and exact per-chunk source
  external version. No checkpoint before all actual writes are refresh-visible; later-chunk failure/replay cannot
  silently lose earlier or remaining work. The 64-envelope batch remains a separate native limit.
- Exact keyed sink operation results, rejecting wrong keys and success-with-error bodies. A 409 alone cannot prove
  visible success: establish the real superseding winner's refresh visibility and shard success before checkpoint.
- Actual bounded native name normalization in every default writer and replay/rebuild, preserving full display
  names, exact source versions and null/missing-last ordering for oversized normalized keys. Helper and cursor
  capacity proof does not establish default wiring or analyzer/ICU behavior.
- The canonical routeKey and current source-fence filtering in default worker, CLI and rebuild. Default composition
  must actually start the Semantic producer; no fake source or no-op module starter establishes that integration.
- No late older-write resurrection after real native delete-version pruning. A lost core CAS does not undo an
  external sink effect. Native competing-worker, ambiguous-response, crash/replay and actual pruning schedules must
  prove fencing under the adopted epoch/index lifecycle; do not invent a safety-token store to fill this gap.
- Complete identified new-generation population before atomic alias publication, including missing and extra keys,
  native partitions and actual physical identity. Empty targets or equal metadata counts do not prove correct keys.
  Preserve actual engine UUID, generation/name lifecycle and prevention of late accidental auto-creation. Keep
  per-partition reconciliation; counts alone cannot certify population.

`coverage.ts`/`coverage-projection.ts` unavailable exports and existing `coverage-store.ts` do not close these gaps.
Actual native acceptance/default composition/growth remain required through real commands, Access, source, engine,
worker and production rebuild, including pause/drain/restart/retirement and all owner pools. Existing adversarial
outcomes remain useful evidence; old protocol-specific home-certificate proof is not the replacement gate.

### Producer and generation maintenance cost

- Touches: shared outbox/runtime, actual bounded source chunks, normalization, keyed sink actions and refresh,
  checkpoint settlement, complete population/reconciliation, identity-epoch mapping/index maintenance and retirement.
- Bound: retain 64-envelope batches, 256 IDs per Source call and at most three live generations per prefix.
  Separately admit each step's actual keys, points, rows, statements/connections, bytes and engine operations and
  retain durable progress. Total replay/audit may follow finite source/log/index input; refresh/deletion are engine
  work, not constant metadata operations. No transaction holds a database connection across external I/O.
- Growth check: three geometric scales with real native/default-worker/API captures, all pools, first/deep/sparse
  pages, history/alias/duplicate axes, source tails, wrong-key outcomes, actual winner refresh, late writes after
  pruning, crash/replay and privacy changes. Performance supplies numeric allowances and captures. Existing
  certificate storage, helper or 256-proof checks do not establish this acceptance.

## Account population

The default starter and rebuild CLI install the actual Accounts source and current-summary readers in the closed
Discovery registry. Both owners write canonical `discovery-v1` identities into the same `discovery-gN` family;
legacy Subject callers retain their existing family and ABI. Account documents use only current handle/displayName,
kind and exact native revision. Summaries remain owner reads. Current Account disclosure admits each bounded native
chunk through `validateAccountSnapshot` with no indexer envelope obligation, then checks candidate source-position
coverage against that admitted position; a later invalid chunk fails the whole response before Account hydration.
Source census is used only for generation reconciliation.

A generation registers its replay consumer before bounded native enumeration. Independent Account/Subject frontiers
advance after visible keyed settlement. Reconciliation checks every engine identity against current owner documents
and both native censuses, then rechecks native Account/claim heads and partition positions before alias publication.
Incomplete or mismatched generations retain their frontier and never replace the prior alias. Physical UUID and
allocation incarnation bind every write. A permanent native per-key deletion high water and serialized physical
writer prevent delayed replay after engine tombstone pruning. Writes require the generation's native write alias.

Account copy locators commit under the Account erasure fence before external writes. Terminal cleanup uses the
versioned Access late-item/acknowledgement protocol, purges every located generation and reclaims engine segments.
Retirement drains relays, deletes the physical index, then reclaims locators/checkpoints; allocation names persist.
These generation observations grant no query/count authorization. Mixed query owners must bracket all participating
Account and claim partitions with the native witness and use current owner hydration, including for retained reads.

## Private recent Search

`/v1/recentSearches` provides own-account GET/POST, DELETE by ID and POST `:clear`, with observed revisions and
native receipts. A fresh use, remove or clear at the last representable revision 2147483646 conflicts without entry,
state, event or receipt effects; the last valid transition and ordinary receipt replay remain. Signed keyset pages default/cap at 20; current owner reads hydrate scope display without retained
labels or links for unavailable scopes. PostgreSQL retains at most 100 entries/account for 90 days. Erasure and
indexed 100-row retention batches install independently of OpenSearch; strings never enter public indexes or events.
Query entries optionally carry exactly the existing Realm/Collection/Library scope union. The closed query schema
accepts references only; scoped query display uses the same current owner hydration as a visited scope and is null
when that scope is unavailable. Its destination keeps both the scoped route and query. Scope availability is also
checked on the ordinary create operation.
The shared Web input and `/search/history` use the typed BFF and account-separated queues, discard pending changes
only on explicit conflict reload, never upload anonymous history, omit persisted scope display and clear on logout.

## Default public runtime composition

`server.startServer` installs `createDefaultPublicFilterRuntime` after the full Kernel action/resource catalogue
has produced its actual native Access. The worker obtains that same binding through a headless Kernel composition,
with the installed domain clock, canonical route key and existing WorkClient. The default service sends admitted,
expanded filter/text/order/keyset inputs to the consumer factory, completes generic facts, figures and HTTP summaries
before the execution-joined final observation, and closes its request handle in `finally`. The runtime retains one
Subject factory for the current physical target and meaning digest so a continuation or bounded repair keeps native
observations; replacement and shutdown still drain that factory. Exhausted
observations close after final status; filled observations retain their execution/consumed locator. Sparse
unexhausted pages yield readiness and the producer's retained prepared job rather than an advancing empty response.
Confidential continuations retain actual observation, execution/consumed and root-work locators within the
existing principal/query/language and generation/comparator guards. Public kind
metadata carries no inferred counts. Aggregate facets retain readiness until their native aggregate proof exists.

`PublicSuggestionCaptureInput` adds the canonical `{purpose:'suggest', prefix, size, generation?,
filterDocument:undefined, text:undefined}` variant to `PublicCanonicalCaptureInput`, retained by custody and
resolved by `PublicFilterNativeSource.resolvePublicFilterDefinition`. Prefix is a distinct semantic input;
it is never coerced to a term/phrase or accepted as caller DSL. Source derives the full prefix, excluded,
order and name dependencies from that variant. Bounds retain the existing 1–64 Unicode scalars/128 UTF-16
units and 1–50 native candidates; the public route retains at most ten results and twenty candidates.
`createPublicSuggestionOperations` uses the same capture factory, native custody registry and Source binding.
Its PIT-only versioned `subjects-suggest-v2` template keeps the released v1 bool-prefix behavior and fields.
Actual engine completion, incarnation, retained plan, execution start and original/terminal own rows are checked;
current disclosure and summary hydration precede the final execution-joined status. Neither totals nor an
arbitrary continuation are exposed. Missing native binding prepares or fails unavailable before engine execution.

`public-preparation.ts` runs locator-only maintenance workflows under the existing Search WorkModule and DBOS owner.
It retains one scalar population frontier and at most one interrupted key page, charges a 64-key owner page, chunks
ordinary Source reads at 256, and invokes the ordinary indexer's serializer and actual versions. The delivered
`SearchWriterGuard` caps its native write chunks at 100 keys for both cold population and replay. Replay remains on
the ordinary log/checkpoint path, at most one envelope per preparation step. Claims advance their native revision,
so an expired attempt cannot overwrite a successor frontier. Due discovery re-enqueues the current unleased
revision; only a claim, an advance, or expired-lease recovery changes that dispatchable frontier. Maintenance locators expire after 24 hours; this does
not allocate a public output slot or extend its native quota grant. Only the consumer producer owns current/building
public output reservations. First-start discovery no longer aliases an empty generation in this composition.

The default maintenance worker composes the sole [bounded publication port](#bounded-generation-publication).
Its `preparePublication` adapter resolves the native full-population binding and registers native custody,
then passes the returned consumer to `prepare`. It retains only the publication job ID between steps.
Cold population and ordinary replay both use the delivered native writer's admission gate; no publication
callback supplies authority. After finite population/replay, maintenance advances native reconciliation and
publication through the same worker. CLI rebuild waits for that worker-owned alias publication. Retirement
still requires actual retained-copy and writer evidence. Live physical generations remain capped at three.

The consumer, Source binding and Source key-page adapters remain provisional where owner runtime evidence
is missing. They create no Source identity, permission, coverage, ACK, grant or ready output. Their absence
returns typed unavailable while the independent native reconciliation/publication implementation remains installed.

The adopted runtime plan and end-to-end research distinguish immutable engine observations from current disclosure,
retain request-owned PIT lifetime, and place summaries inside the last privacy boundary. Reference source reads
covered Open Library's worksearch query/enrichment and bounded autocomplete, Discourse's Guardian-bound search,
and OpenSearch's external-version and delete-tombstone pruning paths. They support explicit prefix admission and
owner hydration; engine versions alone do not establish the permanent old-writer barrier.

The existing real outcome driver now binds the actual trusted public runtime through the completed Kernel Access
hook and enqueues its admitted repair locators through the real WorkClient. Its default worker rebuild selects
native publication. The focused `default-public-runtime.test.ts` retains the finite preparation, sparse privacy-lag,
full/exhausted pages and generation-recovery case and adds a prefix/current-summary/privacy-repair journey.
Native acceptance remains deferred to integration; local compilation supplies no native readiness evidence.

## Bounded generation publication

`createSearchGenerationPublication` in `generation-publication.ts` is the shared worker/CLI publication port.
Its synchronous configuration is `{pool, search, source, sourceKeys, binding, clock, meaning, writerGuard,
registry?}`. `writerGuard` is the extended **same native ordinary writer**, `SearchWriterPublicationGuard`.
The optional registry pins the actual mixed Accounts/Subject producers and registered kinds. The four methods
are `prepare(consumer, context)`, `step(job, context)`, `activate(job, context)` and draining `close()`; close
never closes supplied resources. A job contains only `{consumer, job}` and resolves retained native work.
It carries no permission, completion assertion, key list or caller frontier.

Preparation adopts existing physical generation metadata and immutable native custody. Every adoption checks
physical name/UUID, the discovery incarnation and registry, consumer/projection generation, meaning and native
Source definition/configuration. Native Source key pages provide explicit completeness, epoch and position;
Account pages preserve handleless rows. Each step advances one retained key frontier or at most 50 validation
homes. Ordinary keys use the existing writer; mixed keys use `createDiscoveryProjection`, its permanent keyed
deletion high water and native copy inventory. `nativeGenerationActions` supplies native keyed expectations.
A refreshed physical PIT/composite traversal also examines engine-only keys. Native `after_key`, rather than
page length, proves engine traversal exhaustion. Keyed search-visible identities and exact external versions
must match native observations. Ordinary expectations use the actual writer's supplied native Source/listing,
including foreign fences, ratings and counts, and the native retained copy's settled external version.
Both ordinary and mixed comparisons check the complete projected body. Source census and query totals cannot
certify reconciliation. A native repair invalidates the affected home's witness before replay. Interrupted
pages repeat their actual work before committing the frontier. An owner move or pending identity invalidates
the affected home, and physical recreation invalidates the entire old job.

Activation first obtains the ordinary producer's durable publication fence and advances its native all-enrolled
writer/uncertain-first-apply/retained-copy drain. A second finite pass compares under that continuously held
barrier. Current Source evidence comes from an existing immutable custody observation, the selected native
binding join and canonical all-native-homes Source observation. Missing custody, routing, Source or native
barrier evidence returns typed unready; no observation readiness is minted here. Old PIT/prepared observations
remain bound to their own exact physical target and definition.

Publication persists native fencing invocation intent before requesting the gate, and alias intent, including
the previous physical target/UUID, before the native alias switch. A lost fence response resolves through the
same producer/job. A Source change during adoption safely recovers outstanding intent before returning unready.
Only exact native alias readback settles a lost response. Source and writer/copy custody are revalidated through
the critical section, before generation metadata becomes active; release occurs afterwards. A safe abort restores
only this exact alias intent while the fence remains held. Retained intent recovers a lost response or interrupted
metadata update. Existing generation allocation, live-three-generation quota and activation expiry remain owned
by the native generation implementations; this port neither allocates a parallel registry nor launches a worker.
Discovery allocation obtains the historical high water with the primary key's descending full-key LIMIT 1 and the live set through `discovery_generation_live` with LIMIT 4; a fourth live row or unsafe integer exhaustion is unavailable before inserts.

The Source binding/key-page modules publish the selected owner declarations and retain their existing
unavailable adapters. The delivered ordinary writer retains its real native admission, dispatch, uncertainty
and settlement implementation. Publication extends the same admission gate: a durable global target fence
blocks new enrollment, and one bounded retained frontier visits all home-local writer copies, cancelling
only undispatched enrollment. Dispatched uncertainty remains retained. Generation publication still requires its separate owner receiving protocol. For erasure, the same gate
resolves the actual retained physical-home job, checks each home for writer and retained-copy custody, and
consumes the native Source all-home terminal proof before returning drained or held. Native copy enrollment
takes the same admission lock and refuses creation while this fence is held. Dispatched uncertainty remains
draining; neither an elapsed deadline nor an ordinary writer scan supplies missing Source proof. No native or
public-runtime acceptance pass is inferred from compilation.

Cost: pages admit 50 native inputs, preserve the lower owner 100/256-key limits and meter public-filter costs;
steps retain a scalar frontier rather than rechecking every partition in one request. Source enumeration runs
only in generation maintenance. Publication adopts an unfiltered full-population definition; a narrowed
query observation cannot provide generation-wide Source coverage. Expired enumeration PITs restart their finite
engine pass without reusing an old frontier. New native outcomes cover incomplete population/barrier refusal, physical
recreation and lost alias response recovery; existing generation growth bounds remain applicable.

Native consumer repair settlement is retained under the existing custody execution. The exact storage is:
`public_filter_execution.repair_settlement` holds `{id, bootstrap, covered, execution, pages, frontier, closed, fence}`;
`execution` is the immutable parent id, whose existing record retains the original start and own rows.
`public_filter_repair_page`, keyed by `(partition_no, observation, execution, ordinal)`, holds immutable
`{sourceStep, predecessor, frontier, complete, repairs}` (each repair retains kind, locator, own-home Source observation
and projection plus `receipt: {bootstrap, execution, step, locatorDigest}`; the private Source brand is never
serialized). `public_filter_repair_effect`, keyed by the same execution plus page/item, retains each actual native
writer receipt before advancing the scalar page frontier. The existing `identity_writer` row
holds `repair_locator`, `repair_action` and `repair_receipt` beside its ordinary enrollment, dispatch,
owner epoch, incarnation and visible/settled command positions. The locator binds observation, execution,
page and item. No repair writes bypass this writer. Native bulk receipts or exact winner/refresh recovery
are retained there; a lost response retains the dispatched token until recovery.

`readPublicFilterRepairSettlement(pool, {queried, execution}, context)` in `public-filter-custody.ts`
returns `PublicFilterRepairSettlementResult`; its settled value contains the retained definition, queried
observation, original `CustodyExecution`, opaque `NativePublicFilterRepairSettlement` locator and actual
`CustodyCost`. Its private producer brand lives only in the canonical custody type module. The reader
uses the configured native `OPENSEARCH_URL`, never a process receipt cache. It verifies the immutable
native page advancement from the original bootstrap cut, the actual final/effectful Source step locators,
finished retained-copy work, every actual writer receipt and
current searchable winner, physical allocation and final locked writer/owner state before returning.
The real Source binding is installed by the existing consumer constructor through
`createPublicFilterCustody(pool, binding)`. That weak association routes constructor configuration only;
it stores no receipts, retained evidence or successful verification. Recovery installs the owner binding again.
The temporary structural consumer declarations in `public-filter-custody-contract.ts` match the committed
Source item ABI and selected step ABI until those original-module declarations arrive in this checkout.
Unsupported ports and legacy intents without their original locator remain typed unavailable.

The reader stages a bounded local snapshot, commits and releases its checkout, then calls the actual Source
`readRepairStep` and `readRepairReceipt` ports. Step verification compares the exact native successor,
predecessor, completion/frontier and ordered original locators (at most 256). Item verification compares the
actual owner-loaded repair body, including its original locator digest. Semantic projection data must match;
replay accounting may change, as in Source's original projection digest. The actual owner verification cost is
charged and the retained original intent is preserved. The final owner step additionally proves its original
complete window/chain and creation/change closure; an empty final step needs no item receipt.
Search does not infer this from counts, a current equivalent page, callback completion or a serialized brand.
It then opens a fresh local transaction and compares the entire staged custody/execution/work, retained
intent/effect, physical allocation, owner epoch, writer and enrollment/fence generation basis before its actual
native writer verification, readback and refresh. A changed basis invalidates that invocation's owner positives.
Immutable release authority is resolved before taking the local checkout. No raw Source registration,
read-definition, bootstrap or repair-step SQL participates in this Search guard.

This proves Search dispatch closure only. FAA must join its own durable Source step/window verifier,
creation/change bridge and original/start/final checks; the Account owner remains independent.
The final native fence is persisted on that same settlement record only after the reader's complete
revalidation. It contains the actual SQL transaction, physical UUID/write alias, Source registration epoch
and native refresh response. Re-reading a locator always repeats the guard; a previously stored fence
cannot establish current readiness. Effectful pages use a partial execution-leading index and one scalar
ordinal at a time, admitting each bounded intent before loading another; empty Source
scan pages do not require rescanning all native homes. Every effect lookup, owner/writer lock, engine
request and byte, including owner verification and both local snapshots, is charged against the consumer's
existing allowance. `withPublicFilterRepairAllowance` carries already-spent caller work into all reader phases. An over-allowance closure remains
unavailable rather than receiving a second verification budget.
The all-copy erasure worker now consumes the agreed `semantic/account-erasure-source` page port. It passes the
producer's opaque receipt unchanged to its native verifier in the receiving command, and advances a raw frontier
only after exact physical effects settle. Page verification transfers native custody, so it runs in the
same command as frontier advancement. Until then the native unconsumed page remains replayable. The final
complete-page receipt ID remains the replay frontier while independent personal cleanup finishes. The native producer supplies sealed page custody and separate all-home terminal proof;
page completion alone cannot authorize acknowledgement. Accounts' `HistoryBarrier` is only a locator.

Native retained-copy admission advances `public_filter_target.copy_revision` atomically with registration,
observation and prepared creation. Erasure traverses those actual homes and immutable registration ranges,
closes observations, drains their real references and scrubs independent prepared payloads. A changed admission
revision reopens the range, including empty/excluded captures and older incarnations retained under a reused name.
The native Account Discovery purge remains separate; its local cleanup no longer acknowledges all of Search.
Personal recent/trending cleanup records its own progress; only the all-copy worker can send the final ACK.

Physical reconciliation uses current Source through the same ordinary Search writer, then its publication
fence/drain/adopt extension before compaction. Fence strings are persisted locators and are revalidated by that
native guard. Active, building and retiring physical UUIDs remain required. Unregistered native generations,
incomplete population, missing deployment configuration, producer or native guard remain pending. The existing native Search writer supplies its extended guard through
`SearchErasureRuntime.writerGuard`; no callback can certify completion.

The default discovery factory also exports `open(principal, request, context)`, returning a
`RetainedDiscoveryRead`. Its one `search()` returns the projected page before the native terminal
observation. One positional `currentPrimaryCandidates(keys)` batch can check at most 160 original
mixed keys, retaining duplicates and rejecting foreign route/kind identities before owner I/O.
The initial owner snapshots supply their own revisions and are reused by the ordinary disclosure
checker. Unknown owners and failed reads reject the operation; they do not prove an empty page.
`finish()` waits for that batch and then completes the original native final. `close()` abandons
an unfinished operation and disposes its original observation. Final refusal, projection failure,
owner failure and deadline expiry retain the same cleanup path. Calls after finish/close are invalid.
The retained operation snapshots the admitted request, actor and absolute deadline. Caller mutation
cannot extend its lifetime. Expiry removes publication authority immediately but waits for an already
dispatched owner batch to settle before disposal. Finish checks the same deadline after that batch
and after the native final and cleanup, so a late callback cannot restore publication authority.
The existing public `search(principal, request, context)` composes open/search/finish/finally-close.
Factory shutdown drains those public calls and closes outstanding retained operations before its
runtime and work client.

Cost: retaining the operation adds no capture or root, and at most one owner snapshot per Subject
home or per 100-key Account chunk. The checker reuses these snapshots instead of repeating those
native reads. Hydration and resource witnesses remain additional work. These cardinality bounds
are not a complete eight-axis ordinary preparation declaration and do not establish the three-round
mixed Home bound. This internal request-bound lifecycle does not supply `SpaceScopeReads`, a
following-only root or the missing original/native capture provenance and funding operands.
The lifecycle unit regressions are authored; native population, factory, receiving and Home proof
remain separate acceptance obligations. The dedicated retained-lifetime regressions cover expiry
during successful and refused owner reads, delayed timer delivery, caller deadline mutation and
late native final completion. These unit cases remain authored UNRUN.
