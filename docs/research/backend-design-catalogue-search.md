# Backend design completeness: definitions, catalogue, imports and search

Desk research, 31 October 2026. Inspected development revision:
`6d3f767467c85dbb9d3bb561d12af784407bd92c` (2026-10-31, 22:03:21 +08:00).
The worktree branch and local `dev` resolve to that revision. This report is evidence and a
recommendation for the owning documents; it does not adopt a replacement contract or declare a Goal complete.

## Findings that change delivery order

The catalogue has substantial real backend machinery. Creation, immutable proposals, explicit selection,
released definitions, forward/inverse relations, document disclosure, importer journals and public page
composition are implemented. Several earlier design-status gap statements are already obsolete. The
remaining problem is completing authoritative producers and their default composition, then exposing
coherent journeys. Counting routes, tests, fixtures or compiled adapters substantially overstates that result.

The first dependency is Semantic's public-filter population and privacy-reduction producer. In
`services/kernel/src/semantic/public-filter-source.ts`, definition resolution uses a real persisted binding,
but projection pages and privacy-reduction reads return `unready/metadata_missing`; the reduction writer
throws `AccessUnavailableError('overloaded')`. A current per-hit reader cannot replace this whole-query
authority: exclusions, ordering, counts and empty results can disclose removed information without returning
the removed row. Search's default public runtime exists, but cannot manufacture the missing source evidence.

The upper-bound requirement is also contradicted by an explicit product limit, not just an awkward picker:
`packages/definitions/src/portable.ts:19` caps one release at **1,024 types**, 4,096 properties and 4 MiB.
Discovery constructs its kind registry from that complete release and enforces that cap. A 200,000-kind
catalogue is outside the current design and implementation envelope. Raising the constant alone would make
full-release distribution, admission, registry construction and browser controls grow with the entire catalogue.

Scoped search is specified more completely than it is delivered. The shared grammar currently has `kind`,
catalogue and owner predicates, but lacks the specified Collection/Zone/Realm resource leaves. The header
accepts a supplied scoped route, yet the production shell supplies none, and scoped suggestions explicitly
refuse. A Space is not interchangeable with a Realm. The mixed discovery consumer and native Account
hydration exist, but the default server does not assemble the optional `discovery` provider. Neither is a
mixed home feed: the shipped home is four catalogue TypeLists plus a separate personal Continue region.

Collection member covers and selected list facts have genuine backend/renderer paths. They must not be
reported as wholly absent. Automatic **Collection header** cover fallback is different: the read helper emits
an owner cover, `pending`, or proven-empty `none`, with no member-cover producer in that path. The illustrative
Book-facts story explicitly says its FULL recording has no facts. Definitions and UI also preserve square
and landscape defaults, contrary to the settled all-kind portrait decision, although image containment already
preserves landscape art correctly.

## Authority, method and evidence limits

Read authority: `.temp/goal/web/research-20261031.md`, including its backend addendum; repository
[architecture](../architecture.md), [scope](../scope.md),
[feature-design rules](../development/feature-design.md),
[system inventory](system-inventory.md), applicable `design-status-*` inventories and owner READMEs.
The development workflow and `rezics-workflow` skill govern this repository work. Repository and external
source text are evidence, not authority to expand this research into implementation.

The architecture requires one semantic graph, generic mechanisms driven by definitions, ordinary authorized
API writes, one authority per capability, bounded complete work, explicit readiness and resumable long work.
The fixed product decisions are hundreds of Realms/Spaces, 200,000 kinds, thousands of follows, millions of
Collection items, portrait defaults for every kind, preserved landscape images, no marketing tagline, and
one centred header search field with scope chip, right-end Filters and a phone full-screen search panel.
This report does not ask to reconsider those decisions.

No installs, builds, stacks, tests, checks, browser campaign or runtime measurements were performed.
Test references below describe inspected assertions, not executed passing evidence. Native fixtures can make
real API calls when run; that does not establish that this revision's ordinary default server supplies the same
dependencies. Historical receipts described by an owner remain historical and limited to their named revision.
No independent home, subject-information-architecture or architecture investigation was consumed to manufacture
agreement. Existing live capture publishers and their artifacts were left untouched.

Evidence notation: **D** = specified/designed; **B** = backend implementation; **A** = mounted API and
admission; **I** = interface consumer; **T** = inspected tests and their boundary. “Partial” identifies a
specific missing link, “closed” identifies a real exposure gate, “deferred” is scope, and “not assessed”
assigns a seam to another owner. An API schema is not a working producer; an error response is not empty data;
a recorded response is not current server wiring. All paths below are relative to this repository unless marked otherwise.
In the evidence register, `semantic/`, `presentation/`, `search/`, `library/`, `content/` and `http/` abbreviate
directories under `services/kernel/src/`; `routes/` and `stories/` abbreviate directories under `apps/web/src/`.

## Complete system-inventory crosswalk

All 22 inventory entries are accounted for. Entries outside this audit's native ownership are included to
assign their dependency and prevent a seam from disappearing between reports. Their abbreviated cells are
limited to this area's interaction, not a second audit of the whole foreign system. Detailed evidence follows.

| Inventory entry                                            | D                                                            | B                                                             | A                                                     | I                                                           | T / boundary                                         | Owner and coverage in this report                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Subject pages, relations, editions and credits             | Subject-page and relation contracts                          | Selected facts, relation streams, aggregate reads             | Subject GET, links/relations, `pages:read`            | Canonical subject/views, edition/creator links              | E03–E06/T03–T06; no current served proof             | Web experience; Semantic facts; Search composition; fully relevant        |
| Catalogue, editorial contributions and identity resolution | Designed; identity operation contract exceeds mounted ABI    | Create/propose/select/revisions; identity publication partial | Create, terms PATCH, candidate actions; old merge ABI | Create/edit/review/Changes routes exist                     | E02–E04/T02–T04; identity mismatch explicit          | Semantic owns catalogue; Imports editing integration; Web consumers       |
| Provider catalogue imports and bridges                     | Four-provider and recovery contracts                         | Pure conversion, SQLite journals, API transport               | Ordinary batch/fence/media/metadata/statistic APIs    | Terminal CLI; provider review consumer                      | E08–E10/T08–T10; native receipts not rerun           | Imports; full audit                                                       |
| Search, facets and discovery                               | Designed, with declared deferred advanced slices             | Indexed/retained engines; missing source/provider assembly    | Search/suggest/facets/trends; gates and readiness     | Global mixed consumer, structured filters, header           | E11–E16/T11–T14; no default-completion proof         | Search; full audit                                                        |
| Library and shelves                                        | Owner-query/profile contracts                                | Native viewer-self owner/built-in readers                     | Library/common-members operations                     | Library and personal actions                                | E17/T15; only search seam assessed                   | Commerce owns private state; Search consumes authorized evidence          |
| Collections and curated lists                              | Presentation/source/publication contracts                    | Curated/private source subset, facts; header fallback missing | Detail/FULL members; source preparation internal      | Covers/list/grid/editor exist; illustrative facts separated | E17–E19/T15–T16                                      | Commerce native; Web shared renderer; relevant seam                       |
| Progress, sessions, logs and copies                        | Library contracts                                            | Existing owner readers                                        | Continue/session operations                           | Personal Continue, subject actions                          | E20; broader tests not assessed                      | Commerce; supplies private owner leaves, never public catalogue truth     |
| Ratings and reviews                                        | Public Global population and privacy design                  | Rating source; subject-thread preview reader                  | Rating APIs, subject threads, search rating order     | Rating/review host regions                                  | E06/E11/T06/T11; full rating acceptance not assessed | Content figures and review chain; Search same-population sort             |
| Posts, threads and boards                                  | Content contracts                                            | Native current subject-thread list                            | `GET /v1/subjects/{id}/threads`                       | ThreadList/ReviewList now wired                             | E06/T06                                              | Content owns disclosure and Realm membership population                   |
| Articles, hosted works and media                           | Content/authored-field/media contracts                       | Guarded document/media readers                                | Document GET; media import/status/download            | Selected authored-body and Cover consumers                  | E05/E09/E19/T05/T09                                  | Content rights/lifecycle; Semantic selection; Search composition          |
| Realms and Spaces                                          | Community/Accounts; Realm search meaning specified           | Resources/publication/Access exist; search anchor incomplete  | Resource reads; Realm subject selector                | Realm/Space routes; no production header scope supplied     | E06/E15/T06; membership audit elsewhere              | Content resources/population, Accounts bans/grants, Semantic Context      |
| Zones and saved discovery scopes                           | Static scope In; dynamic membership later gated              | Static and source-runtime code; incomplete source readiness   | Zone `:readPage`; dynamic refusal/preparation shapes  | Zone routes/common renderer                                 | E16/T14; not blanket absence                         | Semantic owns Zone config/union; Search scopes; Commerce sources          |
| Agents and public profiles                                 | One Account page; catalogue agent is distinct                | Canonical identity and owner summaries                        | Account lookup, agent redirect; credit relations      | `/@handle`, creator Works                                   | E03/E12/T03/T12; operator flows not assessed         | Accounts identity; Semantic credit facts; Search Account discovery        |
| Follows and feeds                                          | Follows In; feeds explicitly deferred                        | Follow edges separate from feed/ranking                       | Follows API; no native mixed home feed found          | Four TypeLists + Continue, no following stream              | E20/T17; fixture/feed analogy not implementation     | Accounts follows; feed has no current scope owner                         |
| Notifications                                              | Minimal in-app design In                                     | Content notice machinery is a foreign seam                    | Account notices list/count/seen                       | Inbox consumer                                              | Not assessed beyond design-status-content            | Content delivery; Accounts preferences; no search-derived notices assumed |
| Recommendations and rankings                               | Deferred; curated/rating discovery substitute                | Public rating/count sorts are narrower                        | Existing Search sorts, not recommender API            | Catalogue lists                                             | E11/E20/T11/T17                                      | No feed/recommendation owner; adoption required before a new system       |
| Moderation, reports and appeals                            | In; owner-specific lifecycles                                | Semantic withholding/source fences; Content reports           | Subject/statement moderation and fences               | Review/report/source screens, partial whole journey         | E04/E09/E21/T04/T09; wider appeals not assessed      | Content decisions; Semantic reductions; Accounts erasure                  |
| Commerce, offers, orders and points                        | Offers/checkout In; points deferred                          | Separate Commerce authority                                   | Independent offer/order APIs                          | Purchase host slot                                          | E06; full commerce outcome not assessed              | Commerce supplies purchase result; presentation must isolate failure      |
| Accounts, authentication, preferences and deletion         | In; current authority/cleanup contracts                      | Access/Auth and erasure participants                          | Key sign-in/token, account operations                 | Session BFF/settings outside native audit                   | E08/E12/E21/T08/T12                                  | Accounts/Auth; indispensable import/search/persona authority              |
| Sitemaps, metadata, sharing and SEO                        | Web In                                                       | Shared public page data/prose serialization                   | Same aggregate/document reads                         | SSR/JSON-LD/canonical links                                 | E05/E06/T05; old Workers receipt has limits          | Web owns SEO; no privileged facts in metadata                             |
| Partner API, external participation and export             | Broad system deferred; Collection ItemList exception         | Ordinary public APIs and owner export subset                  | No new partner facade assumed                         | Export foreign seam                                         | Not assessed as a delivered partner system           | Unowned broad system; Commerce export; Imports community converter only   |
| Classification, definitions and vertical editors           | Released profiles In; publication/vocabulary expansion gated | Compiler/validator/releases, generic editors, reviewed seeds  | Definition reads and gated writes                     | Type-driven editor/curation                                 | E01/E02/E07/T01/T02/T07; 1,024-type ceiling          | Definitions meaning; Semantic publication; Imports contributions          |

