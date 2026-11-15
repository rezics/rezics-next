# Work references, classification and authored book structure

Independent backend research, inspected 11 November 2026. Repository baseline observed:
`1a1e539f5e`; read-only legacy reference: `legacy-final` at
`1ac6ed6e0668f04e30025c41e59ceaf3bdee5061`. This is a recommendation for owner review,
not an adopted contract or evidence of a passing deployment. No product code was changed or executed.

## Recommendation

Keep one identifiable subject for a work, and allow an explicitly typed **comparative statement to that
subject** when another work is described through it. A sentence such as “this is an Exit 8-like game” need not
create an “Exit 8-like” Concept first. Release a property with the narrow meaning “described as stylistically
comparable to”; preserve its references, Context and editorial selection. Do not infer adaptation, documented
influence, shared setting, series membership, or category membership from that statement.

Retain Concepts for independently defined categories such as an adopted “Soulslike” category. A category may
have exemplars, including Dark Souls, but an exemplar is not the category's identity. A Work and a Concept
can coexist, and their queries should remain distinguishable. Do not change `schema:keywords` into an
untyped bag of Works, People, Concepts and strings.

Books and Notion-like knowledge bases can share **ordered placement mechanics**: stable occurrence identity,
one parent per occurrence, sibling order, references to independently owned resources, revisions and bounded
navigation. They should not share one undifferentiated ownership or graph store. Bibliographic relations,
editorial classification, hosted text, publication manifests and access inheritance have different invariants.
The missing hosted-book capability is an authored structure/publication owner over existing Content bodies;
it is not another bibliography field or an enlargement of the existing Content Edition pointer.

The smallest useful delivery is therefore two coherent slices: a released comparative relation using the
existing Semantic/Search machinery, and an authored reading structure with exact chapter selections using
Content. Sharing structure mechanics with a knowledge-base consumer is justified when that consumer has a
concrete contract; designing a universal graph service first is not.

## Start with graph meaning

The important distinction is between an entity, a claim about an entity, and an occurrence of an entity.

| Graph element | Identity and invariant | What the edge does not establish |
| --- | --- | --- |
| Work | A particular creative work, independent of its editions | Its text, ownership, membership in a category, or all works resembling it |
| Bibliographic Edition | A particular published realization, linked to its Work | A hosted file, a sale entitlement, or the current text of every chapter |
| Series | An independently identified series; members assert membership, possibly with position | A user's list or a hosted book's table of contents |
| Concept | An independently described classification meaning, optionally in schemes | Identity with its label, its examples, or a Work with the same name |
| Semantic statement | Holder, property, value, qualifiers, references and editorial selection | Permission to read or modify either endpoint |
| Authored occurrence | One placement in one structure, with stable ID, parent, order and target selection | A new Work or a transfer of the target's ownership |
| Content revision | Exact immutable authored bytes and their provenance | Continued publication or current permission to disclose those bytes |

Comparison and membership are edges in a general directed graph. Comparisons need neither acyclicity nor
transitivity: A can be compared to B and B to A without duplicate identity; A compared to B and B to C does
not imply A compared to C. A directed “described through this exemplar” edge is more precise than a symmetric
similarity score. A taxonomy can have several parents. A reading occurrence, by contrast, has one parent in a
particular structure revision. Shared target resources make the reference graph a DAG or general graph
without making the placement tree a DAG.

