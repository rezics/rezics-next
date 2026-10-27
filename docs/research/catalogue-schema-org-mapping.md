# Catalogue profiles and Schema.org serialization

Research evidence, inspected 2026-10-27. The reviewed mapping decisions are
recorded in the owning [catalogue](../../packages/definitions/README.md#schemaorg-subject-types)
and [SEO](../seo.md#structured-data) documents; this report remains supporting
evidence rather than authority.

## Mapping recommendation and adopted consumer policy

Annotate each concrete catalogue profile with the narrowest Schema.org class true
of every subject admitted by that profile. Keep the agreed optional
`Release.types[type].schemaOrgType` as a full `https://schema.org/Type` IRI.
The owning [catalogue](../../packages/definitions/README.md#schemaorg-subject-types)
and [SEO](../seo.md#structured-data) documents record the reviewed mappings and
consumer behavior. The web consumer uses explicit metadata for JSON-LD `@type`,
then its existing `schema:` mapping, then `Thing`; other consumers choose their
own fallback for missing metadata. The release does not prescribe a universal
fallback. No backend type switch, ontology import, runtime dependency, or
additional configuration language is needed.

The important exceptions are book editions, which can serialize as `Book` without
becoming identical to book works; fictional characters, which need `Thing` because
the profile includes machines, ships and organizations; and broad game add-ons and
software releases, for which `CreativeWork` is safer than an application or game.
Classification concepts and schemes have useful scoped correspondences to
`DefinedTerm` and `DefinedTermSet`, without asserting ontology-wide equivalence.
The complete inventory and evidence appear below.

## Repository scope and prior decisions

The inspected checkout is commit `b83e8ec43c3056755cc6593b35dafa2e52f2e7f0`.
Its compiled [release](../../packages/definitions/release/rezics.json) contains
**24 concrete type entries**. Count the entries, rather than using the older
17-type figure in the package README. Abstract classes are structural scaffolding,
not additional subject types requiring entries in the recommendation table.

Read alongside this report:

- [SEO, structured data](../seo.md#structured-data): publish the subject's mapped
  Schema.org type, from the same public facts that the page renders.
- [Subject pages](../subject-pages.md#principles): one type system with data-driven
  presentation; a page may concern a person, concept or edition as well as a work.
- [Catalogue overview](../../packages/definitions/README.md#bundled-catalogue),
  [compiler](../../packages/definitions/src/compile.ts), and
  [source-inventory rules](../../packages/definitions/sources/README.md): distinguish
  canonical identity, structural bases, external mappings and presentation metadata.
- The source profiles: [core](../../packages/definitions/catalogue/core.yaml),
  [book](../../packages/definitions/catalogue/book.yaml),
  [game](../../packages/definitions/catalogue/game.yaml),
  [visual novel](../../packages/definitions/catalogue/visual-novel.yaml),
  [anime](../../packages/definitions/catalogue/anime.yaml),
  [manga](../../packages/definitions/catalogue/manga.yaml),
  [character](../../packages/definitions/catalogue/character.yaml),
  [series](../../packages/definitions/catalogue/series.yaml),
  [classification](../../packages/definitions/catalogue/classification.yaml),
  [recipe](../../packages/definitions/catalogue/recipe.yaml), and
  [music](../../packages/definitions/catalogue/works.yaml).

Relevant existing decisions were read at discussion-repository commit
`f0850c4de99e6f2aea0ac9ea9bf771cd2b88ada4`:

- [ADR-0016, identity and type-specific version structures](https://github.com/rezics/rezics-next-discussion/blob/f0850c4de99e6f2aea0ac9ea9bf771cd2b88ada4/docs/adr/0016-identity-layer-only.md):
  works, editions, people and concepts are independently identified subjects;
  versions use the structures appropriate to their domain.
- [ADR-0023, content and semantic layers](https://github.com/rezics/rezics-next-discussion/blob/f0850c4de99e6f2aea0ac9ea9bf771cd2b88ada4/docs/adr/0023-content-and-semantic-layers.md)
  and [engineering document 19](https://github.com/rezics/rezics-next-discussion/blob/f0850c4de99e6f2aea0ac9ea9bf771cd2b88ada4/docs/engineering/19-content-and-semantic-layers.md):
  a subject and the content describing it have distinct responsibilities and identity.
  Changing a presentation mapping must not merge those resources or their storage.

This research neither migrates those topics nor changes the discussion repository.
The owning documents carry the current mapping and serialization policy; profile
annotation data remains a separate change.

## What the catalogue implementations actually do

### Open Library: preserve bibliographic identity, simplify web types

At commit `37e446827465be2febad416de1bc18753b66997d`, both
[work/view.html, line 136](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/work/view.html#L136)
and [edition/view.html, line 136](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/edition/view.html#L136)
emit Schema.org `Book` **microdata**. The native work and edition remain separate.
Its [work RDF template](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/work/rdf.html)
instead emits `frbr:Work`, with edition URIs related through `rdrel:workManifested`;
the [edition RDF template](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/edition/rdf.html)
uses bibliographic properties from several vocabularies.

The [author web template, lines 3–8](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/author/view.html#L3)
selects `Organization` from explicit `entity_type == 'org'` metadata, otherwise
`Person`; its [RDF template](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/author/rdf.html)
uses a FOAF agent type. This is evidence for separating web serialization from
native vocabulary, and for retaining an explicit person/organization distinction.
It is not evidence for inferring that distinction from a name.

Limit: these are executable templates with embedded type choices, not a general
declarative profile-to-JSON-LD mapping registry. Reuse the semantic separation;
the contract already chooses a more extensible transport for REZICS.

### BookWyrm: field mappings and protocol types are separate concerns

At commit `fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4`,
[models/book.py, lines 623–678](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/models/book.py#L623)
keeps edition identifiers and a `parent_work` reference on `Edition`.
[activitypub/book.py](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/activitypub/book.py)
declares different `Work`, `Edition` and `Author` protocol types. Those names are
not Schema.org classes. The
[Open Library connector, lines 27–92](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/connectors/openlibrary.py#L27)
uses lists of field-mapping descriptors, including remote names and formatters.
These descriptors are Python declarations with executable transformations, not
portable ontology-equivalence statements or a generic Schema.org type registry.

Its [book template, line 31](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/templates/book/book.html#L31)
uses Schema.org `Book` microdata, while its
[series template, line 18](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/templates/book/series.html#L18)
uses `BookSeries`. Native/protocol type fidelity therefore need not force a distinct
Schema.org class for each native type. This is corroboration of the book pattern,
not proof that BookWyrm implements the proposed JSON-LD transport.

### Omeka S: the direct multi-vocabulary, data-driven example

Omeka S supplies the closest mechanism at commit
`039a482a00b35cf168c9030593924ff1477c1c1e`.
Its [vocabulary documentation](https://omeka.org/s/docs/user-manual/content/vocabularies/)
and [resource-template documentation](https://omeka.org/s/docs/user-manual/content/resource-template/)
describe vocabulary classes and reusable metadata templates. A
[resource template stores a resource-class reference](https://github.com/omeka/omeka-s/blob/039a482a00b35cf168c9030593924ff1477c1c1e/application/src/Api/Representation/ResourceTemplateRepresentation.php#L22).
The generic
[resource representation, lines 55–65](https://github.com/omeka/omeka-s/blob/039a482a00b35cf168c9030593924ff1477c1c1e/application/src/Api/Representation/AbstractResourceEntityRepresentation.php#L55)
appends the resource's selected vocabulary class term to its JSON-LD types.
The [base serializer, lines 71–82](https://github.com/omeka/omeka-s/blob/039a482a00b35cf168c9030593924ff1477c1c1e/application/src/Api/Representation/AbstractResourceRepresentation.php#L71)
writes those types as `@type`. Its
[REST API documentation](https://omeka.org/s/docs/developer/api/rest_api/)
confirms that JSON-LD is the default representation.

The reusable pattern is metadata selecting an RDF class, with one generic
serializer emitting it. Omeka can use classes from different vocabularies; it does
not automatically translate an arbitrary native class into a Schema.org class.
REZICS needs the explicit presentation correspondence because its native identifiers
include BIBFRAME, Wikidata and SKOS. Omeka's multiple output types also do not change
the agreed single optional Schema.org target in this contract.

### Shared patterns and limits of the evidence

The implementations preserve resource identity while selecting types appropriate
to each representation. They keep work/edition links and distinguish agents;
metadata or mapping descriptors carry reusable choices, while serializers own
output syntax. None of these inspected paths requires declaring native classes
equivalent just to obtain a useful web type.

Only Omeka directly demonstrates vocabulary-class metadata flowing through a
generic JSON-LD serializer. Open Library and BookWyrm demonstrate the bibliographic
and presentation boundaries, using microdata for their web types. The combined
evidence supports the agreed design; it would overstate the sources to claim all
three already implement REZICS's exact profile mapping field.

## Identity, classification and serialization are different assertions

[JSON-LD 1.1 §3.5](https://www.w3.org/TR/2020/REC-json-ld11-20200716/#specifying-the-type)
identifies a node's type with an IRI. Thus the mapped `@type` still asserts
membership of that class for the subject. Presentation intent does not make an
inaccurate type harmless. It does, however, avoid asserting equality between two
classes: many native profiles may safely map into one broader Schema.org class.

[OWL 2 §9.1.2](https://www.w3.org/TR/2012/REC-owl2-syntax-20121211/#Equivalent_Classes)
defines equivalent classes as having the same instances. A native book edition
serializing as `Book` does not justify `bf:Instance owl:equivalentClass schema:Book`:
BIBFRAME instances cover published embodiments beyond books, while Schema.org
`Book` also serves abstract book works. The
[Library of Congress model](https://www.loc.gov/bibframe/docs/bibframe2-model.html)
separates Work, Instance and individual Item; REZICS's book profile narrows Instance
to a published book edition. The proposed annotation is scoped to that profile.

[SKOS §10](https://www.w3.org/TR/2009/REC-skos-reference-20090818/#mapping)
defines concept-mapping relations, including a transitive `exactMatch`, for
cross-scheme retrieval. They are not a way to select a JSON-LD class. Preserve
existing independently justified mappings, but add no `exact_mappings`,
`owl:equivalentClass`, `skos:exactMatch`, or subject `sameAs` solely for this output.
Work and edition URIs must remain different even when both output `Book`.

Schema.org's [data model](https://schema.org/docs/datamodel.html) allows multiple
inheritance and deliberately does not attempt a complete world ontology.
REZICS's structural bases organize admitted properties and targets; they are not
a complete mirror of that hierarchy. In particular `Recipe` and
`SoftwareApplication` currently have only `schema:Thing` as a structural base,
and the software-release entry has no bases. Neither fact determines its web type.

## Recommendation for every existing concrete type

The first column is the compiled release key; profile names disambiguate local
LinkML class names. Every value in the second column is the full recommended
`schemaOrgType` IRI, including deliberately generic choices. Linked Schema.org
definitions provide the external meaning; profile links above establish scope.

| Concrete release type / profile                    | Recommended full IRI                     | Correspondence and evidence                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema:Book` / book Work                          | `https://schema.org/Book`                | Abstract book work, independent of editions. [Book](https://schema.org/Book) and the work/edition example under [workExample](https://schema.org/workExample) support both levels; Open Library confirms the practice.                                                                                          |
| `bf:Instance` / book Edition                       | `https://schema.org/Book`                | This profile is specifically a published book edition, with ISBN, pages and publisher; those are [Book](https://schema.org/Book) properties. Preserve its work link with [exampleOfWork](https://schema.org/exampleOfWork). No claim about all BIBFRAME instances.                                              |
| `schema:VideoGame` / BangumiVideoGame              | `https://schema.org/VideoGame`           | A game work; [VideoGame](https://schema.org/VideoGame) covers electronic games with interaction and visual feedback. Platform aggregates do not create release subjects.                                                                                                                                        |
| `wd:Q689445` / VisualNovel                         | `https://schema.org/VideoGame`           | The current profile explicitly specializes VideoGame and represents the VN work, with staff, characters and separate releases. Use that declared scope and the [VideoGame](https://schema.org/VideoGame) definition, rather than infer `Book` from narrative content.                                           |
| `wd:Q20631656` / VideoGameRelease                  | `https://schema.org/CreativeWork`        | A distinct software release can represent multiple works and include partial/trial or patch releases. [CreativeWork](https://schema.org/CreativeWork) covers software; [exampleOfWork](https://schema.org/exampleOfWork) expresses realization without claiming every release is a standalone game/application. |
| `wd:Q209163` / GameAddOn                           | `https://schema.org/CreativeWork`        | Independently referable expansions and DLC include supplementary creative content; the profile does not require a standalone playable game. [CreativeWork](https://schema.org/CreativeWork) is warranted for the entire admitted scope.                                                                         |
| `schema:TVSeries` / TVSeries                       | `https://schema.org/TVSeries`            | The profile explicitly concerns animated television series. [TVSeries](https://schema.org/TVSeries) includes TV broadcast and associated online delivery; animation alone would not establish this subtype.                                                                                                     |
| `schema:Movie` / Movie                             | `https://schema.org/Movie`               | An animated feature or short film remains a [Movie](https://schema.org/Movie). Neither duration nor animation requires a separate Schema.org class.                                                                                                                                                             |
| `schema:TVSeason` / TVSeason                       | `https://schema.org/TVSeason`            | The contract is a separately identified television season, matching [TVSeason](https://schema.org/TVSeason). Keep the season distinct from its series.                                                                                                                                                          |
| `schema:Episode` / Episode                         | `https://schema.org/Episode`             | The profile admits an episode or other anime installment, without requiring TV provenance. [Episode](https://schema.org/Episode) spans media; [TVEpisode](https://schema.org/TVEpisode) would be a narrower assertion than this contract guarantees.                                                            |
| `schema:ComicSeries` / MangaWork                   | `https://schema.org/ComicSeries`         | A comic series independent of published volumes. [ComicSeries](https://schema.org/ComicSeries) covers sequential comic stories under one title; it is a Periodical/CreativeWorkSeries, not restricted to Japanese origin.                                                                                       |
| `schema:PublicationVolume` / MangaVolume           | `https://schema.org/PublicationVolume`   | An independently referable published volume in that multipart series, with ordinal and optional ISBN. [PublicationVolume](https://schema.org/PublicationVolume) includes parts of successively published or multivolume works; a bound volume need not be a single comic issue.                                 |
| `wd:Q95074` / FictionalCharacter                   | `https://schema.org/Thing`               | The profile includes fictional machines, ships and organizations. [Person](https://schema.org/Person) permits fictional people, but cannot cover this whole class; [Thing](https://schema.org/Thing) can.                                                                                                       |
| `wd:Q2620972` / StoryArc                           | `https://schema.org/CreativeWork`        | A named ordered range within a work is creative content. [CreativeWork](https://schema.org/CreativeWork) avoids assuming this range is itself a TV season, publication volume or separately published series.                                                                                                   |
| `wd:Q7725310` / Series                             | `https://schema.org/CreativeWorkSeries`  | A series of creative works, including nonfiction and mixed media, rather than a curated list. [CreativeWorkSeries](https://schema.org/CreativeWorkSeries) expressly allows related published items of different kinds.                                                                                          |
| `schema:BookSeries` / BookSeries                   | `https://schema.org/BookSeries`          | The profile is a series of books, matching [BookSeries](https://schema.org/BookSeries); BookWyrm independently uses this web type.                                                                                                                                                                              |
| `schema:Person` / Person                           | `https://schema.org/Person`              | Explicit person identity matches [Person](https://schema.org/Person). A creator credit alone must not turn an organization or software agent into a person.                                                                                                                                                     |
| `schema:Organization` / Organization               | `https://schema.org/Organization`        | Explicit organizational identity matches [Organization](https://schema.org/Organization). Open Library also uses explicit organization metadata rather than the fact of authorship.                                                                                                                             |
| `schema:SoftwareApplication` / SoftwareApplication | `https://schema.org/SoftwareApplication` | The profile explicitly promises an application, matching [SoftwareApplication](https://schema.org/SoftwareApplication). Its structural Thing base does not justify downgrading to Thing or guessing a game.                                                                                                     |
| `skos:Concept` / Concept                           | `https://schema.org/DefinedTerm`         | Current scope is classification concepts: named categories/tags, optionally with a focus. [DefinedTerm](https://schema.org/DefinedTerm) expressly covers subject classification. This is a scoped recommendation, not equivalence with every SKOS unit of thought.                                              |
| `skos:ConceptScheme` / ConceptScheme               | `https://schema.org/DefinedTermSet`      | A classification scheme organizing those concepts matches [DefinedTermSet](https://schema.org/DefinedTermSet), which includes category sets and classification schemes. Keep native SKOS membership/hierarchy semantics.                                                                                        |
| `wd:Q2095` / Food                                  | `https://schema.org/Thing`               | A substance consumed for nutrition is not necessarily a recipe, menu item, restaurant or saleable product. [Thing](https://schema.org/Thing) adds no unsupported commercial or instructional claim.                                                                                                             |
| `schema:Recipe` / Recipe                           | `https://schema.org/Recipe`              | Instructions and ingredients for preparing food match [Recipe](https://schema.org/Recipe). Its local structural base being Thing does not erase this direct correspondence.                                                                                                                                     |
| `schema:MusicAlbum` / MusicAlbum                   | `https://schema.org/MusicAlbum`          | An album as a collection of tracks matches [MusicAlbum](https://schema.org/MusicAlbum); that definition separately exposes album releases, so no extra release subject/type is implied here.                                                                                                                    |

### Boundaries that matter when applying the table

**Book work versus edition.** The Schema.org [workExample example](https://schema.org/workExample)
uses different Book nodes for a conceptual work and published editions. Preserve
edition ISBN, publication and pagination on the edition; do not manufacture those
properties on the work merely because both nodes share `@type`. This matches the
native identity distinction demonstrated by both library catalogues.

**Software release versus application.** `game.yaml` does not require every release
to be a standalone application. The existing
[VNDB inventory](../../packages/definitions/sources/vndb.yaml) records complete,
partial and trial release kinds, and a source `patch` flag omitted from projected
facts. Therefore the present contract cannot safely distinguish standalone games
from supplemental releases at serialization time. Explicit `CreativeWork` is the
conservative recommendation. Schema.org does support application versions through
[softwareVersion](https://schema.org/softwareVersion), but the existence of that
property does not prove every release is a `SoftwareApplication`. No patch flag
test, platform cross-product or source-specific serializer branch is proposed.

**Anime and manga.** Keep series, season, episode and volume subject IDs distinct;
part membership is not identity equality. Generic Episode covers the current
non-TV-specific installment contract. PublicationVolume covers a volume, whereas
BookSeries describes a collection of books and ComicSeries describes the manga
series. An ISBN does not itself settle series membership or change a volume's type.
These choices follow the linked definitions, not the page's display label.

**Characters.** Schema.org [character](https://schema.org/character) is a property
whose expected value is Person, not a universal fictional-character class. The
profile's non-person characters prevent a whole-profile Person mapping. Annotating
Thing is accurate, but does not by itself solve property-range correspondence:
a future property serializer must avoid claiming the Schema.org character range is
satisfied for a ship. Do not alter the native profile to accommodate web markup.

**Concepts and schemes.** A category concept with `foaf:focus` on a person remains
the classification concept, not that person. Retain separate identifiers. The
DefinedTerm recommendation relies on the current classification scope; it does
not assume every arbitrary SKOS concept is a formally defined term. If that scope
is broadened to unstructured ideas, Thing is the safe profile-wide replacement
until a narrower profile exists. A missing prose definition alone does not invent
one. Schema.org's `inDefinedTermSet`/`hasDefinedTerm` can express term membership,
but mapping native SKOS properties is separate from selecting this `@type`.

## Explicit annotation, inheritance and a new fixture type

Prefer an explicit annotation on every concrete profile, even when its native IRI
already belongs to Schema.org, or when the deliberate target is CreativeWork.
This makes semantic review visible and leaves missing-metadata behavior to each
consumer. A native HTTP Schema.org IRI is not itself the agreed HTTPS output
field; equivalence/exact-mapping lists are also not a source from which to guess
a target.

Local inheritance is useful evidence: VisualNovel specializes VideoGame, while
Series specializes CreativeWorkSeries. It is not sufficient output policy.
Edition inherits CreativeWork structurally but has an explicit Book
serialization; characters explicitly select Thing, and recipes and applications
have specialized web types despite their local Thing base. The release class has
no structural bases. These examples make explicit per-profile review preferable
to runtime ancestor walking. Do not add inheritance behavior to the agreed
transport.

A third fixture type can explicitly select a reviewed Schema.org class without
backend code: declare its normal catalogue type and `schema_org_type`, compile
and publish the release through the agreed metadata path, then render it through
the same generic lookup. For example, a new independently identified
creative-fragment fixture may select `https://schema.org/CreativeWork`. Its
native fixture CURIE does not need a backend case, an exact mapping or a new web
component to obtain that `@type`. A fixture can verify that an explicit value
reaches the graph and that a consumer's documented missing-metadata fallback
applies when the field is absent. For web, that chain is specified in
[SEO](../seo.md#structured-data). This describes a verification approach, not
implementation completion or an acceptance-test change.

The owning catalogue and SEO documents record the table and these scope
boundaries; profile annotations remain a separate task. Selecting a type alone
neither maps all its properties nor guarantees search-engine rich-result
eligibility; the public-facts and visibility rules in [SEO](../seo.md) still
govern graph construction. This report is supporting evidence, not a claim that
profile annotations or serializer implementation are complete.

## Source provenance, licences and method

All four repositories were shallow-cloned into the specifically requested
`/home/edge/projects/rezics/temp/catalogue-schema-org-mapping-refs/<project>/`.
They were treated as untrusted text: no installation, build, test or execution of
reference code. This explicit reference-clone destination was treated as the sole
exception to worktree-only writes. Only this report is a tracked change.

| Source snapshot                                                                                                                                                                                                                                                             | Licence evidence and use                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open Library `37e446827465be2febad416de1bc18753b66997d`, directory `openlibrary/`                                                                                                                                                                                           | Root [LICENSE](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/LICENSE): GNU AGPL v3. Read implementation patterns only; no code copied.                                                                                                          |
| BookWyrm `fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4`, directory `bookwyrm/`                                                                                                                                                                                                  | Root [LICENSE.md](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/LICENSE.md): Anti-Capitalist Software License v1.4, with use restrictions. Do not describe it as MIT or as an unrestricted open-source licence; no code copied.                    |
| Omeka S `039a482a00b35cf168c9030593924ff1477c1c1e`, directory `omeka-s/`                                                                                                                                                                                                    | Root [LICENSE](https://github.com/omeka/omeka-s/blob/039a482a00b35cf168c9030593924ff1477c1c1e/LICENSE) and [README](https://github.com/omeka/omeka-s/blob/039a482a00b35cf168c9030593924ff1477c1c1e/README.md#license): GNU GPL v3. Read generic class/serializer pattern only; no code copied. |
| Discussion repository `f0850c4de99e6f2aea0ac9ea9bf771cd2b88ada4`, directory `rezics-next-discussion/`                                                                                                                                                                       | Existing project decision context, rewritten in English as brief factual summaries. No root repository licence found; an unrelated third-party skill licence is not a licence for its ADRs. No source text/code copied.                                                                        |
| Schema.org linked type/property pages and [data model](https://schema.org/docs/datamodel.html)                                                                                                                                                                              | Official definitions inspected on the date above; pages identify V30.1, 2026-09-16, and warn that the site is the development version. [Site terms](https://schema.org/docs/terms.html) name CC BY-SA 3.0 for the schema. No ontology dump imported and no implementation copied.              |
| W3C [JSON-LD 1.1, 2020 Recommendation](https://www.w3.org/TR/2020/REC-json-ld11-20200716/), [OWL 2 syntax, 2012 Recommendation](https://www.w3.org/TR/2012/REC-owl2-syntax-20121211/), [SKOS, 2009 Recommendation](https://www.w3.org/TR/2009/REC-skos-reference-20090818/) | Primary standards. JSON-LD specifies the W3C permissive document licence; the older standards link W3C document-use rules. Cited/paraphrased, not incorporated as code.                                                                                                                        |
| Library of Congress [BIBFRAME 2.0 model overview, 2016-04-21](https://www.loc.gov/bibframe/docs/bibframe2-model.html)                                                                                                                                                       | Primary bibliographic model explanation. Referenced for the Work/Instance/Item distinction; no code or ontology data copied.                                                                                                                                                                   |

Patterns may be followed freely. Under this task's copying constraint, code may
only be copied from MIT, Apache-2.0 or BSD projects with attribution; none of the
three inspected implementation licences supplies that permission category.
No code copying is needed for this recommendation.
