# Subject pages, relations, editions and credits

Research inspected 2026-10-30–31, against repository commit
`5827ec24a05f57299ea50343b540eb81bd849c54`. This is evidence and a recommendation
for the existing **In** row in [scope](../scope.md), not an adopted design change
or proof of native, full-row or main delivery. No application, schema or test was
changed; no acceptance, browser, native or database check was run. The optional
local backend audit was unavailable; the contracts and implementation below were
accessible. External designs were read as documentation or source, never built
or executed.

The useful correction is to finish the existing generic subject journey:
canonical identity → typed public facts → bounded, traversable relations and
credits → evidence and rights, with private additions after hydration. Retain
the catalogue's existing profiles, Content's media/rating/community ownership,
and native Access. A separate book, author or credits backend would duplicate
mechanisms already present.

## Authority and research inventory

| Topic                                                          | Current design authority and implementation boundary                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public page information architecture                           | [Subject pages](../subject-pages.md), [Web Goal](../goals/web.md), [Web](../../apps/web/README.md); Web owns routes and rendering. [Composition](../../packages/composition/README.md) owns component/read planning.                                             |
| Identity, released types, relations and selected facts         | [Semantic](../../services/kernel/src/semantic/README.md), [catalogue](../../packages/definitions/README.md). Definitions describe relations and presentation; Semantic selects and discloses facts. Web does not infer facts from type names or external markup. |
| Account versus catalogue agent                                 | [Accounts](../accounts.md), with [supporting verification research](agent-verification.md). Verification links two identities; self-authored account presentation does not become sourced catalogue truth.                                                       |
| Current authority and personal actions                         | [Viewer actions](../viewer-actions.md), [Auth/session assembly](../../apps/web/README.md). Native Access decides; BFF sessions convey the real credential. A visible action, catalogue relation or paid order is not a grant.                                    |
| Cover, authored/imported text, rights, ratings and communities | [Content](../../services/kernel/src/content/README.md), [cover UI](../../packages/ui/README.md#cover). Semantic stores assertions/references; Content owns payload availability and rights. A rating population is not a Semantic Context.                       |
| Original source attribution                                    | [Source-record attribution contract](../../services/kernel/src/semantic/source-record-attribution-contract.md), with Imports supplying admitted trusted metadata. It specifies missing producer ports; its existence does not establish their delivery.          |

Existing research was read before the external comparison. “Primary-backed”
describes research evidence, not current runtime or promotion status.

| Existing report                                                                                                                                       | Evidence and reuse here                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Catalogue/Schema.org mapping](catalogue-schema-org-mapping.md)                                                                                       | **Primary-backed.** Reuse its work/edition identity separation, explicit web type metadata and Open Library source pin; re-read official APIs and templates. Do not restart its catalogue mapping decision.  |
| [Viewer actions](viewer-actions.md)                                                                                                                   | **Primary-backed.** The adopted batch authority contract now lives in `docs/viewer-actions.md`; consume that contract rather than another capability mechanism.                                              |
| [Subject sitemap publication](subject-sitemap-publication.md), [agent verification](agent-verification.md)                                            | **Primary-backed for their topics.** Reuse canonical/public-disclosure and identity separation; no sitemap or verification rewrite is needed for this report.                                                |
| [Anime release grain](anime-release-profile-grain.md), [Open Library import audit](imports-audit/open-library.md)                                     | **Primary-backed, domain-limited.** Preserve reviewed subject grain and rights boundaries; these do not justify adding profiles or copying upstream content.                                                 |
| [Web review](web-review-site.md), [system inventory](system-inventory.md), [Semantic integration audit](semantic-integration-audit-core-catalogue.md) | **Partial for this question.** Useful historical leads, not current proof. Current routes already have canonical checks and some cursor navigation; older blanket “missing” statements must not be repeated. |
| [Universal search](universal-search.md)                                                                                                               | **Primary-backed research with proposed extensions.** Reuse the existing header entry; proposed broader search producers are not delivered subject data.                                                     |
| Complete typed page → every relation page → actual source metadata → current withdrawal                                                               | **None as complete end-to-end evidence found in the inspected reports.** The owner contracts and partial runtime below provide the starting point.                                                           |

