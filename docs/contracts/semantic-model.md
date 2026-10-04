# Native semantic model

## Identity and reference grains

A Resource has a stable logical identity, owner, lifecycle and admitted
capabilities. RDF types describe it without changing its writer or granting
authority. Registered structural types select shapes and operations;
[descriptive types](classification.md#restricted-structure-and-open-vocabulary)
add no behaviour. Genre, form and topic are Concepts, and groupings are
[Saved Filters](queries.md#decisions). Native IDs use UUIDv7 and `https://rezics.com/id/{uuid}` in RDF;
routes, dataset placement, internal TDB2 nodes and external IRIs remain separate.
An ID is neither a causal clock nor an access secret. Identity correction
retains old references under the [correction protocol](identity-correction.md).

| Reference | Required grain |
| --- | --- |
| ResourceRef | One stable referent. |
| RevisionRef | One exact retained component state. |
| OccurrenceRef | One use or placement, distinct from its target. |
| FragmentRef | A revision-qualified block, span, time range or selector. |
| RepresentationRef | Exact bytes or encoding; a locator alone is insufficient. |
| DefinitionRef | Exact versioned meaning, operation or scoped interpretation. |
| ExternalRef | Provider and namespace qualified source identity, without fabricated native equivalence. |
| PrincipalRef | Private verified authority, distinct from a public Agent. |

The [Resource profile](../../model/definitions/semantic-resource-v1.ts) keeps its
current envelope open to admitted types and seals its exact revision. Owner
operations choose which reference alternatives they accept. A universal parent
record, mandatory Tag/Path/Sense bundle or type-based privilege is unnecessary.
Resource summaries still need a resolved name and typed avatar or stable
fallback under the [presentation contract](presentation.md#resource-summaries).

## Definition responsibilities

The long-term model separates seven decisions: ResourceDefinition fixes referent,
owner and lifecycle; ValueDefinition fixes exact representation and missingness;
RelationDefinition fixes roles and occurrence grain; ConstraintProfile fixes
validation scope; OperationContract fixes authority, CAS and outcomes;
StorageBinding fixes the authoritative writer and recovery path; ExchangeMapping
fixes direction and loss. The current [compiler IR](../../model/compiler/ir.ts)
implements a selected shape/command-registry subset, while domain owners hold
their operation and storage contracts. A general runtime compiler for all seven
families remains prospective; untrusted definitions cannot install executable
code or grant authority.

## Types, capabilities and Access

Maintainer and product manager, 2026-09-30. Types describe; capabilities behave;
Access authorizes. A [capability](../product/platform-thesis.md#capabilities)
such as facets, measurements, location, schedules, releases, credits, lists,
ratings, discussion or follows is implemented once in Main and bound to types
through validated definitions that declare prerequisites, property bindings,
owner commands with authority and outcomes, projections, query budgets and
conformance fixtures. It attaches to any admitted resource, not only Works: a
place, an organization or a person carries ratings, lists and discussion through
the same operations. An imported predicate or `rdf:type` never grants authority;
conflicting bindings fail activation; absent data never yields a misleading map,
score or availability claim. The reason is that behaviour keyed to Works forces
every other domain either to be mistyped as a Work or to grow its own backend
path.

## Values, relations and admission

Exact integers, decimals and rationals cross JSON as lexicals. Temporal values
retain precision, calendar and original offset; derived UTC bounds are query
aids. Quantities retain unit, kind and uncertainty. Language and direction,
source uncertainty, unavailable references and erasure are explicit rather
than inferred from a missing triple. The
[exact-value definition](../../model/definitions/value-exact-v1.ts) and
[codec](../../services/main/src/modules/semantic/value.ts) specify the admitted
subset; broader value and geometry profiles require their own owner contract.
Name records retain same-language alternatives, source and validity; locale
cannot silently change authored meaning. Valid, recorded, observation and
operational times remain distinct. Spatial values retain CRS and axis order.

Direct predicates carry ordinary accepted scalar facts. An identified
`rdf:Statement` carries a source-qualified or contested binary claim without
asserting its base edge. Repeated or role-qualified associations have distinct
occurrence IDs, even with identical participants. Statement meaning pins its
speaker, relation/interpretation DefinitionRefs, exact value and semantic
Context revision; viewer defaults and navigation paths cannot retarget it.
Equal meaning does not merge acceptance scopes or voters. See the
[Statement](../../model/definitions/statement-v1.ts),
[relation](../../model/definitions/relation-occurrence-v1.ts) and
[shared Context](context.md) contracts.

Syntax is checked at ingress; the domain command validates meaning, authority
and expected state; the transactional validator checks required persisted
invariants. Missing, private and partial dependencies remain unavailable, not
confirmed absent. Query templates bind data scope, interpretation and budgets on
the trusted server. External contexts and ontology imports require controlled
acquisition. [Model profiles](model-profiles.md) explain term choice and
[validation operations](../implementation/model-profile-validation.md) explain
profile activation.

## Identities, variants and projections

Decision 51, maintainer and product manager, 2026-10-04. A character, person
or thing keeps one Resource across Works, volumes, adaptations, translations,
ages, forms and names. What differs by Work, continuity, time or form is a
Statement scoped by applicability, or a participation in an appearance; neither
mints an identity. Wikidata scopes such facts with
[applies to work](https://www.wikidata.org/wiki/Property:P10663),
[age](https://www.wikidata.org/wiki/Property:P6249) and
[form](https://www.wikidata.org/wiki/Property:P4675) qualifiers, and
[VNDB](https://vndb.org/d12), [AniDB](https://wiki.anidb.net/Content:Characters),
[AniList](https://anilist-submission-manual.super.site/characters) and
[MusicBrainz](https://musicbrainz.org/doc/Style/Artist) keep one entry with
per-Work roles and credited names. Splitting has a measured cost: on
[Bangumi](https://api.bgm.tv/v0/characters/273) the Lancer and Lancer Alter
entries of Artoria hold 32 and 15 collections against the main entry's 2,207.

No source defines a decidable identity threshold, and similarity of properties
cannot decide one ([fictional entities](https://plato.stanford.edu/entries/fictional-entities/)).
Editors apply these tests in order; the first that matches decides:

| Test | Outcome |
| --- | --- |
| Provenance: did the later Work knowingly take the character over (adaptation, sequel, spin-off, crossover)? | If not, an unrelated namesake: another Character, no link. |
| Title: is the name held by several individuals in turn or at once (Batman, the Saber class)? | The title is its own Resource; holders link to it through relation occurrences with time and applicability. |
| Unit: is it a playable unit with its own identifier, statistics, skills or tier? | A unit Resource that represents one or more Characters, as [PokéAPI varieties](https://pokeapi.co/docs/v2) and [Atlas Academy servants](https://api.atlasacademy.io/nice/NA/servant/3?lore=true) do. |
| Coexistence: do the two appear together in a narrative as distinct individuals? Units sharing a party do not count. | Two Characters; the variant links to its hub. |
| Independent identity: does the Work or its publisher name it on its own, and does it carry an identity fact that cannot be reconciled with the hub within one frame? | A variant Character linked to its hub. |
| None of the above | One Character; differences are scoped Statements, and a projection serves whoever judges "X in F". |

Popularity and the wish to rate a version separately are not tests: projections
serve them, and identity must not follow popularity.

**Variant links.** A variant links to exactly one hub, forming a star as
[VNDB instances](https://vndb.org/d12) and MusicBrainz performance names
do; nested trees such as AniDB's complicate roll-ups and hub choice. The link
carries a kind, `persona` (a transformed other self, such as an Alter) or
`counterpart` (another universe's or timeline's individual that can coexist),
and a revelation position for spoilers. It is a relation occurrence with
evidence like any other relation between Characters, never `owl:sameAs` or
`prov:specializationOf`: a variant does not share all of its hub's aspects. A
variant has one hub and a hub is never itself a variant. The hub is the most important member, then the original,
then the earliest, as AniDB orders it. Fusion, fission, clones and
reincarnation are ordinary relations between Characters.

**Names.** Names are appellations, as [IFLA LRM](https://www.ifla.org/wp-content/uploads/2019/05/assets/cataloguing/frbr-lrm/ifla-lrm-august-2017_rev201712.pdf)
models Nomen, with applicability, time and spoiler level. Each participation
records the name credited there, as AniList's `CharacterEdge.name`, Wikidata's
[name of the character role](https://www.wikidata.org/wiki/Property:P4633) and MusicBrainz
artist credits do. The display name is the one most often seen or least
spoiling (VNDB).

**Projections.** A Projection names a subject within a frame: exactly one
`projectionOf`, any Resource, and one or more frame coordinates, at most one
per dimension. Its identity is a UUIDv7, unique per subject and sorted frame
set, and the API creates it on first use (get-or-create) when a rating, review,
discussion, page or imported per-match record needs an anchor; nothing mints one
per fact. Frame dimensions describe the subject only: continuity; Work and
structure position (volume, chapter, episode, scene); release or realization;
in-story time; form; event, match or map; game version. A narrative continuity
(Canon, Legends, Earth-616) is its own type, distinct from the Work continuity
that scopes progress and Main Versions. Realms, Contexts,
populations, speakers, spoiler levels, raters' languages and the times of
assertion or rating are never frames. A projection is not a member of its
subject's type: counting a Work's characters counts neither projections nor
units ([the counting problem](https://nemo.inf.ufes.br/wp-content/papercite-data/pdf/agent_roles__qua_individuals_and_the_counting_problem_2005.pdf)).
There are no projections of projections, and no facts stored on one: a fact
about X in F is a Statement about X with applicability F, and the API
normalizes a projection subject to that form. A projection page reads its
subject's Statements whose applicability covers its frame, the most specific
first, filtered by the reader's position.

The shape follows [Context Slices](http://ontologydesignpatterns.org/wiki/Submissions:Context_Slices),
[NdFluents](https://www.emse.fr/~zimmermann/Papers/corr2016.pdf) and
[ORE proxies](https://pro.europeana.eu/files/Europeana_Professional/Share_your_data/Technical_requirements/EDM_Documentation/EDM_Definition_v5.2.8_102017.pdf);
the nearest standard term is [`prov:specializationOf`](https://www.w3.org/TR/prov-o/).
Web Annotation's [scope](https://www.w3.org/TR/annotation-model/#scope-of-a-resource)
is not one: it "does not imply an assertion that the annotation is only valid"
in that context, so a consumer could read a scoped rating as a rating of the
subject. Reified statements, RDF 1.2 reifiers and named graphs qualify claims
but never identify "X in F" as a subject.

**Typed applicability.** Every applicability IRI belongs to one dimension.
Values within a dimension combine with OR (true in Canon or in Legends) and
dimensions combine with AND (in continuity C and in chapter 3), as the
[dimensional contexts](https://mlanthology.org/ijcai/2018/bozzato2018ijcai-enhancing/)
of contextualized knowledge repositories do. Coverage between coordinates
(scene, episode, season, Work, continuity) comes from Structure and Work
relations. The same dimensions type projection frames.

## Relation lexicon

Maintainer and product manager, 2026-09-30
([relations in every language](../product/platform-thesis.md#relations-in-every-language)).
One shared relation lexicon serves
every domain, Zone and client; manifests reference its definitions and never
clone "author", "character" or "adaptation". Three layers are versioned
separately:

- **Meaning**: identity, exact revision, scope with examples, participant slots,
  cardinalities and qualifiers.
- **Viewing directions**: each `fromRole → toRole` projection, including those
  of n-ary relations, so "Protagonist: A" on B and "Protagonist of: B" on A come
  from one occurrence, never from a stored inverse fact.
- **Presentation per language**: labels in any BCP 47 language with a noun
  form, heading and plural forms; optional grammatical forms keyed by case,
  number or gender; optional reviewed sentence templates in
  [MessageFormat 2](https://cldr.unicode.org/downloads/cldr-47) with typed
  slots; source, licence, review status and the compatible meaning revision.

A wording edit creates a presentation revision and never changes meaning. A
change of meaning creates a semantic revision, invalidates incompatible
translations and leaves historical occurrences with the meaning they had.

Main returns the rendering contract: meaning and revision, bindings, selected
labels or template, typed arguments, the language, script and direction
actually used, review status and fallback provenance. Structured rows, role
chips and plural headings are the baseline; sentences appear only where prose
earns it (feeds, notifications, agent answers). No client concatenates a
translated predicate between names, appends "of" for an inverse or infers
gender from a name. Selection and fallback follow
[content languages](content-languages.md#vocabulary-labels-are-graph-content).

Narrative role (protagonist), prominence (main, supporting), credit role
(author, voice actor) and participant slot (character) stay distinct concepts:
a prominent antagonist is main without being the protagonist, and a source's
"main" maps only after review. Presentation writes are separate from the
[definition change operation](../../services/main/src/modules/semantic/change.ts),
and reviewing a presentation is a separate authority from drafting one.
MessageFormat 2 templates remain to be built.