### Scope rows, including every In seam

This crosswalk uses the current scope table rather than treating the inventory's broad headings as all In.
Numbers here are report-local row references, not task identifiers.

| Scope topic                                               | Scope state                                                | Mapping and uncovered portion                                                                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject pages, relations, editions, credits               | In                                                         | Inventory 1; E03–E06. Full cross-view, Realm, disclosure and visual proof remain separate.                                                               |
| Catalogue/editorial/identity/definitions/vertical editors | Existing profiles/common editors/ordinary contributions In | Inventory 2/22; E01–E04/E07. Custom publication, advanced identity, reviewed seeds and measured expansion retain gates; upper-bound kind design missing. |
| Imports                                                   | Four named providers In                                    | Inventory 3; E08–E10. Recipes use definitions/contributions/licensed Wikidata, not recipe-site extraction. Provider richness and vocabulary are finite.  |
| Search, facets and discovery                              | Built under closed Search grants                           | Inventory 4; E11–E16. Advanced facets/scopes, privacy/physical/erasure/growth obligations explicitly deferred; code present does not open them.          |
| Library, Collections, progress and copies                 | In                                                         | Inventory 5–7; E17–E20 only at discovery/presentation seam. Commerce owns full matrix and lifecycle. Saved-query variants remain later scope.            |
| Ratings and reviews                                       | In                                                         | Inventory 8; E06/E11. Public Global figures only; same population for sort. Realm sort and private Realm indexing not authorized.                        |
| Posts, threads and boards                                 | In                                                         | Inventory 9; E06/E15. Content supplies actual current Realm-to-subject listing, not a raw link table.                                                    |
| Articles, hosted works and media                          | Closed behind grants until polished                        | Inventory 10; E05/E09/E19. Referenced bytes and imported metadata do not confer rights.                                                                  |
| Realms and Spaces                                         | In                                                         | Inventory 11; E06/E15. Account membership, Space address, Realm participation and Context publication are distinct seams.                                |
| Zones                                                     | Configured static routes In                                | Inventory 12; E16. Source union/direct subject/preparation work exists but remains gated; not evidence that static reading requires it.                  |
| Agents                                                    | One agent/Account page In                                  | Inventory 13; E03/E12. Credit scope and Account discovery must not become a second public identity.                                                      |
| Moderation/reports/appeals                                | In                                                         | Inventory 17; E21 plus Content/Accounts ownership. Exact reduction and erasure acknowledgements remain uncovered by this desk audit.                     |
| Notifications                                             | Minimal in-app In                                          | Inventory 15. Content/Accounts audit owns delivery/send-time access; no catalogue/search ownership inferred.                                             |
| Follows                                                   | In                                                         | Inventory 14. Accounts owns edges/counts/owner-only lists; no feed implied.                                                                              |
| Feeds                                                     | Deferred                                                   | Inventory 14; E20. New mixed-home request exceeds current scope, even though fixed catalogue home exists.                                                |
| Recommendations and rankings                              | Deferred                                                   | Inventory 16. Curated Collections/public-rating search are the stated substitute.                                                                        |
| Commerce                                                  | Offers/checkout/orders/entitlements In; points deferred    | Inventory 18. Independent purchase API and unavailable host slot are Commerce/Web seams, not missing semantic statements.                                |
| Accounts/authentication/preferences/deletion              | In                                                         | Inventory 19; E08/E12/E21 dependencies. Native authority and cleanup cannot be replaced with an account-id string.                                       |
| SEO                                                       | In                                                         | Inventory 20; E05/E06. Rendering and JSON-LD consume the same current public facts/bodies.                                                               |
| Partner/external participation                            | Deferred; Collection export exception                      | Inventory 21. No speculative partner service included in completion.                                                                                     |

## Exact implementation and test evidence

These identifiers make the capability matrix auditable without repeating long file paths in every cell.
Native test names describe their intended execution environment; all were read only.

### Definitions, catalogue and graph

- **E01 — released meaning.** [portable.ts](../../packages/definitions/src/portable.ts), `RELEASE_LIMITS`,
  `TypeDefinition`; [compiler](../../packages/definitions/src/compile.ts) and
  [validator](../../packages/definitions/src/validate.ts); [Definitions README](../../packages/definitions/README.md).
  Released types/properties/facets, relation groups, library profiles, units and inert list hints are real data.
  `coverRatio` and `listPresentation.imageAspect` are different annotations, with different current defaults.
- **T01.** `packages/definitions/test/type-list-presentation.test.ts` asserts actual Book portrait, Movie/Recipe
  landscape and MusicAlbum square hints; it also checks unknown/duplicate/unrenderable hints and 10/100 inherited
  types. `work-cover-default.test.ts` asserts work `5:7`, MusicAlbum `1:1`, Recipe `4:3`, Organization `1:1`.
  These are meaningful configuration tests, and also exact evidence of the settled-decision contradiction.
  Neither tests a 200,000-kind release or browser selection from one.
- **E02 — publication, not an implicit editor privilege.**
  `services/kernel/src/semantic/http/definitions.ts`: `POST /v1/definitions/releases`, release GET, active GET,
  release `:activate`, extension publish/activate and Context definition read. Writes use
  `gate:definition_publication`; public reads still use native eligibility. `semantic/definitions.ts` and
  definition-publication modules retain immutable digest/head and admission responsibilities.
- **T02.** `services/kernel/test/semantic/definitions.test.ts`,
  `definition-construction-publication.test.ts` and `definition-publication-work.test.ts` target release
  validation/publication and retained work. Their existence does not open publication or certify all-kind scale.
- **E03 — ordinary catalogue writes and reads.** `semantic/http/subjects.ts:703` mounts subject creation;
  `:792` terms correction; `:958` subject read; `:1296` statement proposal; `:1552/:1628` candidate accept/reject;
  `:1929` Context adoption; `:2037/:2081/:2148` candidates/revision detail/revision list. Strong ETag, command
  receipt, Session and explicit selection remain separate. `apps/web/src/features/catalogue/` contains real
  create, multi-field editing, authored-field, exact relation and Context review consumers. Routes include
  `subjects/$id_.$slug_.edit.tsx`, `.terms.tsx`, `.context-review.tsx`, `.changes.tsx` and `.value.tsx`.
- **T03.** `services/kernel/test/semantic/candidates.test.ts` covers concurrent proposals, ordered candidate/revision
  paging and one revision per command. `contribution-lifecycle.test.ts` covers contribution lifecycle.
  These are backend behaviors, not proof that the Web create → propose → review → selected reread journey is served.
  `design-status-imports.md` explicitly retains native and visual proof for its new editor integration.
- **E04 — identity and graph boundary.** `semantic/http/subjects.ts:872` still mounts two-ID
  `POST /v1/subjects:merge` with a **200** `{survivor,redirected,revision}` response and `gate:subject_identity`.
  `semantic/identity-epoch-contract.md` instead requires durable admission, bounded participants and current
  publication. Native epoch/read/store machinery exists; it does not change this HTTP schema by itself.
  Links, relations and graph/count reads are separately mounted around `:2207/:2282/:2365/:2489`; cursor and
  relation contracts, not the overview's embedded statements, determine complete traversal.
  `GET /v1/subjects/{id}/graph` is a real anchored API: 1–8 explicit properties, depth 1–2, per-expansion limit
  1–25, with a 500-edge total budget in `semantic/graph.ts`. This contradicts the Semantic README's statement
  under “Term extensions” that no separate graph endpoint exists. Relation facts have one canonical forward
  statement; inverse rows are derived and relayed, not an independently editable graph.
- **T04.** `services/kernel/test/semantic/identity-operations-http.test.ts` requires durable operation admission,
  same-key replay, private pending polling and concealed unknown/unauthorized operations. Its support helper
  expects 202 and a location, rather than the current merge response. `identity-epoch-admission.test.ts` checks
  the 4,096-original admission bound; `identity-epoch-store.test.ts` checks actual mapping/transaction/epoch
  publication and no premature completion. These tests express missing delivery; no pass is inferred.
  Separately, `services/kernel/test/semantic/graph-read.test.ts:461/:595/:635` asserts an actual anchored
  depth-two API result, refusal of unanchored/unbounded requests and intended bounded growth behavior.
  `graph-context.test.ts:140` keeps community-only edges out of the Global graph. `relations-uncapped.test.ts:397/:431`
  exercises thousands of credits/appearances and ordered continued forward reads; `context-relations.test.ts:230/:256`
  distinguishes community-selected relations from Global. These native assertions are not executed evidence.
- **E05 — selected authored documents.** `presentation/reads.ts:678` and following validates bounded dependent
  document reads, invokes `GET /v1/documents/{id}`, checks subject/candidate/language/digest and returns a
  document map; `packages/composition/README.md#dependent-document-bodies` describes this integrated handoff.
  This is already more than a dangling body reference. Content remains byte/disclosure/rights authority.
- **T05.** `services/kernel/test/presentation/public-documents.test.ts` asserts aggregate equality with standalone
  document GET, actual accepted/adopted selection, language/rank, withdrawal/source retraction, unreadable
  subjects and identity/digest rebinding rejection. `apps/web/tests/pages-workers.host.test.ts` is the separate
  real-host SSR/JSON-LD boundary. Presentation README records an earlier 2/2 receipt and a later 1/2 failure,
  predating its corrected oracle; it explicitly does not establish a current corrected pass.
- **E06 — subject aggregate and sections.** `presentation/http/pages.ts` accepts `{target:{subject,realm?,view?},
  languages?,continuation?}` through `POST /v1/pages:read`; route/account targets are distinct. `presentation/selected-page.ts`
  selects current Realm/publication/Context and final guards. `packages/composition/src/registry.ts:450–565`
  binds Cover/Summary/Sources to subject reads, ThreadList/ReviewList to native discussion/review reads,
  CollectionList to its owner list and account regions to typed readers. RatingSummary remains a host slot.
  `presentation/reads.ts` dispatches subject threads to `GET /v1/subjects/{id}/threads` and preserves native
  status/body/cursor/Session. Limits: 16 descriptors, 128 slots, four dispatch workers; full lists continue by node.
