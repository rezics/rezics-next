# Anime publication release acceptance

This document owns the first-public AnimeRelease acceptance scenarios. The actual
[Definitions README](../README.md) owns released catalogue meaning and adoption;
[library profiles](library-profile-design.md) own personal capability selection.
The [grain research](../../../docs/research/anime-release-profile-grain.md) is evidence,
not a release or a competing authority. This specification freezes native cases before
configuration implementation. An absent required definition is a red, not a scope exclusion.

The approved narrow ADR-0031 exception admits `rezics:AnimeRelease`, full IRI
`https://rezics.com/vocab/AnimeRelease`, directly under `schema:CreativeWork`.
It has no exact Wikidata mapping. `schemaOrgType: https://schema.org/CreativeWork`
is presentation correspondence only. Movie remains an anime **work**, `bf:Instance`
remains Book Edition, and `wd:Q20631656` remains software release. None is an alias
or a parent supplying a library profile to AnimeRelease.

An AnimeRelease identifies an independently referable publication/distribution embodiment.
It is neither a playback file, personal Copy, distribution event nor automatically generated
platform-by-language product. Labels, languages, dates and carriers alone do not create identity.
One identified publication may contain several languages. Work, season and episode retain
independent identities; there is no mandatory season, Expression or synthetic anthology work.
A release embodies an actual work/season/episode through existing `schema:exampleOfWork`.
An anthology contains actual works through standard `bf:hasPart`, rather than asserting that
it is an edition of every contained work. A work may appear in several publications.

`marcrel:fds` credits an actual Person or Organization distributing the release. One
qualified statement retains credited wording (`wdt:P1932`), order (`schema:position`,
whose existing mapping is P1545), detailed role (`wdt:P3831`), rank and reference parts.
It is not a publisher substitution, language tuple or propagation of every work credit.
Missing source facts stay absent. The controlled authored facts below make no claim about
Bangumi/VNDB source coverage, real publication identifiers or automatic import mapping.

## Frozen native scenarios and bindings

The new suite is
`services/kernel/test/semantic/anime-release-user-cases.test.ts`. Its two exact scenario names are:

- `anime release is a distinct publicly readable catalogue subject with work and anthology relations and no library profile`
- `release grain preserves independent work season episode identities and existing eleven tracking profiles`

Both use version **1** of the actual
[shared released-discovery fixture](released-discovery-fixtures.md), imported from
`services/kernel/test/support/released-discovery.ts`. There is no duplicate fixture database,
replacement release, synthetic type registration, missing-driver permanent failure or callback.
The fixture publishes the identical `@rezics/definitions/bundled` object, reads active and
immutable definitions over HTTP, and compares their actual digest. It does not compile a
proposed class into a substitute bundle. Native `createSemanticDriver` in
`services/kernel/test/semantic/outcome-driver.ts` issues real Auth credentials, configures
real Access and invokes the production `createKernel().handle`; responses retain their
status, headers and original body. Native session headers remain the driver's responsibility.

The first scenario binds these outcomes:

1. `POST /v1/subjects` for `rezics:AnimeRelease` must return **201**, an actual created ID
   and the accepting bundled release. An absent type answering 422 fails that expectation;
   it never counts as delivery. The immutable HTTP definition has the approved IRI, bases,
   no mappings/library reference, eight nonempty locale labels, standard relation declarations
   and localized new property/inverse labels. Locales are de, en, es, fr, ja, ko, zh-Hans,
   zh-Hant. UI labels are independent of resource `schema:inLanguage` values.
2. Real returned TVSeries and Movie IDs distinguish the single-work publications and anthology.
   One anthology has two `bf:hasPart` slots, no synthetic parent, and no `exampleOfWork` facts
   falsely turning containment into editions. Another independently identified bilingual
   publication retains both ja and en while linking the same work; it is one subject.
3. `fixture.adopt` calls the real candidate proposal, Context acceptance and adoption routes:
   `POST /v1/subjects/{id}/candidates`,
   `POST /v1/subjects/{id}/candidates/{candidate}:accept`,
   `POST /v1/subjects/{id}:adopt`. The fixture uses actual Context, candidate, acceptance head,
   adoption head, revision and target-addressed relation slots. Public subject reads verify
   actual adopted target, scope, rank, qualifiers, citation parts/hash and release pin.
   References are the shared fixture's explicitly controlled authored assertions, not invented
   external publication evidence. The distributor/role are actual native created subjects.
