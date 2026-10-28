# Anime publication release grain

Evidence inspected on 2026-10-29. This is a recommendation for owner adoption, not a definition release,
source binding, library contract, or declaration that the semantic Goal is complete.

## Recommended owner decision

Approve one narrowly scoped local, data-only class: **`rezics:AnimeRelease`**, an independently referable
published/distributed embodiment of anime content. Its full URI is
`https://rezics.com/vocab/AnimeRelease`; its LinkML parent is existing **`CreativeWork`**
(`http://schema.org/CreativeWork`). Give it no exact Wikidata mapping and no library annotation.
Use existing `schema:exampleOfWork` for a single-work embodiment, and add standard `bf:hasPart` for
the works included in an anthology release. Add the standard film-distributor role only when needed
to assert an actual distributor. These are catalogue declarations using existing compiler capabilities.

The local class is necessary because the evaluated standard classes either describe a different grain
or collide with an existing native class contract. This recommendation explicitly asks the owner to
approve this narrow domain-subtype exception to ADR-0031's preference for standard vocabulary; it does
not reinterpret that ADR as blanket permission to mint domain terms. Prefer the standard properties
below. Do not rename, generalize or reparent Book Edition, software release, or their library profiles.

Create a release subject only when a contributor or source can independently identify that publication
or distributed version, such as an identified home-video edition or identified localized distribution.
A different title label, language, format, distributor or date alone is not an algorithm for creating
another subject. Several formats/languages may belong to one identified release; no Cartesian product
is implied. No mandatory Expression, carrier, season or empty intermediate subject is introduced.

## Inspection basis and retained contracts

The worktree and inspected local `dev` both pointed to **`31a6191bdc18aaada7983ecdb174ed80c6c3a984`**.
All repository paths below refer to that pin, under the repository's AGPL-3.0-only licence. The prior
[integration audit](semantic-integration-audit-core-catalogue.md), integrated at
`186d49c92708821427bab9d1d9655e826f9bf6d0`, was read including its complete anime finding and surrounding
launch-profile evidence. Its historical main/promotion observations are not new execution evidence here.

The authoritative main-checkout `.temp/goal/managers/semantic.md`, “Next Done when: catalogue”, requires
anime work, season, episode **and release**, eight-locale presentation/Context/filter/Zone data, and
configuration-only expansion at ten and one hundred manifests. The tracked [semantic Goal](../goals/semantic.md)
also preserves the native statement/provenance/persona outcomes. This report discharges none of those tests.