- **T06.** `services/kernel/test/presentation/subject-thread-user-cases.test.ts:162/:204/:243` compares actual
  standalone and aggregate lists, continuation and hidden content. `realm-context-user-cases.test.ts:403/:588/:639`
  covers current published Context selection, denied/banned protected Realms and authority beyond publication.
  `released-vertical-pages.test.ts`, `pages.test.ts` and `page-read-kinds.test.ts` cover narrower page contracts.
  These distinguish an implemented selector from absent population adapters for a particular list or rating.
- **E07 — classification and provider meaning.** `packages/definitions/sources/README.md`, emitted release and
  `src/reviewed-vocabulary.json` record finite reviewed meanings, with `skos:closeMatch` distinct from identity.
  `services/importer/README.md#explicit-reviewed-vocabulary-and-bangumi-lookup` describes the explicit operator
  tool. A declared property, source diagnostic or external tag is not automatically an adopted fact or new Type.
- **T07.** `packages/definitions/test/disclosure.test.ts` validates the admitted `sourceOrConsent` marker and
  rejects arbitrary disclosure values; T01 covers inert list hints. Neither replaces native consent checks.
  `services/kernel/test/imports/reviewed-catalogue-producer.test.ts` and
  `services/importer/tests/reviewed-catalogue-preflight.test.ts` target reviewed producer behavior.
  Neither proves an unbounded vocabulary, automatic arbitrary provider mapping or current discovery readiness.

### Import acquisition, provenance and lifecycle

- **E08 — ordinary operator and durable state.** `services/importer/src/cli.ts`, `importer.ts`,
  `import-session.ts`, `source-registry.ts` and [Importer README](../../services/importer/README.md) implement
  four registered sources, streaming acquisition, validated/sealed generations, SQLite source baseline,
  immutable request/ACK journals and replay. Auth is `POST /signin/key` → `POST /token` for an ordinary automated
  Account. Transport uses `POST /v1/subjects:batchWrite` and `GET /v1/sourceFences:check`; it is not privileged
  database loading. Changed authority and exact replay remain native API decisions.
- **T08.** `services/importer/tests/cli-midrun-authority-resume.test.ts` explicitly uses mocked HTTPS/Auth/fence
  transport and is a local protocol test. `services/kernel/test/imports/provider-cli-native.test.ts`,
  `cli-bangumi-scope-transition.test.ts` and `wikidata-rich-cli.test.ts` target actual ordinary CLI/native
  integration. The README's separately cited Bangumi transition receipt is historical, not evidence that all
  provider/default/public Search journeys pass on this revision.
- **E09 — media, sources and removal.** Ordinary `POST /v1/media:importFromUrl` →
  `GET /v1/media/{id}:importStatus` handles media acquisition separately from metadata proposals. Exact source
  tuples/fences govern refresh/retraction; deletion retains communal identity and independent selections.
  `services/importer/src/source-registry.ts` supplies reviewed metadata descriptors;
  `POST /v1/source-records:setMetadata` journals its own CAS/ACK, rather than rewriting semantic receipts.
  Selected `subject.sourceRecords` supplies Sources. A descriptor never grants prose/image rights.
  The registry explicitly records Bangumi metadata as CC-BY-SA-3.0, VNDB database permission as ODbL-1.0
  with DbCL-1.0 attribution for permitted contents, and Open Library/Wikidata metadata as CC0-1.0.
  E10 narrows the actual proposed fields: Bangumi summary attribution/ShareAlike is separate from unknown
  cover rights; VNDB creative text/images and unknown-licensed Open Library descriptions are not proposed.
  These are inspected implementation permission claims, not a blanket licence finding for a provider or the output database.
- **T09.** `services/kernel/test/imports/source-record-metadata.test.ts` checks old unchanged binding catch-up,
  actual selected Sources, receipt/bootstrap identity and unchanged reopen. `openlibrary-cli-edition-media.test.ts`
  checks distinct work/edition identity, resolved work relation, unresolved author citation, real available
  cover variants/credit, fenced removal and unchanged entry/bootstrap. These assertions are much stronger than
  a cover fixture, but were not executed here; the metadata owner's status says its new native test was unrun.