4. Anonymous, outsider and Bob read actual release facts through `GET /v1/subjects/{id}`.
   Related distributor labels come from the real response. The distribution credit stays on
   the release; the work acquires no copied distributor. Outsider editorial adoption returns
   403 forbidden, not_applied and an unchanged public subject.
5. Existing native work releases/editions discovery uses
   `GET /v1/subjects/{workId}/links?property=schema%3AexampleOfWork&type=rezics%3AAnimeRelease&limit=10`.
   It returns exactly the two single-work publication IDs and next=null, excluding anthology
   containment. The filter property is the authored `exampleOfWork`, **not** inverse metadata
   `workExample`. Forward anthology discovery uses
   `GET /v1/subjects/{releaseId}/relations?property=bf%3AhasPart&limit=10` and actual target IDs.
   `fixture.catchUp` drains native link projections, not Search or page-publication workers.
6. Existing generic Collection creation/member routes curate the actual release ID with a note:
   `POST /v1/collections`, `POST /v1/collections/{id}/members` and
   `GET /v1/collections/{id}/members?limit=10`. Public and unlisted direct member reads succeed
   for anonymous/outsider/Bob. Private header/member reads return 404 not_found to those readers;
   Alice retains her member read. Unlisted direct readability does not claim public listing.
   Unauthorized membership writes return the current owner's 404 not_found, not_applied, for
   all three visibilities, and leave Alice's members unchanged. No domain-specific curation API
   or profile requirement is introduced.

The second scenario binds the exact existing eleven accepting type/profile references and
complete profile descriptors to the actual HTTP bundle. It reuses the existing
`launchProfiles`, `libraryProfile`, `compiledProfile` and `legacyProfile` expectations from
`packages/definitions/test/support/library-profiles.ts`, without changing that producer.
The registry retains eleven launch profiles plus the existing legacy-fixed-v1 descriptor;
AnimeRelease adds none. All existing states, units, copies and eight-locale labels remain intact.
TVSeries, TVSeason, Episode and Movie keep anime.series, anime.season, anime.episode and
anime.film respectively. Book Edition and software release keep book.edition and game.release.

Independent work, season, episode, standalone episode and Movie are created using native IDs.
An episode's `isPartOf` points to the actual season and `episodeNumber` remains the string `01`.
There is no invented Season-to-series edge through the Episode-only slot. Independent season,
episode and film publications each point to their actual content subject. No release becomes
an episode ordinal, parent container or source-record `schema:version`. The production
`selectLibraryProfile` selector returns null for AnimeRelease in the actual released definition,
with no ancestry/default Book, game, Movie or legacy fallback. This proves the released capability
selection; it does not claim owner state/session/holding HTTP mutations were executed.

## First-public consumer cells

Catalogue, work releases/editions discovery and curated Collections are first-public obligations.
They are not silently postponed by the absence of a release library profile. “Bound” below
means assertions exist against current APIs, not that a failing bundle has delivered the outcome.
No helper, native JSON response or composition validation proves a served Web page.

