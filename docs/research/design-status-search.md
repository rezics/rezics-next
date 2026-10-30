# Search, facets and discovery: design status

Desk review, 30–31 October 2026. This page covers exactly the **Search, facets and discovery** In row
in [Scope](../scope.md). Search also owns Kernel presentation and shared composition. Web owns the
Subject pages In row and the page experience; Search supplies aggregate contracts and collaborates
on its callers. This is design evidence, not a source-security audit or a completion declaration.

## Authority and existing evidence

[Search Goal](../goals/search.md), [conditions](../search-conditions.md),
[facets](../search-facets.md) and [filtered lists](../filtered-lists.md) own query meaning and budgets.
[Search](../../services/kernel/src/search/README.md),
[presentation](../../services/kernel/src/presentation/README.md) and
[composition](../../packages/composition/README.md) own their runtime boundaries;
[subject pages](../subject-pages.md) owns page organization and Context traversal.

Primary-source research already exists: [universal search](universal-search.md) compares official
product APIs and established source; [native cuts](public-filter-native-cut-current.md) examines
PostgreSQL/OpenSearch; [visibility witnesses](search-visibility-witnesses.md) examines authorization
and engine mechanisms; [worker outcomes](search-worker-outcome-harness.md) examines real lifecycle
harnesses. [Scoped text](library-scoped-title-plan-current.md) and [rating epochs](search-rating-epochs.md)
remain useful engine evidence, but their older title-only/PIT recommendations do not override current
conditions. The [end-to-end recommendation](search-end-to-end-design.md) adds official Open Library,
Algolia, Discourse, OpenSearch and HTTP/accessibility/JSON-LD sources, with provenance and licences.

## Actual reader journey and missing links

- **Entry:** `apps/web/src/routes/search.tsx` exposes anonymous `/search`; the bare route shows an input,
  while `q` or `type` loads results. AppShell's shared header submits the ordinary form. Its scoped
  mode needs an existing supplied route; without one it disables submission/suggestions. The header
  opens neither advanced admission nor a Zone source. No complete advanced/scoped Web query path is
  established by this seam.
- **Request:** `search/search.tsx` calls `POST /v1/subjects:search`, plus
  `POST /v1/subjects:facets`; `search/suggestions.ts` and `/api/search/suggestions` call
  `GET /v1/subjects:suggest`. Kernel `search/http/routes.ts` performs public/bearer admission and
  returns Subject summaries. These are exposed Subject APIs, not an all-kind facade.
- **Storage:** default `server.ts` binds the real rated Semantic SubjectSource and OpenSearch client;
  `search/work.ts` starts indexing. Semantic owns subjects, selected facts and released definitions;
  Content contributes public Global ratings and Commerce public Collection counts. Search owns
  `subjects-gN`, templates, generation metadata and relay checkpoints. Current hydration rejects stale
  candidates. It does not establish safety of exclusions, ordering or zero results under privacy lag.
- **Mixed result to page:** `search/results.tsx` links a Subject through `subjectHref` to
  `/subjects/$id/$slug`, with canonical account redirection where applicable. The configured page
  consumer calls `POST /v1/pages:read`. Account identity lookup already supports
  `GET /v1/accounts?ids=...`; it is not discovery. A native discovery producer/current-discovery guard
  and generic mixed hit consumer remain missing. Proposed `POST /v1/search:query` is not mounted.
- **Edition and creator traversal:** Search wires the remaining vertical journey on Web's Subject pages.
  The shipped CreativeWork and generic configurations add the released `schema:exampleOfWork` outgoing group;
  editions and creator Works compose the existing configured incoming lists and independent relation streams.
  The unfiltered `/relations` route now consumes that current grouped page rather than its older incoming-only
  reader. Semantic retains ownership of native streams, counts, qualifiers, disclosure and cursor limits.
  Cards and continuation preserve the selected Realm for fresh native Context resolution; bounded embedded
  statements never supply a native total. This is journey wiring, with native proof and Web visual review separate.
- **Refinement:** Web uses released definitions but displays only its first eight property controls;
  its type choices come from sampled facets, not complete configured-kind metadata. The current public
  facet envelope already omits counts. Its underlying sampled, count-ordered execution still lacks
  canonical complete value continuation; Web drops `next`. Kind counts are a separate narrow contract,
  never permission to restore property counts or public totals.
- **Continuation and failure:** Web transports result cursors and restarts rating 409 once. Its
  `search-params.ts` accepts only 2,048 cursor characters versus the adopted 4,864-character ceiling;
  `q` also has a character limit distinct from the API's UTF-8 budget. Other search failures reach a
  generic error boundary; failed facets can leave hits visible. Complete restart, invalid-input,
  preparing/readiness, unavailable metadata and final-page states need the shared native response path.
- **Private execution:** request-only Collection/Zone/Realm leaves require real native authority,
  including under NOT or a true OR branch. Owner state stays in Library. Contracts exist, but the
  public-filter Source/default consumer binding, eligible owner preparation and complete Account
  discovery are missing whole slices. `createCollectionSource` currently reports dependency
  unavailable. A string account principal, a scope chip or Search custody is not native authority.
- **Composition:** closed descriptors drive `readPage`; the sticky public statement reader retains
  caller authority. Web validates inline document values and derives prose/JSON-LD from shared page
  data. Content exposes `GET /v1/documents/{id}` for guarded bodies, including
  `content.authored_field`. The registry has no selected authored-document descriptor; current
  ThreadList/ReviewList lack read callbacks, and `pages.read` lacks the specified Realm selector and
  aggregate continuation. A body reference is not yet a composed authored-body journey.

## Remaining whole work and evidence level

The six existing artifacts are selected proposals pending owner adoption, not six completed journeys:

1. [Native runtime](../search-native-runtime-plan.md): bind the one Source/consumer/custody path to
   default reads and workers; populate, reconcile keys, activate, repair and recover useful pages.
2. [Index erasure](../search-index-erasure-plan.md): connect exact retained/physical copy custody,
   late-writer fencing and erasure to the existing identity participant.
3. [Mixed kinds](../search-mixed-kind-plan.md): Accounts supplies native active/unfenced discovery;
   Search evolves the same engine family and Web consumes typed mixed navigation and kind metadata.
4. [Facet runtime](../search-facet-runtime-plan.md): complete native value sources and retained,
   count-free canonical pages, including values beyond the current source sample and Web continuation.
5. [Page documents](../search-page-document-plan.md): bind selected Content body and JSON-LD,
   current Context/Realm authority and subject-thread/node continuation with Web and native owners.
6. [Composed closure](../search-composed-closure-plan.md): connect catalogue, Members, Everything,
   own-state, mounted Zone and configured TypeList through the same admitted semantics and budgets.

Source-present/callable, owner-reported typechecked, exposed and native-outcome-proven are distinct
states. Current route exposure and real custody fixes establish useful pieces; types and owner-reported
local typechecks establish structural work only. This review does not upgrade any of them to a native
pass, reverify another Goal's receipts or claim main/root closure. The end-to-end report assigns later
growth, SQL, Access, engine and byte proof to each whole slice. No runtime checks were run here.
