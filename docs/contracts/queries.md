# Queries, facets and filters

## Vocabulary

Decided by the maintainer on 2026-09-28. The terms follow RDF, SKOS and faceted
search. Anything a reader can filter by is a Resource; what differs is the path
from the queried Resource to it.

| Term | Meaning |
| --- | --- |
| Resource | Anything with an IRI: a Work, a class such as `schema:Book`, a Concept, a franchise such as Blue Archive, a character, a value such as Female. |
| Type | A Resource's `rdf:type`. A registered structural type selects shapes and admitted operations; descriptive types add no behaviour under the [open-vocabulary decision](classification.md#restricted-structure-and-open-vocabulary). |
| Concept | A `skos:Concept` in a vocabulary, such as a genre, form, trope or theme: Fiction, Web novel, 後宮. |
| Statement, relation occurrence | An attributed claim, and an identified association with roles, such as one character's appearance in one Work ([classification](classification.md), [relationship graph](relationship-graph.md)). |
| Context | Whose accepted Statements a read uses: Global or a Realm's ([Context](context.md)). |
| Facet | One admitted, versioned path from the queried Resource to a value, with labels, value domain, operators, Statement source and cost. `rdf:type` is one Facet; genre, based-on, author, language, rating and character appearance are others. |
| Condition | A Facet, an operator and values, or a group of Conditions bound to one occurrence. |
| Filter | A boolean combination of Conditions: the FilterDocument below. |
| Query | A Filter with text, scope (such as a Zone's population), Context, sort and page. |
| Saved Filter | A Filter with its own identity and name, such as "Female lead" or a Zone's scope. |

For example, fiction based on Blue Archive with a female lead, as Global reads it
(Facets are DefinitionRefs; short names stand in for them here):

```jsonc
{ "context": "global", "filter": { "all": [
  { "facet": "type", "any": ["schema:Book"] },
  { "facet": "genre", "any": ["<Fiction>"] },
  { "facet": "basedOn", "any": ["<Blue Archive>"] },
  { "facet": "appearance", "where": { "all": [   // one appearance of one character
    { "facet": "role", "any": ["<Lead>"] },
    { "facet": "gender", "any": ["<Female>"] } ] } } ] } }
```

## Decisions

- **Structural type is not grouping.** The 2026-09-29
  [open-vocabulary decision](classification.md#restricted-structure-and-open-vocabulary)
  distinguishes registered structural types from descriptive types without
  behaviour. Genre, form and topic remain Concepts: a web novel is a Book
  carrying a form Concept. A structural class used as a subject heading forks
  shapes whenever the heading changes, and a heading made a class cannot be
  attributed, contested or read per Context. schema.org likewise separates
  `@type` from `genre`, `about` and `isBasedOn`, and Wikidata separates
  *instance of* from *genre* and *form of creative work*.
- **Querying is not classification.** Classification is the write-side flow of
  stating Concepts about a Resource and accepting them in a Context. Every read
  goes through Facets, whatever the value is: a type, a Concept, another Work or
  a character.
- **Groupings are Saved Filters.** A product grouping such as "Books & web
  novels" is a Saved Filter with its own name and visible Conditions, not a
  Concept and not a fixed enum. Zone scopes, onboarding choices and feed
  filters are Saved Filters. A grouping made a Concept would add a false claim
  to each Work; an enum has no identity, labels or history.
- **Every displayed name belongs to something.** A filter reads as its Facet's
  label and its value Resource's label, or as a Saved Filter's name. Clients keep
  no private tables of type or grouping names.
- **Facets define queries; data never references them.** They add none of the
  Facet, Path or Sense wrappers that [presentation](presentation.md) rejects.

Retired words: *kind* for a Work's type; *interest* for a grouping; *Sense* for a
Concept; *category* and *typed predicate* for a Facet; *tag* except for a
source's unmapped term, an author's proposed Concept, or the UI label of the
free Concept Facet ("Tags" is that Facet's label, not a model term). TypeScript
discriminants named `kind` are unaffected. A persisted profile id such as
`work-kind-v1` changes only through a new profile revision.

## Concepts and value pages

Decided by the maintainer on 2026-09-28. Tags were clear because one mechanism
served every use: a tag opened the list of what carried it, and several tags
combined as all, any or none. That experience stays, generalized to every value.

- **Every value has its own page.** Opening a value opens its Resource, drawn
  as its type calls for, with the Resources that reach it through a Facet: the
  reverse query. A Concept page is what a tag page was (description, broader and
  narrower Concepts, matching Works, a Condition bar, Follow). Blue Archive's
  Work page adds "Based on this"; a character's page lists appearances and
  filters them by role.
- **Values combine as tags did.** A listing's Condition bar holds values; each
  is included or excluded, and several values of one Facet match all or any.
  AO3's typed tag filters are the reference: its tag types are Facets.
- **Concepts lead in the product, not in query mechanics.** Concepts are the
  values people meet most, so they get the surfaces: chips on Works grouped by
  Facet ("Genre: Fantasy · Tags: 後宮 · Based on: Blue Archive · Characters:
  Hoshino (lead)"), Follow, pinning as a Home tab, and the onboarding choice.
  Querying stays one Condition grammar. A tag-only mechanism would again make
  Blue Archive a tag without its Work page and relations, and could not say
  that one character is both the lead and female.
- **Home tabs are pinned Saved Filters.** Following a Concept follows its
  one-Condition Filter; the Home tabs after Following and All are the filters
  a reader pins, as X pins topic timelines and Reddit keeps custom feeds. The
  feed's `tags` parameter, which already filters by Concept, becomes `concepts`.

## Filter contract

FilterDocument is the shared descriptor for ordinary and advanced editors. It
has no deployed schema or round-trip client test yet, so this section remains
until both editors preserve fields their UI does not support. An empty document
supplies no hidden query, sort or page defaults. It contains sparse Conditions
and controls; editors group Facets for display without changing meaning. Server
field and Work policies set privileges and budgets; a Saved Filter cannot
enlarge either.

The compiler must intersect the Zone's explicit population, declared by its
Saved Filters and mounted Collections, with resource authorization and the
viewer's Access; none can enlarge another, and a detail route checks the same
membership. A Zone is a [routed site](../product/platform-thesis.md#zones-are-routed-sites)
over shared resources, so a fixed Realm is not its boundary: one Zone may span
several domains and Realms, and a Realm's Context selects acceptance, not
population (2026-09-30). Named terms resolve through an explicit,
speaker, entry or Global policy before compiling their admitted definitions;
equal-priority meanings remain ambiguous. Saved Filters retain exact
DefinitionRefs and Context revisions. A new Concept cannot erase another's
contextual uses, and labels or navigation cannot choose meaning. Semantic
selection, preference, disclosure, populations and acceptance scopes remain
separate. The compiler binds Context roles, Main Version, rating policy and
semantic match intent. It canonicalizes identical Conditions without losing
meaningful multiplicity. Conditions that describe one participant or
occurrence must bind to that same occurrence. Count grain, display groups and
optional self-filter-excluding facet counts follow
[statement aggregation](search.md#statement-aggregation).

Admission must check descriptor shape, node count, Facet/operator
applicability, depth, sources and the parent budget of any nested Block before
Jena execution. Candidate scans, graph expansion, time, memory and bytes need
bounds. Saved query state excludes cursors; continuations bind policy,
semantic, preference and disclosure revisions and report actual selection,
data/index generations and completeness. Text hit limits cannot substitute for
final post-filter limits or a snapshot across ordinary SPARQL offset requests.
Temporal controls preserve possible and definite time plus calendar semantics.
Rating controls preserve question, population, scale, time basis and
aggregation. A display edit cannot create a rating Context or recast a
correction as a new vote. Restore rechecks format and capability eligibility.
Private text and unsupported query shapes fail explicitly: an unsupported
Condition combination is a typed refusal, never an empty result. Each client
adapter must verify scope intersection, empty and advanced documents, stale
cursors and graph/text semantics.

## Moving to this contract

Querying is spread over separate shapes today. Each public search profile in
[the search route](../../services/main/src/routes/search.ts) fixes one
combination of type, Concept (still named `sense`), language, rating and the
selected text's author. That `author` is who wrote the published Contribution,
the `contributor` Facet, not the Work's author credit. A Realm there is the
Query's Context, which selects the Realm's publication and acceptance; it does
not limit results to the Realm's population. The
[grouped Statement read](../../services/main/src/modules/work/search-grouped.ts)
has generic Conditions with role binding, and the
[graph query schema](../../services/main/src/modules/graph-query/schema.ts) reads
relations. The feed's legacy `interests` parameter still uses a fixed enum
([Work kinds](../../services/main/src/modules/work/work-kinds.ts)) that also
matches Concept labels as strings, which this contract rejects; onboarding
offers Concepts instead. The web keeps its own tables of type names and cover
forms, and onboarding groups Concepts under them, since Main serves no type
labels yet.

Facet definitions now live in `model/definitions/facet-*.ts`, and Main serves
them at `GET /v1/facets`. A [mapping test](../../services/main/tests/facet-profile-mapping.test.ts)
writes each Work search profile as a Query over them. The grouped read's
predicate Conditions use the `statement` Facet with an exact relation
DefinitionRef until named Facets, such as gender, are admitted. Readers' Saved
Filters exist for Home tabs ([owner](../../services/main/src/modules/saved-filter/store.ts)):
a followed Concept's filter is created with its follow, and a pinned filter
reads Home's feed through a feed template that refuses shapes it cannot show.
That feed checks two candidates a page for a Concept, so a Concept index for
the feed remains. Still to come: one Query input that Main compiles onto
admitted, bounded templates, with today's profiles as the first templates;
Saved Filters for groupings such as Zone scopes; and labels read from the
Resources themselves.

## Complete traversal

Decision 12, product manager under maintainer delegation, 2026-09-29.
Previews, ranked retrieval and exhaustive inventories are different promises.
Every inventory continues through its whole population and states count precision
and freshness. A request bound is never a product limit. This matters for exports,
imports and heavy readers as much as catalogue browsing: silently missing later
items cannot be repaired by a larger first page.

[Notion's search limitations](https://developers.notion.com/reference/search-optimizations-and-limitations)
explicitly distinguish search from exhaustive enumeration. REZICS therefore gives
inventory traversal its own contract; the query and paging implementations linked
above retain their concrete bounds and qualification status.