## Four directly relevant primary designs

Links were fetched/read on 2026-10-30–31. These comparisons recommend patterns
to implement in this repository's stack, not source files or passages to copy.

| Design and primary evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Useful pattern; limitation for REZICS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wikibase statements and REST.** [Official REST overview](https://www.wikidata.org/wiki/Wikidata:REST_API), [conceptual data model](https://www.mediawiki.org/wiki/Wikibase/DataModel).                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Entity reads retain statements, qualifiers, ranks, references and multilingual terms; unknown and absent values differ. This supports preserving credit roles and evidence through a typed DTO. A rank is not a truth guarantee. The model explicitly is not a concrete API binding: do not infer REZICS endpoints, authorization, page layout or source licences from it. The Swagger shell returned no readable operation text; endpoint-specific claims here rely on REZICS source, not that shell. Documentation is CC BY-SA per the page footers; Wikidata's structured namespaces are CC0, a separate scope.                                                                 |
| **Open Library work/edition/author traversal.** [Books APIs](https://openlibrary.org/dev/docs/api/books), [Authors API](https://openlibrary.org/dev/docs/api/authors); pinned [work](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/work/view.html), [edition](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/edition/view.html), [author](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/author/view.html) templates. | Distinct work and edition URLs/API resources keep edition-specific publisher/ISBN data in place; work editions and author works have traversable reads. Both web book templates can serialize as `Book` without merging identities; the author template distinguishes organizations explicitly. Apply that identity/navigation separation through native relations. Limit: bibliographic product assumptions, templates and upstream offset pagination are not our generic catalogue or cursor design. Code is [AGPL-3.0](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/LICENSE); this does not license all descriptions or covers. |
| **Schema.org relationship annotation.** [Role](https://schema.org/Role), [exampleOfWork](https://schema.org/exampleOfWork), [terms](https://schema.org/docs/terms.html).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | A relationship can carry a role; a creative work can link to another work through `exampleOfWork`/`workExample`. Use these as serialization vocabulary around existing native credit qualifiers and separate identities. Neither term defines catalogue release selection, persistence, inverse maintenance, fact provenance or Access. The site identifies a development vocabulary; it is not an implementation contract. Schema vocabulary is CC BY-SA 3.0 under the linked terms.                                                                                                                                                                                              |
| **Omeka S generic resources and templates.** [Items](https://omeka.org/s/docs/user-manual/content/items/), [resource templates](https://omeka.org/s/docs/user-manual/content/resource-template/).                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Resources can describe people/things and link other resources; templates guide properties, optional classes and interpretation. This supports released data-driven page profiles over a generic graph. Resource/value visibility remains a separate concern from template presentation. Limit: its curatorial permission model does not establish our disclosure, source-fence or cross-home transaction rules. Only official manuals were used here; their reuse licence was not verified, so no manual text/assets or implementation files are imported.                                                                                                                         |

The shared pattern is stable resource identity, explicit relationships, bounded
navigation and a presentation layer separate from stored meaning. Combining
these into one REZICS recommendation is an inference, not a claim that any one
source implements our whole journey. Keep one native relation with inverse
projections; render a human role and evidence without creating an intermediate
“credit product” or deriving identity from Schema.org output.

The reused Open Library clone is
`/home/edge/projects/rezics/rezics-next/.reference/partitioned-sitemap-feeds/openlibrary`,
commit `37e446827465be2febad416de1bc18753b66997d`; the reference index records
its reuse. No new clone or dependency was needed.

## Current UI ↔ API ↔ storage journey, and the remaining connection

### 1. Discover, open and canonicalize

**Current:** the shared header search and existing Collections cards lead to
subject links. [Subject hrefs](../../apps/web/src/subject/subject-href.ts) use
`/{locale}/subjects/{id}/{slug}`. The id-only route and stale-slug checks use
[load-subject](../../apps/web/src/subject/load-subject.ts): anonymous typed
`GET /v1/subjects/{id}`, an API merge redirect followed by a fresh read, localized
label selection and a current verified-agent account lookup through
`GET /v1/accounts?agent=…`. Subject routes preserve search parameters and issue
canonical redirects. Verified public agents use `/{locale}/@{handle}`; people
without an account remain subjects. Locale paths and page metadata are assembled
by [subject-head](../../apps/web/src/features/pages/subject-head.ts).

Native owners are [Semantic HTTP subjects](../../services/kernel/src/semantic/http/subjects.ts)
and Accounts. Persistent identity includes `semantic.subject`,
`semantic.account_agent_subject`, merge/identity records and Access account
records; a slug or translated name is never the identity. Unknown/undisclosed
subjects must not acquire a successful page from a cached label. Account
discovery and public attribution have different suspension/deletion rules in
the Accounts contract; do not expose suspension via an attribution lookup.

**Close the connection:** exercise locale, merge, account and former-handle
redirects together, preserving the requested supported view. There are separate
canonical paths in [subject.tsx](../../apps/web/src/features/pages/subject.tsx),
`load-subject.ts` and agent routes; the former emits a 308 account redirect while
the Web subject canonical contract uses 301. The duplicated `subjectUrlForView`
helpers in `load-subject.ts` and `subject-queries.ts` drop a view when the
destination is an account URL.
Reconcile these under the existing identity contracts, including the documented
former-handle forwarding window, rather than creating a second identity resolver.

### 2. Read and render the public subject

**Current:** canonical overview and view routes call
`POST /v1/pages:read` with `{target:{subject,view?},languages}` through the
[public query factories](../../apps/web/src/features/pages/subject-queries.ts).
The server client is anonymous; public query entries are distinct from personal
entries. [Presentation reads](../../services/kernel/src/presentation/reads.ts)
execute a deduplicated composition plan, forwarding actual credentials when
provided and using `withPublicStatementReader` for consistent public disclosure.
Composition bounds a page to 16 distinct reads/cost 128 and each preview to at
most 12. Released type/base/generic templates select the presentation.

The real subject response is `{subject,account,summary,related}`. Its closed
typed item includes revision/release/Context/resolution, terms, statements and
`relationCounts`. Statements retain value type, rank, qualifiers and references.
Native storage is `semantic.subject`, `revision`, `fact`, `candidate`,
`acceptance_current` and `adoption`, with definition releases and disclosure
records. Current Access and lifecycle decisions are reapplied at the native
read boundary; Presentation is not a grant issuer. Property labels come from
the subject's applicable release. Related identities, labels, types and cover
summaries are returned by the owner, with bounded current-disclosure reads;
Web must consume them rather than fetch each card separately.

[data.tsx](../../apps/web/src/features/pages/data.tsx) and
[overview.tsx](../../apps/web/src/features/pages/overview.tsx) already render
reader-facing terms, facts, Details and source regions, avoiding raw IDs for
unsupported reading values. They also use `bestRank`; this alone does not prove
the documented competing-claim/contested presentation. A failed read must remain
an unavailable section with retry, distinct from a successful empty list.

**Recommendation:** retain this typed read boundary. Attach any newly needed
bounded public representation to its owning response/composition read, carry
resolution and actual selected support through it, and render the public page
without JavaScript. Do not reuse a privileged page result for anonymous SSR.

### 3. Traverse editions, contents, appearances, credits and relations

**Existing contract:** edition/work identities remain distinct (`bf:Instance`
and `schema:Book`); `schema:exampleOfWork` supplies navigation. Credits use
released relation properties and native qualifiers, including credited-as
`wdt:P1932`, credit order and performed character `wdt:P453`. People and
organizations show Works, characters show Appearances. Role groups, inverse
labels, symmetry, order and filters come from definitions, not a Web vertical
enum. Related labels, media and source provenance follow the selected fact.

**Current native mechanism:** Semantic stores the canonical relation once and
maintains `semantic.outbound_link`, `inbound_link` and their Context/count
projections. `GET /v1/subjects/{id}/links` reads incoming relations;
`GET /v1/subjects/{id}/relations` reads outgoing relations; `/counts` supplies
bounded count/group information. These are real HTTP handlers in
`semantic/http/subjects.ts`, with current eligibility and returned summaries.
Keyset continuations bind the relevant query shape, not an unbounded graph walk.
Subject statements contain only the first 12 selected relation slots per
property, alongside counts; removing a renderer's slice cannot recover the rest.

**Current Web connection is partial:**

- [views.ts](../../apps/web/src/features/pages/views.ts) counts outgoing previews
  from returned statement length as exact, ignoring `relationCounts`. A capped
  preview can therefore suppress the full-list affordance.
- [subject-frame.tsx](../../apps/web/src/features/pages/subject-frame.tsx)
  continues only the first planned `links` or `collections` read. Its full-view
  rendering cannot page every role/property in a multi-read Works view.
- The dedicated [relations route](../../apps/web/src/routes/subjects/$id_.$slug_.relations.tsx)
  has real SSR cursor links and an inverse read. Its
  [view](../../apps/web/src/features/pages/relations-view.tsx) and
  [relation labels](../../apps/web/src/subject/relations.ts) describe incoming
  holders; they do not establish a complete bidirectional Relations page.
- Composition `PageRead` has no outgoing `relations` descriptor. Forward
  `LinkSection`/Credits lists use embedded statements, not the existing forward
  cursor endpoint. Forward card construction also drops related type/cover
  information already returned by the subject read.

**Recommendation:** connect the existing direction-specific endpoints through
one bounded composition contract; preserve each group's independent continuation
and exact/lower-bound count. Editions → work and author → works must return to
the canonical target; no copied reverse fact or author aggregation backend.
Render role grouping/order/credited-as/character/spoiler qualifiers from native
values, and current target summaries through the shared card renderer. A missing
or concealed target has no invented label, cover or successful raw-ID link.

### 4. Read cover, summary, fact evidence and source rights

**Current cover path:** native subject/search/list/links summaries carry Content's
cover summary. Web uses [cover-src](../../apps/web/src/media/cover-src.ts)
`/media/{media}/{format}-{width}`; Content's
[media routes](../../services/kernel/src/content/media-routes.ts) and
[download decision](../../services/kernel/src/content/media-download.ts) own
serving. `content.media`/`media_variant`, parent bindings, moderation and source
fences decide availability. Missing, rejected, erased or withheld media becomes
a placeholder without removing the subject. Original bytes are not a public
thumbnail; current rights decisions and supported variants control each request.
Cover credit is not the licence for catalogue facts or prose.

**Current text path needs a connection check:** Semantic document values identify
Content documents; `content.imported_field`/`authored_field` retain bodies and
rights. `GET /v1/documents/{id}` in the
[document routes](../../services/kernel/src/content/document-routes.ts) and
[document reader](../../services/kernel/src/content/document-read.ts)
perform exact subject/candidate/source disclosure and current erasure checks.
Web's `data.tsx` instead expects a renderable embedded `content.document` body.
The inspected page-read descriptors do not include a document read. Thus a
renderer accepting a fixture document is not evidence that a real summary reaches
SSR; bind this explicitly through Content's contract rather than sending raw
document IDs or inventing text. Imported erased documents and concealed authored
erasures have distinct owner-defined representations.

**Source metadata is specified, not delivered:** Web's Sources section accepts
`name`, record `url`, optional `licence` and `attribution`, plus cover credit,
reference URLs and identifiers. It reads `sourceRecords` reflectively, while the
native closed Item schema has no such field. The source-record contract names
the missing `semantic/source-records.ts`, HTTP mount, `semantic.source_record`
table and typed `subject.sourceRecords`. The proposed endpoint is
`POST /v1/source-records:setMetadata`, with Global trusted bulk authority
`subject:batch_write`, its own idempotency receipt and metadata revision/CAS.
It must not be presented as a working endpoint or ordinary editorial privilege.

The existing contract already settles the native shape and lifecycle: exact
original `(source, external_id)` tuple ownership, actual displayed-support
attribution including bootstrap terms and multiple originals after merges,
deduplication, grouped point hydration after releasing connections, and current
fences removing payload and its support together. Metadata does not create a
fact, revive a hidden contribution or revise a subject. It also identifies the
current term-provenance/fencing gap in `read-subject.sql`/`asFacts`.

Imports' registration descriptor, distinct metadata transport/journal ACK and
admitted-run binding remain **not yet frozen** there. Recommended sequence is
validated/sealed/admitted acquisition → trusted tuple metadata ACK → existing
new/bound/unchanged record path, before its shortcuts. No acquisition-side effect
or history backfill. Unknown rights remain unknown: no licence derived from a
hostname, source alias, CC0 bibliographic policy, or a cover's credit.

### 5. Public page, personal additions and neighboring Content regions

**Current:** [subject queries](../../apps/web/src/features/pages/subject-queries.ts)
separate public page/aggregate reads from browser-enabled personal library,
reader-preference, own-reaction and own-rating reads. The latter prepare the
actual BFF session and use private/no-store responses; route components enable
them after sign-in/hydration. Existing library/label/copy/progress writers remain
Commerce/personal work. `POST /v1/viewerActions` is the existing native batch
contract for exact operation-ID offers on displayed resources: visible denial
is `[]`, hidden/unknown is `not_found`, dependency failure is not empty success.
It must never enter public SSR, a shared DTO or sitemap. Commands authorize again.

[subject-ratings.ts](../../apps/web/src/features/pages/subject-ratings.ts)
already calls Content's subject ratings/source-statistics and separates own
vote operations. Keep named question/population, sample count and native privacy
threshold; do not turn source statistics or Realm populations into catalogue
facts. `RatingSummary` is connected to that UI, but `ReviewList` and `ThreadList`
in `overview.tsx` still render `FeatureEmpty`. An empty placeholder is not a
successful review/discussion read. Lists use existing Collections reads/cards;
their membership/privacy belongs to that owner.

### 6. Realm selection and accessible navigation

**Documented, not production-wired:** `docs/subject-pages.md` freezes optional
`target.realm` selection through community `readRealm` then `readPublication`,
with protected denial/ban returning 404. Genuine absent publication may fall
back independently to Global without leaking Realm metadata. Actual Context and
publication state must be revalidated after execution; bounded retry/503 handles
change. Current `presentation/http/pages.ts` target validation rejects `realm`,
and current `PageRead` does not bind it. A query parameter cannot substitute for
this protocol. Realm rating/review/discussion/list bindings are explicitly not
yet frozen; Content/Accounts/Presentation must settle them before Web claims
those regions as Realm-scoped. Sticky public statement disclosure alone does
not implement Realm selection.

**Current navigation:** overview and subviews have SSR URLs, sticky single-line
tabs and horizontal phone overflow in
[view-tabs.tsx](../../apps/web/src/features/pages/view-tabs.tsx). Active-tab
scrolling runs after hydration. The page contract hides redundant list tabs but
retains direct full-view URLs; empty or closed views redirect appropriately.
Current generic route handling explicitly checks reviews/discussion, which does
not establish every unavailable-view case.

**Recommendation:** use navigational anchors with current-page semantics for
document navigation; reserve tab-widget roles for a genuine tabpanel interaction.
The [WAI tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) describes the
latter's keyboard model. Check headings, focus, keyboard links, active-location
visibility, long localized labels and no-JS continuation on phone and desktop.
The [WCAG reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)
requires page reflow at 320 CSS pixels; a scrolling tab strip alone proves
nothing about the remaining page. These are later proof requirements, not visual
conformance established by reading CSS.

## Gaps by delivery state

| State                      | Concrete gap and owning boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Missing design**         | Composition has no reviewed complete outgoing/multi-group continuation contract. Imports metadata registration/ACK integration and Realm neighboring-region bindings remain explicitly unfrozen. These need decisions by the named owners; the native source-record DTO and catalogue grain already have authority and should not be redesigned here.                                                                                                                                                                                                                                                                                              |
| **Missing runtime**        | Source-record metadata persistence/command/read hydration and bootstrap-term source fencing named in its contract; admitted importer metadata dispatch; production Realm page selection/revalidation. Existing forward relation/count endpoints are present, so do not commission another relation store.                                                                                                                                                                                                                                                                                                                                          |
| **Missing UI/integration** | Outgoing full-list/count connection; independent Works/credit group pagination; bidirectional Relations; forward summary/type/cover use; complete credit qualifier grouping; typed real Sources; explicit Content document-to-SSR binding; review/discussion reads instead of unconditional empty placeholders; consistent identity/view and unavailable-view handling. Existing code supplies part of each region, not a completed journey.                                                                                                                                                                                                       |
| **Missing proof**          | One real typed public journey through canonical/locale/agent redirects, more than 12 relations in both directions and multiple credit roles, truthful counts/cursors, current hidden/erased targets and rights withdrawal, actual source tuples after merge, no private SSR leakage and accessible no-JS phone/desktop navigation. Existing [personal outcome driver contract](../../specs/web-personal-driver.ts) and focused Web tests are reusable proof boundaries; their presence does not establish a native binding or passing outcome. Document-body compatibility and cache freshness after lifecycle change also require owner evidence. |

No neighboring owner's checks were rerun. Current cache lifetimes and renderer
fixtures are implementation evidence, not proof that hide, erasure, membership
revocation or source fences have reached every public response.

## Ordered whole corrective slices

1. **Canonical public reading and availability.** Web regions: id/slug/view and
   `@handle` routes, `load-subject`, subject head/frame/query factories and
   navigation. API owners: Accounts identity plus Semantic subject disclosure;
   Content for actual summary documents. Close redirects with view/locale/query
   preservation, current unavailable resources, real text and honest partial
   failures in one SSR journey. Reuse the existing Auth assembly, header-search
   entry and document renderer. Smallest later proof: an anonymous no-JS visit
   across stale slug, merge and verified-agent transitions, then hide/erasure,
   with a real document, correct HTTP result/head and no private additions.

2. **Complete relation, edition and credit traversal.** Web regions: overview
   lists, Credits, Works/Appearances, Relations, `views`, `subject-frame` and
   shared CoverList. API owners: Presentation/Composition read planning and
   Semantic's existing `/links`, `/relations`, `/counts`; Definitions owns
   metadata only. Close both directions, correct counts, role qualifiers and
   every group's continuation together. Reuse existing Collections continuation
   conventions and type-renderer cards; do not take over their writers or add
   per-row reads. Smallest later proof: more than 12 editions and two independently
   paged author/credit roles, forward/back canonical links, localized inverse
   labels, hidden target and a truthful final page, with bounded owner reads.

3. **Original-source evidence through current withdrawal.** Web regions: typed
   Sources, Details, About and cover credit. API owners: Semantic source-record
   producer/read DTO, Imports trusted registration/admitted-run journal, Content
   exact source fences and document/media rights. Implement the already specified
   native contract and settle its named importer binding; do not create a Web
   metadata writer or change existing bootstrap receipts. Smallest later proof:
   native metadata ACK before both new/unchanged paths, actual SSR attribution
   for two original tuples after merge, correction without subject revision,
   and withdrawal removing only affected text/support. Reuse the contract's
   existing source-attribution/growth suites; mock source arrays are insufficient.

4. **Admitted Realm and neighboring public sections.** Web regions: page target,
   frame, Ratings/Reviews/Discussion/Lists and unavailable states. API owners:
   Content publication/community/populations, Accounts membership/Access and
   Presentation's documented Realm selection. First settle the explicitly open
   bindings; then connect real public reads and revalidation without disguising
   a Global result as Realm data or a failed dependency as empty content. Reuse
   Content's ratings and Collections producers. Smallest later proof: actual
   publication, genuine-absence fallback, denied/banned Realm and a late
   withdrawal, with the correct 404/Global/503 outcome and no Realm/private leak.

Across these slices, use the existing personal-driver work for real session,
consent, command and isolation outcomes. Checkout's
[currentEntitlement](../../apps/web/src/checkout/order.server.ts) already reads
and validates the current entitlement against its order; neither the subject
page nor this research needs a benefit engine. Header search, Collections,
type-presentation, Auth assembly and personal outcomes keep their current
writers. [Type presentation](../../apps/web/src/media/type-presentation.mdx)
already shares real Search/cover-list inputs; its supplied film-runtime fact is
explicitly a fixture, not another delivered fact producer. Each slice's later
served-page proof must include keyboard, no-JS,
phone/desktop and long-locale states where it changes navigation. This report
does not substitute for that proof or for owner adoption of the open decisions.