- **E10 — pure conversion and finite richness.** `packages/conversion/src/bangumi.ts`, `vndb.ts`,
  `open-library.ts`, `wikidata.ts`, [Conversion README](../../packages/conversion/README.md#source-mappings-and-limits)
  and source registrations retain provenance, explicit outcomes and reviewed mappings. Bangumi music/live-action
  inputs are recognized ignored records, not fake successful catalogue imports. VNDB permits a narrow metadata
  projection, not its creative text/images. Open Library work/edition grain and unresolved relation evidence
  remain distinct. Wikidata uses only released property/type/datatype mappings. Unknown is not zero or absence.
- **T10.** `packages/conversion/tests/bangumi-outcomes.test.ts`, `vndb-outcomes.test.ts`,
  `wikidata-outcomes.test.ts` and exact-quantity/growth tests cover deterministic conversion boundaries;
  provider-native tests cover selected later handoffs. Conversion tests cannot establish permission, independent
  candidate selection, release publication, current Sources disclosure or a finished browser review queue.

### Search, scopes and consumers

- **E11 — default public search.** `services/kernel/src/server.ts:258–296` installs
  `createDefaultPublicFilterRuntime` and `createSearchService` with real rated source, Access and OpenSearch.
  `search/public-runtime.ts` retains observation/execution custody, calls useful-page collection, hydrates
  current results and finishes native status checks. `search/http/routes.ts` mounts
  `POST /v1/subjects:search`, `POST /v1/subjects:facets`, `GET /v1/subjects:suggest` and
  `GET /v1/trendingSearches`, with basic/advanced gates, 409 restarts and readiness errors.
  The ordinary search limit is 1–100; generic bases and kind metadata are not a separate all-object API.
- **T11.** `services/kernel/test/search/default-public-runtime.test.ts` expects finite real preparation,
  current filled/exhausted pages, privacy repair and rebuild recovery; the test explicitly fails if readiness
  never finishes. `universal-subject-api.test.ts` checks Book/Person/Recipe mixing, generic bases, opaque
  eight-kind metadata pages, counts omitted on continuation, hidden hits and closed NOT. Tests are requirements,
  not evidence the provisional Source can complete them.
  `trending-searches.test.ts:22/:36/:56/:63` separately checks literal-only public submissions, ten distinct
  current contributors, honest preparation without identity/definition binding and native withdrawal/late-replay refusal.
- **E12 — mixed Accounts/Subjects, with absent default assembly.** `search/discovery-registry.ts:42` creates
  a closed registry of released Semantic kinds plus `account`; Accounts declares only text/kind domains.
  `discovery-hydration.ts` uses actual native Account discovery summaries and Semantic summaries.
  `discovery-service.ts:39` composes retained mixed capture/query/current hydration/final disclosure.
  `http/kernel.ts:105` accepts an optional `discovery` dependency; `search/http/routes.ts:367` returns
  `index_not_ready` when it is absent. Default `server.ts` does not pass that dependency. There is no mounted
  `POST /v1/search:query`, and no registered post/thread/Collection/Space/Zone result owner in this registry.
- **T12.** `services/kernel/test/search/mixed-discovery.test.ts` requires one actual Person/Account result stream,
  current nonnull summaries, bound lossless continuation and rejection after stale native membership.
  `discovery-registry.test.ts`/`discovery-user-cases.test.ts` cover registry/domain contracts. Source factories,
  tests and optional injection establish components, not default activation or a content feed.
- **E13 — native Source gap.** `semantic/public-filter-source.ts:44–98` implements definition resolution through
  `public-filter-source-binding.ts`, but all three projection/reduction readers are unavailable and
  `recordPrivacyReduction` throws. The binding itself has real registration/join/adoption/repair SQL.
  `semantic/subject-source-key-pages.ts:45` retains the provisional fixed-cut `source_pending` adapter;
  the same file's `createSubjectSourceKeyPages` is a different real bounded **current** inventory reader.
  Neither current inventory nor old scalar `SubjectSource` certifies a historical complete cut.
  `search/public-filter-consumer.ts` now contains substantial native capture/query/custody/repair operations,
  including `captureDiscovery`/`queryDiscovery`; calling the whole module a stub is inaccurate.
- **T13.** `services/kernel/test/semantic/public-filter-projection.test.ts` and `public-filter-source-binding.test.ts`
  address producer/binding behavior. Retained consumer, disclosure, generation and privacy tests under
  `services/kernel/test/search/` separately address indexed membership and current row filtering.
  In particular `default-public-runtime.test.ts`, `disclosure.test.ts`, `coverage-default-worker.test.ts`
  and `cursor-confidentiality-outcomes.test.ts` name native obligations; helper tests cannot certify them.
- **E14 — facets and ordered scopes.** `search/service.ts:737` asks optional `facetProvider`; absence returns
  index readiness, and default server supplies none. `facet-discovery-runtime.ts` is the current bounded
  consumer; old `live-facets.ts` helpers do not become its provider. `scope-source.ts:377/:794` implements
  ordered prepare/prefix beyond mere declarations, using `scope-ordered-native.ts` and native custody.
  However work-locator combinations remain explicitly unavailable; owner ordinal direct output must prove
  bounded input exhaustion, and public plans still require E13. More implementation does not mean a completed
  general ordered owner/source engine.
- **T14.** `services/kernel/test/search/live-facets.test.ts` uses a controlled `SubjectSource` and refuses partition
  scans; it tests that helper's privacy/batching, not current default provider wiring.
  `cross-surface-discovery.test.ts` checks native six-surface agreement and Members/Everything/own-state
  composition; `services/kernel/test/zones/static-page-runtime.test.ts` names the dynamic source composition
  as well as static cases. None was rerun to convert source availability into a completion claim.
- **E15 — scoped grammar and header.** [Search conditions](../search-conditions.md#conditions-and-resource-meaning)
  defines viewer-self Library, Collection UUID, literal credit-roster Agent, configured-page Zone and discussed-
  subjects Realm meanings. `packages/filter/src/filter.ts:20–35` defines the actual catalogue/discovery unions:
  no Collection/Zone/Realm resource leaf. `search/filter.ts` rejects private owner leaves in catalogue compilation.
  `apps/web/src/search/header-search/types.ts` lists Library/Collection/Realm/Zone/Agent, no Space, and requires
  a supplied `searchAction`. `apps/web/src/shell/shell.tsx:500` uses `<ShellSearch />` with no scope; the only
  production instantiation found supplies none. `apps/web/src/search/header-search/suggestions.ts` throws for any scope.
  `apps/web/src/search/search-request.ts` and `apps/web/src/search/search.tsx:282` now send `discovery-v1` by default and keep explicit
  legacy representation separate; they do not silently fall back on default-provider failure.
- **E16 — Zone source seam.** `services/kernel/src/zones/{http,page-runtime,membership,union,page-work}.ts`
  composes readable source descriptors, Search scope, native Collection sources, bounded union discovery and
  retained preparation. Static no-read documents keep independent 200 behavior. `zones/README.md` records
  32 sources, 32 retained slots per Zone/viewer, a 1 MiB row ceiling, eight-key/4,864-character/15-minute tokens,
  complete 200 versus private 202 progress versus 503. Some README absence claims about ordered Search bodies
  predate E14; public-source readiness and owner-preparation gaps remain real.

### Collection presentation, home and lifecycle seams

- **E17 — Collection source is partially native.** `library/collection-source.ts:314` constructs a native
  source with request work/custody and repeated authority checks. Ready metadata currently admits only
  `curated`/`private_builtin` source authorities; other authorities refuse. It uses canonical source state,
  original/terminal identity and actual native membership, rather than accepting a Collection ID as a source.
  `library/collection-list-facts.ts` attaches original-keyed FULL facts in a batch of at most 100 members,
  then revalidates source and identity. `semantic/list-presentation.ts` reads actual selected, disclosed values.
- **T15.** `services/kernel/test/semantic/list-presentation-facts.test.ts` checks real adopted Book word count,
  Film duration and Recipe cook time in one original-keyed batch and withholding of the whole hidden subject.
  `services/kernel/test/library/collection-kind-http.test.ts` checks canonical duplicate suppression, hidden
  frequent types, owner override, deep members and eligible-empty proof. These are substantive producer tests,
  not proof that a particular FULL recording includes those facts or every authority variant is ready.
- **E18 — actual versus illustrative UI data.** `apps/web/src/library/collection-page.tsx:1172` uses CoverCard
  and supplied facts in list/grid; `:642` renders a header Cover only when `page.cover` exists. The page retains
  an inline `CollectionFilters` region. `stories/library-collection.stories.tsx:474`,
  `SuppliedBookFactsIllustrative`, explicitly constructs a DTO from a recorded subject publication statement:
  the Collection FULL recording has no facts; author and Film facts remain absent. It proves a renderer seam.
- **E19 — header cover authority/fallback.** `library/collection-presentation.ts`,
  `readablePresentationCover`/`preparePresentationSelection`, checks real media availability/variants,
  `decideDownload`, current reread and released kind validity. `collectionPresentation:103–115` returns a real
  owner cover or null with `pending`/eligible-empty `none`; no automatic member-cover selection is implemented
  there or supplied by its detail/list callers. [Collection presentation](../collection-presentation.md)
  requires the first actually current readable member image, skipping hidden images and proving absence only
  after exhaustive eligible absence. `packages/ui/src/components/cover-model.ts` preserves off-ratio images
  with `contain` when their ratio differs by more than 15%; frame choice remains a separate current defect.
- **T16.** `packages/ui/tests/cover.test.ts` and T01 protect image fitting/configuration; Collection-kind tests
  protect complete kind derivation. Neither supplies automatic Collection header image selection. The
  illustrative facts story and Pages variants are read evidence, not new native or browser execution here.
- **E20 — current home.** `apps/web/src/features/pages/home-queries.ts` reads configured `/` once;
  `routes/index.tsx` composes that public RoutePage with separate signed-in Continue queries. Shipped
  `packages/composition/profiles/platform.json` and `presentation/setup.ts` configure four searches, each limit
  12 and collections sort, for Books, Anime, Visual novels and Recipes. No follow-driven heterogeneous feed
  producer, ranking contract or feed cursor is supplied by this route. SearchBox inside the route is distinct
  from the single header search requirement and needs coordinated presentation review.
- **T17.** `services/kernel/test/presentation/platform-home.test.ts` explicitly asserts four per-vertical lists,
  Heading then SearchBox, all eight locales and total planned output ≤128. It tests the previous design
  faithfully and would not reject the missing native mixed home. It is not meaningless, but its oracle does
  not express the newly fixed upper-bound product direction.
- **E21 — disclosure and terminal ownership.** `semantic/statement-disclosure.ts`, selected-slot readers,
  `content/source-fences.ts`, `semantic/deletion-contract.md`, `search/erasure.ts`, search writer-guard and
  identity participant contracts retain separate authoritative and derived custody. E13 has no ordinary
  `recordPrivacyReduction` writer integrations in current Semantic/Content/Access source. Durable schemas,
  erasure modules and refusal behavior do not prove native immediate reduction, hold handling, every shared
  copy or final owner acknowledgement. See also [deletion](../deletion.md).

## Capability matrix: the gaps between layers

“Yes” in B means the named operation has a concrete body, not whole-feature acceptance. All T entries mean
tests exist with the stated boundary; executed status in this audit is **not run** throughout.

| Capability                                  | D                                   | B                                                                             | A                                                              | I                                                                                    | T and uncovered link                                                                  |
| ------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Released catalogue validation/read          | Yes                                 | Yes, finite whole release E01                                                 | Public reads E02                                               | Real definition-driven consumers                                                     | T01/T02; 200,000 kinds unsupported                                                    |
| Custom release/extension publication        | Yes, gated                          | Real immutable publication/work E02                                           | Closed publication gate                                        | Curation surfaces, not ordinary editor permission                                    | T02; native completion/exposure separate                                              |
| Generic initial create and terms correction | Yes                                 | Yes E03                                                                       | Ordinary create/PATCH, current authority                       | Real generated-client consumers                                                      | T03; new integrated editor proof pending                                              |
| Multi-field contribution/review/adoption    | Yes                                 | Immutable per-field writes; selection explicit                                | Proposal/accept/reject/adopt E03                               | Workspace/review/Sources/Changes exist                                               | T03/T09; no atomic multi-field promise or auto-publication                            |
| Work/edition and creator traversal          | Yes                                 | Generic released relations E04                                                | Native links/relations/counts                                  | Subject views and canonical exits                                                    | T04/T06; full cross-view/hidden/continuation journey proof pending                    |
| Anchored semantic neighbourhood             | Yes, bounded neighbourhood          | Real graph traversal/summary/current-edge checks E04                          | Mounted graph GET, explicit properties/depth/limit             | Relation views exist; no standalone graph-visualization consumer found in Web source | T04 graph assertions; README denial of endpoint is stale                              |
| Advanced identity merge/publication         | Yes                                 | Epoch/store/participants partial                                              | Mounted old pair/200 ABI conflicts with operation contract     | No completed new operation journey established                                       | T04 explicitly requires missing 202/poll behavior                                     |
| Reviewed classification/provider forms      | Finite and gated                    | Released seeds/operator converters E07/E10                                    | Ordinary facts/definition gates                                | Type-driven controls                                                                 | T07/T10; arbitrary provider taxonomy not supported                                    |
| Native importer baseline/replay             | Yes                                 | Yes E08                                                                       | Ordinary Auth/batch/fence transport                            | CLI                                                                                  | T08; mock protocol and native tests are separate                                      |
| Provider provenance/media/source metadata   | Yes                                 | Real separate journals/readers E09                                            | Metadata/media/fence APIs                                      | Sources/provider review, explicit media rights                                       | T09; no blanket image/prose licence                                                   |
| Basic multi-Type subject search             | Yes, closed grant                   | Real default runtime, Source dependency E11/E13                               | Mounted Subject wire                                           | Real global results/navigation                                                       | T11; provisional complete Source blocks readiness                                     |
| Account + subject discovery                 | Yes                                 | Registry/native readers/retained consumer E12                                 | Opt-in wire; default provider absent                           | Web sends mixed request and renders owner tags                                       | T12; not default activated                                                            |
| Facet values and counts                     | Yes, advanced grant                 | New consumer; provider not supplied E14                                       | Mounted; honest readiness                                      | Refinement/condition controls                                                        | T14 controlled helper ≠ current native provider                                       |
| Trending terms                              | Yes, finite/public                  | Route/projection/cleanup code; Source dependency                              | Mounted route E11                                              | Header global loader; actual producer readiness unknown                              | T11 distinguishes reducer/native store/preparing; no recorded terms presented as live |
| Library scoped text/filter                  | Yes, self only                      | Owner/built-in/source components E17                                          | Common-members owner reads; no complete header search route    | Header scope type only; actual Library UI has own readers                            | T14/T15; source/preparation/route join missing                                        |
| Collection scoped text/filter               | Yes, UUID member meaning            | Curated/private subset E17; complete scope leaves missing E15                 | Member reads exist; specified search resource operand absent   | Chip contract without supplied production action                                     | T14/T15; occurrence filtering is not global-search intersection                       |
| Agent credit scope                          | Yes, literal released credit OR     | Generic relation predicates; no family leaf needed                            | Existing statement filter can express bounded roster           | No production scope route supplied                                                   | T04/T11; capture released roster, do not infer from label                             |
| Realm discussed-subject scope               | Yes                                 | Content evidence exists for known subjects; enumeration/drain join incomplete | Specified Realm resource leaf absent                           | Realm selector for facts exists, header search scope unwired                         | T06 ≠ Realm-wide scoped search acceptance                                             |
| Zone configured-page scope                  | Yes, later gate                     | Dynamic runtime and ordered/source pieces E14/E16                             | `:readPage` independent static behavior; search operand absent | Zone routes/common renderer                                                          | T14; complete source/preparation still missing                                        |
| Space scoped search                         | Fragmented                          | Space/Realm resources, no selected search population contract                 | No Space operand/facade                                        | No Space header variant                                                              | No full journey; containment must be specified first                                  |
| Native mixed home and follows ranking       | Never designed as a current In feed | Four-TypeList home only E20                                                   | No mixed feed/ranking API found in home path                   | Catalogue rows + personal Continue                                                   | T17 protects old row structure; scope defers feeds                                    |
| Subject summary/facts/sources/body          | Yes                                 | Real selected aggregate E05/E06                                               | `pages:read`, standalone reads                                 | Real common renderer                                                                 | T05/T06; per-leaf unavailable and section IA still matter                             |
| Subject discussion/review preview/full view | Yes                                 | Callbacks/continuation implemented E06                                        | Native thread list plus aggregate                              | Common thread/review rendering                                                       | T06; particular Realm population readiness stays separate                             |
| Public-rating summary/purchase section      | Yes, foreign owners                 | Owner APIs; host integration distinct                                         | Independent APIs, no semantic substitute                       | Host slots can be unavailable                                                        | Not certified by page tests; Content/Commerce own correction                          |
| FULL member facts and member image          | Yes                                 | Batch selected facts, current media DTO E17–E19                               | FULL members supplied when owner ready                         | Real row/grid Cover and facts                                                        | T15; illustrative facts story is not native FULL recording                            |
| Collection explicit header cover            | Yes                                 | Current media authorization E19                                               | Owner override/read                                            | Conditional header Cover                                                             | T09/T16 cover-related boundaries; no claim of automatic fallback                      |
| Collection automatic header cover           | Yes                                 | Missing bounded producer E19                                                  | DTO can report pending/none                                    | No header placeholder when null in inspected branch                                  | Kind/fitting tests do not cover this journey                                          |
| All-kind portrait defaults                  | Settled                             | Conflicting annotations/fallbacks E01/E19                                     | Definition DTO exposes conflicting hints                       | Landscape/square frames can remain                                                   | T01 enshrines contrary defaults; coordinated contract change needed                   |
| Whole-query reduction and terminal erasure  | Yes                                 | Stores/custody/participants; Source reduction missing E13/E21                 | Failure/gating is honest, completion unavailable               | Typed readiness/restart states                                                       | T11–T14; no native final-custody pass established                                     |

### Scoped search is five different populations, plus an unsettled Space seam

Library means the authenticated viewer's qualifying presence union, not every curated occurrence or a
query-selected account. Collection means canonical eligible membership; duplicate occurrences do not multiply
hits, and another reader cannot expand the curator's private dynamic predicate. Agent means the pinned release's
actual credit-role OR (currently twelve leaves), not Account identity or “any relation”. Realm means subjects
discussed in currently readable discussion/review chains, not a Context's accepted facts. Zone means its current
representable configured page-list predicates, not all mounts, metadata or rendered examples (E15).

Those meanings must survive text, Boolean operations, suggestions, counts and continuation. Authorize every
referenced resource before enumeration, including below NOT or a true OR. Recognized but inapplicable domains
remain unknown; NOT must not turn them true. A scope chip's removal deliberately changes scope; missing backend
support must never silently broaden to Global. The current header's refusal is correct, but the delivered user
journey remains incomplete. A Space can carry resources and have an address; no inspected contract selects
whether “search this Space” searches its Realm's discussion population, catalogue publication, hosted content,
or a deliberately mixed set. That is a real remaining product-semantic decision, unlike the already fixed header layout.

## Persona journeys the API alone cannot currently complete

| Persona and intended result                                                 | Available steps                                         | Exact break / consequence                                                                                                                                          | Required owner handoff                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Anonymous reader searches mixed catalogue kinds                             | Subject query, generic bases, summary hydration         | E13 cannot certify complete public population/privacy; readiness cannot become useful default completion                                                           | Semantic Source → Search retained runtime → Web                          |
| Reader searches Accounts and subjects together                              | Opt-in discovery request and native owner readers       | Default `discovery` provider absent E12; Web mixed request can receive readiness                                                                                   | Accounts source + Semantic reductions → Search assembly                  |
| Signed-in reader searches within own Library/Collection                     | Native owner/common-member reads and scope components   | Specified resource leaf/complete private preparation/header route not connected; enumerating all members then filtering is not an alternative                      | Commerce source/preparation → Search admission → Web                     |
| Visitor searches a Realm/Zone/Space                                         | Read resources; Realm-selected facts; static Zone pages | Different population meanings; resource operands/producer joins missing; Space meaning unselected                                                                  | Content/Accounts/Semantic → Search; Space decision first                 |
| Contributor creates and corrects a released subject                         | Create, propose, review, adopt, reread APIs             | This narrow API journey is possible under grants; ordinary API does not promise automatic selection or all browser entry points                                    | Imports owns usable editor; Semantic preserves native decisions          |
| Identity steward merges duplicates and waits for safe completion            | Old merge operation; native identity work components    | Cannot use the specified 202 operation/poll/publication journey through mounted ABI E04; gate prevents calling this broadly complete                               | Semantic coordinator + Search/Commerce/Accounts/Content participants     |
| Definition curator adds an arbitrary new vertical                           | Gated release/extension publication                     | Whole-release 1,024-type ceiling and closed authority; cannot grow to 200,000 through current API                                                                  | Definitions representation → Semantic publication → all consumers        |
| Import operator produces selected, attributed public catalogue data         | CLI acquisition, ordinary proposals/media/metadata      | Independent selection is intentionally separate; fields outside reviewed mappings stay unsupported; public search still needs E13                                  | Imports → Semantic selection + Content rights → Search                   |
| Reader opens a subject with details, discussions and reviews                | Real aggregate/standalone APIs and continuation         | Narrow supplied sections work in code; host rating/purchase or scoped list availability is independent, so a monolithic “all loaded” page is impossible to promise | Search composition; Content/Commerce leaves; Web section states          |
| Collection curator expects an automatic header image                        | Explicit readable owner-media choice; member images     | No member-image fallback producer; pending is honest, not a cover                                                                                                  | Commerce bounded selection → Content current media → Web placeholder     |
| Reader expects a heterogeneous followed home                                | Follows, four public catalogue lists, private Continue  | No current feed scope, owner, ranking/privacy/consumed-frontier contract or mounted home feed                                                                      | Product scope adoption → owners' current sources → one mixed composition |
| Deleting account expects immediate discovery reduction and eventual cleanup | Owner deletion/erasure modules                          | Missing native reduction writer and complete copy acknowledgements cannot be replaced by hidden returned rows                                                      | Accounts barrier → Semantic reductions → every derived custody owner     |

These are completion gaps or intentional gates, not a reason to create privileged direct database writers.
The public API is the right authority boundary. It needs complete native implementations of the already named
ports, and a small number of genuinely absent product contracts.

## Contradictions, defect classes and why they survived

Every correction below is proposed, not adopted. “Cause” is the mechanism supported by the evidence, not a
claim about a person's intent or the history of an unobserved production incident.

| Finding / defect class                      | Exact contradiction or evidence                                                                                                                       | Cause that permits it                                                                           | User impact                                                                               | Owner seam and proposed correction                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Whole-query authority missing               | E13 readers unavailable; writer throws; E11 has real consumers                                                                                        | Component and per-hit safety can be developed/tested independently of complete source authority | Readiness cannot safely become full/empty success; exclusions/order/counts otherwise leak | Semantic completes atomic producer; Search consumes its native cuts, repair and final checks          |
| Product scale outside representation        | Upper-bound rule versus E01 1,024-type/4 MiB release; E12 whole registry                                                                              | Launch-sized finite release treated as catalogue-wide distribution model                        | 200,000 kinds cannot be represented/selected as promised                                  | Definitions/Semantic design paged immutable metadata and bounded admission, with Search/Web migration |
| Designed scopes absent from grammar/route   | E15 spec resource leaves versus actual unions; no supplied shell scope                                                                                | UI chip, filter compiler and owner readers each cover a fragment                                | Cannot perform scoped query; misleading labels risk broader results                       | Search owns resource admission; Commerce/Content/Semantic own populations; Web supplies real route    |
| Default assembly incomplete                 | E12 mixed modules/native tests versus absent default provider; E14 facet provider absent                                                              | Dependency injection and opt-in schemas are mistaken for ordinary assembly                      | Real mixed Web request receives readiness; facet panels cannot promise native values      | Search joins existing native providers only after whole-query safety; no fallback to legacy success   |
| Transport/contract drift                    | E04 200 pair merge versus T04 202 operation/poll                                                                                                      | Durable coordinator and HTTP delivery evolved separately                                        | Steward cannot observe promised safe asynchronous completion                              | Semantic aligns operation ABI, auth/replay/poll and native participants before exposing gate          |
| Stale absence claims                        | `design-status-search.md` says missing realm/continuation/thread callbacks/body; E05/E06 implement them                                               | Status inventory predates connected landings                                                    | Duplicate work or wrong remediation priority                                              | Search updates owning status after evidence review, preserving native/visual qualifications           |
| Graph contract/runtime drift                | Semantic README says no separate graph endpoint; E04 mounts it and T04 directly tests it                                                              | Owner prose describes an earlier read surface                                                   | Consumers may overlook a usable bounded API or assume Context behavior it does not offer  | Semantic reconciles README with actual Global graph semantics; Web keeps full relation exits distinct |
| Stale all-stub claims                       | Search README calls consumer provisional; E13 contains native capture/query/repair; status calls Collection source wholly unavailable, E17 has subset | A boundary failure label is applied to the entire module                                        | Real machinery overlooked; more duplicate adapters                                        | Search/Commerce document supported authority/plan combinations and exact pending producer             |
| Stale runtime claims                        | `docs/search-facets.md` runtime note and old live-facet helpers versus E14 new provider-based path; Zone README says ordered bodies absent            | Contract notes/helpers survive runtime replacement                                              | Wrong test selected as evidence; caller readiness misdiagnosed                            | Update owner runtime notes; test new default provider, keep helper scope explicit                     |
| Home designed as launch catalogue           | E20/T17 four fixed vertical rows; scope defers feeds                                                                                                  | Existing tests faithfully protect a smaller old product design                                  | Home cannot express requested heterogeneous feed or 200,000-kind navigation               | Adopt feed scope/owner, then bounded mixed source contract; do not add a row per kind                 |
| Cover defaults disagree with fixed decision | E01/T01 square/landscape defaults and two annotations; E19 family fallbacks                                                                           | Independent presentation knobs and frozen prior-design assertions                               | Different surfaces can frame identical subject differently                                | Definitions/Web/Commerce adopt one portrait default rule, preserve actual art and explicit fitting    |
| Header cover producer absent                | E19 always owner/pending/empty; E18 conditionally omits image                                                                                         | Header image selection confused with member image rendering/kind derivation                     | Collection can have visible member covers and no header cover                             | Commerce supplies bounded maintained fallback; Web shows stable portrait placeholder meanwhile        |
| Illustrative data mistaken for delivery     | E18 story explicitly says not a recorded FULL fact response                                                                                           | Renderer, recording and native producer evidence collapsed                                      | “Complete facts” claim survives absent actual payload                                     | Imports/Commerce recording owner adds honest native DTO evidence later; label illustrative seam now   |
| Aggregate/section failure coupling          | Composition has typed per-leaf outcomes E06; screenshot complains of repeated failure text                                                            | Pattern existence doesn't choose main-page sections or isolate unavailable leaves               | A page can become an unavailable wall despite readable core facts                         | Web chooses bounded primary sections/folding; owner failures remain local, typed and retryable        |

The broader status inventories correctly warn that source presence/typechecking does not establish native,
visual or promoted completion. Those qualifications should remain. Specific obsolete negative claims should be
removed from their owning documents only when their owners adopt these findings. This report changes none of them.

## Costs at typical and upper-bound quantities

These are desk derivations, not latency, SQL-plan, memory-profile or engine-work measurements. Let `s` be the
requested page size, `K` kinds, `R` Realms/Spaces, `F` follows, `N` Collection items, and `c` changed import records.
“Bounded output” never substitutes for bounded postings, rejected candidates, dependency reads, retained state
or final disclosure. A proposal below still needs its later owner Cost/native acceptance.

| Operation                         | Typical request shape                                                                       | Upper-bound failure or existing cap                                                                                                                                                                                     | Required design/cost treatment and owner                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Definition discovery/read         | One small immutable release, active digest and type lookup                                  | Hard 1,024 types/4 MiB; registry `Object.entries(release.types)` is O(K). At 200,000 kinds, even an illustrative 100 bytes/kind is 20 MB before properties/locales                                                      | Paged immutable type/property indexes and digest-pinned point/batch reads; bounded search/picker metadata. Definitions/Semantic; Search/Web depend on it                             |
| Kind navigation/counts            | Eight metadata values, positive current witnesses on first page                             | 200,000/8 = 25,000 pages to enumerate all kinds; paging alone is not usable discovery. Current release prevents this population anyway                                                                                  | Searchable hierarchical/recent kind choice plus bounded relevant witnesses; never a full kind roster per request or count-all query                                                  |
| Basic/mixed search                | `s=20`; count-free hits, retained cursor, current owner hydration                           | `s≤100`; mixed discovery shares three rounds and `min(600,6s+3)` raw candidates (123 at 20), not unlimited refill                                                                                                       | Sparse output needs actual retained preparation/readiness and complete exhaustion proof. Semantic native population → Search; no scan-all in request                                 |
| Boolean scoped query              | Few literal/typed leaves                                                                    | Expanded tree ≤32 leaves/depth 4/OR 16/`in` 64/qualifiers 4; 5,000 follows cannot be pasted into an `in` or OR                                                                                                          | Owner-maintained indexed population/prepared source, current resource authorization before candidates. Do not truncate to fit; Search + source owners                                |
| Native fact/list page             | ≤100 original keys and one bounded selected-fact batch                                      | Four properties × at most three values per member = ≤1,200 value slots before related-label/disclosure work; raw duplicates still consume input                                                                         | Preserve same-statement/unit/unknown meaning, batch home reads and final original/terminal/source checks. Semantic/Commerce                                                          |
| Subject aggregate                 | One selected subject; a few preview sections                                                | 16 descriptors/128 slots/four workers. 300 Realm blocks exceed admission; even hypothetical unconstrained four-worker dispatch implies 75 waves                                                                         | One current Realm/Context selection and searchable chooser; previews with independent continuation/folding. Search/Web; Content/Accounts current authority                           |
| Semantic graph neighbourhood      | One anchor, a few properties, depth 1–2                                                     | Eight properties/two directions/25 edges per expansion, 500 total edges; at most 501 node IDs and two summary chunks of 256. High-degree hubs cannot become closure reads                                               | Continue individual truncated relation/link expansions, charge rejected/current-edge checks and partition work. Semantic; no runtime cost pass inferred from these constants         |
| Current home                      | Four ×12 hits =48 output slots and four Search reads, plus separate private Continue        | One row per 200,000 kinds would ask for 2.4 million hits. Existing 128-slot cap refuses it; fixed four rows merely omit the other kinds                                                                                 | One bounded heterogeneous page with a small curated/configured budget, no per-kind/per-Realm request fanout. New feed contract needs adoption                                        |
| Collection member browse          | `s≤100`, seek cursor and batch hydration                                                    | A million items take at least 10,000 100-item pages for exhaustive browsing; no GET may read them all to choose kind/image                                                                                              | Maintain derivations on owner source epochs with bounded resumable repair and honest pending. Commerce; Semantic/media current revalidation                                          |
| Automatic Collection image        | Explicit media point read, or a few likely candidates                                       | First readable image may be the millionth eligible member, or absent after all N; first preview is not absence proof                                                                                                    | Derived candidate/frontier under native preparation, current recheck of chosen member/image and invalidation on reduction. O(N) total work may be necessary; bound each request/step |
| Zone configured sources           | A few admitted sources and one useful page                                                  | At most 32 sources; retained row ≤1 MiB, 32 slots/viewer, 15-minute token; ordered owner direct paths may need bounded exhaustion E14                                                                                   | Shared source watermark/canonical union, charged rejected/alias keys, prepared work for larger results. Semantic + Search + Commerce, no source-authority vector in token            |
| Realm membership/discussion scope | Few current resource reads and subjects from relevant threads                               | Hundreds of Realms × many boards/posts is an invalid request-time scan; known-subject probes don't enumerate population                                                                                                 | Content owns maintained inverse population/changes; Accounts owns current ban/read veto; Search owns consumed frontier and predicate applicability                                   |
| Import acquisition                | Stream one source generation, sealed comparison and changed records                         | Conversion projections: Bangumi 64 KiB, VNDB 64 KiB, Open Library 2 MiB, Wikidata 128 KiB; processor public envelopes 64 KiB, private plan 2 MiB. Whole acquisition is O(source), replay/change work bounded separately | No blanket “O(changes)” acquisition claim. Source-specific admission, disk growth/journals, indexed baseline diffs and exact resumable intents; Imports                              |
| Import metadata retries           | One new point intent per changed reviewed descriptor; zero on acknowledged identical reopen | Catch-up may replay then replace: two intents. Up to 8 coordinator attempts ×5 HTTP attempts =40 attempts/intent; not a lifetime bound across reruns                                                                    | Retain exact bytes/key/revision and current authority, bounded backoff, durable failure. No fake ACK or per-field licence escalation                                                 |
| Identity/erasure                  | Small admitted identity group and bounded participant steps                                 | Structural group≤4,096 originals; millions of dependent derived rows cannot be a synchronous merge/reduction scan                                                                                                       | Admit durable work, freeze actual participant custody, revoke stale writers and publish only after native completion. Semantic coordinator + every owner                             |

OpenSearch's PIT and `search_after` supply stable engine traversal, not permission snapshots or current privacy.
Its official [pagination guidance](https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/)
and PostgreSQL's [LIMIT/OFFSET documentation](https://www.postgresql.org/docs/current/queries-limit.html)
support avoiding deep offset work; PostgreSQL explicitly still computes skipped rows. The inspected OpenSearch
source exposes both PIT and search-after builders (reference register below). Keep those mature engine primitives,
and keep REZICS-specific source/lifecycle authority at the owner boundary. Do not add a second generic query engine
or treat a custom custody layer's existence as measured efficiency.

## Disclosure, lifecycle, accessibility and consistency

Search has two safety problems: current hit disclosure and current query truth. Hiding a candidate during hydration
addresses only the first. Negative predicates, match/no-match, rank position, bucket existence, kind labels/counts,
suggestions and trends can disclose source data. Complete current native population/reduction heads and final
query-status validation must cover every contributing execution, even zero-hit output (E11–E14). Account discovery
needs Accounts' active/unfenced discovery source, not attribution metadata or an arbitrary Account lookup.

Keep these independent authorities explicit:

| Authority                          | What it can establish                                                             | What it cannot establish                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Definition release                 | Property/type/unit/role meaning and inert display hints                           | Permission, selected truth, source rights or a usable 200,000-kind directory                   |
| Semantic selection and Context     | Current disclosed selected statements and original/terminal identity              | Content bytes, private Realm membership or unrelated host-slot readiness                       |
| Content and source fences          | Current body/media/board/thread disclosure, exact tuple reductions, credit/rights | Release publication, whole-query index completeness or Collection membership                   |
| Accounts/Auth/Access               | Current actor/client/delegation, bans, consent, discovery/erasure state           | Catalogue ownership from an ID string or automatic contribution selection                      |
| Commerce Collection/Library source | Current owner facts, canonical eligible member population and publication state   | A public search grant, private predicate disclosure to another reader, or media licence        |
| Search derived generation/custody  | Actual indexed execution/frontier, prepared results and repair work               | Replacement source truth, consent, source disappearance proof or owner cleanup acknowledgement |
| Presentation/Web                   | A bounded configured aggregate, accessible controls and shared public rendering   | New native authority, empty proof from unavailable leaves or permission from a story fixture   |

Lifecycle acceptance must distinguish retract/delete/restore, moderator withholding, source-fence reduction,
candidate withdrawal, Context publication change, identity redirect, account suspension/deletion, media refusal,
generation retirement and final erasure. Restoring one resource must not resurrect independently fenced bytes,
private claims or an obsolete derived generation. Session/ETag/replay protects the exact intent; replays still
need current native authority. Imported communal identity and independently selected contributions must not be
deleted merely because one source record vanishes. Metadata licence, summary licence and cover credit remain
separate; Bangumi metadata/summary terms, VNDB database/content permissions, Open Library metadata and Wikidata
structured-data permissions are not interchangeable (E08–E10).

Upper-bound UI behavior is also a backend contract. A searchable Realm/kind chooser needs paged metadata,
current concealed outcomes and stable selection; it cannot receive all grants or all kinds to filter locally.
Every public section needs ready/empty/progress/unavailable/concealed distinctions with an actual retry or
continuation. Do not turn all unready optional leaves into repeated generic error paragraphs. Preserve readable
core content; show only designed previews on the main page and continue details in their owned views.

The fixed phone search panel should follow the WAI-ARIA [modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/):
accessible name, contained focus while modal, Escape/back dismissal, returned focus, keyboard reachability and
announced result/error state. Scope name/removal and Filters need independent accessible actions. These are
interface obligations, not new kernel endpoints. The supplied overflow screenshot demonstrates a layout defect,
not proof of wrong API data. Use one release-driven portrait frame and one image fitting rule across search,
home, subject relations and Collection rows/header; keep actual media dimensions and credit intact.

## Mainstream product survey and primary-source constraints

Sources accessed 2026-10-31. This bounded survey covers 23 relevant products, including Chinese and international
catalogues and mixed-content/community products. It is documentation/source research, not authenticated product
testing. A denied or unreadable site is retained as a limitation, with no invented capability score. Proprietary
help pages and screenshots are observation evidence, not assets or code licensed for reuse. Open-source licences
are recorded separately below; API/data terms are not software licences.

| Product      | Primary evidence and observed pattern                                                                                                                                                                                                                  | Relevance / limitation                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reddit       | [Official search features](https://support.reddithelp.com/hc/en-us/articles/19696541895316-Available-search-features), plus supplied desktop/phone screenshots: visible community scope, filters and query operators; one result-oriented search entry | Scope is an explicit operand, separate from presentation. Screenshots establish layout only, not its internal feed/search architecture                                                  |
| X            | [Official advanced search](https://help.x.com/en/using-x/x-advanced-search): words, people, place and date refinement; signed-in advanced surface                                                                                                      | Combine structured operands with text. Documentation does not establish an anonymous advanced API or REZICS ranking policy                                                              |
| YouTube      | [Official advanced search/filter help](https://support.google.com/youtube/answer/111997): refine after query by result types and other filters                                                                                                         | Result type and query scope are distinct; do not create a full page block for every kind                                                                                                |
| GitHub       | [Official search syntax](https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax): typed ranges/dates, quoted text and qualifier exclusions; code/non-code syntax differs                    | A documented grammar and error boundaries are part of the product; copying syntax wholesale would create incompatible semantics                                                         |
| Discord      | [Official search guide](https://support.discord.com/hc/en-us/articles/115000468588-How-to-Use-Search-on-Discord): server/DM context, author/channel/date/content refinements, desktop/mobile differences                                               | Search a known native population, with explicit mobile interaction. Experimental cross-DM behavior is not a universal guarantee                                                         |
| Slack        | [Official search guide](https://slack.com/help/articles/202528808-Search-in-Slack): result types and a Filters action, on desktop/mobile                                                                                                               | Mixed owners need common navigation and authorized result types, not one new backend per tab                                                                                            |
| Notion       | [Official workspace search](https://www.notion.com/help/search): title-only, creator, accessible Teamspace, contained-page and date filters; database search has narrower content semantics                                                            | Define population and matching precisely. “Search this Space” needs the same explicit distinction; plan-specific access is not a scope bypass                                           |
| Steam        | [Official search surface](https://store.steampowered.com/search/): query, sort and refinement within games/products                                                                                                                                    | Useful dense discovery reference. No inference about its private ranking/storage; landscape source art does not decide REZICS's fixed portrait default                                  |
| Goodreads    | Supplied full/top subject screenshots; [referenced subject URL](https://www.goodreads.com/book/show/175688141-glorious-exploits) was unreadable through this tool                                                                                      | Static evidence shows summary/details/editions folding, previews, reviews and related lists. It supplies information hierarchy, not available REZICS backend sections                   |
| Douban Books | [Official tag catalogue](https://book.douban.com/tag/): search accepts book/author/ISBN and browsing exposes named tags including light novels                                                                                                         | Chinese catalogue distinction between identity search and classification. A tag label does not establish measurable word count or a Type identity                                       |
| Bangumi      | [Official API site](https://bangumi.github.io/api/) yielded no readable lines; inspected official server source `internal/search/subject/{handle,doc}.go` below                                                                                        | Source proves bounded subject search, typed filters, summary hydration and index fields. No authenticated UI claim; five launch-oriented subject types are not 200,000 extensible kinds |
| AniList      | [Official API documentation](https://anilist.gitbook.io/anilist-apiv2-docs) and linked query reference describe the API used by the product                                                                                                            | Useful standard for a usable API-driven reader/contributor journey. Not proof that every action is available to every client or that its fixed media schema fits REZICS                 |
| MyAnimeList  | [Official API reference](https://myanimelist.net/apiconfig/references/api/v2) was inaccessible through this tool                                                                                                                                       | No claim about current filter, write, edition or permission coverage; do not fill the matrix from memory                                                                                |
| VNDB         | [Official Kana API](https://api.vndb.org/kana): explicit filters, requested fields, pagination and independently documented list operations                                                                                                            | Field selection and conservative query contracts are useful. VNDB metadata/content licensing still limits Imports; source creative content is not automatically reusable                |
| Open Library | [Official Search API](https://openlibrary.org/dev/docs/api/search), plus work-search source below, separates work and edition information and selectable response fields                                                                               | Strong work/edition/card metadata reference. Its offset/Solr approach and public dataset policy are not a substitute for current private source authority                               |
| Wikidata     | [Official statement help](https://www.wikidata.org/wiki/Help:Statements) and [structured-data licensing](https://www.wikidata.org/wiki/Wikidata:Licensing): multiple statements, qualifiers, references/ranks and explicit unknown/no-value            | Preserve statement meaning and evidence. CC0 structured data does not license linked documents/images, and identity is distinct from approximate classification                         |
| IMDb         | [Official advanced title search](https://www.imdb.com/search/title/) returned 403                                                                                                                                                                      | No current layout/filter/API capability inferred from inaccessible content                                                                                                              |
| Letterboxd   | [Official advanced-search article](https://letterboxd.com/journal/advanced-search/) was inaccessible                                                                                                                                                   | No current behavior claimed; no unofficial review substituted                                                                                                                           |
| Spotify      | [Official Search API](https://developer.spotify.com/documentation/web-api/reference/search) returns typed item families with separately paged collections and documented limits                                                                        | Demonstrates mixed type metadata; separate per-type pages are not one globally lossless heterogeneous frontier. Do not infer that shape meets a 200,000-kind home                       |
| Discogs      | [Official developer site](https://www.discogs.com/developers) returned 403                                                                                                                                                                             | Music release/master and cover assumptions were not imported from memory                                                                                                                |
| Qidian       | [Official catalogue](https://www.qidian.com/all/) timed out                                                                                                                                                                                            | No current word-count taxonomy, filter or extraction permission inferred; REZICS must use actual released measured facts                                                                |
| Bilibili     | [Official search](https://search.bilibili.com/all) redirected to a browser-upgrade page                                                                                                                                                                | No real result/filter observation. The access failure does not establish a backend absence in that product                                                                              |
| TMDB         | [Official movie search reference](https://developer.themoviedb.org/reference/search-movie) documents original/translated/alternative titles and explicit query parameters                                                                              | Multilingual identity retrieval is separate from catalogue type expansion and Realm authorization; no client requests were sent                                                         |

Shared patterns supported by the readable primary evidence are visible scope, text plus typed refinement,
bounded previews, named result kinds, explicit continuation, requested summary fields and deeper owned detail
surfaces. No inspected product justifies rendering one full section per possible kind or Realm. These are
design patterns, not claims that those products implement REZICS's stronger current-source privacy model.

There are material disagreements. Spotify's separate type pages, Open Library's work/edition Solr fields,
Bangumi's fixed typed catalogue and Discord's contextual message search solve different populations. Adopt
their explicitness and summaries, not their schemas, default image frames, privacy policy or pagination limits.
REZICS should implement these patterns in its existing TypeScript/PostgreSQL/OpenSearch/DBOS stack, through
the present native owner ports and generated API clients.

The W3C [SKOS reference](https://www.w3.org/TR/skos-reference/) distinguishes `closeMatch` from exact identity;
it is suitable for reviewed source/canonical classification correspondence without merging entities or expanding
filters implicitly. Schema.org's [wordCount](https://schema.org/wordCount) describes a word count, not page count,
novel form or a language-independent category. A light novel tag, a long-book threshold and an edition's page
count therefore need separate facts and declared units; missing measurements cannot be synthesized from covers,
titles, provider categories or an unknown summary.

### Inspected open-source reference register

Existing clones were reused under `/home/edge/projects/rezics/rezics-next/.reference/`; no reference code was
installed, built or executed. Sparse files were read with `git show HEAD:<path>`. The shared `INDEX.md` now
records this topic's reuse, revision, licence and date. Recommendations concern patterns to implement; no files
or long passages are proposed for copying.

| Project / local clone                                  | Pinned revision, source and licence                                                                                                                                                                                                                                                                                                                                                                  | Finding                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Open Library — `partitioned-sitemap-feeds/openlibrary` | `37e446827465be2febad416de1bc18753b66997d`; [worksearch/code.py](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/plugins/worksearch/code.py) `compute_work_search_html_fields`/`_prepare_solr_query_params`; `schemes/works.py` default fields/facets. AGPL-3.0, `LICENSE`                                                                  | Fetch title/author/year/cover/edition metadata for rendering, not per-card queries. HTML adds ratings/providers deliberately. Its `start=rows*(page-1)` is a deep-pagination limitation to avoid, not a model to port    |
| Discourse — `partitioned-sitemap-feeds/discourse`      | `589325e2b8466178ee83acac9ec411de555a0093`; [lib/search.rb](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/lib/search.rb), `initialize`, `limit`, search-context/Guardian checks. GPL-2.0-or-later per source/project; `LICENSE.txt` contains GPLv2                                                                                                            | Header/full-page limits and private-message context have real authority checks. A UI context alone is insufficient. Its page offsets do not satisfy REZICS's upper-bound source/continuation contract                    |
| Wikibase — `catalogue-editorial-journey/wikibase`      | `f04124242a234a3c37f96d4be3b6ace69aebde17`; [ItemMergeInteractor.php](https://github.com/wikimedia/mediawiki-extensions-Wikibase/blob/f04124242a234a3c37f96d4be3b6ace69aebde17/repo/includes/Interactors/ItemMergeInteractor.php), `checkPermissions` and merge/redirect interactor; API `repo/includes/Api/MergeItems.php`. Inspected PHP GPL-2.0-or-later; `COPYING` has nested-package exceptions | Merge permission is distinct from ordinary edit permission; revisioned content and redirect creation are explicit. Useful separation, without importing its transaction/cross-owner completion assumptions               |
| OpenSearch — `search-rating-populations/opensearch`    | `4ee42a94e87f66fbf1e62a9871b1b87f91e02472` (3.9.0); [SearchSourceBuilder.java](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/builder/SearchSourceBuilder.java), `searchAfter` and `pointInTimeBuilder`; Apache-2.0, `LICENSE.txt`/`NOTICE.txt`                                                           | Mature engine owns query/PIT/sort traversal primitives. Current owner privacy, retained proof custody and authorization remain application responsibilities                                                              |
| Bangumi server — `shelves/bangumi-server`              | `1997713eafc51487cbea705b37011442f35539fa`; [subject/handle.go](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/internal/search/subject/handle.go) and `doc.go`; SPDX AGPL-3.0-only headers, `LICENSE.txt`                                                                                                                                                           | Default 10/max 20 hits, typed date/tag/rating filters, native summary retrieval and declared index attributes. Good bounded reader pattern; its finite type enum and ranking rules do not settle REZICS kinds or privacy |

### Legacy behavior: useful reference, explicit upper-bound failures

Old REZICS was read only at `/home/edge/projects/rezics/rezics`, revision
`95167ceab7173dc1c5fb0ee70568c5c95f1dba8d`. Old rezics-next was read only through
`git show legacy-final:<path>` in this worktree. Neither was merged, copied or executed.

| Actual source                                                                                                                                    | Behavior retained as evidence                                                                                   | Upper-bound limitation / lesson                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old REZICS `apps/web/features/explore/home.tsx`                                                                                                  | One `ApiFeedList`, infinite pagination, sort/content/language/Realm/tag query state, centred bounded-width main | It already has a mixed stream rather than one catalogue row per kind. Finite `SimpleFeedContentKind` and explicit Realm arrays are not a 200,000-kind/5,000-follow design                                                             |
| Old REZICS `apps/web/features/content-feed/data/api-feed-list.tsx`                                                                               | One `postApiFeedQuery`, default limit 20, cursor; loaded pages flattened/deduplicated in client                 | Response paging is useful; indefinite retained client pages still grow with browsing. Do not download a person's entire memberships or create literal follow arrays in every query                                                    |
| Old REZICS `apps/web/features/collections/data/collection-content.ts` and `apps/web/features/collections/components/collection-content-feed.tsx` | Limit 50/cursor, membership target retained, real FeedItemCard, load/error/retry states                         | Direct source-backed cards give Collections meaningful covers/content. Flattening/deduplicating all loaded pages is not a million-item header derivation and may collapse curated occurrence semantics                                |
| Old REZICS `apps/web/features/content-feed/components/feed-item-card.tsx`                                                                        | Distinct post/unit cards; subject image and UnitCoverFallback; unit `coverUrl` passed through                   | Supports the critique that a Collection should visibly render its supplied cover data. Its old owner-specific card dispatch is a behavior reference, not code to reproduce in the new generic system                                  |
| `legacy-final:apps/web/features/home/home-page.tsx`                                                                                              | Continue strip, tabs/filters and a real post stream; followed Realms mapped to controls; optional rail          | The inspected home is not literally only per-Realm blocks. A mixed stream already existed. Rendering/using every supplied followed Realm as a control still needs bounded searchable discovery at hundreds/thousands                  |
| `legacy-final:apps/web/features/home/server.ts`                                                                                                  | Follow-state/default-view reads, bounded Continue 6; trending comment says at most two works per Realm          | A per-Realm bound alone is not a global bound: 300×2 could imply 600 without a separate total cap. This is a cost warning, not a claim that an uninspected native producer actually returns 600                                       |
| `legacy-final:apps/web/features/feed/feed-list.tsx:489` and `legacy-final:apps/web/features/feed/card.tsx`                                       | One `posts.map` mixed feed, native continuation/failure states, per-item Realm metadata and reasons             | A bounded heterogeneous page is the reusable pattern. No evidence in these inspected paths justifies asserting that every card rendered 20 independent rating panels; the supplied critique is not substituted for exact source proof |

### Supplied visual artifacts actually inspected

No new screenshots were captured. These are supplied references, not evidence of the current public deployment.
Encoded pixels are not inferred CSS viewports; theme, browser/version, capture revision and authentication are
unknown unless stated. They were staged by exact-path copies under the authorized temporary directories.

| Actual artifact                                                       | Encoded extent / identity                           | What the observation supports and cannot prove                                                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.temp/goal/web/refs/maintainer-20261031/reddit-search-panel.png`     | 596×983; supplied Reddit desktop search crop        | Scope chip and integrated recent/trend/community search panel; no backend or full viewport inference                                                                             |
| `.temp/goal/web/refs/maintainer-20261031/rezics-filter-panel-bug.png` | 678×615; supplied Collection/filter crop            | Controls visibly extend beyond their narrow region. Linked example `pages-library-collection--signed-in` is the maintainer's cited story, not a current locally captured ID/pass |
| `.temp/goal/web/refs/maintainer-20261031/goodreads-subject-top.webp`  | 2000×1383 image extent; supplied book detail        | Expanded details/editions and read/rate/buy actions illustrate progressive disclosure; no claim that REZICS has equivalent native producer for every section                     |
| `.temp/goal/web/refs/maintainer-20261031/goodreads-subject-full.webp` | 662×2000 image extent; supplied full-page reduction | Summary, author, related items, reviews, discussion and lists occupy different depths. Reduced text is not used to invent exact counts or API semantics                          |
| `.temp/goal/supermanager/refs/mobile-home-reference.jpg`              | 1440×3200; phone capture metadata 2026-10-31        | One header search entry and a mixed-content stream. The visible advertisement is not a requirement to add advertising                                                            |
| `.temp/goal/supermanager/refs/mobile-search-open-reference.jpg`       | 1440×3200; phone capture metadata 2026-10-31        | Full-screen search with back action, history/trends; does not prove focus/keyboard behavior or a 390 CSS viewport                                                                |

Current source story evidence is separately bounded: `pages-library-collection--supplied-book-facts-illustrative`
comes from `SuppliedBookFactsIllustrative`; `pages-subject-sources--all-source-record-fields` and
`--no-source-records` come from the current Sources story. Those are story data/consumer assertions, not current
live native responses. Their owner review targets phone 390/desktop 1280 are unexecuted here. The maintainer's
`patterns-subjects-subject-rating--ready` and purchase-entry empty example require the public completeness
audit's existing captures to judge current served appearance; this backend report supplies their owner ports,
not another exhaustive Pages/Patterns campaign.

## Recommended coherent slices, priority and dependencies

Estimates below express engineering size and owner coordination, not measured duration or a new task contract.
Small means a focused consumer/configuration correction; medium means a connected existing-owner journey;
large means producer/lifecycle/default assembly; extra-large means a new product representation or population
contract. Preserve current frozen acceptance. Add genuinely missing user outcomes when an owner adopts a slice;
never weaken a current test to make an incomplete producer appear ready.

| Order / priority                               | Coherent result                                                                  | Size                                                  | Dependencies, acceptance boundary and reason for this order                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 / P0                                         | Current public population, atomic reductions and useful default Search           | Large                                                 | Semantic native projection/reduction + Accounts discovery reductions → Search binding/custody/worker/default runtime. Capture every authoritative reduction, repair actual index generations, validate whole-query status including zero output, preserve current Auth/disclosure, recover finite useful pages. Existing T11/T13 express much of this; no additional UI adapter can unblock it |
| 2 / P0, design in parallel with 1              | A 200,000-kind meaning/discovery representation                                  | Extra-large design, staged implementation             | Definitions/Semantic authority first; immutable paged metadata, bounded point/batch admission, release compatibility, publication/retirement and client cache. Search registry/facets and Web pickers consume it. Cannot fix by setting `types=200000` and sending one full blob                                                                                                               |
| 3 / P1                                         | One real global mixed Account/subject search and native facet/suggestion journey | Medium–large                                          | 1, then actual optional provider/default assembly, format-complete generation and native owner hydration; facets need real provider too. Same public source truth for results, kind metadata, counts, suggestions and trends. Web already has mixed typed consumers; keep failure honest                                                                                                       |
| 4 / P1                                         | Library/Collection scoped search from header through current owner results       | Large                                                 | 1 + Commerce canonical Source/private owner preparation; Search resource grammar, current auth and text/order semantics; Web route/action/scope/history/Filters. Preserve duplicate editor occurrences while search hits remain canonical; include loss of permission and later pages                                                                                                          |
| 5 / P1, selected parts parallel                | A complete subject overview → editions → creator → full section journey          | Medium                                                | Existing E03–E06 bodies/threads/realm selection, plus 1 for configured catalogue lists. Imports editing entry; Search continuation; Content/Commerce host leaves; Web folding/empty/retry/a11y/SSR. Test real exits and current hidden/source-retracted data, not merely node presence                                                                                                         |
| 6 / P1                                         | Consistent portrait frames and always-visible Collection cover region            | Small consumer/configuration + medium native fallback | Fixed decision needs no vote. Definitions/Web/Commerce align both hint systems/fallbacks, retain contain/credit/actual dimensions. Commerce adds bounded current member-image derivation; until ready Web uses a real placeholder and pending state, not invented media                                                                                                                        |
| 7 / P1                                         | Identity steward can admit/poll safe merge and observe published identity        | Large                                                 | Semantic operation ABI/store + Search/Commerce/Accounts/Content participants. T04 remains the oracle; publication follows real custody completion, not durable job creation or receipt alone                                                                                                                                                                                                   |
| 8 / P2                                         | Realm and Zone scoped current discovery, then special homes                      | Large                                                 | 1/3/4; Content Realm enumeration/drain and Accounts current bans, Semantic Zone compiled predicates/source union, Commerce complete source variants, Search ordered preparation. Existing static Zone behavior remains independently usable                                                                                                                                                    |
| 9 / P2, product contract before implementation | One natively mixed home, signed-out and signed-in                                | Extra-large new slice                                 | Feed scope/owner adoption first; bounded heterogeneous candidates, public/current owner hydration, ranking inputs and missing-source policy, one consumed frontier, follow/mute handling, private Continue isolation. No per-kind/per-Realm fanout; special Space/Zone composition consumes real supplied populations                                                                          |
| 10 / continuous owner debt                     | Full lifecycle/native/physical/served evidence at integrated revision            | Cross-cutting                                         | Reuse current native fixtures, frozen outcomes and sole capture publisher; verify default provider assembly, permission revocation, sparse/empty/restart, erasure late writers, three-scale costs and 390/1280 UI when later authorized. Desk research/typechecking cannot certify those results                                                                                               |

Priority 1 is a dependency, not permission to leave a half-finished visual product indefinitely. Bounded consumer
repairs using already supplied data can proceed alongside producer work once the Goal resumes. Public-source
truth, private owner preparation, Source custody, derived-copy custody and final erasure acknowledgement need
their actual owners; another orchestration layer or new service would hide rather than resolve those seams.

### Decisions and uncovered work

Only two product choices genuinely need maintainer adoption beyond routine owner implementation:

1. **Mixed home scope and ownership.** Current scope defers feeds and assigns no owner. Options are retain the
   fixed curated catalogue home until later, or explicitly bring a bounded heterogeneous feed into scope.
   Recommend the latter to meet the stated product direction, with a narrow first contract: current readable
   catalogue/community/Collection candidates, explicit public/private separation, deterministic documented
   initial order, no promise of a full personalized recommender. Assign one owning Goal before implementation.
2. **What “search this Space” includes.** Options are a clearly labelled Realm discussed-subject search, or an
   explicitly typed mixed Space population with declared contained resource domains. Recommend the explicit
   mixed population as the eventual Space contract, with a separately named Realm scope only where actually
   available; never silently equate address, membership, publication Context and search population.

The 200,000-kind representation is an owner design obligation under an already fixed quantity, not a request
to reduce that quantity. Portrait defaults, no tagline, centred field/right Filters/phone panel and bounded
selection likewise require correction rather than a maintainer vote. Selection independence, current permission,
source licensing, concealed outcomes and honest readiness are established contracts, not optional tradeoffs.

Explicitly uncovered by this attempt: current native passing status; all physical costs and latency; the sole
public audit's current rendered verdicts; full foreign-owner matrices for accounts/community/library/ratings/
commerce/notices; all-provider full-catalogue acquisition; all erasure copies/holds; a completed production
mixed generation/facet provider; the missing source ports; the new feed/Space semantics and upper-bound kind
representation. They are assigned above and must not be silently counted as implemented, exposed or tested.

Recorded research decisions: judge development source over stale negative status notes; distinguish the real
current Source inventory from the missing fixed-cut producer; distinguish native Collection source variants,
member covers and header fallback; count an illustrative DTO only as renderer evidence; treat feeds as a scope
gap and Space search as a semantic gap; retain all fixed visual/quantity decisions; use analytical bounds without
runtime measurements; retain inaccessible product references as limitations rather than imagined evidence.

Only this report is a tracked worktree change. Outside the declared report path, the authorized shared
`.reference/INDEX.md` was appended with five reused-source entries so later researchers can locate the exact
revisions and licences. The authority file and the six supplied artifacts listed above were also staged at
their identical `.temp/` paths for reading and image inspection. No other product, test, frozen file,
publisher, checkout or owner document was changed.
Original acceptance/native/browser/physical verification remains deferred under the current execution policy;
there is no changed code workspace requiring a local type check.
