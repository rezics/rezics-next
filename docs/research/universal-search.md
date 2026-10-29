# One search across REZICS kinds

Research evidence and recommendations, inspected 29 October 2026. This report changes no public contract,
DTO, test, index template or runtime admission. The binding product direction is one request, mixed kinds
by default, kind as a condition, one ranked sequence, one opaque continuation and counts for kind chips.
The physical and ranking recommendations below require adoption and native proof before activation.

## REZICS premises and evidence boundary

Read the owners before choosing a search product:

| Owner document                                                                                                                   | Consequence for universal search                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Scope](../scope.md), [architecture](../architecture.md)                                                                         | A new catalogue vertical is definitions data over the same graph. A universal catalogue also contains communities and personal resources; it is not just a Wikidata clone.                                                                        |
| [Zones](../zones.md)                                                                                                             | A Zone is a routed site over saved scopes and mounts, not a Realm or an independent catalogue. Source permissions survive mounting. Public metadata, configuration and subject membership are different reads.                                    |
| [Filtered lists](../filtered-lists.md)                                                                                           | Complete useful pages, whole-query disclosure, original and terminal eligibility, direct/prepared admission, freshness and numerical ceilings apply to the entire answer. A limit on returned hits is not a bound on examined work.               |
| [Search facets](../search-facets.md)                                                                                             | Existing property/value discovery is count-free, ordered by native value key, with complete continuation. Kind counts need an explicit, narrow exception in this owner document.                                                                  |
| [Owner queries](../library-owner-queries.md), [dynamic Collections](../dynamic-collections.md)                                   | Owner facts remain native PostgreSQL facts. Viewer-self predicates, historic accepting pins, canonical state winners and completed published output retain their meanings. A public Collection never lends its curator's private query authority. |
| [Search README](../../services/kernel/src/search/README.md)                                                                      | Existing subject search supplies text, Boolean/property predicates, public index execution, native disclosure and confidential continuation. It is the first producer, not evidence of heterogeneous federation.                                  |
| [Community README](../../services/kernel/src/community/README.md), [Content README](../../services/kernel/src/content/README.md) | Space, Realm, board, thread and post have distinct identities and native disclosure. Raw discussion projections are candidates. Current opening-post, board, place, Realm and ban checks matter.                                                  |
| [Accounts](../accounts.md), [Access README](../../services/kernel/src/access/README.md#public-identity-read)                     | Public identity projection differs from authentication admission and attribution tombstones. Catalogue people/organisations and accounts are not interchangeable identities.                                                                      |

The following controller inputs were also read in full by their absolute paths under
`/home/edge/projects/rezics/rezics-next/`: `.temp/goal/performance/search-mixed-kind-cost-review.md`,
`.temp/goal/performance/shared-subject-search-cost-review.md`,
`.temp/goal/search/shared-search-conditions-after-universal-research.md`,
`.temp/goal/web/search-mixed-kind-review.md` and
`.temp/goal/commerce/scoped-text-plan-pair-comparison.md`. They are review inputs, not a delivered merge ABI.
This report retains all eight earlier Cost corrections and evaluates the later count/cursor proposals.

“Kind” should identify a configured result category: each configured catalogue type, catalogue Person or
Organisation where defined, account identity, Collection, Realm, Zone and eventually board/thread/post.
Do not replace every catalogue type with one hardcoded “subject” chip. Library is a viewer-owned population,
not a synonym for Collection or a new catalogue type. Space and Realm must not become duplicate search hits
merely because a Realm has a backing Space. The registry must state each producer's canonical result identity.

## Primary-source survey

The table records observable contracts, not guesses about proprietary indexes. A tabbed search, a batched
multi-search, heterogeneous federation and keyword/vector hybrid retrieval are four different mechanisms.
Neither a single search box nor a vendor's “fast” claim proves REZICS's privacy or growth bounds.

| System and primary evidence                                                                                                                                                                                                                                                                                                                                                    | Read finding and transferable lesson                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reddit: [search behaviour](https://support.reddithelp.com/hc/en-us/articles/19695647891988-How-does-Reddit-search-work), [features](https://support.reddithelp.com/hc/en-us/articles/19696541895316-Available-search-features), [comment-search announcement](https://redditinc.com/news/new-on-reddit-comment-search-improved-search-results-relevance-updated-search-design) | Posts, communities, comments and people have distinct result modes; community scope and author/Boolean conditions refine retrieval. The announcement describes expanding retrieval beyond posts. Retain explicit kind and scope affordances, but do not import separate tabs as separate REZICS requests or assume one cross-kind score.                                                                                                           |
| Discourse: [official search guide](https://meta.discourse.org/t/searching-for-content-effectively/273328), pinned `lib/search.rb` below                                                                                                                                                                                                                                        | Categories, tags, users and topic/post content share search syntax. The implementation groups results, uses PostgreSQL text ranking with title/category/tag/body weights and applies Guardian/private-message restrictions in query construction. Useful evidence for native authority and name intent, not a ready-made universal comparator. Its suspended-user search option conflicts with REZICS's identity projection and must not transfer. |
| Discord: [official search guide](https://support.discord.com/hc/en-us/articles/115000468588-How-to-Use-Search-on-Discord)                                                                                                                                                                                                                                                      | Search is contextual to a server or conversation, with author/channel/mention/content/date filters and relevance or time ordering. Scope is a visible condition. This does not establish a public global directory or describe its internal index or permission-safe facet counting.                                                                                                                                                               |
| Steam: [store search](https://store.steampowered.com/search/), [community user search](https://steamcommunity.com/search/users/), [discussions](https://steamcommunity.com/discussions/), [store visibility documentation](https://partner.steamgames.com/doc/marketing/visibility)                                                                                            | Store products, community people and discussions have distinct discovery surfaces. Store visibility guidance discusses language, tags and player behaviour; it is not documentation of a common search rank. REZICS needs an explicit bridge between catalogue and community instead of assuming one from shared branding.                                                                                                                         |
| Bangumi: pinned `web/handler/search.go`, `internal/search/search.go`, `internal/search/{subject,person,character}/client.go`; [API project](https://github.com/bangumi/server)                                                                                                                                                                                                 | Separate subject/person/character handlers dispatch to separate Meilisearch searchers/indexes. Subjects have a shared catalogue producer rather than an index per entertainment type. This is evidence for configuration within a producer and explicit entity boundaries; it does not show community posts fused into one list.                                                                                                                   |
| AniList: [introduction](https://docs.anilist.co/guide/introduction), [media search](https://docs.anilist.co/guide/graphql/queries/media), [Page](https://docs.anilist.co/guide/graphql/pagination), [schema reference](https://docs.anilist.co/reference/object/page)                                                                                                          | The social/catalogue graph includes media, characters, staff, studios and other families. Media type is a filter. One Page may paginate only one data field, and its total/lastPage are documented as inaccurate. GraphQL batching is not a global blended page; continuation evidence is more reliable than an uncertified total.                                                                                                                 |
| MyAnimeList: [official API location](https://myanimelist.net/apiconfig/references/api/v2), pinned Jikan `src/Request/Search/*SearchRequest.php`                                                                                                                                                                                                                                | Official HTML/API documentation was inaccessible to this reader. The established open-source adapter's own source constructs separate anime, manga, character, person, user, news and featured-article requests, including offset-style person/user pagination. This is primary evidence of the adapter, not a claim about MAL's current backend or community fusion. Coverage is deliberately limited to these source-visible boundaries.         |
| Goodreads: [staff search response](https://help.goodreads.com/s/question/0D58V00007PRxYwSAL), [official group directory](https://www.goodreads.com/group/near_me)                                                                                                                                                                                                              | Staff describe book lookup by title and ISBN/ASIN; the product separately exposes group discovery and discussions. Direct search HTML was inaccessible. These sources establish identifier/name intent and catalogue/community coexistence, not a blended rank, complete author search contract or native topology. User replies in the help forum are not treated as official technical claims.                                                   |
| Letterboxd: [search surface](https://letterboxd.com/search/)                                                                                                                                                                                                                                                                                                                   | The published search navigation includes films, reviews, lists, stories, cast/crew/studios, members and tags, plus an All mode and full-text option. A common entry can expose category refinements and different row summaries. The page does not prove a common engine score or private-list indexing policy.                                                                                                                                    |
| BoardGameGeek: [official XML API2](https://boardgamegeek.com/wiki/page/bgg_xml_api2), [API terms](https://boardgamegeek.com/using_the_xml_api)                                                                                                                                                                                                                                 | Name search accepts multiple item types and an exact option; user, guild and forum operations remain separate. Item type is a condition, but the catalogue API does not prove unified forum ranking. Registration/terms apply to reuse; no dataset or implementation is copied here.                                                                                                                                                               |
| Wikidata: [search help](https://www.wikidata.org/wiki/Help:Searching)                                                                                                                                                                                                                                                                                                          | Statement conditions and namespace selection refine entity search; some expensive property searches are excluded. Entity namespaces are not REZICS's configured catalogue types. Transfer typed condition capability and explicit unsupported cases, not an assumption that personal Libraries and protected conversations are public entity statements.                                                                                           |
| Wikipedia/CirrusSearch: [official help](https://www.mediawiki.org/wiki/Help:CirrusSearch)                                                                                                                                                                                                                                                                                      | Namespace/prefix, title, category, language and file-property conditions share a query language. Redirect handling influences canonical results; file predicates do not automatically select the File namespace. This supports explicit domains and applicability rules. Wikipedia's default main namespace is not REZICS's mixed default.                                                                                                         |
| GitHub: [official search overview](https://docs.github.com/en/search-github/getting-started-with-searching-on-github/about-searching-on-github)                                                                                                                                                                                                                                | Repositories, code, issues, pull requests, discussions and people share an entry and repository/organisation scope, with specialised search modes. Shared navigation is useful; it neither supplies cross-engine score comparability nor authorises a client to merge separately paginated results.                                                                                                                                                |
| Slack: [official search guide](https://slack.com/help/articles/202528808-Search-in-Slack)                                                                                                                                                                                                                                                                                      | Messages, files, people and channels have refinements; channel, author, thread and time modifiers capture work intent. This is evidence for one discoverable condition vocabulary and contextual summaries. It is not a published proof of permission-safe global totals or a deep-pagination algorithm.                                                                                                                                           |
| OpenSearch: [cross-cluster search](https://docs.opensearch.org/latest/search-plugins/cross-cluster-search/), [normalisation processor](https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/), pinned hybrid pagination source below                                                                                                     | Cross-cluster search federates OpenSearch clusters, not arbitrary PostgreSQL readers. Hybrid retrieval combines query scores using normalisation. Its documented pagination depth changes the candidate set and can change normalised order; a fixed window with offsets is not an unbounded keyset solution. Retain server coordination, not this pagination policy.                                                                              |
| Elasticsearch: [cross-cluster search](https://www.elastic.co/docs/explore-analyze/cross-cluster-search), [RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion), [pagination](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results)                                                                      | CCS coordinates remote engine indexes; RRF fuses bounded retriever windows, including keyword/vector retrieval. RRF does not support ordinary sort/scroll. Search-after requires consistent sort/ties, with PIT for an unchanged engine observation. Optional-remote partial success is unsuitable when REZICS promises a complete answer.                                                                                                         |
| Meilisearch: [federation](https://www.meilisearch.com/docs/capabilities/multi_search/getting_started/federated_search), [weights](https://www.meilisearch.com/docs/capabilities/multi_search/how_to/boost_results_across_indexes), [hybrid search](https://www.meilisearch.com/docs/capabilities/hybrid_search/overview)                                                       | Federation returns one list across indexes, supports query weights and cross-query distinct; ordinary multi-search can return separate lists. Hybrid search combines keyword and semantic scores. Federated offset/page totals and remote distinct/count caveats are not REZICS continuation/count guarantees. Multiplying an engine's relevance score by a weight does not calibrate PostgreSQL ranks.                                            |
| Algolia: [multi-index UI](https://www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/multi-index-search/js), [faceting](https://www.algolia.com/doc/guides/managing-results/refine-results/faceting), [NeuralSearch](https://www.algolia.com/products/features/neuralsearch)                                                                                     | Multi-index widgets can share a query while preserving separate lists. Conjunctive/disjunctive facets explain switching a selected dimension; NeuralSearch combines keyword and vector retrieval. Neither establishes a mixed native cursor across REZICS stores. Adopt the deliberately defined kind-dimension transformation, with stricter disclosure and count evidence.                                                                       |
| Vespa: [federation](https://docs.vespa.ai/en/querying/federation.html), [phased ranking](https://docs.vespa.ai/en/ranking/phased-ranking.html), [blending example](https://docs.vespa.ai/en/learn/tutorials/news-6-recommendation-with-searchers.html)                                                                                                                         | Search chains can federate internal/external sources, merge and fill summaries, with explicit deduplication. Global-phase ranking normalises or fuses a bounded reranked set. Transfer the producer/coordinator separation; cross-hit normalisation still depends on its set and is not a native per-hit continuation key.                                                                                                                         |

Shared patterns: identity lookup differs from discovery; kind and scope are independent dimensions; catalogue,
people and conversations need different summaries; a common entry often hides separate physical producers.
The products disagree about tabs, default domains, exact totals and ranking. REZICS's one mixed page resolves
the first two; its disclosure and growth contracts resolve the latter two. No surveyed product supplies all
of REZICS's private-owner, arbitrary configured-type and whole-query privacy requirements together.

### Inspected source revisions, paths and licences

Reference root: `/home/edge/projects/rezics/rezics-next/.reference/`. Reused clones stay in their existing
directories; the inventory records this topic. Clones were read only, never installed, built or executed.

| Local directory; revision                                                                     | Inspected source and upstream URL                                                                                                                                                                                                                                                                                                                               | Licence                                        |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `partitioned-sitemap-feeds/discourse`; `589325e2b8466178ee83acac9ec411de555a0093`             | [`lib/search.rb`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/lib/search.rb): `execute`, `posts_query`, `sort_by_relevance`, `weights`, user/category/group searches and Guardian checks                                                                                                                               | GPL-2.0-or-later, `LICENSE.txt`                |
| `shelves/bangumi-server`; `1997713eafc51487cbea705b37011442f35539fa`                          | [`internal/search/search.go`](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/internal/search/search.go), `web/handler/search.go`, `internal/search/subject/client.go`, person/character counterparts                                                                                                                           | AGPL-3.0-only in source headers; `LICENSE.txt` |
| `universal-search/jikan`; `0f0f841ee30cc2145ee0fd4ae2704d0bf8ca3bd1`                          | [`src/Request/Search/PersonSearchRequest.php`](https://github.com/jikan-me/jikan/blob/0f0f841ee30cc2145ee0fd4ae2704d0bf8ca3bd1/src/Request/Search/PersonSearchRequest.php), `UserSearchRequest.php`, `AnimeSearchRequest.php`, `MangaSearchRequest.php`, `CharacterSearchRequest.php`, `NewsSearchRequest.php`, `ArticleSearchRequest.php`                      | MIT, `LICENSE`                                 |
| `search-rating-populations/opensearch`; `4ee42a94e87f66fbf1e62a9871b1b87f91e02472` (3.9.0)    | [`server/src/main/java/org/opensearch/search/query/TopDocsCollectorContext.java`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/query/TopDocsCollectorContext.java), `search/profile/query/QueryTimingType.java`, `search/profile/Timer.java`, read with `git show` | Apache-2.0, `LICENSE.txt`, `NOTICE.txt`        |
| `search-rating-populations/documentation-website`; `9bf360dee6e0930aa0bd66ba91e992b9ee2828bf` | [`_vector-search/ai-search/hybrid-search/pagination.md`](https://github.com/opensearch-project/documentation-website/blob/9bf360dee6e0930aa0bd66ba91e992b9ee2828bf/_vector-search/ai-search/hybrid-search/pagination.md), `_search-plugins/search-pipelines/normalization-processor.md`                                                                         | Apache-2.0, `LICENSE`                          |

Official web pages above are cited as documentation under their publishers' terms, not offered as
source-licensed implementation material. MediaWiki/Wikidata pages identify their content licensing on-site;
software licences in this table do not license those other publishers' pages. Recommendations are designs to
implement in REZICS's TypeScript/PostgreSQL/OpenSearch stack, not files or long passages to port.

## Index topology: a shared public projection with native private producers

| Choice                             | Adding configured kinds                                                                              | Cost and disclosure consequence                                                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One public index, kind field       | Add definition/field mapping and projection data, normally no new query                              | Shared analyser and score context simplify ordering; heterogeneous optional fields need bounded schema. It cannot contain owner facts, private Collections, protected associations or withheld text, even as hidden filter fields.                    |
| One index per kind                 | Adds query/shard fanout, lifecycle and score calibration per kind                                    | Runtime grows with configuration. Independently scored corpora are not automatically comparable. A default-all request can exceed read/round/cursor budgets long before the grammar limit. Reject as the normal vertical model.                       |
| Federation per authoritative store | A configured kind reuses its store producer; a genuinely new store needs admission                   | Preserves native private authority but requires comparable keysets, whole-page accounting and complete source participation. Engine CCS alone cannot federate these stores.                                                                           |
| Hybrid, recommended                | Many configured kinds share a bounded public producer; native sources represent authority boundaries | Public catalogue facts remain in OpenSearch; owner facts and protected content stay native. Public community/identity/resource projections can join the public producer only after their owner supplies current disclosure, repair and erasure proof. |

Keep the public index a derived search projection, not an authority. Use common identity/kind, complete searchable
public text, safe display data, version/provenance and native sort fields; keep released catalogue statements
and kind-specific public fields in bounded capabilities. Do not dynamically add one physical index, field family
or server endpoint per Book/Recipe/other configured type. Physical separation for operational reasons is possible,
but it must still meet the same bounded producer/comparator contract, including shard work.

Collection metadata can be a result while Collection membership is a condition on other results. Public
Collection output is a completed published population; evaluating its hidden definition is forbidden. Private
metadata/membership stay native even when the same subject is public. A public Realm's description can be a
result independently of the subjects discussed there. Only public, listable thread/subject associations may
enter the public projection. Granted protected boards remain native; a public Realm does not make every board
public. Threads and posts need Content's own index/projection and current read rules, not Semantic statements.

The long-term target is a small fixed number of physical producers, not a small fixed number of kinds. It does
not follow that all future native stores can already join a direct request. Coalesce only through a real indexed
producer or an authorised complete prepared result. Do not relabel sixteen Collection output reads as one source
because they use one database, or call a loop over partitions one batch. Unsupported physical composition remains
a capability gap with the finite preparation work below, never a successful answer omitting a kind.

## One condition model, with explicit applicability

Use the existing Boolean condition tree and admission machinery. Kind is another dimension; public tags and
released properties retain typed operators, units, qualifiers and unknown semantics. Library/Collection/Realm/
Zone/Agent scopes are resource conditions, not routes or parallel filter protocols. This report chooses no new
wire spelling. The current catalogue `{type:{in:[...]}}` must map coherently to configured result kinds without
silently changing existing type meaning; the pure shared grammar owner must specify that mapping before freeze.

| Condition    | Catalogue subjects, including catalogue people/organisations                                                  | Other result kinds                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind         | Released/configured catalogue category; multiple choices OR within this dimension                             | Registry-backed Collection/Realm/Zone/account/thread/post category, not a fixed client enum                                                                                            |
| Text         | Complete public labels, aliases **and descriptions**; same parser/analyser/phrase/Boolean rules               | Owner-approved public names/body fields and the same text semantics; private text only in an authorised native evaluator                                                               |
| Property/tag | Released type/property capability, including range/quantity/unit and same-statement qualifiers                | Only an explicitly declared equivalent capability; no invented genre/state field on a person, Realm or post                                                                            |
| Library      | Current viewer-self owner population/predicates; Everything is the defined union, not all curated occurrences | Does not implicitly select accounts, Realms or posts. A future saved-resource capability must be explicitly defined.                                                                   |
| Collection   | Own manual membership or expanded dynamic predicate; another reader's completed published output              | Metadata result is not automatically a member of its own subject Collection. Non-subject membership needs an adopted capability.                                                       |
| Realm        | Subjects discussed by currently readable linked discussion **and review** threads on that Realm's boards      | Realm result identity and thread/post containment are different relations. Content must approve future per-kind semantics before admission; do not inherit the subject-selection rule. |
| Zone         | Union of readable configured subject-list predicates and mounts, resolved at current head/release             | Not every Realm, account or Collection mentioned by the site. Zone/Collection metadata scopes need their explicit owner relation.                                                      |
| Agent        | Literal OR of actual released credit-role statements referring to the catalogue Agent                         | Distinct from an account operated by an organisation, an author-of-post condition, or selecting the Agent identity itself                                                              |

Separate three cases. An invalid/unsupported condition is an admission error, never ignored. A recognised
predicate whose declared domain excludes a kind evaluates to not-applicable/unknown, including under NOT;
only proven true contributes a hit. A supported predicate with complete evidence can be false: for example
`NOT owner.state X` may include a subject with no entry in the admitted population. Missing/withheld evidence is
unknown, not evidence of absence. Inapplicability must not make `NOT book.wordCount > 1000000` select every Realm.
An OR can still prove true through another applicable branch, but cannot bypass resource authorisation.

Resolve and authorise **every** resource leaf, even under true OR or NOT, before execution. Concealed resources
retain their native concealment outcome. Authorise the Realm and current ban for every Realm leaf; this does
not grant thread access. Request-only Collection/Realm/Zone references remain disallowed in saved/dynamic
definitions where the owners forbid recursion. Expand first, deduplicate exactly, then apply the existing
32-leaf/depth-4/OR-16/in-64/qualifier-4 ceilings. Agent credit expansion currently contributes twelve real leaves.

Preserve raw text admission: 512 UTF-8 bytes, depth four, 64 text leaves, phrases at most 32 counted tokens,
implicit AND, `|`, unary `-`, quotes and existing escapes. Empty/whitespace-only text is typed 422 at `/text`;
omitted text is different. Do not transport-trim/casefold/NFC. `cjk_bigram_v2` performs its existing ICU NFKC_CF,
standard tokenisation, Traditional/Simplified and Hiragana/Katakana folding, CJK bigrams and stopwords inside
analysis. Multivalue phrase boundaries, aliases and description-only matches must survive native owner execution.

## Ranking: comparable native keys before heterogeneous admission

Default remains relevance with text, name without text. Current subject relevance is `_score DESC, id ASC`;
name, public-Collection-count and rating orders retain their existing meaning and ties. The template boosts
exact names by 10 and name phrases by 3 over complete `search_text`; do not substitute title-only matching or
a private-corpus rank. Source: [query.ts](../../services/kernel/src/search/query.ts),
[template](../../services/kernel/db/search/templates/subjects-search-v2.json),
[Search owner](../../services/kernel/src/search/README.md#search-planning-and-engine-page).

The admission requirement is a versioned **per-hit** total-order key, computed from the hit/query and an
identified ranking context, which **every participating source can sort and seek natively**. Include kind and
canonical identity as deterministic global ties. Within today's subject-only producer preserve existing order.
The same logical hit must have the same key through every plan; deduplicate by kind plus canonical identity,
not title, handle or supporting occurrence. Native identity resolution still checks original and survivor.

Raw BM25 from separate indexes and PostgreSQL `ts_rank`/`ts_rank_cd` are not comparable. A fixed, query-independent
monotone score calibration is preferable to set normalisation, but only if it preserves the adopted relevance
meaning and is native-sortable/seekable in each source. It is not delivered by writing down a formula. Owner
evaluation needs complete public text positions/provenance and the **same public ranking context/statistics**,
not statistics of a private Library. A complete authorised retained evaluation can materialise the adopted
key/order when direct equivalence is too expensive. Arbitrary private membership must never be copied into
the public engine to obtain a score. The native text/rank source and conformance suite are missing.

RRF, page min/max, L2 or z-score normalisation and global-phase cross-hit fusion are useful precedents for
relevance experiments, but are not the direct merge comparator. RRF depends on source ranks; normalisation
depends on the retrieved population. Expanding the window changes keys; continuing needs offsets, recomputation
or a retained complete ordering. A fixed rerank window only proves a finite window, not complete arbitrary
continuation. None is admitted without a bounded alternative inside current native/cursor costs. A hash of
the old candidate set is not that alternative. OpenSearch hybrid pagination and Elasticsearch RRF explicitly
expose this distinction; see the survey.

For intent, exact public name/handle/identifier matches should receive the existing exact-name treatment across
applicable kinds: an exact person or Realm can precede weak incidental mentions without a hidden kind filter.
Do not classify a query as “person” and suppress books or posts. No per-kind minimum quota, round-robin or
section concatenation belongs in the one ranked sequence: a genuinely dominant kind may fill the page. Kind
chips let the reader narrow it. Sections can be presentation of the same sequence, not separately paginated
inventories. Popularity/recency for community content are later versioned per-hit public rank features or
explicit sorts, with calibrated saturation and stable ties; private membership, private activity and moderation
state cannot contribute. Do not invent weights or change today's default as a side effect of research.

A mixed first page therefore contains the best authorised matches in total-order sequence, with kind labels,
compact kind-specific context and a generic row fallback. For “Ursula Le Guin”, a matching person, books,
public Collections and a readable discussion can coexist; this is an illustrative outcome, not a fabricated
ranking fixture or a promised quota. No kinds need appear if they have no eligible competitive hits.

## Disclosure applies to membership, exclusion, order and metadata

Apply [Filtered lists](../filtered-lists.md#disclosure) to the full query: sources, targets, private scopes,
positive and negative predicates, excluded rows, ranking inputs, counts, suggestions, labels/images/URL inputs
and continuation. A final check of displayed IDs cannot repair a stale NOT result, a leaked count or an ordering
influenced by a withheld fact. An old PIT plus a live repair ACK is not a current disclosure certificate.

Protected Realm/board associations and private Collections remain native. Collection output for another reader
is the complete currently disclosed published result, never fresh curator predicates. An owner's editor authority
cannot widen public output. Content must use its current thread/opening-post/board/place/reference disclosure,
Realm read and ban; drafts, takedowns and erased search content cannot contribute. An erased attribution slot
or reply placeholder is not permission to search the erased text or title. Unlisted versus public discovery must
follow each resource owner, not an assumption that direct URL readability implies global enumeration.

For account identity hits/counts use [Accounts' public projection](../accounts.md#public-identity): pending never
public; fenced from T, deleted and erased identities hidden as search hits; personal data minimised. Suspended
identities retain ACTIVE public attribution, with no suspension disclosure in fields, counts or omissions.
Do not hide them as a search policy. Tombstones retained by ID for attribution are not search identities.
Catalogue people/organisations are Semantic subjects; verified account association is an explicit relation,
not identity equivalence. Preserve automation/operator marking where public and applicable.

This is independent of acting-request admission: an invalidated pre-suspension bearer returns native 401
`invalid_credentials` with Bearer `invalid_token`, never anonymous fallback. Auth's suspended sign-in 403 without
a token and defensive verified-actor denial are different paths. Native owner execution needs the actual verified
request, gates, consent, source eligibility, original/terminal fences and deadline; a viewer string is insufficient.

Source reductions must enter Semantic's authoritative transaction log/cut, covering full keys and subject-wide
effects across all 4,096 homes, including dependencies of excluded and not-yet-examined rows. Search ACKs only
after refresh-visible repair of **all local and foreign dependencies** on the exact physical observation.
Record the start observation and validate after **all** query/count/hydration work, detecting a reduction that
arrives and is ACKed during the request. Realm protection, unlink/move/removal, ban, takedown/lift and erasure
share this mechanism. It adds no per-Realm/board/thread safety probe or head vector. Native membership and
current resource authorisation still occur within the fixed/per-candidate budgets.

Ordinary public projection lag remains 60 seconds healthy, with readiness required beyond five minutes;
privacy reductions are immediate and owner writes affect the next read. Order-changing identity publication
may restart continuation; pending identity work requires actual preparation/currentness. Do not make every
ordinary owner write a global cursor restart.

## Continuation and complete top-page selection

Prefer one global last-**consumed** frontier F. Request every native stream strictly after F under the same
total order. Before emitting/consuming the global next candidate, every source must supply its next head or
prove exhaustion; an unresolved source prevents a complete answer. A heap selects the next key. Native streams
must deduplicate canonical hits and retain current supporting disclosure; cross-plan duplicates are charged.

Proof: when F advances, every source's unconsumed head is later than F. Thus every unconsumed hit is later than
F. Seeking every source after F loses no undisclosed hit. Prefetching does not consume: discard unused buffers
at the request boundary and re-seek F, never advance to each buffer's final fetched key. Consume rejected
lookahead in each stream as it reaches the **global** head, including after filling the page, stopping before
the next eligible unreturned head. This preserves the current service's rejected-lookahead rule without skipping
another stream's earlier eligible hit. A local reject beyond that head remains unconsumed; it cannot advance F.
No empty successful continuation or fabricated final exhaustion substitutes for unresolved work.

For an unchanged identified observation, deterministic keys give no duplicates/skips. Live keysets alone do
not promise a cross-database snapshot under arbitrary edits: current eligibility is rechecked, and insertion or
reranking behind F follows the adopted observation policy. Exact relevance statistics must belong to that
identified context; a moving score population cannot silently pretend to be stable. Physical index generation,
comparator meaning, published identity meaning or producer-set changes can require restart. Ordinary row writes
do not change the registry generation. Resources/head/release are re-resolved each continuation inside the fixed
budget; cached resolution or a cursor is not reusable authority.

### Cursor capacity proof, including the maximal admitted source set

Use the existing confidential [Search cursor](../../services/kernel/src/search/cursor.ts) and
[list codec](../../services/kernel/src/tokens/list-cursor.ts): eight after keys, 2,560 UTF-8 bytes/key,
3,072 aggregate after bytes, 3,584 plaintext bytes and 4,864 token characters. The request hash binds full raw
text/conditions, viewer, language, sort, release and static meaning; authenticate it before dynamic checks.
Keep constant decode attempts (today two compatibility bindings), not one attempt per source/kind. Length is
checked before decryption, with zero I/O; expiry remains fifteen minutes. Replay costs one ordinary page.

A feasible **internal encoding budget**, not a new DTO, is six frontier/context components plus at most two
bounded native observation locators at the proposed Smax=2: existing normalised name key (at most 512 UTF-16
units, otherwise existing missing-key treatment), numeric score, phase/version, fixed 64-ASCII kind tie key,
canonical UUID and a 64-ASCII context commitment; each optional observation locator is at most 64 bytes of
unescaped base64url or lowercase hexadecimal text. Phase/version has a fixed printable numeric encoding.
Kind ties can use a registry-validated fixed digest, not a client-controlled long kind label. Every source must
index the same tie value. Searchable text and display labels are not truncated to fit the name key.

Including the codec's type prefixes, the first six keys occupy at most
`1537 + 26 + 17 + 65 + 37 + 65 = 1747` UTF-8 bytes; two locators add 130: **1877 < 3072**, each key <2560.
JSON's worst case for 512 control characters is 3072 escaped bytes, so a conservative six-key plaintext bound
is 3400 bytes including separators, epoch/time and envelope fields. Two quoted prefixed locators add at most
136: **3536 < 3584**. With the existing 34-byte crypto envelope, base64url needs at most
`ceil(4*(3536+34)/3) = 4760 < 4864` characters. Eight keys suffice at Smax; no per-kind/source frontier vector.
The future native test must check actual encoded maximum values, control characters, non-BMP text and score
forms, rather than substituting this algebra for codec evidence.

Today's rating cursor already uses eight keys, including question, population and prior epoch. The proposed
compact context must bind all those guards and recover their authoritative scalar values within the existing
fixed native metadata budget; hashing them does not recover them. Preserve scored/unscored phase and tie rules.
Until that native context producer and maximum-size test exist, this is capacity design, not permission to
drop rating guards or change the current codec.

An observation commitment is not itself a recoverable PIT or a safety certificate. A producer must supply an
existing bounded, authoritatively recoverable observation, or native stable-key context; arbitrary PIT IDs cannot
be shortened by hashing and called resumable. Any retained public merge observation needs actual principal-class
quota, global cap and expiry authority before its first write, including anonymous reads. Existing public result
generations do not authorise a new per-request observation store. Prefer F and existing native observations;
if the representation/proof cannot fit, prepare under real authority, not an unbounded cursor or free cache.

## Kind facets and result shape

Recommend Web's **disjunctive kind dimension** precisely: remove only the designated kind leaf that is a direct
child of the top-level AND; keep every other text/scope/tag/property/language predicate. Multikind selection is
OR inside that dimension. Kind leaves nested under OR/NOT remain untouched; do not distribute or arbitrarily
strip the AST. Without a designated removable leaf the count query is the unchanged query. This transformation
is a separate enumeration and may admit a larger source set than the hit query; account and authorise it too.

Metadata comes from the configured registry in configured order, never count order. Recommend a fixed metadata
page of **K_page=8** kinds as a conservative new output cap, not eight queries or an existing eight-kind roster.
More configured kinds use bounded metadata continuation; they still participate in the hit search. This choice
does not reinterpret the existing eight-property facet request limit. Counts are attempted **once on the initial
query**, for that bounded metadata page, never recomputed on hit continuations; changing conditions starts a
new query. Later metadata pages can expose metadata with unavailable counts rather than replaying hit queries.

For every shown count, `{value, exact:true}` means certified complete canonical membership; `{value, exact:false}`
means a certified lower bound displayed as `N+`. Unknown/unavailable is absent or explicitly unavailable, never
zero. Recommend omitting a zero lower-bound badge; zero with `exact:true` requires proven authorised absence.
Count actual matching logical hits, not supporting occurrences, raw candidates, page length or an estimated
bucket. Current [subject Collections read](../../services/kernel/src/library/collection-reads.ts) uses maintained
`listingCounts` and returns **exact:true only**; it supplies no delivered approximate/lower-bound producer.

| Admissible evidence              | Bound and exactness                                                                                                                                                                                                                                                                     | Consequence at ten million matches                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maintained fixed-key counter     | At most K_page indexed keys, updated atomically with membership **and privacy reductions** in the authoritative transaction; only for the exact population/condition the key represents                                                                                                 | Exact without enumerating matches. An unconditioned kind counter or one Collection counter does not answer arbitrary text/property conditions. No per-request counter creation.                                   |
| Capped fully checked enumeration | Proposed initial cap **C=2 raw candidates total**, shared across all K_page kinds and counted as page candidates, including rejects/duplicates/lookahead. Exact only with native certified exhaustion of the entire requested population; otherwise positive witnesses are lower bounds | Constant checked work, often unavailable for rare kinds. A dominant-kind prefix does not establish zero for unseen kinds. C is deliberately below the 64-scale floor, with native iterator growth still required. |
| No admissible evidence           | Unavailable                                                                                                                                                                                                                                                                             | No all-match direct aggregation, guessed zero, private total or repeated count jobs                                                                                                                               |

C=2 is a conservative seed implementation recommendation, not a claim that two witnesses make useful exact
counts or that the count producer exists. It reserves **existing** candidate/round/engine/SQL capacity as shown
below. If hits need that capacity, omit counts as unavailable; never compromise the complete hit page. Better
coverage can come from fixed maintained evidence or an already-authorised complete prepared observation.
Increasing C later needs actual native capture/review, not multiplication by K_page or by source.

Do not treat engine `terminate_after=C` as an examined-work bound. The [OpenSearch Search API](https://docs.opensearch.org/latest/api-reference/search/)
defines collected-hit limits per shard; sparse matches can require many iterator steps before collection, shard
fanout multiplies work, and aggregation/termination completeness must be checked. A proposed engine shortcut
must cap and charge shard collection, raw checked candidates and iterator work together, reject partial/shard
failures and prove exhaustion; otherwise it remains unavailable. A `terms` aggregate over ten million matching
documents is not a direct count producer.

Count privacy covers the **whole disjunctive population**, including excluded/ineligible originals, not just
the hit page. A checked witness must prove the complete current query, including negative leaves and original/
terminal support. A query-level clean observation must cover all dependencies of every counted/excluded row;
positive-hit checks cannot establish that. Fixed counters need atomic privacy reductions before disclosure.
Counts never use raw account lifecycle/private profile state or protected association populations. The native
served-share proof under growing reductions is required for this larger population, not inferred from hits.

Every hit should carry a common base sufficient to render/link it without an extra read: canonical identity,
registry kind identity and localised label, title with its actual BCP-47 language tag, optional image plus aspect
class, and currently disclosed canonical URL inputs such as slug/handle. A kind-specific summary extends that
base: catalogue type/description, Collection description, Realm/Zone context, or thread/post excerpt and readable
containing context. Configure kind label/icon metadata. Unknown newly configured kinds render a generic row.
No hidden configuration, erased text, private count or inaccessible parent title may supply those fields.
This is a response design recommendation, not a changed current response schema.

## Cost

These are proposed adoption sections in the development workflow's **Touches / Bound / Growth check** form.
They extend, rather than replace, the earlier four sections. All units include rejected, duplicate, discarded,
lookahead and repeated work, source resolution, Access, guards, hydration, cursor and count work.

### Condition admission and resource resolution

- Touches: full condition/text trees; pinned Agent credit roster; resource identities, heads, release and current
  authorisation; owner predicate or published Collection output; compiled Zone page predicates/readability;
  Realm visibility and current ban, including negative leaves.
- Bound: parsing linear in bounded request bytes. Full expansion respects 32 leaves, depth 4, OR 16, in 64 and
  qualifiers 4 after exact deduplication. Resolution shares **16 fixed points / 64 fixed examined rows** and the
  page statement ceiling with all other fixed work, not one allowance per leaf. Overflow is 422 before candidate
  enumeration. Zone serves head plus at most sixteen compiled rows keyed by head/release, maintained on config
  change; never 256 raw descriptors per query. Maximal supported Zone must fit these terms.
- Growth check: 64/512/4096 catalogue, Collection, mount, board/thread and owner-history populations with fixed
  request; constant rows/points/statements, logarithmic blocks. Expanded 32 accepted, 33 rejected before reads;
  maximal compiled Zone and current authority re-resolution on continuation.

### Mixed subject read

- Touches: actual positive-anchor index, remaining predicates and complete text; Collection membership; expanded
  Zone; Content Realm candidate disclosure; original/terminal eligibility, current source/viewer Access and summaries.
- Bound: direct `c <= min(600,6n+3)`, at most three rounds and `2*remaining+1` requested candidates per round;
  six engine searches including counts, at most two/round; three owner keyset seeks, at most one/round.
  Points `16+8c`, examined SQL rows `64+16c`, blocks at most six per budgeted row, response `16KiB+4KiB*c`,
  request `64KiB+1KiB*c`. One-read page at most twelve SQL statements/backend and one caller-owned connection
  per backend. Composed pages retain `R_reads<=16`, sum requested slots `<=128`, SQL `<=8+4R_reads`, one
  connection/backend; maximum existing composed ceilings remain 816 candidates, 6784 points, 14080 rows and
  96 searches. Another reader's **each distinct** published Collection output is a ready-result read, at most
  `2s+2` candidates/two index reads; own dynamic predicates expand normally. No source/leaf/kind allowance.
  Realm uses one **multi-home** batch/backend/round on the caller's connection, total `<=2*remaining+1<=201`
  subjects, both discussion/review kinds, within native 256/call. At most four thread checks per subject fit
  **inside eight points**. Unknown stays unknown under NOT. Native Agent OR is one indexed EXISTS/candidate
  over the pinned twelve-role roster, not twelve probes or a statement-list scan.
- Growth check: 64/512/4096 credit/noncredit histories, manual/dynamic/published memberships, compiled lists,
  Realm boards/threads/homes and protected boards. Both large-owner/sparse-text and many-text/small-owner axes
  must pass with descriptions/aliases/phrases/default rank intact. Full mixed Library/tag/over-one-million-words/
  text queries, unknown OR/NOT and sparse full/final pages must make useful progress. Realm-only subject scope
  needs public prepared listed projection or an actually authorised native plan; the known-candidate batch is
  not a Realm-to-subject anchor. The four-thread cap needs bounded advancing completeness when a fifth is eligible.

### Realm projection and drain

- Touches: public listed subject/Realm/thread associations; link/unlink, revise, move, protection, takedown/lift,
  erase, board removal and Realm visibility/ban changes; subject-home version and authoritative reduction log.
- Bound: thread changes follow bounded linked subjects; board/Realm fanout is paged retained-frontier work,
  linear total in affected threads, never synchronous request fanout. Same 4096-home privacy mechanism, once
  per page, **two SQL statements and `64+2*(behind homes+changed homes)` rows**. No head-vector scan, per-Realm/
  board/thread safety probe or extra allowance. Separately budget native membership and current authorisation.
  Projection/dependency rows enter erasure inventory and bounded reclaim.
- Growth check: 64/512/4096 boards/threads/subjects/Realms; step/total bounds, crash/replay and ordering. During
  drains, reductions affecting NOT, excluded/order and zero-hit populations remain concealed, including a change
  ACKed before final validation. Actual refresh-visible local/foreign repair and served share must be measured.

### Preparation and maintenance

- Touches: authorised prepared public/owner outputs, complete text positions/provenance/rank input, one owner
  structural directory, compiled Zone predicates, source dependency indexes, activation/catch-up, erase/reclaim.
- Bound: retain the existing per-step ceilings: 1000 input keys/candidates, 1000 result writes, one frontier write,
  eight points/input, `64+16*input` SQL rows, sixteen SQL statements/backend, four searches, one connection/backend,
  four MiB response. Stronger native Library 100-row steps still apply. Total linear in finite relevant input,
  replay at most one step. Subject edits reach copied holder text in bounded pages, not synchronous fanout;
  source changes use indexed affected definitions. Include heap/TOAST, every index, positions, MVCC/WAL,
  abandoned generations and cleanup in storage growth, not just UUID payloads.
  Owner retained evaluation is authorised **only** for exactly one viewer-owned Collection OR one positive
  viewer-self presence, not both/multiple/negative/foreign/anonymous cases. Use actual verifiedActor, native
  collection:read/source eligibility, real resource home, same Everything derived ID/preparation basis, deadline,
  fences and quota as Members GET, at most two Accounts participants. No Actor reconstructed from viewer text.
  At most 32 live owner outputs, 24-hour idle expiry; public preparation has one current/one building generation
  per admitted definition. These are ceilings, not permission for a per-public-request merge store or private
  Content preparation. Unauthorised shapes write zero preparation rows/workflows.
- Growth check: 64/512/4096 relevant inputs/holders/dependencies; linear total and bounded steps with interruption,
  replay, source withdrawal, original/terminal eligibility and coherent final activation. Unchanged finite input
  settles useful full/final pages under disjoint traffic. If direct sort fails, build the actual authorised
  complete ordered evaluation, with custody/erasure and progress proof. A 422 while that producer is missing is
  honest temporary admission, not completion of the requested ordinary search capability.

### Mixed-kind ranked page and kind counts

- Touches: admitted physical source inventory (including Collection OR outputs), native comparable ordered streams,
  global merge, whole-query privacy cut, current eligibility, summaries, opaque frontier, bounded kind metadata
  and initial disjunctive count enumeration/evidence.
- Bound: recommend **one admitted merged read with s=n**, one shared candidate/round/engine/SQL envelope, not S
  separately budgeted reads. Native stream fetches are internal candidate operations, not independent readPage
  requests. **Smax=2 distinct physical hit reads for every n=1..100**, counting request-induced reads, plus at
  most one distinct physical count enumeration when capacity remains: total physical reads at most three, below
  sixteen. Count-query planning includes its potentially broader source set; the seed count plan supports one
  physical enumeration only, otherwise counts are unavailable. The merged read requests n output slots once,
  so its contribution to sum requested slots is n<=100<=128. An existing independently invoked Collection or
  common-page read cannot be hidden inside this accounting: it also consumes its actual composed read/slots;
  until a native single-envelope producer exists, apply the stricter composed accounting and reject/prepare
  shapes that do not fit. No existing allowance is enlarged by this proposed planner boundary.
  Before accepting S=2, the native planner must prove all fixed, candidate, byte and SQL work fits **twelve**
  statements/backend, including the two privacy statements. If invoked within a common page it must also fit
  `8+4R_reads`, sixteen distinct reads and 128 slots. S is physical reads, never just registered store count:
  sixteen distinct Collection OR outputs are sixteen reads even on one backend. They do not fit Smax. Actually
  coalesce through an indexed native plan or authorised complete preparation; do not merge their budgets away.
- Growth check: Search writes the merged-page native capture using the shared Performance harness at
  64/512/4096. Exercise S=1 and Smax=2 at n=1,2,20,100, source dominance, equal keys, overlap/rejects, Collection
  OR read multiplication, source unavailability, count disjunction, all sorts and cursor depth. Adding configured
  kinds must not add physical queries. Assert every ceiling without slack and successful finite useful output;
  passing heap/output-k assertions alone does not establish engine/SQL bounds.

#### Derivation of k, refill and count reservation

`S*(n+1)` must be counted: fetching n+1 per source under one envelope permits at most five sources at n=100
from candidates alone, and engine/SQL/round costs can be tighter. If instead every source were a separate
size-n read, `S*n<=128` would permit only one at n=100. Neither authorises sixteen size-100 reads. The proposed
two-source cap deliberately leaves one of the existing three rounds for a competitive refill.

For two sources, request at most **n+1 raw candidates from source A in round one, n+1 from B in round two**,
keeping remaining=n until all stream heads are known. Each request fits `n+1<=2n+1`; n+1<=101<200, the actual
native subject-search maximum. Each source's existing plan must use at most two engine calls or one owner seek
in its round; hydration/guards share the SQL ceiling. No outputs are committed before both heads/EOF are known.
This sequential schedule also respects the one-owner-seek/round ceiling when both sources are native SQL.

With no eligibility rejects and canonical-distinct streams, the global top n+1 are contained in the union of
their first n+1: any later hit has at least n+1 predecessors in its own stream. Therefore the first page fills
and continuation is known even when **all n hits come from one source**. This is stronger than equal small
shares with an unproved refill promise. Duplicates must have identical keys and are charged; native within-stream
canonicalisation is required, not a top-prefix collapse that can hide the real next hit.

After globally consuming the known prefix, let r be unfilled slots. Round three can request a total of at most
`2r+1`, only from competitive exhausted buffers, divided across at most two sources. Each actual request also
respects its native cap (subject search: `min(200,2r+1)`), and the whole round permits at most two engine calls
and **one owner keyset seek**. Two SQL streams cannot both refill in that round. An independently read ready
Collection output still has its own `2s+2` candidate/two-index-read ceiling; this algebra cannot enlarge it.
Require every live head or EOF before further output. Thus hit candidates satisfy
`H <= 2(n+1)+(2r+1) <= 4n+3 <= min(600,6n+3)` for n=1..100 (maximum 403).
Per-source fetched k is at most `n+1+2r+1<=3n+2`; eligible top candidates needed remain at most n+1.
Raw refills/rejects do not receive an additional allowance. Native two-phase rating or other multistep sources
must fit the six-search/two-per-round bound; a third-round split that would exceed it is not admitted.

If no hit refill is needed, round three may instead run **one** disjunctive count enumeration of at most
`min(C,2r+1)` raw candidates with the declared C=2 cap, reserved before final emission. A full hit page has r=0,
so this actually permits **one**, not two, count candidates; a proven exhausted short page may permit two.
Never reset remaining to n to buy count work. Total `H+C<=2n+4` stays within the same candidate ceiling even
at n=1 (six versus nine). At most five engine searches occur if each hit producer
uses two and the count uses one. A count requiring more source reads, an extra owner seek or SQL work beyond
the shared twelve receives unavailable status. If round three is needed for hits, C=0; no count retry on a
continuation. Maintained fixed-key evidence can be read only if the same fixed/statement/byte budget has room.

At n=100, worst hit-refill H=403 yields points<=3240 and SQL rows<=6512; these are tighter **derived maxima**,
not new quotas. Count-only initial pages use H+C<=204. Merge working storage is O(H+C+S), heap CPU
O((H+C) log(max(2,S))) plus the sum of actual source work. These CPU/output bounds do **not** bound postings
iteration, native predicate probes, visibility repair, sort preparation or count enumeration.

If rejected/duplicate/unresolved work exhausts the third round without a full page or proved EOF, use an
actually authorised finite retained evaluation, not a short success. For broader physical composition, first
provide the needed coalesced producer or obtain the owning product's real preparation scope; no public/private
write permission follows from Smax. The present exact one-owner scope can use the existing preparation authority
once its missing bridge/eligibility/evaluator exists. Other shapes remain explicit missing capabilities rather
than an indefinite refusal advertised as completed universal search.

#### Native engine work is a separate obligation

The current immutable `subjects-search-v2` sends `track_total_hits:10000` on hit reads, while
`service.ts` returns subjects/next/as_of and discards `page.total`. At the 64/512/4096 scales that cap can look
match-linear. The smallest future Search producer is a **new versioned hit template and response parser** with
`track_total_hits:false`, preserving v2 unchanged, handling omitted totals and retaining complete-shard checks.
Add a focused native “hit reads do not request/count totals” test plus profile growth captures. Audit the
optional overflow aggregation separately: disabling totals does not remove aggregation work or prove bounds.
The pinned OpenSearch collector source distinguishes disabled hit tracking from counted collectors, but some
score paths still disable pruning; this recommendation does not claim a measured speedup or complete bound.

For **each** relevance, name, id, public-Collection-count and both rating phases, measure first, deep
`search_after` and sparse pages at 64/512/4096; record `next_doc_count+advance_count` over the entire query tree
and every shard, alongside SQL examined/removed rows and blocks. Relevance scoring of the consumed prefix is
a **hypothesis to test**, not a measured failure inferred from theory. Include matching population, corpus
population, unrelated history, duplicates and Smax. Output k and the heap remain constant even when engine
iteration grows, so both measurements are mandatory.

If any sort fails constant/logarithmic direct growth, choose its real authorised finite preparation: complete
public ordered evaluation per admitted public definition, or the exact one-owner directory evaluation above.
Retain complete labels/aliases/descriptions, positions and ranking dependencies; process relevant finite input
in bounded steps, order only after complete evaluation/coherent activation, then seek its ready index. Unseen
inputs may outrank a prefix. Public preparation needs its existing definition authority/cap; protected Content
needs explicit native authority, not a blanket borrowed owner quota. Prove next-read owner changes, immediate
withdrawal fences, bounded repair and useful completion. Neither source theory nor this report authorises
removing relevance, limiting search to titles, weakening a growth assertion or declaring 422 the finished feature.

## Missing producers, proposed coordination and failing native scenarios

All entries are prerequisites for later implementation, **not tests claimed to exist or pass**. Names below are
recommended ownership boundaries, not invented callable signatures or claims of coowner acceptance. Search
must coordinate/freeze the actual typed producers, callers and tests after document review. Every growth case
uses 64/512/4096 with a fixed page neighbourhood, plus the named boundary variations.

| Missing producer / proposed owner                                                                                                                                                           | Native or growth scenario that fails or is unsupported today                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source inventory/admission/refill/comparator; Search with each store owner                                                                                                                  | S=2, n=100, one source dominates; true top n+1, equal-key ties, canonical overlap and rejected third-round lookahead. Add 16 Collection OR outputs and assert physical read/slot accounting before enumeration. Current subject-only service has no heterogeneous streams/comparator or count-aware planner.                                                                                     |
| Constant-size mixed cursor and bounded native observation; Search/Tokens, source owners                                                                                                     | Encode worst eight keys at Smax and <=3072 bytes/4864 chars, constant decode attempts; first/deep pages with an unreturned prefetched hit and rejected lookahead in the other source, source loss and ordinary owner writes. Current cursor has no mixed registry/native-observation representation.                                                                                             |
| Count-free hit producer; Search                                                                                                                                                             | Native new-template requests have total tracking disabled; all sort/phase/search_after growth captures at fixed n. Today's v2 requests 10000 and parser expects totals; overflow aggregate remains a separate measured axis.                                                                                                                                                                     |
| Complete public catalogue text/rank/currentness source; Semantic + Search                                                                                                                   | Description-only, alias-only, multivalue phrases, CJK folding, zero-token/Boolean/negative cases and same default rank/ties through public and owner plans. Increase corpus/matches and depth independently. Existing owner text equivalent/native rank producer is absent.                                                                                                                      |
| Structural owner directory, finite retained text evaluation, activation/repair/custody; Commerce coordinated with Semantic/Search                                                           | Large-owner/sparse-text and many-text/small-owner in both directions; label-only and retained completed history, curated-only manual members, original hidden/survivor visible, state winner/pins, behind-frontier rename/withdraw/reveal, interrupted complete activation and paged holder fanout. Scaffolding or an ID-only order does not supply this evaluator.                              |
| Public kind count evidence; Search with Semantic and resource owners                                                                                                                        | At fixed n and C=2, 64/512/4096 then logical 10M matching population, dominant/rare kinds, disjunctive sources, reduction in excluded rows, duplicate originals, partial shards, exhausted exact zero versus unavailable. Current sampled type aggregation is not this producer.                                                                                                                 |
| Owner/Collection count evidence; Commerce with Search                                                                                                                                       | Same count axes over private/foreign published/manual/dynamic sources, privacy-reduced membership atomic with fixed counter, no owner-fact exposure, composed slots<=128. Existing exact subject-Collections counter is only its own population, not arbitrary query evidence.                                                                                                                   |
| Content count and result producer; Content coordinated with Search/Community                                                                                                                | Public/protected/granted boards; draft, takedown, erased opening text, unlink/move, NOT and a no-hit count population. Grow boards/threads/links and reductions without per-entity safety fanout. Existing thread lists/candidate projections do not supply universal streams or kind counts.                                                                                                    |
| Complete whole-query privacy cut/log and physical repair ACK; Semantic produces authoritative cut/log, Search owns dependent engine repair/ACK, Content/Commerce/Accounts supply reductions | 4096-home exclusions/order/NOT/counts; local and foreign dependency, original/terminal, old PIT after live repair, reduction arrives and ACKs during query. Measure actual served share while reduction rate grows; it must not decline toward permanent preparation (`exp(-lambda*tau)`). Current positive-hit checks/head scaffolding are insufficient.                                        |
| Logical Everything read authorisation and source eligibility; Accounts/Access + Commerce                                                                                                    | Real native logical-owner collection:read at derived Everything ID and actual resource home, routing across >4 homes; label-only/history-only versus curated-only, OR branches outside eligibility, consent/fence changes. Same Members GET preparation locator/quota, at most two account participants. Native OP authorisation/eligibility remains missing; derived ID alone is not admission. |
| Verified request bridge; Search with HTTP/Access/Commerce                                                                                                                                   | Route's actual verifiedActor and deadline reach native private plans without reconstruction from `account:ID`; missing/revoked/suspended credentials, delegation, foreign/anonymous zero writes and exactly one authorised scope. Current search service accepts a principal string only.                                                                                                        |
| Multi-home Realm batch, complete progress and Realm subject anchor; Content with Semantic/Search                                                                                            | 201 distinct candidates across 64/512/4096 homes mapped to real backends, one caller connection/backend and one batch/backend/round; first four thread candidates ineligible, fifth eligible; both review/discussion, ban under NOT. Known-candidate one-home scaffolding is not this batch or a Realm->subjects enumerator.                                                                     |
| Kind registry, resource metadata/identity projections and summaries; Search coordinates Semantic, Accounts, Commerce, Community, Zones and Content; Web consumes                            | Grow configured types to 64/512/4096 without per-kind queries, eight metadata rows with continuation, generic unknown-kind rendering, no extra hydration read; Person subject/account association dedup semantics, pending/fenced/deleted/erased hidden and suspended ACTIVE with identical count treatment. Existing resource point reads do not establish search enumeration.                  |
| **Merged multi-source page Cost check writer: Search**, Performance reviews/enforces harness                                                                                                | One actual mixed page with Smax, count reservation/unavailable fallback, currentness before/after, complete SQL/engine/bytes/candidate/slot capture at all three scales; include composed 16 reads/128 slots in the existing common-page owner's check, not a new universal allowance. No current owner-only/catalogue-only test proves this merged page.                                        |

Existing native Content/Accounts reads can guide implementation, but their per-resource limits or occasional
empty-list continuation do not override universal useful-page rules. Every new directory, copied text/position,
dependency/result/frontier/repair/intent locator enters Library erasure/storage inventory; durable payload copies
enter Accounts shared-history custody/minimisation. Reuse the actual fixed identity participant and full canonical
apply/rekey custody; do not create a third participant, follow-only ACK or false NoData. No financial retention
exception follows for private text. These inventories and native T fences are part of delivery, not metadata polish.

## Recommendation for adoption and smallest first slice

Adopt hybrid authority-based topology, one condition tree, a registry of configured result kinds, native comparable
per-hit order and a global consumed frontier. Reject an index/query per configured vertical, client federation,
set-dependent direct ranking and full-match direct counts. Adopt the precise disjunctive kind transformation,
configured chip order/metadata, truthful exact/lower-bound/unavailable evidence and common generic hit base.
Use the conservative one-envelope Smax=2/C=2/K_page=8 proposal only after its actual native accounting is reviewed;
the report does not assert those producers currently exist. Extra physical composition needs coalescing or actual
authorised preparation, with no larger allowance.

The smallest first slice is today's **subjects:search as the first producer**: existing catalogue text, released
types/properties, analyser, default order/ties and disclosure remain intact. First adopt the shared semantics and
cost obligations; then deliver the versioned count-free hit producer/test and existing-sort growth evidence.
Represent configured subject kinds through data and prove the generic summary/metadata path without claiming
that Realm/account/post streams or false-exactness counts are live. This is a migration slice of the one search,
not a permanent subject-only endpoint product or an invitation to create per-kind routes. Do not alter existing
public DTOs, count-free tests or immutable templates in this report.

Before admitting a later kind, its owner supplies canonical identity/domain and scope applicability, complete
text/summary projection, native sorted seek stream with compatible rank context, current privacy/reduction/ACK,
counts or truthful unavailable status, physical cost/finite preparation, erasure/custody and actual native cases.
Adding a configured catalogue type should require definitions and fixtures, not another source registration.
Adding an authoritative store requires new proof, not just a kind label in the UI.

Adopt decisions through the **same sole documentation change** in `docs/search-conditions.md` and the narrow
kind-count exception/Cost in `docs/search-facets.md`, together with Search README and command-purpose text owned
by that change. Preserve every unrelated count-free property facet/public-total rule. Remove superseded full-kind
count wording rather than leaving two defaults. Review the **actual formatted four outputs, SHA-256 values and
commit**, then obtain the owners' and Performance's review before types, native interfaces or runtime freeze.
This report is evidence; it neither installs an ABI nor records adoption on the owners' behalf.

### Questions the owning documents still need to settle

- Which configured result identities represent Space versus Realm, catalogue Person/Organisation versus verified
  account, and subtype membership? Specify canonical per-kind dedup and the type/kind mapping without changing
  released catalogue type predicates accidentally.
- Which scope relations are meaningful for non-subject results, especially Realm on threads/posts and Zone or
  Collection metadata? No subject-scope rule transfers automatically. Until approved, an undefined capability
  is not-applicable/unknown or unsupported at admission, never silently ignored or broadened under NOT.
- Which actual native ranking-context/observation producer provides equivalent relevance and bounded seek in
  protected Content and owner PostgreSQL? Freeze no comparator that only one store can execute. If direct growth
  fails, specify the actual authorised complete evaluation and activation, not permanent preparing or 422 closure.
- Can the native planner implement the proposed single envelope with all metadata/guards inside twelve SQL
  statements/backend? Existing independent ready-output reads retain composed charges until a real producer
  replaces them. Native captures may require a smaller admitted source set; numbers cannot increase by prose.
- Which fixed populations merit exact maintained kind counters, and which queries can supply checked witnesses?
  Confirm atomic privacy reductions, C/K_page output choices, truthful unavailable UX and once-initial counts.
  Broader private/multiscope/public per-query preparation needs actual authority before writes, not this report.

### Explicit inferences and limits

Hybrid topology, Smax=2, the serial first-two-round schedule, global frontier, optional C=2 checked count cap,
K_page=8 metadata cap, bounded internal cursor encoding and not-applicable/unknown per-kind evaluation are this
report's derived recommendations, not observed product implementations or accepted coowner APIs. Their algebra
proves storage/merge/candidate feasibility under stated assumptions, not native iterator, SQL, disclosure or
availability performance. Native source completeness, ranking equivalence and useful preparation remain tests
to deliver. Proprietary surveyed products reveal UI/query contracts, not internal topology; MAL coverage uses
source-visible Jikan behaviour and Goodreads coverage uses staff/product pages because direct docs were blocked.
No external code, runtime test, benchmark or build was executed for this research.