These distinctions are consistent with primary standards, but the recommendation is an application design
judgment. BIBFRAME separates Work, Instance and Item and associates agents through roles. Its allowance for
works as subjects demonstrates that a work can be a relation target without becoming a genre; it does not
define stylistic comparison. [Library of Congress model](https://www.loc.gov/bibframe/docs/bibframe2-model.html)

SKOS supplies multilingual Concept labels, schemes and semantic/mapping relations. Its immediate `broader`
relation and transitive closure are distinct; its specification even permits hierarchical cycles that an
application may choose to prohibit. REZICS's acyclic `broader` policy is therefore a product invariant, not a
universal fact about every graph. [SKOS Reference](https://www.w3.org/TR/skos-reference/)

## What current REZICS actually represents

The assigned Goal, capability inventory and catalogue editing documents were read alongside the current
definitions and native code. The older catalogue/search research is useful as an evidence map, not current
execution evidence. In particular, it predates current Search route decomposition and several source ports.
This investigation does not repeat its old missing-provider conclusions as if they were verified today.

| Capability | Specified meaning | Current backend evidence | Interface and verification boundary |
| --- | --- | --- | --- |
| Book Work and Edition | Distinct identity grains | `book.yaml`: Work is `schema:Book`; Edition is `bf:Instance`; `schema:exampleOfWork` relates Edition to CreativeWork and has inverse `schema:workExample` | Literary create/edit exists; its initial entry is scalar-only, with relations contributed after creation. No native run here |
| Edition details | ISBN, publisher, pages, language, translator and qualified credits belong at the relevant grain | Released Book/Edition slots and typed target validation | A Book's word count is not edition pages or a count of hosted text; the editor explicitly preserves this boundary |
| Series | `wd:Q7725310` Series and `schema:BookSeries`; `wdt:P179` is asserted on each member | `series.yaml`, `core.yaml`; position-qualified inverse membership | BookSeries creation does not populate contents or infer an author field |
| Agents and names | Person/Organization identity, qualified authorship, distinct pen names | `schema:author` points to Person/Organization; `creditedAs`, detailed role and part qualifiers; `rezics:penNameOf` has disclosure rules | Terms/aliases and statement evidence are separate; authorship gives no write authority |
| Concepts | `skos:Concept`, scheme, broader, focus, close match | `classification.yaml`; `schema:genre` and `schema:keywords` require Concept targets | Concept editor and source reader exist; scheme/descendant selection is explicit, not universal equivalence |
| Direct comparative Work reference | No narrow bundled predicate found | Generic item relations and Context term extensions can represent one after its meaning is released | No existing “Work as adjective” release, picker or complete cross-surface acceptance was found |
| Sourced/editorial relations | Proposal, Context acceptance/rejection, separate adoption, history and moderation | Native candidates; forward/inverse projections with current statement and target checks | A candidate or a successful write is not a public selected fact |
| Relation filters | Typed item equality and same-statement qualifiers | `FilterStatement`, `validateFilter` logic, native relation evidence, Search HTTP filter input | Property/facet admission and complete indexes still matter; grammar support alone is not a passing user journey |
| Hosted nested chapter authoring | Not supplied by bibliographic meanings | No chapter/TOC command owner found in current Content/Semantic source; StoryArc and chapter-count/progress vocabulary are descriptive | No current native create/move/reorder/exact-reading TOC contract found |
| Content Edition | Fixed authored paid edition of one Post revision | `content.edition` stores a pointer, creator, target Subject, hash and licence; no body copy | It is not `bf:Instance`, a chapter collection or a multi-chapter publication manifest |

Exact repository evidence:

- [Semantic Goal](../goals/semantic.md) and [capability inventory](../goals/semantic.capabilities.md):
  meanings, ownership, cross-surface requirements and the distinction between declaration and native proof.
- [Book](../../packages/definitions/catalogue/book.yaml),
  [series](../../packages/definitions/catalogue/series.yaml),
  [core](../../packages/definitions/catalogue/core.yaml),
  [classification](../../packages/definitions/catalogue/classification.yaml),
  [game](../../packages/definitions/catalogue/game.yaml) and
  [visual novel](../../packages/definitions/catalogue/visual-novel.yaml) definitions.
- [Target matching](../../services/kernel/src/semantic/targets.ts) admits the exact target type or a declared
  structural base; [proposal](../../services/kernel/src/semantic/candidate-proposal.ts) validates item targets.
  A direct Work UUID is consequently not a valid substitute for a Concept UUID under `schema:keywords`.
- [Semantic relation contract](../../services/kernel/src/semantic/README.md#relations): canonical forward
  statement, derived inverse, relation slot identity `(subject, property, target)` plus optional item qualifier
  slot key. Association relations are not subject to the 512 descriptive-fact cap; command limits still apply.
- [Subject HTTP](../../services/kernel/src/semantic/http/subjects.ts):
  `POST /v1/subjects/:id/candidates` accepts `{ statement }`; candidate decisions and Context adoption are
  separate operations. `GET /v1/subjects/:id/relations` and `/links` provide continued relation reads.
- [Filter grammar](../../packages/filter/src/filter.ts): 32 leaves, depth 4, at most 64 equality operands and
  four qualifiers; UUID item equality is independent of the optional scheme-bound Concept selection.
  Inverse admission additionally requires its enabled option and a declared relation property.
- [Search routes](../../services/kernel/src/search/http/routes.ts),
  [native selected source](../../services/kernel/src/semantic/search-source.ts), and
  [current relation source](../../services/kernel/src/semantic/search-relations.ts): current discovery
  consumes native facts and relation evidence rather than an arbitrary graph traversal supplied by the client.
- [Catalogue editing](../catalogue-editing.md#browser-flow-book-and-book-series-works) and
  [Concept editing](../catalogue-editing.md#browser-flow-concept-and-scheme-creation): names, bibliography,
  authored fields, references and relation corrections are already separate operations.
- [Content Edition model](../../services/kernel/src/content/edition-model.ts) and
  [fixed authored editions](../../services/kernel/src/content/README.md#fixed-authored-paid-editions):
  creation pins `{ postId, revisionId, targetSubjectId }`, publication is separate, and a new version gets a
  new edition ID. Current subject/source guards still govern disclosure.

Two easy category errors deserve explicit prevention. `schema:CreativeWork` includes published realizations
in this repository, so targeting that base alone does not restrict a relation to abstract Works.
Also, book Work and book Edition both serialize as Schema.org Book under the adopted mapping; this does not
make their native types or identities interchangeable. The existing
[serialization research](catalogue-schema-org-mapping.md#identity-classification-and-serialization-are-different-assertions)
documents that distinction.

## Compare the classification choices

| Candidate | Advantages | Costs and semantic risks | Assessment |
| --- | --- | --- | --- |
| Separate Concept per work-derived description, linked to an exemplar Work | Existing classification editor, scheme membership, hierarchy and Concept filtering apply; independently named meanings can evolve | Requires an extra identity and editorial lifecycle for every title-derived expression; invites duplicate concepts and accidental equivalence; target Work rename/merge does not settle category meaning | Appropriate for a real category; excessive as a compulsory encoding of every comparison |
| Typed direct Work reference | Reuses Work identity and qualified statements; one bounded relation filter; no shadow title identity; natural inverse “works compared to this” | Must define what comparison means and keep it separate from influence/derivation; needs released facets and disclosure/index acceptance | Recommended default for the user's adjectival use |
| One generic relation plus role qualifier | Can express several relationship uses with one main property | Every query and index must bind role on the same statement; slot identity must include role or unrelated meanings compete in one slot; a generic edge can conceal undefined semantics | Technically possible, but inferior to a few clear predicates for these established distinctions |
| Retype the Work as a Concept or create a “Work-as-tag” identity | Superficially unifies selection controls | Conflates artifact identity with category meaning; conflicts with single native type and target validation; complicates merges, aliases and library profiles | Reject |
| Hybrid: direct comparisons plus independently adopted Concepts | Preserves lightweight comparisons and stable taxonomy; explicit queries can combine them | Requires honest labels and no hidden conversion between the two populations | Recommended overall model |

“Role” has two useful meanings here. A Work can play the role of an exemplar **as the target of an edge**;
that need not change its Type or mint a role entity. A statement can also carry an aspect or attribution
qualifier. REZICS already has that qualified-claim shape. Schema.org Role demonstrates adding information to
a relationship through an intermediate object; it does not require every relationship use to become a new
domain identity. [Schema.org Role](https://schema.org/Role)

`foaf:focus` needs particular care. Its documented purpose is relating a SKOS conceptualization of a particular
thing to that thing; broad categories do not necessarily have such an individual focus. A subject-heading
Concept about **Dark Souls itself** can focus on the Dark Souls Work. A category **works with Soulslike
mechanics** is not simply a second description of that one Work. If an exemplar link is required, release a
property such as `rezics:exemplarWork` with that meaning; do not silently reinterpret `focus` as “inspired by,”
“originated with,” or “one example of.” [FOAF focus](https://xmlns.com/foaf/spec/#term_focus)

Keep four questions separate:

1. **Classification:** is this work a member of the adopted Concept's category?
2. **Comparison:** has this work been described in terms of the named Work's style, structure or experience?
3. **Influence:** is there evidence that the creator/work was influenced by that source?
4. **Derivation/adaptation:** is this work based on, adapted from or a modification of that work?

Wikidata's `P737` explicitly concerns influence or inspiration. Schema.org `isBasedOn` concerns derivation,
modification or adaptation. Neither is evidence that a critic's comparative phrase establishes those facts.
The current visual-novel `wdt:P144` relation is a based-on relation, and the current symmetric cross-media
counterpart deliberately does not assert direction. Preserve those meanings.
[Wikidata P737](https://www.wikidata.org/w/index.php?title=Property:P737&oldid=2539717574),
[Schema.org isBasedOn](https://schema.org/isBasedOn)

## Concrete book and game behavior

The following are synthetic acceptance examples, not factual assertions about particular released games or books.

- Work G has a cited description comparing its anomaly-detection loop to **The Exit 8**. Store
  `G — stylisticallyComparableTo → Exit8Work`. Do not infer “adapted from Exit 8,” an official franchise
  relationship or membership in every category applied to Exit 8.
- Work H is described as “Dark Souls with gardening.” Store a comparative Work reference. If editors also
  classify H as **Soulslike**, that is a separate `schema:keywords` or `schema:genre` statement to the adopted
  Concept. Either claim may be disputed or suppressed independently.
- Novel N is described as “a Pride and Prejudice-like comedy.” Its comparative target is the book Work.
  Edition N-E has a particular ISBN, translator and page count. Finding N by comparison does not assert that
  a translation's prose resembles the original English edition, or that N-E has another edition's page count.
- A claim specifically comparing two translations is edition-to-edition evidence. It requires a separately
  admitted edition-grain comparison policy; it must not be silently promoted to all editions or all Works.
- Book B belongs to BookSeries S at position 3. B's title, S's title and the hosted reading structure's title
  may differ. A comparison to S means the series, not automatically one member or all members. The initial
  Work-comparison release can omit Series targets until that user outcome has explicit semantics.
- A pen name can carry the authorship credit and its exact `creditedAs` text. A “Kafkaesque” Concept is not
  a Person alias, a pen-name mapping or a statement that Kafka authored the work.

Names are discovery affordances, not keys. Keep native IDs and actual multilingual labels; do not add
“Soulslike” as an alias of the Dark Souls Work merely to make a filter picker find it. Search should present
the Work and the independently defined Concept with their types and distinct actions. A free-text title match
does not itself select either semantic interpretation.

## Minimal comparative relation and query contract

Proposed vocabulary, not a currently released property:

```text
rezics:stylisticallyComparableTo
  meaning: this work is described as comparable to the target work in style,
           structure, mechanics, tone or another stated experiential aspect
  domain/targets initially: schema:Book and schema:VideoGame (including admitted subtypes)
  datatype: wikibase-item; multivalued: true
  relation group: association
  inverse: rezics:comparedWork
  symmetric: absent; acyclic: absent; order: name
```

Definitions must put the property in the applicable effective slots and facets. Use the existing candidate
shape and separate editorial decisions. Require an identified source for public adoption of this subjective
comparative predicate; allow draft proposals without treating them as matches. This requirement is proposed
editorial policy, not a claim that all native relation properties currently require citations.

```json
{
  "statement": {
    "property": { "id": "rezics:stylisticallyComparableTo" },
    "value": { "type": "value", "content": "<exemplar-work-uuid>" },
    "rank": "normal",
    "qualifiers": [],
    "references": [
      {
        "parts": [
          {
            "property": { "id": "schema:url" },
            "value": { "type": "value", "content": "https://example.org/review" }
          }
        ]
      }
    ]
  }
}
```

The request goes to existing `POST /v1/subjects/<described-work>/candidates` with native authorization and
idempotency. The example URL is illustrative, not evidence. Acceptance and adoption remain separate commands.
No new tagging table, “apply tag” authority or duplicate reverse statement is needed.

After definition/facet/index admission, the existing Search grammar can express the intended request:

```json
{
  "filter": {
    "and": [
      { "type": { "in": ["schema:Book"] } },
      {
        "statement": {
          "property": "rezics:stylisticallyComparableTo",
          "in": ["<pride-and-prejudice-work-uuid>"]
        }
      }
    ]
  },
  "limit": 25,
  "sort": "name"
}
```

This is a proposed use of `POST /v1/subjects:search`, not a claim that the unreleased property works today.
Concept filtering stays an independent leaf, for example `schema:keywords` with `in: [conceptId]` and optional
`concept: { scheme, includeChildren }`. A combined “compared to Dark Souls OR classified Soulslike” request
can explicitly OR those leaves. There is no automatic join through focus, exemplar or category descendants.
The Concept's current meaning cannot be reconstructed from whichever Work happens to be its exemplar today.

Do not add a generic weighted similarity score in this first slice. The existing VNDB source tag weight has
a specified source statistic and scale; it is not a REZICS confidence score. If comparison aspects become
necessary, release an aspect Concept qualifier with same-statement filtering. Define whether separate aspects
need distinct slots before adding a slot key. Spoiler thresholds currently have specific classification/
appearance admission logic in the filter package; attaching a spoiler qualifier to an association does not by
itself prove equivalent query disclosure. Add that outcome deliberately or keep the first predicate free of
spoiler-bearing detail.

## Hosted books and knowledge bases

### What external systems establish

Open Library's inspected schema keeps edition-to-work references and a distinct edition table-of-contents
field. BookWyrm keeps an Edition `parent_work` foreign key, ordered Work edition discovery and separate Series
membership. These are evidence for bibliographic identity and navigation; neither inspected implementation
establishes an editable hosted chapter publication system for REZICS.
[Open Library work schema](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/plugins/openlibrary/types/work.type),
[edition schema](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/plugins/openlibrary/types/edition.type),
[BookWyrm model](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/models/book.py)

Notion's block API exposes one level of children with pagination; child expansion is explicit. Its synced
blocks distinguish the original from references that mirror it, and its append API names insertion position.
This supports separating owned hierarchy from reused content. It does not prove Notion's internal database
representation or justify reproducing its API limitations.
[Block children](https://developers.notion.com/reference/get-block-children),
[synced blocks](https://developers.notion.com/reference/block#synced-block),
[insertion position](https://developers.notion.com/reference/patch-block-children)

Notion also documents parent-derived subpage permissions and page-specific overrides. A navigational link
and an authorization parent are thus separate concepts even in a familiar hierarchical product; REZICS should
make its own Access semantics explicit instead of inheriting them from the shape of the tree.
[Notion permissions](https://www.notion.com/help/sharing-and-permissions#inherited-permissions)

EPUB distinguishes publication resources, linear reading order in the spine, and the navigational TOC
hierarchy; TOC references should follow the content/spine ordering. The useful lesson is that a TOC is a
navigation structure over content, not the content's identity. A book may eventually need a reading order
different from a secondary navigation view, so do not make every tree edge a universal bibliographic part-of
assertion. [EPUB 3.3](https://www.w3.org/TR/epub-33/#sec-nav-toc)

### A shared occurrence model, with separate policies

Use these conceptual objects; final endpoint and table names belong to the implementing owner:

```text
Structure(id, ownerResource, profile, draftHead, publishedHead)
Occurrence(id, structure, parentOccurrence, orderKey, role, localLabel, targetSelection)
StructureRevision(id, previousRevision, change, author, timestamp)
Publication(id, structureRevision, exactTargetSelections, state)

targetSelection = { resourceKind, resourceId, revisionId, digest }
```

One occurrence is one placement, even when two placements target the same Post revision. Containers can
have labels without a content target. An alias/link occurrence does not own the target. Transclusion is an
explicit reference with a selection policy, not another parent pointer on the target resource. The first book
profile should support containers and chapter references with exact revision selections. Live-following
references can be added for a knowledge-base profile without changing the meaning of already published books.

| Invariant | Shared mechanics | Book profile | Knowledge-base profile |
| --- | --- | --- | --- |
| Hierarchy | One parent per occurrence, sibling order, no containment cycle | Parts/volumes/chapters; target reuse retains occurrence identity | Pages/sections/links; owned child and alias are distinguishable |
| Target identity | Typed references, stable IDs, no implicit target copy | Post/document revision; optional separately catalogued Work relation | Page/block/document reference; optional live transclusion |
| Navigation | Paged children, ancestors, exact occurrence address, bounded neighbors | Published revision fixes reading order and selected bodies | Current navigation can evolve; history remains addressable |
| Authorization | Ask owner policy; a reference is not a grant | Structure edit, source-content use and publication rights are distinct | Parent inheritance may apply only to owned children, never arbitrary backlinks |
| History | Structure changes separate from body changes | Publication freezes exact chapter selections | Draft/live selection can differ from a selected historical snapshot |
| Catalogue | Optional references to Semantic subjects | Work and optional bibliographic Edition identity | Topic/about links; a page is not automatically a new Concept |

Crosslinks can form cycles without invalidating the containment tree. Rendering transclusion must carry a
visited-target set, finite depth and output budget; it must not recursively expand arbitrary backlinks. An
alias to a page must not import that page's entire permission ancestry into the local occurrence tree.
Current disclosure applies to both occurrence/container and target. A historical URL is an exact address,
not a bypass around takedown or revoked permission.

For a book, assign the authored structure/publication contract to **Content**, with Semantic retaining the
Work/Edition and bibliographic claims. Reuse the existing native Post/document revision and Access boundaries.
Keep personal reading progress and purchases in Commerce. A book author credit is not proof of the requesting
account's authority to revise a Post, publish a structure or sell it. The current Content Edition remains its
single-revision resource; a paid multi-chapter publication needs an explicit new admitted benefit/source
contract with Commerce, rather than accepting arbitrary manifest JSON at the old endpoint.

These mechanics could be shared as a narrow owner-independent module once the second consumer is concrete.
Do not put all claims, pages, blocks, chapter placements, grants and binary revisions into the Semantic
statement table merely because all can be drawn as nodes and edges. A chapter reorder is an author command
over one structure revision; it is not competing editorial adoption of a bibliographic statement.

### Proposed authoring and reading API shape

The following paths are illustrative additions, not mounted APIs:

```text
POST /v1/readingStructures
  { subjectId: BookWork, profile: "book" }

POST /v1/readingStructures/{id}/changes
  If-Match: <draft structure revision>, Idempotency-Key: <key>
  { operation: "insert", parent, after, role: "chapter",
    target: { postId, revisionId, sha256 }, label }
  or { operation: "move", occurrenceId, parent, after }
  or { operation: "replaceSelection", occurrenceId, target: { ... } }
  or { operation: "remove", occurrenceId }

GET /v1/readingStructures/{id}/children?revision={r}&parent={p}&cursor={c}&limit=25
GET /v1/readingStructures/{id}/occurrences/{o}?revision={r}
GET /v1/readingStructures/{id}/history?cursor={c}
POST /v1/readingStructures/{id}:publish
  { revision: r }
```

A chapter body is created/revised through the existing Content owner, then attached by exact reference.
If attachment fails after body creation, retain the body and retry the attachment with its original command
key; do not create another body or perform compensating deletion. Structure operations preserve occurrence
IDs through move/reorder, and removals remain explainable in revision history. A publication step resolves
and verifies exact selections in bounded resumable work before switching the published head.

An exact reader address contains structure/publication revision and occurrence ID; its response binds the
selected native body revision and digest. Moving a chapter changes the current route through the TOC, not
the old address's identity. Renaming it cannot break bookmarks. “Continue reading” retains occurrence plus
content revision; a content update can offer an explicit transition without silently changing the archived
selection. Published body withdrawal returns the owner's current unavailable result, including for old links.

### Legacy behavior worth preserving

Read-only inspection found a substantially closer behavior reference than generic bibliography:

- `legacy-final:services/main/src/modules/structure/README.md`: occurrences own placement/order, while
  chapter Posts retain text, publication and custody; reuse does not mint a Work.
- `legacy-final:services/main/src/modules/structure/format.ts`: stable occurrence, parent/order keys,
  removed state, fixed-revision selection and immutable manifests.
- `legacy-final:services/main/src/modules/structure/reading-order.ts`: neighbor seeking at a selected
  immutable revision, bounded sibling/ancestor steps, and an explicit limit rather than false end-of-book.
- `legacy-final:services/main/src/modules/studio/chapters.ts`: one-level continued contents, separate
  placement and target identity, exact Content reads and independent authoring/publication state.
- `legacy-final:services/main/tests/studio-chapter-length.test.ts`: repeated placements retain their own
  context while sharing exact body reads; language-dependent manuscript units remain distinct.

These are inspected behaviors and assertions, not executed passing evidence. The useful principles can be
implemented against the new owners without adopting the old Jena/immutable-object architecture. Any later
actual port must follow the repository's source attribution and differential-test rules.

## Query cost, ordering and physical design

### Semantic hot paths

The direct comparison needs no new graph database. Its positive query is a property/value lookup in Search's
existing indexed statement representation, followed by current native evidence. Its inverse list uses the
target's existing inbound relation index; forward selection uses the holder's outbound/native keys. A named
Work with a million comparisons is an ordinary high-degree relation anchor, not a million-row subject GET.
The Concept alternative adds a separate node and, if a caller requests comparisons through exemplars, an
extra join/expansion that needs an explicit retained query plan. Neither `focus` nor `broader` warrants
implicit unbounded graph traversal during autocomplete or filtering.

Every indexed tuple must retain enough identity to recheck the selected statement and qualifiers together:
holder, property, original target, statement/candidate, Context, source/security revisions and relevant
qualifier values. Do not flatten “comparison target = Dark Souls” from one statement with “aspect = combat”
from another. Title matching finds candidate identities; relation equality uses IDs. The native original ID
and current canonical survivor are distinct operands during a merge.

Use existing Search preparation/currentness rather than adding a second interpreter in Semantic or Library.
An incomplete or withheld relationship is unknown for negative predicates; it is not false evidence that
can make a `NOT` query pass. Counts, suggestions and facets must use the same admitted population. The current
Search documentation itself retains limits on immediate general count privacy, so count correctness is a
required acceptance item, not an automatic consequence of hiding visible hits.
[Semantic Search contract](../../services/kernel/src/semantic/README.md#search),
[Search evidence boundary](../../services/kernel/src/search/README.md)

### Structure hot paths

Let `N` be the structure's occurrences, `D` admitted depth, `P` a page's examined entries and `B` a bounded
local reorder segment. Proposed logical access paths are:

| Operation | Keys and bound | Important failure case |
| --- | --- | --- |
| Child page | `(structure, selected revision/head, parent, orderKey, occurrenceId)`; keyset seek, `O(log N + P)` | A visible limit must not scan an unlimited hidden prefix |
| Occurrence/bookmark | `(structure, occurrenceId)` plus selected revision and exact target points | Renaming/reordering must not change the lookup key |
| Breadcrumb | At most `D` parent point reads | No recursive walk of all siblings or descendants |
| Insert/reorder | One parent/neighborhood, `O(log N + B)` work plus authority | Repeated insertion into the same gap must not grow key bytes indefinitely |
| Reparent | Old/new parent and at most two ancestor chains; normally `O(D log N + B)` | Concurrent A-under-B and B-under-A must not create a cycle |
| Next/previous | Bounded sibling and ancestor steps at one revision | Skipping hidden bodies must return continuation/unavailability when its budget ends |
| Publish/export | Bounded pages totaling `O(N)` plus exact target checks | A partial manifest must never become the published head |
| Backlinks/invalidation | `(target owner/kind, targetId, structure, occurrenceId)` | A popular target must not synchronously fan out to all users/structures |

Keep all structural mutations for one structure within its owning partition and serialize through its head
revision/CAS. A move validates the new parent's ancestor chain under the same serialized mutation. To enforce
a maximum depth without scanning the moved subtree, maintain reliable subtree-height metadata with an
indexed maximum-child-height seek and update the finite ancestor chains; otherwise use staged validation for
such moves. “Read the parent then update” without a concurrency invariant is insufficient.

Order is sibling-local. Do not use global consecutive integers that renumber the whole book on insertion.
Use finite order keys and bounded segments, with resumable compaction when a dense gap cannot be repaired in
one segment. Renumbering cannot change occurrence IDs, old revisions or page continuation semantics. The
current `schema:position` string permits only one-to-four-digit positive ordinals; it is a bibliographic
qualifier, not a sufficient universal TOC order-key design.

For current authoring, indexed adjacency plus revision history is the simplest initial storage candidate.
Historical reads must not replay an unbounded edit log: use retained indexed snapshots/checkpoints or
copy-on-write revision roots. The precise representation should follow the benchmark below. Publishing a
large manifest is allowed to take total work proportional to its finite contents; each step stays bounded.
Do not clone the entire tree synchronously for every title edit.

Compare hierarchy strategies explicitly:

| Strategy | Good fit | Cost that changes the decision |
| --- | --- | --- |
| Indexed adjacency with bounded recursive ancestor queries | Frequent reparenting, paged children, modest bounded depth | Descendant queries need explicit traversal or prepared population |
| Materialized path / `ltree` | Read-heavy path/descendant selection | Moving a subtree changes descendant paths; permissions and historical revision still need owner checks |
| Closure table | Frequent ancestor/descendant membership tests with relatively stable hierarchy | Up to `O(ND)` rows for bounded-depth trees, quadratic worst case for chains; moves rewrite affected ancestor/descendant pairs |
| Immutable ordered snapshots / copy-on-write pages | Exact published navigation and revision reads | More snapshot/garbage-collection machinery; mutation and retained-byte costs must be measured |
| One arbitrary graph with recursive query per read | Flexible exploratory traversal | Weakest bound on expansion, ambiguity of path/authority and high fanout; unjustified for the hot paths above |

PostgreSQL supports recursive queries with cycle detection and indexed `ltree` paths. These are tools, not
automatic complexity guarantees: the official recursive-query documentation warns that a final limit may
not bound work once sorting or joining forces full evaluation. A recursive query is appropriate for a
bounded ancestor chain, not for materializing an entire book before returning its first 25 chapters.
[PostgreSQL recursive queries](https://www.postgresql.org/docs/current/queries-with.html),
[ltree indexes](https://www.postgresql.org/docs/current/ltree.html)

### Authorization, caching and invalidation

Separate immutable structure bytes from current authorization. A cache key for a child page includes its
structure revision, parent, cursor, language policy and viewer/security observation where relevant. Exact
revision bytes can be cached by digest; permission to disclose them cannot be cached forever with those
bytes. A public publication never makes a currently hidden chapter or source readable.

For knowledge-base owned-child inheritance, reparenting can change effective access for descendants.
Invalidate/fence the changed authorization ancestry at the parent boundary immediately; update derived
search/index copies in resumable pages. Do not wait for every descendant index rewrite before enforcing
the new restriction. For reused target content, recheck its independent owner authority rather than
propagating destination permissions into the source. Cached breadcrumbs also require current disclosure;
they must not preserve a newly private ancestor's name.

Semantic target merges, label changes and restrictions already have relation re-emission/currentness paths.
The comparative property must enter those same paths. A Work merge must not merge its focused Concepts,
rewrite historical sources, move authored rights or deduplicate chapter occurrences that happen to point at
the same survivor. A structural reference to exact content must never be rewritten merely because its
associated catalogue Work was merged.

### Benchmark before selecting the structure representation

No latency or physical-work result was measured in this desk investigation. Proposed experiments should
compare ordinary PostgreSQL plans and retained snapshots with the same native owner and Access checks.
Start with child page 25 and trial depth bound 16; these are experiment parameters, not adopted product limits.

1. Grow unrelated subjects/structures through three scales while holding the target neighborhood fixed.
   Grow one anchor from 1,000 to 10,000 to 100,000 occurrences, and separately one comparison target through
   1,000/100,000/1,000,000 inbound claims. Include broad/shallow and deep/narrow shapes.
2. Measure first/middle/last child pages, exact bookmarks, breadcrumbs, next/previous, title edits,
   same-gap insertion, reorder, large-subtree move and full publication. Test repeated targets independently
   from unique targets and history length independently from current size.
3. Exercise anonymous, author, collaborator and revoked readers; 99% hidden candidate prefixes; current
   source withdrawal during a page read; permissions changed during reparent; and concurrent cycle attempts.
4. Search by direct comparative target, Concept, same-statement aspect, AND/OR/NOT, and scoped Collection/
   Library/Zone populations. Measure first useful page and explicit preparation, not just a capped response.
5. Record `EXPLAIN (ANALYZE, BUFFERS)`, examined rows, statements, partitions, bytes, index/WAL growth,
   lock waits, retry rate and end-to-end p50/p95/p99 with real authorization. Include warm/cold caches and
   process restart midway through staged publication or reindexing.
6. Require fixed-page/point work to stay bounded by `P`, `D` and `B` as unrelated `N` grows. Require reparent
   latency not to scale with subtree size for the adjacency choice, except explicitly staged derived work.
   Require publication's total work to be linear in its finite input, without quadratic replay or full-copy
   work on each mutation. Set numeric latency SLOs from the actual deployment budget after the first baseline.

## Migration, ownership and acceptance

Migrate meaning, not spelling. Existing Concept classifications remain classifications. A legacy “Dark Souls”
tag could mean the game itself, a style category, franchise membership, an influence claim or a personal label;
title equality cannot decide. Keep source identifier, original value and references; queue ambiguous values
for review. Do not globally replace every Concept with a matching Work or merge on `foaf:focus`.

For an explicitly mapped direct comparison, import an ordinary candidate against the native Work and
predicate. When a source later changes the association, preserve the old candidate/history and apply the
source-fence and selection lifecycle. If a category later becomes independently useful, create/adopt that
Concept and add warranted classifications; do not retroactively reinterpret all comparative references.

For hosted books, migrate structure revisions, stable occurrence identities, exact body selections and
their source provenance separately from bibliographic subjects. Do not treat every chapter as a Work.
Repeated placements must survive. Preserve old exact reading addresses through an explicit mapping; where
the old body is unavailable or its authority cannot be established, keep that fact unavailable rather than
substituting the latest text. A borrowed legacy algorithm requires attribution and tests if actually ported.

| Owner | Adoption or delivery responsibility |
| --- | --- |
| Definitions / Semantic | Comparative meaning, target grain, inverse labels, facet admission, optional exemplar semantics; native candidates, identity and current relation evidence |
| Search | Typed equality/same-statement execution, inverse discovery, complete index population, scoped composition, count/privacy/freshness and merge behavior |
| Content | Authored body/revision authority and new reading structure/publication contract; exact reading and lifecycle |
| Accounts / Access | Structure/source actions, owned-child inheritance policy if adopted, revocation and current authorization |
| Commerce | Reading progress and purchases; any explicit multi-chapter publication benefit contract |
| Imports / Conversion | Faithful source relation direction/meaning, provenance, explicit reviewed mappings and ordinary proposal path |
| Web / Presentation | Distinguishable Work/Concept selection, exact reading addresses, bounded trees, current unavailable states; no invented backend facts |

Minimum acceptance for comparative references:

- A contributor selects the actual Exit 8 Work, proposes a cited comparison and sees pending versus adopted
  state. The public reader/filter changes only after appropriate selection.
- A Soulslike classification and a Dark Souls comparison can coexist, disagree and be moderated separately.
  Neither is returned as adaptation/influence solely because the other exists.
- Book Work, its two editions, its Series and its author remain separate; comparison scope does not leak
  through edition, series or author links. Same-name Works are selectable by identity.
- Direct, inverse, negated and combined queries agree across supported catalogue, Collection, Library and
  Zone paths. Hiding/retracting a claim or target removes disclosure through results, facets, suggestions,
  counts and exclusion. Unknown coverage remains explicit.
- Duplicate Work merge/unmerge preserves original evidence and yields no duplicate canonical discovery
  hits; Concept and occurrence identities remain independent. Growing relation degree preserves bounded pages.

Minimum acceptance for authored structure:

- An authorized author creates a book structure with two nested parts and chapters, reuses one chapter in
  two places, and moves/reorders a placement without changing content or losing either occurrence.
- Two conflicting moves cannot form a cycle; stale revision edits conflict recoverably; unknown delivery
  retries the original idempotent command. Inserting repeatedly between the same two siblings remains bounded.
- Publishing freezes exact order and body revisions. Editing the next draft changes neither the published
  reader nor old exact links. Revision history identifies body-selection and structure changes separately.
- A target withdrawal or access revocation applies to current and historical reads, cached navigation,
  excerpts and search. Reparenting an owned knowledge-base page obeys the adopted permission policy; a link
  to that page never grants the target access.
- A 100,000-placement structure remains navigable by child pages and bounded neighbor seeks; sparse hidden
  content yields honest continuation/preparation. A restart resumes a large publication without exposing a
  partial manifest, and deleting a structure does not delete independently owned reused Posts.

These outcomes should be tested through native APIs before rendering work. Existing assertions and this
report are not substitutes for those tests. The report itself received no product test run because it changes
only research prose.

## Evidence confidence and what would change the recommendation

**High confidence:** current Work/Edition/Concept/agent boundaries and strict target validation; absence of a
released narrow comparison predicate in the inspected catalogue; the one-revision meaning of Content Edition;
the need to distinguish placement from target identity. The retrieved primary sources and current source
agree on these distinctions.

**Moderate confidence:** direct comparisons plus optional real Concepts are the smallest useful public model.
The user examples establish the need to name Works descriptively, but do not establish a single universal
meaning of “like.” A corpus of real desired queries and reviewed claims could show that mechanical style,
tone and narrative structure need separate predicates or a mandatory aspect qualifier.

**Not established:** current runtime readiness of all Search populations, native performance, count privacy,
the exact desired chapter editor permission model, or the economics of a retained structure representation.
There was no production load, API walk or browser verification in this investigation.

Evidence that would change the decision:

- If most real title-derived terms have stable definitions, source schemes and membership materially
  different from pairwise comparison, favor Concept-first authoring for that population, while retaining
  Work references for actual comparisons.
- If users need n-ary comparisons, independently discussed comparison objects, several named exemplars in
  one claim, or qualified assessments that cannot be represented faithfully by existing statement candidates,
  reconsider a first-class assessment entity. A role wrapper alone is not evidence of that requirement.
- If the knowledge-base requirement mandates the **same owned node** under multiple permission parents,
  the strict occurrence tree plus references may be insufficient; adopt explicit DAG path semantics and
  permission-combination rules before claiming shared authoring support.
- If measured workloads are mostly descendant queries on almost immutable structures, materialized paths
  or closure can beat adjacency despite their move costs. If exact-history reads dominate, immutable indexed
  snapshots may deserve priority. Compare measured write amplification and revocation cost, not only reads.
- If current native owners already expose a complete reusable versioned ordered structure outside the
  inspected Content/Semantic paths, reuse it after checking its target/authority invariants. The negative
  finding here is scoped to the inspected current contracts, not a proof that no reusable primitive exists
  anywhere in the repository.

## Retrieved source and licence record

Primary web documents above were retrieved on 11 November 2026; standards are cited to their actual
specification pages and product docs describe their retrieved versions. The Open Library API documentation
URL attempted during research was unavailable through the retrieval tool; no claim relies on that response.
Its already-present reference checkout supplied the cited schema evidence instead.

| Inspected source | Revision/version and licence boundary |
| --- | --- |
| Open Library existing reference checkout | `37e446827465be2febad416de1bc18753b66997d`; root LICENSE is AGPL-3.0; schema behavior read, no source copied |
| BookWyrm existing reference checkout | `fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4`; LICENSE.md is Anti-Capitalist Software License 1.4 with use restrictions; model behavior read, no source copied |
| FOAF | Vocabulary specification 0.99, 14 January 2014; its page states Creative Commons Attribution; paraphrased technical meaning |
| SKOS / EPUB | W3C Recommendation 18 August 2009 / EPUB 3.3 Recommendation 13 January 2026; linked W3C document licences; paraphrased behavior |
| Schema.org | Retrieved development vocabulary pages, displayed version 30.1; vocabulary evidence only |
| Wikidata | P737 revision `2539717574`; page states structured data CC0; property meaning only |
| Notion / PostgreSQL | Retrieved official product/technical documentation; behavior cited, no implementation copied |

The reference checkouts were inspected without installation, build or execution. No other researcher's
work-derived-label or chapter conclusions were used.