Only engineering/11 §6 and the relevant standard-vocabulary, LinkML and expansion sections of ADR-0031
were consulted in the read-only discussion mirror at **`7ff5c2aa6034f8fbd9951cf477c040804b125f65`**:
[grain requirement](https://github.com/rezics/rezics-next-discussion/blob/7ff5c2aa6034f8fbd9951cf477c040804b125f65/docs/engineering/11-schema-classification-and-vertical-profiles.md#6-垂直資料粒度不能只給一張subject表),
[vocabulary ADR](https://github.com/rezics/rezics-next-discussion/blob/7ff5c2aa6034f8fbd9951cf477c040804b125f65/docs/adr/0031-standard-vocabularies-linkml-definitions.md).
No top-level licence was identified there; requirements are restated, not copied. In particular, §6 allows
independent episodes and multiple works in an anthology release, forbids filler subjects for a fixed hierarchy,
and separates personal Copy and playback/collection positions from work identity.

Inspected declarations and implementation:

| Path under `packages/definitions/` | Finding at the pin |
| --- | --- |
| `catalogue/anime.yaml` | Concrete `schema:TVSeries`, `schema:Movie`, `schema:TVSeason`, `schema:Episode`; no anime release. Episode `isPartOf` targets series/season; its string ordinal is separate from identity. TVSeason does not itself declare that slot. |
| `catalogue/book.yaml` | `Edition.class_uri = bf:Instance`, description explicitly published Book edition, exact mapping `wd:Q3331189`, Book presentation. Its `exampleOfWork` targets CreativeWork; that broad range is not an anime-release class. |
| `catalogue/game.yaml` | `VideoGameRelease.class_uri = wd:Q20631656`, explicitly software; shared work, platform, language and distribution terms. It imports anime, so adding an anime→game import would make a cycle. |
| `catalogue/visual-novel.yaml` | VN is a work subtype of VideoGame; its actual software releases reuse the game class. This remains valid. |
| `catalogue/core.yaml` | CreativeWork explicitly includes published realizations; common language/date/credit/identity fields exist. `version` describes the source-record revision, not an anime cut identifier. |
| `catalogue/classification.yaml` | Genre/tag/format values can remain Concepts in schemes, with `foaf:focus` when referring to another subject. No release identity follows from classification. |
| `src/compile.ts:150–340,450–551,685–725` | Restricted data keys, LinkML loading/induction, type bases/properties, explicit presentation `schemaOrgType`, named relation targets and metadata; no per-domain switch is needed. |
| `src/compile-library-profiles.ts:90–146`; `src/library-profile-design.md` | Nearest **whole** authored library declaration becomes a closed profile reference; no runtime ancestry merge/inference. A child of Edition could inherit Book operations. |
| `test/library-profiles.test.ts:640`; `test/support/library-profiles.ts:184–196` | Eleven accepting launch declarations, including `bf:Instance → book.edition`, Movie→anime.film and software release→game.release. Anime release is absent; preserve all existing expectations. |

The source YAML and generated `release/rezics.json` at this pin do not yet carry the agreed launch library
declarations/registry. The launch test is a required contract, not a claim that the bundle is already green.
Adding this class must not conceal that separate unfinished producer's work.

## Primary vocabulary evidence and rejected fits

The Library of Congress [BIBFRAME model overview, 2016-04-21](https://www.loc.gov/bibframe/docs/bibframe2-model.html)
distinguishes conceptual Work, published-form Instance (publisher, date, format), and individual-copy Item.
The official ontology repository additionally makes MovingImage a Work subtype, so animation is within
its descriptive scope; BIBFRAME is not intrinsically restricted to printed books.
[Pinned vocabulary source](https://github.com/lcnetdev/bibframe-ontology/blob/76753d48e12530eac19ad6091fd6c461eb1bed66/bibframe.rdf)
identifies vocabulary **3.0.1**, version IRI `http://id.loc.gov/ontologies/bibframe-3-0-1/`, issued 2025-12-03,
and CC0-1.0. Inspect the `bf:Instance`, `bf:Item`, `bf:MovingImage`, `bf:instanceOf`, `bf:hasPart` and
`bf:Distribution` elements there. `instanceOf` has Instance domain and Work range; `hasPart` describes
physical/logical inclusion, with suggested use/value Work, Instance, Item or Event. Distribution is a
ProvisionActivity subtype, not the distributed edition itself. These definitions justify the boundary;
they do not migrate native Book identity to a general publication class.

Schema.org sources are the official term definitions and the pinned source listed in the provenance section.
The following comparison concerns semantic fit, not similarity of names:

| Candidate | Decision |
| --- | --- |
| [`schema:Movie`](https://schema.org/Movie), TVSeries, TVSeason, Episode | Retain their native anime creative identities. Schema.org itself allows these types at work/expression granularity (its titleEIDR discussion distinguishes edits); that flexibility does not make the repository's existing Movie work/profile a publication-release witness. An edit identity alone also does not identify its distributed publication. |
| [`wd:Q20631656`](https://www.wikidata.org/wiki/Q20631656) | Wikidata defines software made public. Reject anime reuse; keep actual Game/VN software releases and their current profiles. Wikidata structured data is CC0; this mutable page was inspected on the date above. |
| `bf:Instance` | Standard publication boundary is relevant, but this native IRI is already concrete Book Edition. Reusing it or inheriting Edition would attach Book semantics/profile to anime. Generalizing it would require a separate migration, outside this recommendation. |
| `bf:MovingImage` / `bf:Distribution` | Respectively a Work and distribution activity. Neither is an anime publication class. |
| [`schema:VideoObject`](https://schema.org/VideoObject) / MediaObject | A video file/media encoding can implement playback. It does not establish independently identified publication identity. |
| [`schema:PublicationEvent`](https://schema.org/PublicationEvent) | An event of publication/broadcast/on-demand availability; multiple events may concern a release. Reject as the version itself. |
| [`schema:CreativeWork`](https://schema.org/CreativeWork) / [`exampleOfWork`](https://schema.org/exampleOfWork) | Suitable broad base and realization relation, but neither supplies the missing concrete accepting release type. `exampleOfWork` is also used for derivations, so the class contract must supply the narrower publication meaning. |

The common pattern is separation of intellectual content, its distributed embodiment, individual holding,
and distribution event or encoding. No evaluated source supplies a drop-in native anime-release class
without losing one of the existing boundaries. The local subtype implements that pattern in this
repository's existing definition compiler and generic TypeScript/Bun/PostgreSQL subject API.

## Concrete configuration proposal and assertion scope

Use `AnimeRelease.is_a: CreativeWork`, `class_uri: rezics:AnimeRelease`, and explicit
`annotations.schema_org_type: https://schema.org/CreativeWork`. The latter is presentation metadata,
compiled as `schemaOrgType`; it is neither exact identity, a Wikidata mapping, nor runtime type inference.
Do not declare `is_a: Edition`, `bf:Instance`, VideoGameRelease, or LaunchWork. No global Instance base
or OWL intersection is needed. Do not claim that this local class formally inherits BIBFRAME Instance.

| Property and exact URI | Proposed domain/range and use |
| --- | --- |
| Existing `schema:exampleOfWork` (`http://schema.org/exampleOfWork`) | Add the existing slot to AnimeRelease; global range stays CreativeWork and existing multivalued setting stays unchanged. For this profile, target an independently identified TVSeries, Movie, TVSeason or Episode whose content this single-work edition embodies. Existing relation metadata is derivation, inverse `schema:workExample`, date order, acyclic. Do not widen its native contract to make an anthology an edition of each included work. |
| New slot `animeReleaseContains`, standard `bf:hasPart` (`http://id.loc.gov/ontologies/bibframe/hasPart`) | Domain AnimeRelease; `any_of` ranges TVSeries, Movie, TVSeason, Episode; wikibase-item, multivalued, membership group, inverse `bf:partOf`, name order, acyclic. An anthology may have several contained works; a work can occur in several releases. No single-parent or track-placement claim. `bf:partOf` is inverse metadata, not a second authored slot. |
| New slot `filmDistributor`, standard `marcrel:fds` (`http://id.loc.gov/vocabulary/relators/fds`) | Domain AnimeRelease; Person or Organization, wikibase-item, multivalued, credit group, qualifiers creditedAs/position/detailedRole, position order, inverse `rezics:filmDistributionOf`. This inverse names a derived view, not another identity. |

The official [MARC relator list](https://www.loc.gov/marc/relators/relaterm.html), film distributor [fds],
defines distribution of moving-image resources to theatres or other channels. It differs from publisher
and from distributor [dst], whose definition specifically concerns marketing rights. The list is a live
LoC standard inspected on 2026-10-29, without an asserted numbered release. No licence to copy the list
is inferred; only term identity and short paraphrases are used. This proposal introduces no invented QID.
`bf:hasPart` and `marcrel:fds` are genuinely absent catalogue terms, supplied by standard vocabularies;
the only new local accepting class is AnimeRelease. Existing relation annotations support both slots.
Existing `schema:isPartOf` is episode→series/season with inverse `schema:hasPart`; it cannot be repurposed
for anthology containment. Using `bf:hasPart` also avoids authoring that already-reserved inverse IRI.

The existing fields suffice for the following assertions, when actually evidenced:

- `name`, `alternateName`, `url`, `sameAs`, `image` identify/describe the release using their existing
  meanings. Same-as requires real identity evidence; a source record about a work is not its release ID.
- `inLanguage` is multivalued resource language, distinct from labels in eight UI locales. It cannot
  distinguish subtitle/audio/menu roles by itself. A multilingual edition can remain one release.
- `distributionFormat` (`wdt:P437`, Concept) already means distribution format/physical medium;
  it applies to a release, unlike `workFormat` (`wdt:P7937`, anime creative form). `releaseType`
  (`wdt:P31`, Concept) is usable only for actual complete/partial/trial-style release classification,
  not an invented anime taxonomy or replacement for the subject's accepting type.
- `datePublished` is that release's publication date; a work's original date does not fill it. Source
  precision, references and competing candidates remain intact. No territory/date event structure is
  inferred. If distinct scoped facts cannot be expressed by admitted qualifiers, leave that distinction
  unasserted for its owner to define, rather than flattening it into one apparently exact date.
- `publisher` remains publisher and `translator` remains translator when the corresponding release
  actually credits them. Author/director/voice/contributor credits may describe work or release-specific
  contributions at their actual scope. Use existing credited-as, position and detailed-role qualifiers;
  do not copy all work staff onto every release or use publisher to stand for film distributor.

Audio/subtitle language roles and an edition/cut designation would need precise additional configured
terms if structured source assertions require them; standard `schema:subtitleLanguage`, for example,
exists but is not currently declared here. Existing `schema:version` is a source-record revision and
must not be silently repurposed. Neither distinction is required to create/read an independently
identified release, and this recommendation does not introduce a parser, qualifier framework or query engine.
Missing source language, dates, distributors, identifiers and coverage remain missing.

Anime Work/Season/Episode remains creative identity. AnimeRelease is shared publication identity.
A person's physical **Copy** is their holding of one release, not a shared Subject or a new release.
A playback media file is an encoding/asset, with its own bytes/locator, not either of those identities.
No personal-library import, progress conversion, music Recording/Release redesign, or runtime profile
inference follows from this proposal. In particular, inherit no library operations from CreativeWork;
absent a library reference means unsupported operations, not a fallback to book.edition or game.release.

## Exact future handoff, without editing those files here

The existing release/profile/recording producer must sequence any adopted configuration with its work.
The later data-mapping documentation owner binds real sources after adoption. This report changes
none of their files or semantics. Expected paths are:

| Future path | Necessary action or explicit retention |
| --- | --- |
| `packages/definitions/catalogue/anime.yaml` | Add the class, two standard slots and their prefixes; reuse existing fields by name. AnimeRelease need not import game: the root already imports all schemas, and compiler induction resolves the complete supplied vocabulary. Preserve the current import DAG. |
| `packages/definitions/presentation/anime/de.yaml`, `en.yaml`, `es.yaml`, `fr.yaml`, `ja.yaml`, `ko.yaml`, `zh-Hans.yaml`, `zh-Hant.yaml` | Labels/descriptions for new type/properties and inverse labels in all eight locales. These eight names are relative to the same anime directory. |
| `packages/definitions/contexts/anime.yaml` | Review new properties under existing defaults; `{}` remains valid. No suppression or different authority is implied. |
| `packages/definitions/filters/anime.yaml` | Add a separately labelled releases saved filter for the new type. Preserve the existing work-only `all`, films, series and before-2000 meanings. |
| `packages/definitions/presentation/anime/zone.json` | Add the release filter to scope and an inert starter route/list using the existing TypeList component; preserve existing pages. This does not instantiate a Zone. |
| `packages/definitions/catalogue/rezics.yaml` | Already imports anime; no new import is needed. Its release version is producer-controlled. No Book/Game/VN library declaration changes are required for this class. |
| `packages/definitions/release/rezics.json` | Producer runs `bun run --cwd packages/definitions release`; do not hand-edit. |
| `apps/web/src/kernel/recorded/definitions-active.json`, `apps/web/src/kernel/recorded/definitions-release.json` | Producer regenerates the matching pair with `bun run --cwd apps/web record -- definitions-active definitions-release` in the same configuration change. |

There is no anime JSON Forms/UI-schema file in the inspected presentation directory. Do not invent a
new presentation file format for this missing type. Existing declared properties/facets and presentation
labels are the available inputs; a distinct custom form would require its own established consumer contract.
No source inventory or converter edit is proposed by this evidence report. Source identifiers and mapping
versions must come from actual source inspection by their writer, not a fabricated binding here.

## Native API witness to register after adoption

An actual existing pattern is
[`services/kernel/test/semantic/expansion.test.ts`](../../services/kernel/test/semantic/expansion.test.ts):
`sourcesFor`/`compiledRelease`, `kernelFor` with native `createAccess`, `grantEditor`, `handle`,
`serveVertical` (lines 174–217), and the files-only end-to-end test (273–340). That test publishes and
activates a compiled release through HTTP, compares OpenAPI and database catalogues before/after,
then creates, proposes, accepts, adopts and reads through the mounted generic API. It is a real
test pattern, **not an existing anime-release witness**. Its reference URL fixture proves input shape,
not external source coverage; do not reuse it as an anime publication citation.

After the configured class is included in released definitions, add an independent focused native test
(for example `services/kernel/test/semantic/anime-release.test.ts`), leaving frozen tests intact:

1. Compile the adopted bundle with `compileCatalogue(bundledSources())`, publish via
   `POST /v1/definitions/releases`, activate via `POST /v1/definitions/releases/{digest}:activate`
   with the actual `expected_head`, and verify the active digest. Do not patch a database type row.
2. Use `POST /v1/subjects` with `{type, labels}` for TVSeries work, TVSeason, Episode, and
   `rezics:AnimeRelease`. Use **returned** subject IDs throughout. Create and read Movie separately
   as the existing work-type control, not as a release alias. No invented external IDs or release facts.
3. Propose Episode `schema:isPartOf` → returned Season ID, and release `schema:exampleOfWork` →
   returned Season or work ID. Candidate body uses `statement: {property: {id}, value:
   {type: 'value', content: returnedId}}`; attach references only for genuine evidence. Accept via
   `/v1/subjects/{id}/candidates/{candidate}:accept` with Context and expected head, then adopt via
   `/v1/subjects/{id}:adopt` with property, **target**, selection/rank and expected head.
   Explicit target addresses relation slots, as in `specs/semantic-outcomes.test.ts:746–823` and
   `services/kernel/src/semantic/http/subjects.ts:350–369`; do not rely on an old helper's omission.
4. Read each through `GET /v1/subjects/{id}` (and Context view where relevant); assert distinct IDs,
   accepting types, adopted targets/ranks, related labels, candidate references and release meaning.
   Do not assert a Season→series edge through the Episode-only `isPartOf` slot. The independent
   Work/Season records and Episode parent already test their grains without inventing that edge.
5. Separately create an anthology release and two independently referable work subjects through the
   same APIs; adopt `bf:hasPart` for both target slots, read both back, and retain the works' own IDs.
   Assert it has not become two editions, a synthetic parent work, a Copy or a playback file.
6. Retain the expansion pattern's unchanged OpenAPI/database-schema assertions, plain-data key
   restrictions and historical release pins. This demonstrates configuration-only operation, with
   the same deployed kernel and no anime branch, table, deployment or executable configuration.

That is a native **input/data** witness design; it does not assert that Bangumi, VNDB or another source
already supplies an anime release record. The owner must register real native fixture data and its
expected facts, then run the acceptance. For source-backed coverage, bind an actually independently
identified publication and preserve its references; lack of a source binding does not invalidate
manually contributed native facts or justify manufacturing source coverage.

Keep the existing `packages/definitions/test/anime-profile.test.ts` and add separate assertions for
the missing class, containment, labels and the unchanged Book/software meanings. Preserve
`test/library-profiles.test.ts`, `test/library-profile-expansion.test.ts`, `test/vertical-bundles.test.ts`
and the ten/hundred-manifest native expansion acceptance. Preserve all four core personas in
`specs/semantic-outcomes.test.ts` and its native wrapper `services/kernel/test/semantic/outcomes.test.ts`;
the focused witness must not replace anonymous/editor/Context-acceptor/suspended-account coverage.
None of those tests, native checks, gates, check hosts or reference-project builds ran in this research.

## Proven applicability and remaining evidence

The current compiler and native expansion test bodies establish a generic route for data-defined types,
released relation terms, immutable activation and API writes/reads. They do not establish a configured
anime release, its actual source binding or a native anime-release execution receipt. The recommendation
is one local accepting subtype with standard relation reuse/additions, preserving existing identities
and library contracts. Owner adoption, sequenced configuration/release generation, real source binding
where available, and registered native acceptance remain separate future steps.

Reference clones were read as untrusted data only; nothing was installed, built or executed from them.
They live under the main checkout's allowed `.reference/anime-release-profile-grain/` directory and
are registered in `.reference/INDEX.md`. BIBFRAME pin/licence are above. Schema.org was inspected at
**`b0b19f7fab48caa1f2cbee1f1149e2aee8dec896`**, in a shallow sparse clone: stable vocabulary **30.1**,
[`data/releases/30.1/schemaorg-current-http.ttl`](https://github.com/schemaorg/schemaorg/blob/b0b19f7fab48caa1f2cbee1f1149e2aee8dec896/data/releases/30.1/schemaorg-current-http.ttl),
especially CreativeWork (line 1257), Movie (3389), PublicationEvent (4265), VideoObject (5533),
titleEIDR (18540), exampleOfWork (20033) and workExample (21179). `data/schema.ttl` was also retained.
Live term pages above identify themselves as development documentation; the pinned release is the
repeatable vocabulary evidence. Schema.org's [terms](https://schema.org/docs/terms.html) license the
schema under **CC BY-SA 3.0**; repository supporting software has **Apache-2.0** `LICENSE`.
No implementation or long source passage is copied. Outside the report, the only writes are these
two permitted reference clones and their ignored index entries, for repeatable source inspection.
