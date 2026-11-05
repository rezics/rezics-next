# Search from entry to factual page

Research evidence and selected implementation recommendations, 30–31 October 2026. This report
covers the Search, facets and discovery In row and Search's presentation/composition boundary.
Web retains ownership of Subject pages. The report does not adopt a public API, authorize an
operation, make Source/runtime available, or establish native outcomes. Cross-owner changes below
remain proposals for the named owners to adopt in their authoritative documents.

## Authority and method

The current [conditions](../search-conditions.md), [facets](../search-facets.md),
[filtered-list contract](../filtered-lists.md), [Search Goal](../goals/search.md),
[Search README](../../services/kernel/src/search/README.md),
[presentation README](../../services/kernel/src/presentation/README.md),
[composition README](../../packages/composition/README.md) and
[subject pages](../subject-pages.md) constrain every recommendation. This is desk research:
bounded caller, route, default-module, relay, generation and storage inspection; official sources;
and read-only established project source. No native, browser, database or remote execution was used.

Three evidence levels must remain separate. A declaration or checked type establishes a contract;
a mounted caller establishes exposure; a native user outcome establishes behavior under the tested
schedule and bounds. Source inspection here establishes the first two where named. Owner handoffs
are used without rechecking their landed revisions, historical receipts or tests. None supplies a
main/root claim. Existing six planning artifacts are useful whole briefs, not evidence that their
future bindings already exist.

Relevant prior primary-source reports are [universal search](universal-search.md),
[current native cuts](public-filter-native-cut-current.md),
[visibility witnesses](search-visibility-witnesses.md),
[scoped text](library-scoped-title-plan-current.md),
[rating epochs](search-rating-epochs.md) and
[worker outcome harnesses](search-worker-outcome-harness.md). Current adopted conditions supersede
older title-only coverage, pagination choices and historical public-count language in those reports.
This report supplies integration evidence rather than another fragment design.

## What mature products and standards actually establish

The facts in this section are external evidence. Subsequent REZICS choices are recommendations
inferred from those facts and the repository contracts; they are not claims about those products.
Official pages were accessed on 30 October 2026; the OpenSearch PIT, Open Library API, Algolia
faceting and WAI combobox pages were also accessed on 31 October 2026.

### Catalogue search and deliberate advanced controls