| Cell                         | Native binding or exact outstanding producer                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalogue subject/type       | Bound by the first scenario to bundled definitions, native 201 creation and public subject GET.                                                                                                                                                                                                                                                                                                                   |
| Catalogue release query      | **NOT YET FROZEN — Search:** bind the actual current catalogue query request, released AnimeRelease saved filter, exact ID set and page/preparation envelope; include work-only filter exclusions, sparse results and current disclosure. No route/response is guessed here.                                                                                                                                      |
| Curated Collection           | Bound by the first scenario to current Collection/member APIs for public, unlisted and private direct reads, notes and denied writes. Filtered curated discovery remains **NOT YET FROZEN — Search/Commerce:** actual common filtered-list request, exact release IDs, count-free initial wire and withheld-fact controls. Do not require unchecked counts or a rendered zero.                                    |
| Everything without state     | **QUALIFIES:** a readable unprofiled AnimeRelease with a current own live label and live parent belongs in Everything. No profile lookup, entry, state, session, holding, pin or state siblings are required. Native label/Everything binding remains **NOT YET FROZEN — Commerce** until actual code and its native assertions exist.                                                                            |
| Own typed state              | **N/A:** no release entry state, progress session or holding capability. Existing eleven work/edition/software profiles stay unchanged; work tracking must not move to publication IDs.                                                                                                                                                                                                                           |
| Mounted Zone                 | **NOT YET FROZEN — Semantic/Search:** use actual Zone creation/configuration/publication plus `POST /v1/zones/{id}:readPage`, current mounts and native Collection-source catch-up. Bind public/private/outsider disclosure, overlapping mounts, exact release IDs and the owner's 200 page or 202 preparation contract. Shared `fixture.sources` is still a prerequisite; link catch-up alone cannot prove this. |
| Work releases/editions view  | Native links/relations bound above. Served work-page view is **NOT YET FROZEN — Web/Search:** actual page producer/current route, view binding and rendering of native release IDs, anthology separation, links and empty state. No guessed page route or UI callback.                                                                                                                                            |
| Configured TypeList          | **NOT YET FROZEN — Definitions/Search/Web:** actual released anime saved release filter, eight-locale labels, reviewed Context defaults and inert Zone starter TypeList, validated presentation profile and served page. Preserve work-only all/films/series filters. No invented presentation format.                                                                                                            |
| Negative library HTTP writes | **NOT YET FROZEN — Commerce/Accounts:** authorize the current personal_library and reading_progress gates with real account scopes, then assert unsupported_library_profile/no effect for release state/session/holding writes and successful work tracking. Fixture v1 currently opens collections only; platform_closed would not prove profile rejection. The released null selector is already bound above.   |

N/A applies to fresh release-typed state/session/holding operations, not to Everything with an own live
label, catalogue, curation, mounts or public pages. Generic labels and Collection membership do not
require or supply a library profile or tracking state. Pending cells require
producer-native request/response and disclosure evidence before their own scenarios freeze; they must
not become permanent missing-driver failures or guessed API contracts.

## Producer conformance and verification

Configuration implementation adds no YAML executable, release-specific backend path, table, deployment,
recording rewrite or runtime inference here. The existing catalogue expansion acceptance remains required
producer evidence: `packages/definitions/test/vertical-bundles.test.ts`,
`packages/definitions/test/library-profile-expansion.test.ts` and
`services/kernel/test/semantic/expansion.test.ts` exercise the existing ten/hundred-manifest data expansion,
immutable pins, unchanged native OpenAPI/database catalogue and native operations. Preserve existing
anime-profile and library-profiles tests. Reuse these suites; do not invent another backend or duplicate
expansion database for this grain. The configuration producer owns generated bundle/recording updates.
These producer checks are required at implementation, not claimed run by this specification freeze.

Format these two new files before recording SHA-256. Run the focused native acceptance and root typecheck
once after the last relevant edit, through the worker check wrapper from the worktree root:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/semantic/anime-release-user-cases.test.ts
bun scripts/worker-check.ts -- bun scripts/typecheck.ts
```

The handoff reports both formatted file hashes, commit, actual exit statuses/logs and observed native reds.
A missing bundled type or pre-existing missing launch registry remains a required producer red; this
specification does not implement it or claim API/page completion. Existing frozen acceptance and owners
are unchanged.

## Cost

### Create, adopt, discover and dispose the controlled publication subjects

- Touches: one versioned native fixture and its owned Auth/database resources; a fixed set of native
  work/season/episode/release/agent/Concept subjects, fixed statements and three curated Collections.
- Bound: fixed scenario population, three native editorial requests per adopted fact, bounded reference
  parts, explicit limit=10 for these small relation/member pages and at most 200 native link projection
  steps per selected partition. Strict cleanup failures propagate. A small result does not establish
  engine-work growth bounds or filtered-list completeness.
- Growth check: no new runtime operation is implemented. Existing ten/hundred-manifest expansion remains
  required for the configuration producer. Search/Commerce/Zone producers must retain their native
  examined-work bounds with unrelated catalogue/history growth, sparse/deep pages and denied/empty paths;
  page helpers or fixed request counts cannot substitute for those measurements.
