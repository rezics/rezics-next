# Platform thesis

Decisions 34 and 35 (2026-09-29), revised by the maintainer and product manager
on 2026-09-30 after research round R40–R50. The [goal](goal.md) states why
REZICS exists; this page states how one engine serves every domain.

## The vertical engine is the product

Cost is why REZICS exists. A multilingual visual-novel database, a
science-fiction index or an LLM and benchmark index is another view of the one
catalogue, not a separate application. The engine combines a shared graph, a
small abstraction base, capabilities implemented once, and Zones that assemble
them into complete sites. A new descriptive domain is configuration: vocabulary,
mappings, seed data, saved views and a Zone. New behaviour still requires
engineering, and it enters as a reusable capability. The
[backend one, frontend free](goal.md#backend-one-frontend-free) rule states
where that line sits.

## One graph, many language fronts

REZICS has one logical multilingual graph across all domains and languages.
Verticals, language communities and Zones are views over it; none owns a
separate catalogue, namespace of identities or copy of a referent. Physical
partitions may follow owners, privacy, rights or workload, never domain.
Communities disagree through [Contexts](../contracts/context.md) without copying
the thing they disagree about, and a correction in any language or Zone improves
every view that shows the same fact. The
[language contract](../contracts/content-languages.md) owns language distinctions.

## What the semantic web supplies

**Vocabulary to align with, not to invent.** schema.org is the public map
(Thing, CreativeWork, Person, Organization, Place, Event, Product, Offer,
Action). The [Wikibase data model](https://www.mediawiki.org/wiki/Wikibase/DataModel)
supplies qualified statements with references and ranks, and treats classes as
data. Specialist standards cover recurring problems:
[IFLA LRM](https://www.ifla.org/wp-content/uploads/2019/05/assets/cataloguing/frbr-lrm/ifla-lrm-august-2017_rev201712.pdf)
and [BIBFRAME](https://www.loc.gov/bibframe/docs/index.html) for works and
editions, [OWL-Time](https://www.w3.org/TR/owl-time/),
[GeoSPARQL](https://docs.ogc.org/is/22-047r1/22-047r1.html),
[SOSA/SSN](https://www.w3.org/TR/vocab-ssn/) with [QUDT](https://qudt.org/)
for measurements, [PROV-O](https://www.w3.org/TR/prov-o/) for provenance,
[ODRL](https://www.w3.org/TR/odrl-model/) for rights,
[SKOS](https://www.w3.org/TR/skos-reference/) for concepts and
[OntoLex-Lemon](https://www.w3.org/2016/05/ontolex/) for lexicalization.

**An open world with a generic fallback.** Anything expressible as statements
can be stored, edited, queried and shown before any domain work exists, as on
Wikidata. Every admitted resource gets a generic page: cover or avatar,
localized names, identifiers, statement groups with qualifiers, sources and
history, relations in both directions, collections, and the actions it admits.
Unknown predicates stay visible; unsupported datatypes keep their exact value
and say so. An unfamiliar type never inherits book-only controls.

**Seeds and interoperability.** Wikidata's CC0 identifiers and labels and the
admitted open dumps reduce acquisition cost under their own licences.

**What it does not supply:** behaviour (spatial indexes, recurrence, ranking,
fraud control), grammatical sentences in every language, and demand. REZICS adds
those through capabilities and communities.

## The mainline abstraction base

A small application ontology whose families compose; none is a separate service.

| Family | Meaning and alignment |
| --- | --- |
| Resource | Stable referent, revisions, multilingual names, external correspondences, lifecycle (schema.org Thing, Wikibase entity) |
| Person, Organization | Public identities independent of accounts and communities |
| Concept, Definition | Classes, properties, roles, metrics and units (SKOS, Wikidata items and properties) |
| Work, Realization, Release, Representation, Copy | From creative scope to an individual holding (LRM, BIBFRAME) |
| Place, Spatial feature | A location with geometry, distinct from its subject (schema.org Place, GeoSPARQL) |
| Relation occurrence, Participation, Role | Identified n-ary associations with roles, applicability, time and evidence (schema.org Role, PROV, Wikibase qualifiers) |
| Event, Activity, Action | Occurrences, processes and actionable contracts (schema.org Event and Action, PROV Activity) |
| Observation, Assessment | Results about an exact target under a procedure or question (SOSA, QUDT) |
| Offer | Counterparty, item, terms, price, territory, availability and validity (schema.org Offer) |
| Collection, Entry, Saved view | Curated membership and reproducible selections (schema.org ItemList) |

**Types describe; capabilities behave; Access authorizes.** A restaurant is an
Organization at a Place; a light novel is a Work with Releases; an LLM is a Work
whose checkpoints are Releases and whose benchmark results are Observations. A
person who writes novels, ships software and reviews a café keeps one identity
with several participations. Fictional characters gain no Agent authority.

## Capabilities

Each capability is implemented once in the backend and bound to types through
validated definitions. It declares its prerequisites and property bindings, its
vocabulary, its owner commands with authority and outcomes, its projection,
index and query budget, its page sections and list views, its import and export
mappings, and its conformance fixtures. An imported predicate or `rdf:type`
never grants authority; conflicting bindings fail activation; absent data never
produces a misleading map, score or availability claim.

| Capability | Bound by | Gives every bound type |
| --- | --- | --- |
| Facets, search, saved views | Admitted property paths and value domains | Complete filtered traversal, counts, table and gallery views |
| Measured | Observation with metric, method, conditions, unit and time | Specification sections, comparison tables, histories |
| Located | Geometry or location, with precision and disclosure | Maps, nearby and area search, directions links |
| Scheduled | Event time, validity, recurrence or opening hours | Calendars, timelines, upcoming and open-at views |
| Offered | Offer with seller, price, territory and validity | Availability tables and price history; purchase is separate |
| Versioned | Releases, editions, coverage | Edition selection, coverage matrices, changelogs |
| Composed, Trackable | Ordered parts and an admitted progress unit | Contents, sessions, progress, next item |
| Credited | Participation with a role | Credits sections and portfolios |
| Listed | Collection membership | Mixed-type lists: ordered, annotated, exportable |
| Reviewable | Target grain, question, scale and population | Contextual ratings and reviews |
| Discussed, Documented | Resource-targeted threads and documents | Discussion and wiki sections |
| Followed | Subscription to a resource or saved view | Inbox, digests, change feeds |

Table, map and calendar are views; switching between them never changes query
meaning. Identity reconciliation, provenance, rights and freshness are
foundations every capability shares.

**Build order.** First, capabilities target any admitted resource rather than
only Works; a type registry served by Main replaces the closed type lists in
profiles, TypeScript and the Jena policy; components attach to existing
resources; generic pages and forms follow. Second, facets, search and saved
views with complete correlated traversal. Third, qualified measurements, proven
by the LLM index. Fourth, geography: a PostGIS projection inside the existing
PostgreSQL (Jena's GeoSPARQL index is rebuilt rather than updated), MapLibre
with regional PMTiles and external directions links; Earth coordinates stay
distinct from fictional maps and private locations. Time, releases, credits,
collections, ratings and progress become generic on the way. Purchasing,
reservations, recruitment workflows, routing and learned recommendations each
need their own capability decision later.

## Relations in every language

The semantic web solves multilingual vocabulary (labels in any language,
qualified roles, inverse wording); it does not generate grammatical sentences
for arbitrary relations and languages. Abstract Wikipedia's
[renderers](https://www.wikifunctions.org/wiki/Wikifunctions:Status_updates/2026-09-10/de)
cover specialized cases, and LLM verbalization still hallucinates facts.

- One shared relation lexicon serves every vertical. Meaning, viewing
  directions and each language's presentation are versioned separately: a
  wording edit never changes meaning, and a change of meaning invalidates
  incompatible translations.
- Each role and direction carries labels in any BCP 47 language: noun form,
  heading, plural, optional grammatical forms, and optional reviewed sentence
  templates in [MessageFormat 2](https://cldr.unicode.org/downloads/cldr-47).
- Structured rows are the baseline: "Protagonist: A" on B, "Protagonist of: B"
  on A, role chips and plural headings. Sentences appear only where prose earns
  them: feeds, notifications and agent answers.
- Main returns the rendering contract: meaning and revision, bindings, the
  selected labels or template, typed arguments, the language, script and
  direction actually used, review status and fallback provenance. Clients format
  it; they never invent relation semantics or concatenate translated fragments.
- Narrative role (protagonist), prominence (main, supporting), credit role
  (author, voice actor) and participant slot (character) are distinct concepts.
- A new relation is data plus review: search existing vocabulary, define its
  meaning and both directions, seed labels from Wikidata (CC0) and source
  vocabularies, let agents draft translations, and publish each reviewed
  language independently. The eight UI locales are reviewed first; any other
  content language works without deployment.

The [semantic model](../contracts/semantic-model.md) and the
[language contract](../contracts/content-languages.md) own the details.

## Vertical manifests

A versioned manifest selects and composes shared definitions, mappings, saved
views, policies and Zone starters, and it shows that reuse was ruled out before
it adds a definition. Namespaces identify where vocabulary comes from; stewards
maintain definitions, not the entities described with them; neither creates a
catalogue. Activation reviews an exact revision and its dependencies;
configuration never executes code, queries or remote schemas.
[Open vocabulary](../contracts/classification.md#restricted-structure-and-open-vocabulary)
and [complete traversal](../contracts/queries.md#complete-traversal) keep
definitions extensible and inventories exhaustive.

Books, Games (including software) and Media (anime, manga, film and TV) override
a few slots of the default page; every other type uses the default page with the
sections of its bound capabilities.

## Zones are routed sites

A Zone is a complete site over shared resources, such as a franchise wiki, a
prompt gallery or a specialist catalogue, never a single page.

- **Routes** have stable identities, localized paths and typed bindings: home,
  documents, saved-view indexes, resource detail pages and capability subroutes
  such as `/characters/{resource}/appearances`. A detail route verifies that the
  resource belongs to the Zone's population; creating a route never creates an
  entity.
- **Templates** resolve by explicit route choice, then type, then structural
  base, then the generic page. Sections and blocks bind to the current resource,
  a property, a document, a Collection or a versioned saved query; every
  inventory can be traversed completely.
- **Navigation** is its own ordered tree; **documents** are custom pages; a
  **theme** sets branding and layout within protected controls (identity,
  search, language, provenance, accessibility). A Zone may also ship bespoke
  presentation code under the backend-one, frontend-free rule.
- **Governance and versioning.** Site editing, publishing, moderation and graph
  contribution are separate grants. A site revision bundles routes, navigation,
  templates, theme and queries, with preview, validation, rollback and export,
  through the same API for people and agents.
- One Zone may combine several domains, and one domain may serve many Zones. A
  Chinese and a Japanese visual-novel Zone share every identity and choose their
  own names, prose, ordering and accepted assertions.

The first proofs are a franchise wiki with hundreds of pages and a prompt
gallery: visibly different products on the same routing, identity, documents
and queries.

## Expansion protocol

| Stage | Agents do | Humans review |
| --- | --- | --- |
| Define the job | Find existing capabilities, vocabulary and entities; draft bindings | Recurring user value, identity grain, missing behaviour |
| Prepare the domain | Propose alignments, mappings, Zone routes and views, labels, seed data | Ambiguous identities, novel semantics, rights, privacy, moderation |
| Prove composition | Run conformance, cross-links, imports, exports and failure cases | Task success and material semantic or policy decisions |
| Activate and maintain | Submit exact revisions; run resumable jobs; propose refreshes | Activation, stewardship capacity, consequential changes |

Agents propose equivalence; they never establish it silently. Proposal intake is
throttled to review capacity, and reviewer time is recorded.

## Expansion acceptance

Freeze the engine and shared assets. An administrator and an API-only agent,
each within four working hours and starting from a job brief and an admitted
source snapshot, configure a withheld domain. It passes only if:

1. no backend code path, table, deployment or executable configuration was
   added (bespoke frontend pages are allowed, not required);
2. the domain includes a type that is not a CreativeWork and a Zone with several
   routed pages;
3. discovery, editing, review, applicable ratings and discussion, lists and
   export pass their API and browser journeys;
4. known overlaps reuse existing identities, with at least two cross-domain
   relation types, and abstention is preferred to fabricated links;
5. traversal covers at least 1,000 records past former windows, and non-UI, RTL
   and mixed-script content survives with Advanced state;
6. denied, private, revoked, retried, interrupted, withdrawn and retired cases
   leave unrelated domains usable;
7. query cost stays within budget with 10 and 100 activated manifests;
8. onboarding, review and 30-day maintenance hours are recorded and compared
   across successive launches.

Configuration does not make stewardship, source rights or a new parser free,
and this test remains unvalidated until it passes.

## First manifests and proof

Settled research adoption, 2026-09-29, extended 2026-09-30. These are engine
demonstrations, not permission for broad acquisition campaigns or a claim that
their importers work:

- **LLMs and benchmarks:** exact model releases, evaluation conditions,
  benchmark, dataset and harness revisions, task and language, units,
  uncertainty, sample size and observation date. User reviews remain separate
  from benchmark results. [HELM](https://arxiv.org/abs/2211.09110) motivates
  comparisons qualified by scenarios and metrics rather than a universal score.
- **Visual novels:** usable releases qualified by language, platform, region,
  complete, partial or trial coverage and translator provenance. Correlate all
  conditions on one release; translated names do not prove playable translations.
- **Science-fiction books:** existing Book and series structures with ISFDB
  titles, variants, publications, contents, contributors and awards. A
  publication can contain several Works; source variants need explicit
  correspondence.
- **Work-linked events:** conventions, signings and release events connecting
  Works, creators, venues and dates; the first non-CreativeWork proof, reusing
  Located and Scheduled.

Open dumps reduce acquisition cost; their licences still apply to reuse and
export. The selected seeds are Arena's
[CC BY 4.0 leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset),
VNDB's [ODbL/DbCL dump](https://g.blicky.net/vndb.git/tree/util/dump/LICENSE-ODBL.txt?h=2.10&id=5a3a446b0530632942c577edbf10e9c7c2fb6fa9)
and ISFDB's [CC BY 4.0 data](https://www.isfdb.org/cgi-bin/languages.cgi).
Retain attribution and modifications; apply
[ODbL's derivative-database obligations](https://opendatacommons.org/licenses/odbl/1-0/).
Provenance partitions alone do not resolve derivative versus collective scope.
Check each archive's notices and exceptions: cover art, quoted text,
descriptions and model weights do not inherit the dataset licence automatically.
Verify the archive notices before publication, as the
[source owner](../contracts/source-lifecycle.md) requires.
