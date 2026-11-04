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

- **Entry:** `apps/web/src/routes/search.tsx` exposes anonymous `/search`. The existing BFF supplies
  released public condition metadata even on the bare route. The shared header's Filters action opens
  the route's existing desktop region or phone sheet, now including the structured condition editor.
  AppShell retains its ordinary text form and PhoneShell owns its existing frame. Scoped header mode
  still requires an actual supplied route; unavailable scopes do not submit as Global. UI exposure
  does not grant native advanced admission or provide a Zone source.
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
- **Refinement and condition editing:** `search/condition-editor.tsx` extends the existing Filters
  region alongside its count-free refinement controls. Released types, facet properties, datatypes,
  units and qualifier declarations supply the structured AND/OR/NOT controls; qualifiers stay on their
  statement. Shared filter construction admits edits without persisting expanded saved definitions.
  The same `condition` URL field reaches the existing typed `subjects:search` caller together with
  simple text, refinements, kinds and existing opaque filters. Owner operands cannot be added here.
  No delivered saved-filter/resource selector exists on this surface, so retained references have no
  invented picker or writer. Native resource and kind applicability admission remains authoritative,
  including below OR/NOT. The editor adds no counts or per-result reads.
- **Continuation and failure:** The BFF retains typed native problem pointers for both mixed and
  explicit legacy reads. The editor associates nested errors with their fields and keeps submitted
  values, text and other predicates on refusal. Grammar validation retains unfinished edits locally.
  The current URL contract enforces 512 UTF-8 text bytes and 4,864 cursor characters. Tree, sort and
  result-language changes start without the previous hit cursor; the existing query signal reaches
  native fetches. Rating retains its one automatic restart; the other native 409 state offers a fresh
  read bound to the current tree and language. Missing definitions leave the tree retained with retry.
  Caller stories are `patterns-discovery-search-condition-editor--nested-phone390`,
  `--nested-desktop1280`, `--native-pointer-retention`, `--language-and-restart` and
  `--metadata-unavailable` (the same prefix applies). Native and Web visual proof remain separate.
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
- **Curation inspection:** `/curate/presentation` now has a separate active published inspection region.
  It makes one anonymous current `pages.read` with an existing Subject address (and optional Realm) or a
  configured route, then reads the response's immutable profile and separately observes the active head.
  The pinned profile digest and document must agree with the native selection through the existing
  composition helper. Native scope/key are the selection witness; the client does not reconstruct a Type
  hierarchy or claim the independently observed head was part of the aggregate snapshot. A changed active
  profile asks for another inspection. Unknown routes cannot become generic previews, and failed native
  reads never become a successful static shell. The native aggregate retains its 16-read/128-slot and
  current Context/publication/source bounds; the two control reads add no per-row body, media or Subject IO.
  The shared registry renders the actual returned title, cover, facts and document without admin feature
  slots or SEO scripts. Its query client sees anonymous session state and is separate from the curator's
  cache, and anonymous registry controls preserve the curator's imperative CSRF token. All inspection
  transport strips credentials and session tokens and uses `no-store`; editor
  state and publish/activate behavior are independent. The published region keeps its **ACTIVE published preview** label. A separate deliberate capture in the
  admitted editor sends the entire detached candidate, exact subject/account/route and view, and locale to
  native `pages:previewDraft` through a prepared reader-bound BFF. Its digest identifies the captured
  revision; subsequent edits stay local and mark that revision out of date. The existing isolated anonymous
  renderer retains native leaf failures and their supported siblings. Reader/admission, credential, target,
  locale and transport replacement retire pending work and output permanently, including a returning
  reader. Publication advice and recovery keep their own lifetimes.
  Decision: retry re-executes the captured revision; the capture action explicitly adopts later draft edits.
  The additive mounted schemas and local typed BFF seam are inputs to Content’s complete-input publisher;
  generated client declarations and OpenAPI remain publisher-owned. Additional personal host regions
  and supplementary rating/community reads are not synthesized by this inspection.
  Connected examples are `patterns-curation-presentation-resolution--current-resolution`,
  `--route-resolution`, `--denied`, `--unavailable` and `--draft-distinction`, using shared viewport,
  locale and theme globals. They use a recorded public Subject body inside clearly identified
  contract-shaped aggregate fixtures; native execution and Web visual review remain separate.

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