Open Library returns work results with edition information and stable identifiers; language preference
differs from a language restriction. It exposes explicit field selection and warns that selecting all
fields is expensive. Its help documents fielded and Boolean queries. Those are useful precedents for
a simple entry backed by an expressive, documented query model. Its offset/page parameters and
public result totals are product choices, not requirements for REZICS.
Sources: [Search API](https://openlibrary.org/dev/docs/api/search) and its linked
[Search HowTo](https://openlibrary.org/search/howto).

The retained Open Library source separates a search scheme's population, query/filter construction
and selected result fields in `openlibrary/plugins/worksearch/code.py`. Its
`openlibrary/plugins/worksearch/autocomplete.py` supplies work/author-specific bounded fields and
prefix-oriented suggestions. The transferable design is an explicit summary/navigation boundary,
not its query language or a fallback that bypasses REZICS's native current authority.
[Source](https://github.com/internetarchive/openlibrary/tree/37e446827465be2febad416de1bc18753b66997d/openlibrary/plugins/worksearch).

Discourse's official help connects advanced controls to its ordinary search syntax and documents
scoped/private-message search. Its `lib/search.rb` routes native post/private-message populations
through Guardian checks. This supports keeping scope in actual population authorization rather
than treating a label or hidden form field as authority. It does not prove REZICS's cross-home
privacy or Cost bounds. Sources:
[search help](https://meta.discourse.org/t/searching-for-content-effectively/273328) and
[native search source](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/lib/search.rb).

### Refinement, typeahead and accessible interaction

Algolia documents contextual facet values and separate conjunctive/disjunctive behavior. It also
documents approximate facet counts and configurable value limits. Its autocomplete presents query
suggestions or actual results on desktop and mobile. Transfer contextual controls and explicit
suggestion identity; do not transfer approximate counts, top-value truncation or extra unbudgeted
requests. Sources: [faceting](https://www.algolia.com/doc/guides/managing-results/refine-results/faceting),
[autocomplete](https://www.algolia.com/doc/ui-libraries/autocomplete/introduction/what-is-autocomplete)
and the linked [React widget API](https://www.algolia.com/doc/api-reference/widgets/autocomplete/react).

The WAI combobox pattern specifies focus, popup/listbox relationships and keyboard behavior,
including selection and dismissal. This is interaction guidance, not search or authorization logic.
REZICS should preserve the same native input and ordinary form when the popup is unavailable.
[WAI-ARIA combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).

### Engine pagination, writes, analysis and terms

OpenSearch documents that `search_after` alone sees a changing index, while a PIT retains a fixed
dataset backed by retained segments. Pagination carries the previous sort values with the same
ordering. Deep offset pagination processes earlier results. A PIT's retained dataset can survive
ordinary live edits, and PIT resources can be lost on failure. Therefore a PIT is an observation
resource, not current disclosure authority or a repair acknowledgement.
Sources: [PIT](https://docs.opensearch.org/latest/search-plugins/searching-data/point-in-time/),
[pagination](https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/) and its
linked [PIT API](https://docs.opensearch.org/latest/api-reference/search-apis/point-in-time-api/).

External versioning accepts a strictly newer version; `external_gte` admits equality. Refresh
controls search visibility separately from acceptance of a write. Pinned `VersionType.java` and
`InternalEngine.java` show version conflict rules and expiry of retained delete versions. The
inference is specific: external versions alone cannot certify permanent physical absence after
a delayed old writer resumes. REZICS still needs the existing erasure/custody protocol.
Sources: [Index Document API](https://docs.opensearch.org/latest/api-reference/document-apis/index-document/),
[version rules](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/VersionType.java)
and [engine](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/engine/InternalEngine.java).

An OpenSearch analyzer has character filters, one tokenizer and token filters. Custom analyzers
also define position gaps between array values; CJK bigrams are a particular token filter, not a
complete multilingual equivalence guarantee. The inference is to pin REZICS's full adopted
`cjk_bigram_v2` pipeline and positions, rather than approximate it with a database text function.
Sources: [analyzers](https://docs.opensearch.org/latest/analyzers/),
[custom analyzer](https://docs.opensearch.org/latest/analyzers/custom-analyzer/) and
[CJK bigram filter](https://docs.opensearch.org/latest/analyzers/token-filters/cjk-bigram/).

OpenSearch `terms` returns selected buckets; distributed count accuracy depends on collection
and ordering parameters. Increasing shard collection does more work. Neither a top-terms result
nor key ordering proves complete, authorized, population-wide value discovery within REZICS's
page budget. This is a reason to retain the facet plan's preparation decision, not to add an
approximation exception. [Terms aggregation](https://docs.opensearch.org/latest/aggregations/bucket/terms/).

### HTTP, lists, errors and public documents

HTTP 202 means processing has been accepted, not completed. HTTP defines authentication, conflict,
unprocessable-content and service-unavailable statuses and `Retry-After`; it does not mandate a
Search total or a new preparation endpoint. Keep existing REZICS error semantics rather than
inventing success-shaped readiness. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html),
sections 10.2.3, 15.3.3 and 15.5–15.6.

`no-store` prevents compliant caches from retaining the exchange; `private` restricts shared caches.
Neither establishes permission or removes copies already retained elsewhere. Use both for native
private/scoped/preparation and composed private responses, while preserving actual authorization.
[RFC 9111, section 5.2](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2).

Problem Details supports typed machine-readable errors and extensions. Web Linking defines relation
semantics, not a universal list DTO or cursor algorithm. Preserve existing problem codes/pointers
and existing `next`; neither standard requires public counts or offset navigation.
Sources: [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) and
[RFC 8288](https://www.rfc-editor.org/rfc/rfc8288.html).

JSON-LD permits embedded linked-data documents; Schema.org permits text, CreativeWork and ordered
instruction forms for `recipeInstructions`. Neither grants disclosure or makes an arbitrary body
reference safe. REZICS should produce metadata from the same validated, selected, currently public
body as its rendered prose. Sources: [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/) and
[recipeInstructions](https://schema.org/recipeInstructions).

The shared pattern is a small ordinary entry, an explicit predicate/population model, stable result
identity, contextual refinement, deliberate continuation and a separately governed detail read.
The sources do not establish bounded whole-query privacy during lag, cross-engine score equivalence,
or REZICS's fixed SQL/Access/engine/byte ceilings. Those require the native proof assigned below.

## Current REZICS path, including exact breaks

Paths in this section are relative to the repository root. These are source observations and trusted
owner declarations, not newly executed tests.

| Journey seam               | Actual caller, API and authority                                                                                                                        | Exact remaining break                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public entry               | `apps/web/src/routes/search.tsx`, `search/search-queries.ts` and `search/search.tsx`; `/search` reads the released catalogue through the public client. | Bare entry does not enumerate results; no all-kind caller. Decide ordinary interaction without silently opening advanced/private admission.                                             |
| Subject hits               | `services/kernel/src/search/http/routes.ts`; `POST /v1/subjects:search`, Global `subject:read`, current summary hydration.                              | Subject-only output; summary filling occurs outside service completion, so final whole-query safety must cover the actual outer fill.                                                   |
| Typeahead                  | `apps/web/src/search/suggestions.ts`, `server.ts` `/api/search/suggestions`; `GET /v1/subjects:suggest`, small Subject summaries, no-store proxy.       | Scoped loader is optional, not a native scoped producer; mixed identity/current Account discovery and full failure behavior remain open.                                                |
| Refinement                 | Web released definitions and `POST /v1/subjects:facets`.                                                                                                | Public DTO already strips counts, but runtime samples/count-orders; no native canonical continuation, Web facet type omits `next`, only first eight property controls.                  |
| Result navigation          | `search/results.tsx`, `subject/subject-href.ts`, `/subjects/$id/$slug`, canonical account redirects and `/@{$handle}` page routes.                      | No generic mixed family/title/kind/url consumer; a subject's account redirect is not Account discovery. Handle-null Account navigation needs the mixed-plan owner decision implemented. |
| Factual composition        | `features/pages/subject.tsx`, `POST /v1/pages:read`, Kernel `presentation/reads.ts`, composition registry/read planner.                                 | Selected authored-body descriptor, Realm selector and node continuation are missing; inline value rendering is not a Content body read.                                                 |
| Configured discovery       | Platform route `/` uses `pages.read` and four TypeLists, 12 slots each, collection order; See all links to `/search?type=...`.                          | The declared 48-slot plan is configuration, not proof of backend work or composed native privacy.                                                                                       |
| Default public index       | Kernel `server.ts`, `work/modules.ts`, `search/work.ts`, `search/runner.ts`, `search/indexer.ts`.                                                       | Real Subject source/worker exist; default complete public-filter Source/consumer, key-complete activation and observation-safe useful-page recovery remain open.                        |
| Native private populations | Library canonical source contracts/primitives, Commerce owner plans, Semantic Zone/Realm semantics.                                                     | `createCollectionSource` currently fails unavailable; verified native authority/preparation bridge and multi-home completeness cannot be supplied by a string principal.                |

Actual search responses contain `subjects`, `next`, `as_of` and requested summaries/facts. No public
total is exposed. Actual facet responses contain value/label entries; stale README wording about
unsafe public counts is not evidence that current routes still return them. Count removal and real
public-filter custody fixes are landed pieces to preserve, not whole runtime closure.

Web's `search/search-params.ts` accepts only 2,048 cursor characters, below the adopted 4,864 maximum.
Its 256-character `q` guard also differs from the backend's 512 UTF-8-byte admission. It exposes rating
sort, with a one-time 409 restart in `search/search-request.ts`; it does not expose every API order.
Its selected facet/type translation covers a subset of the released predicate grammar. These are
transport/UI gaps for the Web handoff, not reasons to relax backend limits or silently discard input.

## Recommended reader journey

### Ordinary search, result identity and kind metadata

Keep `/search` as an anonymous ordinary entry and keep the shared header as its single search region.
Retain the intentional empty entry until a query or supported population selection is submitted.
New submission changes the admitted query and drops the old cursor. Preserve selected supported
conditions; identify invalid/stale values instead of silently converting them to a broader search.
The same native form must work when typeahead fails. A completed empty result is distinct from an
unavailable producer, incomplete index, failed metadata read or pending preparation.

Adopt the mixed-kind plan's proposed `POST /v1/search:query` only after native population and current
disclosure are ready. It reuses the evolved `subjects-gN` public family. Existing
`/v1/subjects:search`, facets and suggestions stay Subject compatibility adapters, with their closed
envelopes. Account is one result kind; configured catalogue types retain exact kind identity and
their existing base/subtype meaning under `type`. Account IDs never become Semantic Subject IDs.
Use tagged internal keys `subject:<UUID>` and `account:<UUID>`; deduplicate family plus canonical ID.

Web consumes the selected generic title/kind/navigation summary rather than guessing a Subject URL
from any UUID. A catalogue result opens the factual Subject page; an Account result uses native
account navigation. Handle-null input is exactly `{family:"account",id,handle:null}`. Existing
`GET /v1/accounts?ids=...` supplies public ID lookup; it is not discovery and needs no new HTTP route.
The missing link is Web's ID-capable navigation/aggregate destination, since the inspected `/@{$handle}`
route requires a canonical handle. Former handles may forward direct navigation under Accounts
policy; they do not become discovery aliases.
Person subjects and Accounts remain distinct even when linked by a verified agent relationship.

Configured kinds come from a bounded registry page in configured order, with More kinds. They are
metadata, not property values, sampled facet buckets or evidence that an unpopulated kind works.
The mixed plan's proposed `kindPage:{limit,cursor?}` has limit 1–8. Default-all searches consider all
configured producers, including kinds outside the first metadata page. The proposed kind leaf
`{kind:{in:[...]}}` is exact selection; it consumes existing grammar allowance.

Kind counts are the sole narrow count exception: initial request only, remove only the designated
top-level AND kind leaf, and retain all other conditions. Return exact complete evidence, a certified
positive lower bound displayed `N+`, or unavailable. Never synthesize zero, use page length or repeat
unbounded count work on continuation. Any unavailable count leaves the kind selectable. Property
facets and ordinary search totals remain count-free. Optional kind counting shares the hit operation's
remaining engine, SQL, Access, byte and safety budget; it has no separate allowance.

### Refinement and typeahead

Use `facetProperties(release, types)` for the complete released property roster, including bases.
Group it into requests of at most eight properties; a group is UI continuation, not permission to
run unbounded requests in one render. Distinguish kind selection, item/code/type value choices,
and independent quantity/time operators with units. Retain selected values when a control is
collapsed. Show unavailable discovery honestly without broadening the submitted predicate.

Keep the adopted facet wire: `POST /v1/subjects:facets`, common text/filter/languages, 1–8 distinct
`{property,size?,cursor?}` requests, size 1–20 default 10; response
`{facets:[{property,values:[{value,labels}],next}],as_of}`. Enumerate the full eligible population in
canonical native value-key order, never count/frequency order. UUID/item keys use their native order;
code/type keys use the selected exact UTF-8 byte ordering. Labels can be localized without changing
cursor identity. Complete source values must include the 129th and later values, not only today's
128-value projection sample or a keyed probe of already known values.

Retain the facet plan's decision: general facets use retained preparation. Reuse durable infrastructure,
deduplicated native basis and finite progress; pending reads use current `503 index_not_ready` and
`Retry-After: 1`. A repeated request resumes the same applicable preparation instead of restarting at
zero. Do not invent an automatic Search/facet 202 DTO, live `terms` fallback, sampled result or second
engine. A future direct exception needs independent measured admission under the literal budgets.

Typeahead is a bounded read, not an alternate query authority. Preserve loading, cancellation, empty,
error and keyboard selection states, the active descendant, Escape dismissal and focus return.
Submit the ordinary form when a user wants the complete query. Use the same configured meaning,
current disclosure and public safety as results; no rejected query becomes a looser suggestion query.
Suppress global suggestions while scoped. An optional scoped loader must perform that native scope's
real authorization; a chip supplies neither a route nor permission. This does not open advanced search,
Zone admission or an AI answer slot. Mixed suggestions require an adopted mixed contract rather than
silently adding Accounts to the closed Subject suggestion DTO.

### Advanced conditions, native scope and private state

Preserve the existing advanced-admission boundary. The inspected header explicitly opens no advanced
admission, and the ordinary route is not a complete advanced builder. Do not invent a gate ID or
permission action to explain the gap. A later Web owner slice must consume the actually adopted gate
and typed grammar; this research grants neither. The grammar is shared across direct, saved, Agent,
owner and composed consumers, not duplicated in a client-specific query language.

Text uses actual `parseText`: 512 UTF-8 bytes, depth 4, 64 leaves, phrases up to 32 counted tokens,
implicit AND, `|` OR, unary `-` and quotes. Escapes remain closed to backslash, quote, pipe,
parentheses and hyphen. Omitted text differs from empty/whitespace-only text, which is 422 at `/text`.
Bind raw validated text without trimming, NFC or casefolding at transport. Catalogue coverage is
complete public labels, aliases and descriptions. Preserve ICU NFKC_CF, standard tokenization,
Traditional/Simplified and Hiragana/Katakana folding, CJK bigrams, stopwords and multivalue phrase
boundaries; native private execution must preserve that meaning and ranking, not substitute ILIKE.

Expand saved filters and literal Agent credit OR branches before execution; retain the adopted
32 leaves, depth 4, OR 16, `in` 64 and four qualifiers. The literal 12-credit expansion is not a
truncation license. Resolve/authorize every request-only Collection, Zone and Realm UUID even beneath
NOT or an already true OR. A recognized leaf outside a result kind's domain is unknown under NOT;
an unrecognized/unsupported condition is 422. For Accounts, only shared text and kind are applicable
under the selected plan; an absent statement array does not make every negative Subject leaf true.

Private holdings, progress, labels, presence and Library membership stay in authoritative owner
stores. Use only the existing sole preparation exception: one own Collection or one positive
viewer-self presence, never both or several; no foreign owner preparation. Manual Collection
membership uses canonical eligible members even when absent from Everything. Foreign dynamic
Collections use only their completed published result. Zone membership evaluates the actual page-list
predicate, not mounts or sampled pages; Realm membership uses current readable linked threads and
their native opening/board/place/subject/ban checks, not a cached label or Context UUID alone.

Bridge the actual verified actor, principal command identity and Access command authorization to the
actual Collection resource/home plus native eligibility. Resolve real Everything through
`library/builtin-identity.ts` and its adopted namespace; do not synthesize a materialized Collection
or authorize a guessed UUID. Same-viewer source-home/fence rules, viewer plus at most two accounts
and routing beyond four homes remain owner obligations. HTTP string `account:ID` is not that bridge.
Private/scoped results and preparation use `private, no-store`, including failures and page sessions.
The present `/search` publicRead/public-cache caller cannot carry those private plans unchanged.
Web must bind the real session client and cache classification before exposing an admitted private
scope; neither a private filter nor credentials may enter an anonymous shared query cache.

## Representation ownership and lifecycle

| Representation                     | Creates and populates                                                                                                                      | Queries and authorizes                                                                                                   | Repairs and removes                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Native catalogue facts/definitions | Semantic commands and released definitions; current `semantic/search-source.ts` SubjectSource.                                             | Semantic current subject/fact/Context readers and native Access; Search consumes the declared projection.                | Semantic emits authoritative changes/reductions; Search never writes source truth.                                          |
| Native Account discovery           | Accounts owns state, handle claims, display name, avatar and verification. Complete retained discovery source is a missing owner handoff.  | A dedicated current discovery guard must require active and unfenced; attribution readers are insufficient.              | Accounts reduction/identity lifecycle; Search repairs its copied projection and excludes unsafe observations.               |
| Public `subjects-gN`               | Search generation/indexer plus existing relay; public Content rating and Commerce Collection-count adapters.                               | The shared admitted query and current native disclosure; same public family for selected mixed plan.                     | Search key-complete reconciliation, refresh-visible repair, activation and retirement; native owners determine eligibility. |
| Source privacy reductions          | Native Semantic/Content/Accounts owners in their authoritative transactions and adopted dependency protocol.                               | One actual Source across all relevant homes; start/final observations plus independent current authority.                | Search repairs dependent copies; native acknowledgement only after complete dependent searchable repair.                    |
| Search custody and observations    | Existing `createPublicFilterCustody` owns durable registrations, observations, executions, references, PIT/prepared locators and barriers. | Actual consumer calls `readPublicFilterConsumerCustody`; custody identifies copies, not permission or complete coverage. | Existing close/drain/lease/revision protocol; existing identity participant owns erasure integration.                       |
| Private and retained populations   | Library/Commerce native plans and existing durable preparation machinery, keyed by authorized basis.                                       | Native source/owner permission and current eligibility on each use; Search never mirrors private facts.                  | Owner invalidation, bounded rebuild/replay/expiry and exact retained-copy erasure.                                          |
| Authored bodies and page data      | Content `content.authored_field`, Semantic selected document-valued fact, inert composition profiles.                                      | Content `readDocument` and native current selection/Context/Realm readers inside presentation.                           | Content erasure/disclosure and final selected-page guard; Web only renders the returned validated binding.                  |

The default server actually constructs `createRatedSubjectSource` and `createSearchService` with
OpenSearch configuration. The work module starts the rated source plus public listing adapter,
generation runner, Subject indexer and relay checkpoints in `core.consumer_checkpoint`. The runner's
generation discovery/retirement and the current source-keyed batch fixes are useful existing plumbing.
A source count equal to an index count is not key-complete reconciliation or proof of correct content.

The inspected native SQL names the actual stores: Semantic `subject`, `fact`, `adoption`,
`candidate`, `statement_disclosure`, `definition_release` and `redirect` in the `semantic` schema,
with `core.partition` position; Accounts `access.account` and `access.handle_claim`; Library
`library.collection`, `collection_member`, `entry`, `copy`, `progress_session` and `label_assignment`.
See `semantic/search-source-*.sql`, `access/account-public-read.sql`, `access/public-identity-page.sql`,
`access/lifecycle-handle-read.sql` and `library/collection-source-native-*.sql` beneath Kernel `src/`.
The Library native primitives expose real rows; the unavailable canonical source factory still
must compose them. Retained population/preparation and discovery additions belong with those
owners, not a Search-owned copy of their native facts.

The source and consumer contracts declare `PublicFilterSourceFactory` and
`PublicFilterConsumerOperationsFactory`. The selected future exports
`semantic/public-filter-source.ts:publicFilterSource` and
`search/public-filter-consumer.ts:createPublicFilterConsumerOperations` are missing runtime bindings,
not callable imports supplied by this report. Do not fork a Source mirror or a second consumer to
make a demonstration work. Preserve the existing consumer-mechanics and native Source/custody writers.

Real custody lives in `services/kernel/src/search/public-filter-custody.md` and the corresponding
SQL migrations under `services/kernel/db/search/migrations/`. A physical target is tied to engine
identity; reused physical names do not inherit registration. Prepared rows are immutable, external
work uses bounded leases, and close drains references before terminal cleanup. These actual fixes
solve copy custody pieces. A custody row, type, lease, successful bulk request or checkpoint is not
a complete source, public permission, readiness, native ACK or erasure receipt.

### Freshness, lag and whole-query privacy

Preserve ordinary healthy source-to-searchable convergence within 60 seconds; lag over five minutes
produces readiness. Owner writes appear on the owner's next read. Neither bound permits lag for
privacy reductions. Freshness includes source logs, projection, repair and refresh-visible state;
an engine refresh timestamp alone cannot establish it.

Capture one request-bound canonical observation for the actual query, reuse it through refill and
summary/count work, and perform final safety only after that work completes. Native source owners
record reductions in their own authoritative transaction. Search must detect reductions affecting
membership, negative evidence, ordering, zero results, labels, figures, cursors and metadata, not
only returned hits. A repaired live index cannot make an older PIT safe. Start/final checks must
retain evidence of a reduction that was repaired and acknowledged between them.

Across 4,096 homes, use the existing Source contract for one complete query dependency observation,
not separate candidate-home probes or a full unchanged-head scan. Missing/unavailable/moved homes
cannot become clean zeros. Relevant incomplete coverage or pending repair/identity work makes the
observation unavailable; do not return a truncated safe-looking page. Coarse initial blocking is not
the required useful-page closure as reduction rate grows with population.

Accounts needs a dedicated native discovery reduction boundary at T: `state = active AND NOT
authn_fenced` for hits and kind counts. Pending, suspended, deleted and erased Accounts are absent.
An attribution reader that deliberately labels a suspended author ACTIVE has another purpose and
cannot authorize discovery. Search only handle/displayName, not email, bio or private fields; boost
only a currently active case-insensitive exact handle claim. Avatar/verification labels require current
guarding too. Proposed retained Account population cuts and replay must be supplied by Accounts;
`pageActiveAccounts` deployment enumeration, keyed identities and exact-handle lookups are not that
protocol. Do not use a global identity marker to block unrelated public pages.

### Continuation, ranking and failures

Continuation carries the last globally consumed frontier, not the last prefetched row. Obtain a
head or EOF from every admitted producer before consuming the next result; support work, duplicates,
rejections and lookahead all count. A dominant producer can fill the page. Do not allocate equal
per-kind quotas, discard unconsumed prefetch, or bind correctness to round-robin interleaving.

The same shared public family supplies a comparable text context for Subject and Account. Native
private producers still need proof of the adopted comparable per-hit keys. Raw BM25 versus database
rank, reciprocal-rank fusion or result-set-dependent normalization does not define a durable merged
seek order. Preserve adopted relevance/name/ID/Collection/rating tie behavior; textless default is
name. Bind registry, semantic release, comparator, expanded definition, actor/scope and exact request
meaning. A generation/comparator/producer-meaning change yields 409 restart; malformed or invalid
cursor yields 400. Expiry never grants continued permission.

Collection-count and rating sorts are Subject-domain orders. Preserve the mixed plan's admission:
explicit catalogue kinds or a positive catalogue type restriction may use them; default-all mixed
requests give 422 at `/sort`. Do not fabricate Account zero scores/counts or silently drop Accounts.
Ordinary mixed relevance, name and ID orders remain required.

Keep the literal confidential cursor limits: eight keys, 2,560 UTF-8 bytes/key, 3,072 aggregate string
bytes, 3,584 serialized bytes, 4,864 token characters and 15 minutes. Apply encoded length admission
before decoding/decrypting or IO; at most two compatibility decodes. Retained preparation locators
and basis fit 4,096 UTF-8 JSON bytes with no raw query text. Do not put PIT/job locators into Search
`after`, log decrypted cursors or create an unowned query-history copy. The proposed two-source,
two-candidate/key-capacity algebra is not a measured native bound.

Keep 400 malformed input, 409 restart, 422 unsupported admitted shape and 503 readiness/dependency
semantics distinct. Search/facet `index_not_ready` retries with one second; retain independent
`semantic_not_ready`. Absent credentials on a protected operation give 401 with Bearer challenge;
bad/expired/revoked/pre-suspension credentials give 401 `invalid_credentials` with invalid-token
challenge, never anonymous downgrade. Do not turn unavailable counts/facets into zero. Preserve
typed problems and pointer errors without exposing private pipeline details.

Web should preserve the query while showing retry/restart states; a new query resets continuation.
Its existing rating-only 409 restart must become the actual adopted common restart experience,
without a loop or silent condition removal. Correct cursor transport and full value continuation
belong in that same Web/native slice, including zero/final/sparse pages and suggestion failure.

## Literal work bounds and the real implementation choice

The following are acceptance obligations from [filtered lists](../filtered-lists.md), not estimates
deduced from product documentation. At fixed request/page size, measured engine work must remain
fixed or logarithmic in corpus/match population. Result limits, PIT, timeout, `terminate_after`, a
small SQL LIMIT or a per-call 256-key source cap do not establish operation-wide work bounds.

| Operation              | Literal allowance to preserve                                                                                                                                                                | Whole-slice proof owner                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission              | Page size 1–100; 32 leaves; at most 16 composed reads and 128 total requested slots.                                                                                                         | Shared planner, Search and presentation; reject before over-budget dispatch.                                                                                   |
| Direct useful page     | Candidates `c <= min(600, 6s+3)`; at most three refill rounds, each asks `<=2*remaining+1`; at most six engine searches and three owner seeks, at most two/one respectively per round.       | Native runtime and mixed-kind slices, counting rejects, duplicates, lookahead and rereads.                                                                     |
| Direct native work     | Access/dependency `16+8c`; SQL examined rows including removed rows `64+16c`; 12 SQL statements/backend and one connection/backend/page; blocks follow the owner's six-per-budget-row rule.  | Shared native runtime, every owner pool and composed closure; no separate per-helper allowance.                                                                |
| Page bytes             | Response `16 KiB+4 KiB*c`; requests `64 KiB+1 KiB*c`.                                                                                                                                        | Search/native owner readers and the actual outer route/summary completion.                                                                                     |
| Ready retained page    | `c <=2s+2`, at most two index reads, same native work/byte ceilings.                                                                                                                         | Facet and private retained plans, including current source checks.                                                                                             |
| Composed maximum       | Shared control/start/final/disclosure/summaries; SQL `8+4R`. At 16 reads/128 slots: 816 candidates, 6,784 Access points, 14,080 rows, 72 statements and 96 searches; one connection/backend. | Presentation/composed closure captures the whole operation, not a sum of separately reset scopes.                                                              |
| Privacy at 4,096 homes | Two SQL observations and `64+2*(behind+changed homes)` examined rows; no full 8,192-head vector scan.                                                                                        | Actual native Source plus Search consumer, including SQL role classification and useful served share.                                                          |
| Preparation step       | At most 1,000 inputs, 1,000 result writes, one frontier, eight points/input, `64+16*input` rows, 16 SQL/backend, four searches, one connection/backend, 4 MiB response.                      | Native retained producer and Search; total finite-input work linear, each input once, replay at most one step. Commerce's stronger 100-row step still applies. |
| Retention              | 32 live owner outputs, 24-hour idle expiry; public one current plus one building per admitted definition.                                                                                    | Existing durable owner infrastructure, runtime and erasure slices.                                                                                             |

The first Subject hit producer also needs the adopted new versioned template/parser with total
tracking disabled. Current immutable v2's discarded `track_total_hits:10000` is still engine work;
leave v2 unchanged, admit omitted totals in the new parser and retain full hit/payload/shard,
generation and privacy validation. Measure overflow aggregation separately. Disabling totals alone
proves no iterator bound.

Engine proof sums actual `next_doc_count` and `advance_count` through the complete query profile
tree and every shard of pinned OpenSearch 3.9. `QueryTimingType.java` names those iterator operations;
`Timer.java` increments operation counts independently of its sampled timings. Use the existing
capture mechanism, not elapsed time or output size as a proxy.
[QueryTimingType](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/profile/query/QueryTimingType.java),
[Timer](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/profile/Timer.java).

The concrete selected design is direct execution only for a measured admitted shape, otherwise
existing finite retained preparation. General facet enumeration is already selected for preparation.
The mixed public family avoids a second engine and narrows ranking equivalence work; it does not
prove broad text/NOT/terms queries meet iterator ceilings. Default all-kind requests also cannot
pretend an unsupported producer is EOF. Before activation the responsible runtime slice must either
prove its real shape or provide its authorized retained path and useful completion. Do not claim
feasibility from syntax, cache warmth or the cited products, and do not report permanent readiness
as closure.

Native privacy proof retains the exact `semantic.privacy-start`, `semantic.privacy-final` and
`semantic.own-rows` SQL roles. If the selected implementation probes transaction IDs, its actual
active-XID schedules 1/8/64 remain part of proof; no extra XID allowance appears. Include all source,
owner, relation, property, Account and summary work in the operation's same scope, across 64/512/4,096
source rows/homes with fixed admitted input. Record examined rows, removed rows, blocks, Access,
engine iterators, statements, connections and bytes. These later measurements are not this report.

## Factual pages, Context, authored body and JSON-LD

Keep the inert closed composition registry and released profiles. There are no executable query
strings or arbitrary network URLs in a composition document. A mixed result's destination reads its
own native current authority; a Search hit is never a page permission certificate. Public aggregate
dispatch must retain `withPublicStatementReader`'s sticky public audience without replacing the
actual caller's authentication, Access, evidence or deadline.

Retain the page-document plan's selected generic Document descriptor bound to a released property,
not a caller-supplied body ID. The proposed `Document`, `DocumentBinding`, `selectPageDocument`,
`guardPageSelection`, `subjectThreads` and `PageContinuation` are not current exports. Select the
exact current public subject/property/context reference and language/rank winner inside the aggregate.
The subject dependency is shared and charged once; reference selection stays within existing fact
limits. Read the exact Content body using existing `readDocument(dependencies,id,{actor,deadline})`
and public DTO shaping corresponding to `GET /v1/documents/{id}`. Internal import origin is not
public body metadata and must not leak by serializing `DocumentView` directly.

Content owns authored canonical body, SPDX licence, BCP 47 language and immutable digest in
`content.authored_field`; Semantic owns which disclosed candidate/reference is selected. Web owns
validated prose and metadata rendering through `features/pages/values.tsx`, `subject.tsx` and
`jsonld.ts`. These are distinct stores and writers, not a body copy to add to OpenSearch.
Bind document ID, digest and selection to one aggregate result and derive prose and JSON-LD from
that same validated binding. Recheck the selected subject after body work and before metadata.
Missing/undisclosed bodies produce the owner's honest absence; erased body data stays null/absent.
Mismatched, invalid or oversized dependency data fails as unavailable, with no truncation or fallback
to a hidden candidate. A whole-request invalid credential remains 401.

Implement the existing subject-pages Realm/Context contract in `pages.read` rather than interpreting
a Context UUID as Realm thread-place authority. The current closed parser supports subject, account
or route plus view, not the required Realm selection. The proposed extension must use actual
`readRealm`, `readPublication`, native Context authorization and current subject reads. An absent
publication allows Global only after independent Global authorization; denial/ban gives 404 without
fallback. A late publication/Context/head change gives retryable whole-page unavailability; a late
ban gives 404, not a retry into another authority. No extra read allowance or authority is created.

Wire current `listSubjectThreads`/`readSubjectThread` into the selected ThreadList/ReviewList read
descriptor and node continuation. Relations and discussion continuation preserve subject, kind,
place, Context, filter and native authority. Continue that node through `pages.read` rather than
re-running an unbounded first-page aggregate or borrowing an unrelated Search cursor. Private,
protected, preparing and session-dependent aggregate responses use private/no-store. The selected
Zone 202 continuation remains its existing protocol, with at most four Web steps per render and an
honest preparing state; it does not become the facet/Search preparation wire.

## Provenance, licences and decision record

No source files or long passages are proposed for copying. Reference clones were read only and
never installed, built or run. Paths below are beneath the allowed main-checkout `.reference/`
directory; the reuse is recorded in its `INDEX.md`. Full revisions identify research sources only,
not landed-code receipts or native proof.

| Retained source                                   | Repository and inspected revision                                                                                                   | Licence and inspected paths                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `partitioned-sitemap-feeds/openlibrary`           | [internetarchive/openlibrary](https://github.com/internetarchive/openlibrary), `37e446827465be2febad416de1bc18753b66997d`           | AGPL-3.0, `LICENSE`; `openlibrary/plugins/worksearch/code.py`, `autocomplete.py`.                                                                   |
| `partitioned-sitemap-feeds/discourse`             | [discourse/discourse](https://github.com/discourse/discourse), `589325e2b8466178ee83acac9ec411de555a0093`                           | GPL-2.0-or-later, `LICENSE.txt`; `lib/search.rb`.                                                                                                   |
| `search-rating-populations/opensearch`            | [OpenSearch](https://github.com/opensearch-project/OpenSearch), `4ee42a94e87f66fbf1e62a9871b1b87f91e02472`                          | Apache-2.0, `LICENSE.txt`/`NOTICE.txt`; `VersionType.java`, `InternalEngine.java`, `QueryTimingType.java`, `Timer.java` at the linked server paths. |
| `search-rating-populations/documentation-website` | [OpenSearch documentation](https://github.com/opensearch-project/documentation-website), `9bf360dee6e0930aa0bd66ba91e992b9ee2828bf` | Apache-2.0, `LICENSE`; `_search-plugins/searching-data/point-in-time.md`, `_analyzers/index.md`; read with `git show`.                              |

Clone access dates: 30–31 October 2026. The official product/help pages above are cited evidence under
their publishers' terms; no licence to reuse their implementation or content is inferred. RFCs are
published under the IETF Trust legal provisions; W3C recommendations/patterns carry their stated
document/software notices; Schema.org vocabulary carries its published terms. Those are separate
from clone code licences. The repository uses its existing TypeScript/PostgreSQL/OpenSearch stack.

Concrete ambiguity decisions for owner adoption:

- Preserve public count removal and actual custody fixes; correct the status description rather than
  reopening their implementation. Distinguish current sampled facet execution from its public DTO.
- Keep one evolved public index family and the mixed plan's proposed facade; Account is not a
  Subject or a second engine. Other universal kinds need real owner producers before admission.
- Treat advanced/scoped header controls as existing-route consumers; no gate/action is invented and
  no unsupported scope falls back to global search. Native source absence remains an explicit gap.
- Select retained general facets and measured direct admission elsewhere. No claimed product precedent
  proves the literal budgets; native measurements and finite useful completion remain prerequisites.
- Keep property values/count-free continuation separate from configured kind metadata and its narrow
  initial-count exception. Correct Web cursor/roster transport in the whole consumer slice.
- Bind authored body, public prose and JSON-LD once through existing native owners; no Search body
  mirror. Preserve actual public-reader/Content DTO fixes without claiming composition closure.
- Keep all six whole planning artifacts and current writers. This report neither dispatches a
  duplicate implementation nor promotes proposal names to exports or native outcomes.

## Remaining whole implementation slices and handoffs

These are the remaining complete journeys, organized by the existing six artifacts. Each slice
must adopt cross-owner choices first, implement its real default path and retain the original
acceptance. Existing consumer-mechanics, Source binding and custody work stay with their writers;
the slice integrates their declared output rather than opening a competing writer. Missing named
outcomes are materialized by the later implementation brief, not claimed by this desk report.

### 1. Default native Search, preparation and useful-page recovery

Continue [search-native-runtime-plan](../search-native-runtime-plan.md). Bind actual Source,
consumer operations and custody into `server.ts`, the existing work modules and all three mounted
Subject endpoints; give the actual completion scope the real deadline and summary fill before final
safety. Initialize/populate every admitted generation from complete owner keys, reconcile key content,
activate only complete targets, then repair/freshen/recover on the default runner. Keep existing
OpenSearch targets, generation metadata, relay checkpoints and custody tables as the only copies.

Semantic hands off the native projection/reduction methods; Search's existing mechanics writer
hands off consumer operations; Accounts/Content/Commerce supply their adopted authority/dependencies;
Library supplies verified own preparation. No direct call to a missing factory or test injection
counts as the default path. Freeze first/deep/sparse/final, crash/replay, outage/recovery, old-PIT
reduction and useful-page schedules with actual startup and workers. This slice owns operation-wide
SQL/Access/engine/bytes, source-to-searchable freshness, 4,096-home privacy and finite retained proof.

### 2. Exact copies, late writers and native erasure

Continue [search-index-erasure-plan](../search-index-erasure-plan.md). Join physical generations,
PIT/prepared locators, registrations, execution leases and retained copies to the existing identity
participant and event-free fenced operational transaction. Enumerate, drain, delete and prove
absence of every owned copy, including an old worker resuming after deletion and name reuse.
Keep native owners' erasure/de-identification policy; do not add a coordinator, engine, permanent
soft tombstone or second participant. Ordinary SubjectSource inventory is not all-role copy custody.

The existing custody writer supplies exact durable barriers/locators; Search integrates physical
index deletes and replay; identity/Accounts owners supply existing participant fencing. This slice
owns native lifecycle schedules, terminal existence/late-write proof, per-step rows/bytes and finite
cleanup work. It closes a real retained-copy lifecycle, not just an HTTP omission or expiry assertion.

### 3. Account population through mixed search to the right factual page

Continue [search-mixed-kind-plan](../search-mixed-kind-plan.md), retaining its two whole briefs:
native Account population/projection, then mixed request/current disclosure. Accounts must supply
the complete retained population cut, replay and active/unfenced current guard at native T, including
handle claims and avatar/verification reductions. Search evolves `subjects-gN`, rebuilds the mixed
mapping/template and mounts proposed `POST /v1/search:query` only after complete activation.

Web then connects `/search`, the shared header, mixed summary navigation and configured kind pages;
it binds ID-capable account navigation to existing `GET /v1/accounts?ids=...` when a handle is absent,
without inventing a new Account HTTP read. Keep Subject APIs compatible. Accounts owns native
discovery/erasure; Semantic owns released kind/type meaning; Web
owns destination/interaction; Search owns shared order/cursor/count safety. Proof includes anonymous
and authenticated mixed pages, dominant-source order, unknown-under-NOT, exact/current handle,
suspension/deletion at T, initial kind metadata/count failure, continuation and Account-to-page
navigation. Charge all native SQL/Access/engine/bytes and privacy work to this whole request.

### 4. Complete count-free refinement and retained value continuation

Continue [search-facet-runtime-plan](../search-facet-runtime-plan.md), retaining native catalogue
closure plus continuation runtime. Semantic supplies a complete released per-subject value source,
including overflow values and target/contributor dependencies. Search builds the deduplicated native
retained value population, orders canonical keys and serves the adopted
`POST /v1/subjects:facets` cursor/next wire. Existing durable preparation infrastructure owns finite
frontiers and publication; current authority is rechecked on every ready read.

Web consumes every roster group and value continuation on `/search`, with localized labels and
independent range/unit controls. There are no property counts, count sorting, sampled fallbacks or
unbounded all-property requests. Proof includes a 129th value, mixed datatypes, bases, exact bytes,
late target/source reduction, pending/retry/resume, first/deep/final and unavailable labels. This
slice owns preparation's linear work, stronger owner step caps, ready-page SQL/Access/index/bytes,
retention and exact-copy handoff to erasure. Preserve the already count-free public envelope.

### 5. Search result to selected authored body, Context and continued discussion

Continue [search-page-document-plan](../search-page-document-plan.md), retaining its authored-document
and Context/thread aggregate briefs. Composition adds the adopted property-bound descriptor;
presentation supplies shared selection, exact Content read/public DTO, final guard, Realm selection
and node continuation in `POST /v1/pages:read`. Semantic hands off current selected facts/Context;
Community current Realm/publication; Content body disclosure, erasure and subject-thread readers.

Web connects `/subjects/$id/$slug` and the relevant views to one returned binding for prose and
JSON-LD, honest absence/failure, current Context and discussion/relations continuation. Account-page
composition stays under its native account authority. Proof includes public and protected personas,
selected-language changes, erased/mismatched/oversized body, late hide/ban/publication change,
no fallback leak, same-body metadata and continuation without authority drift. This slice owns
aggregate reads/slots, actual Content body/response bytes, native Access/SQL and private/no-store
behavior; it does not claim Web's In row or use a Search hit as permission.

### 6. One semantic journey across all composed catalogue consumers

Continue [search-composed-closure-plan](../search-composed-closure-plan.md). Use the existing released
fixture/receipt producer and real Auth personas across catalogue search, curated common Members,
Everything, own-state, mounted Zone and configured TypeList. Consume their actual existing native
routes/descriptors and stores; extend TypeList's optional filter only through adopted shared grammar.
Library/Commerce supplies canonical membership and own-state execution; Zones supplies actual
page-list populations; Semantic released semantics; presentation one shared measured execution.

Exercise standalone/aggregate parity, whole-tree OwnerLeaf rejection before private IO, finite
preparation/activation, first/deep/sparse/final and reduction/crash schedules through real owners.
Preserve the existing original tests and existing SQL-cost classifier; materialize only missing
outcomes. This slice captures the combined 16-read/128-slot operation, shared start/final safety,
all owner pools and child workers, exact SQL/Access/engine/bytes, usefulness at growth and no-store.
It closes the complete consumer journey after the native prerequisites exist, rather than adding
another calculator, Source mirror, result fixture, readiness assertion or duplicate writer.
