# Catalogue, definitions and editorial journey

Research evidence, 2026-10-31. This report covers the existing Semantic catalogue and its definitions,
editorial and reader surfaces. It recommends completing the already owned journey, rather than adding a
catalogue service. Recommendations here are not adopted contracts or evidence of native execution.

## Finding and boundary

The underlying model already supports cited alternatives, separate acceptance and adoption, Context-specific
selection, immutable release interpretation and bounded related-subject reads. The principal product gap is the
connection between those capabilities: a reader cannot yet follow one delivered generic create/edit/review/history
flow from the actual Web subject page. Two important backend gaps already have owners: current Source attribution
and contribution deletion/retention. Collection facts and Realm-context page dispatch also have selected contracts;
another implementation or proof stage would duplicate their work.

The recommendation is five complete repair slices below: identify the right subject; contribute a cited field;
compare and decide; explain the current reading; and withdraw or remove material through its proper owner.
Each slice includes its existing native methods, missing seams and user-visible result.

Authority remains with [scope](../scope.md), [architecture](../architecture.md),
[Semantic](../../services/kernel/src/semantic/README.md), [definitions](../../packages/definitions/README.md),
[subject pages](../subject-pages.md), [Collection presentation](../collection-presentation.md) and their linked
contracts. [The Semantic Goal](../goals/semantic.md) supplies ownership and outcomes. The accepted
[standard-vocabulary and LinkML ADR](https://github.com/rezics/rezics-next-discussion/blob/7ff5c2aa6034f8fbd9951cf477c040804b125f65/docs/adr/0031-standard-vocabularies-linkml-definitions.md)
was consulted for unconverted background; this report does not move its authority or reopen its architecture.
Existing [Schema.org mapping research](catalogue-schema-org-mapping.md),
[release-grain research](anime-release-profile-grain.md),
[catalogue integration audit](semantic-integration-audit-core-catalogue.md),
[native Access research](semantic-native-leaf-access-current.md) and
[history/erasure research](shared-history-erasure.md) are reused where relevant.

Custom definition publication, advanced identity operations, reviewed seed expansion and measured-input expansion
remain under their current gates. Nothing here opens saved-query execution, a new permission/query/content/ownership
engine, arbitrary executable configuration, recipe-site imports, or a public article/media product. A catalogue
profile here means a subject's description and facts; it does not mean a personal Library progress profile or a
Puck page-layout document.

## Primary-source patterns and what they change

### Claims, references, ranks and collision handling

Wikidata models a statement as a property/value assertion with optional qualifiers, references and rank. Multiple
assertions can coexist; an unknown value differs from an assertion that there is no value. Its references identify
support for an individual assertion, rather than making an item's entire page uniformly sourced.
[Statements](https://www.wikidata.org/wiki/Help:Statements),
[references](https://www.wikidata.org/wiki/Help:References).

Wikidata's normal, preferred and deprecated ranks select among values for reading and querying. Rank does not
replace the reference or settle a dispute by itself. Historically correct time-qualified information need not be
deprecated merely because a newer value exists. This supports explicit competition and an explanation of the
selected value; it does not justify turning a citation into a truth badge.
[Ranking](https://www.wikidata.org/wiki/Help:Ranking/en).

The official Wikibase REST specification offers statement collection reads/additions and individual
GET/PUT/PATCH/DELETE. Conditional requests use the containing entity's revision ETag; failed preconditions return 412. PATCH can fail because a patch cannot apply or because its result is invalid. The implementation checks edit
permission, validates the resulting statement and rejects changes to its ID or property.
[REST OpenAPI](https://github.com/wikimedia/mediawiki-extensions-Wikibase/blob/f04124242a234a3c37f96d4be3b6ace69aebde17/repo/rest-api/src/openapi.json),
[preconditions](https://github.com/wikimedia/mediawiki-extensions-Wikibase/blob/f04124242a234a3c37f96d4be3b6ace69aebde17/repo/rest-api/src/Middleware/RequestPreconditionCheck.php),
[patch use case](https://github.com/wikimedia/mediawiki-extensions-Wikibase/blob/f04124242a234a3c37f96d4be3b6ace69aebde17/repo/domains/crud/src/Application/UseCases/PatchStatement/PatchStatement.php).

**REZICS implication:** retain immutable candidates and append a replacement proposal when correcting a value,
qualifier or reference. Reuse native `expected_head` for decisions and adoption; a Wikibase entity ETag is not an
equivalent editorial head. Present acceptance, selected rank and visibility separately. There is no justification
for a second mutable statement store, confidence score or dispute-ticket engine.

### Edit the described object at the right grain

Open Library distinguishes work-wide information from edition publication information. Its actual editor labels
Work Details separately from the selected publisher/date edition; its edition form contains publisher, publication
date, language, identifiers and pagination. Its history page links individual revisions, changes and comparison
against the current version. These are useful navigation patterns, not a reason to import its permissions or schema.
[Official editing guide](https://openlibrary.org/help/faq/editing),
[editor source](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/books/edit.html),
[edition source](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/books/edit/edition.html),
[history source](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/history.html).

**REZICS implication:** before editing or creating, identify the actual work, edition or release and show that choice
through submission and review. A correct page count on the wrong work remains an incorrect catalogue contribution.
The existing generic relation model and release classes suffice; do not create a vertical-specific backend.

### Definitions are compiled data, not an editor execution language

Official LinkML documentation treats annotations as extension metadata, with arbitrary tags allowed by default;
declaring their structure with `instantiates` does not itself provide the documented validation enforcement.
Its inheritance documentation distinguishes authored and induced class attributes.
[Annotations](https://linkml.io/linkml/schemas/annotations.html),
[pinned inheritance documentation](https://github.com/linkml/linkml/blob/ae3df7a455031d49f62b802d484a6c9e73f57b4c/docs/schemas/inheritance.md).

**REZICS implication:** the restricted compiler and release validator remain essential. A generic editor consumes
the emitted effective Type properties, datatypes, targets, cardinalities, units and localized descriptions. It must
not evaluate arbitrary LinkML annotations, Python, functions or client-side ancestry rules. The existing Bun/kernel
runtime consumes the immutable release; upstream generator tooling is not a new runtime dependency.

Schema.org describes Recipe cooking time as a duration and allows several recipe-instruction representations.
SKOS separately models concepts and concept schemes, multilingual preferred/alternative labels and mappings;
its preferred-label integrity condition is one preferred label per language.
[Recipe](https://schema.org/Recipe), [SKOS reference §§3–5,10](https://www.w3.org/TR/skos-reference/).

**REZICS implication:** external vocabulary alignment does not replace native value contracts. Keep Recipe's native
minute quantity, Content document and diet Concept targets, with explicit serialization codecs. Public classification
Concepts, actual subject Types and private Library Labels have different purposes. A label or mapping match never
authorizes a Type conversion. The accepted `foaf:focus` convention links a Concept to its referent; this report does
not derive that convention from SKOS alone.

The shared pattern is a stable described identity, structured field-specific evidence, explicit selection and a
recoverable explanation of change. REZICS already separates these concerns more finely than the external editors.
The repair is to make those distinctions usable and connected, while retaining native Access and Content custody.
No third editor was needed to resolve an additional gap.

## Journey and complete repair slices

### 1. Discover, inspect, and choose the actual subject

**Reader outcome.** Search or a Collection leads to a recognizable subject page; Editions/Contents/Relations let
the reader choose the actual object before adding it to a Library or correcting its description. Show publication
date, language and publication identifiers where appropriate, rather than implying that every same-title result is
interchangeable. Preserve the chosen subject ID when moving from reading into contribution.

| Boundary        | Actual contract/implementation and output                                                                                                                                                                              | Owning module and seam                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery       | `POST /v1/subjects:search` accepts text, admitted filter/sort, limit/cursor, languages and up to four properties; facets and suggestions use `:facets` and `:suggest`. Hits carry Search facts and hydrated summaries. | Search: `search/http/routes.ts`, `hits.ts`, `current-leaf.ts`; Semantic supplies current references/summaries. Never use the index as permission authority. |
| Detail          | `GET /v1/subjects/{id}` returns `{subject,account,summary,related}`. `Item` includes Type, release, Context, terms, statements and resolution. `related` batches labels/covers for displayed links.                    | Semantic: `http/subjects.ts`, `subject.ts`, `item.ts`, `summaries.ts`; `semantic.subject`, `fact`, `revision` and editorial tables.                         |
| Reader page     | `POST /v1/pages:read` currently accepts one subject/route/account target, optional existing view and languages; returns profile/template/document, views and keyed read results.                                       | Search-owned presentation: `presentation/http/pages.ts`, `reads.ts`; composition templates. Current closed parser does not accept `target.realm`.           |
| Actual Web URLs | `/subjects/$id` canonicalizes to `/subjects/$id/$slug`; the `$view` route renders the selected view. `features/pages/subject.tsx`, `views.ts` and `data.tsx` present the returned reads.                               | Web: `routes/subjects/$id.tsx`, `$id_.$slug.tsx`, `$id_.$slug_.$view.tsx`. A Details view is not a delivered editorial workspace.                           |
| Traversal       | Existing links/relations/counts/graph APIs provide bounded previews and continuation; templates select Editions, Contents, Characters, Credits and other applicable sections.                                          | Semantic `links.ts`, `counts.ts`, `graph.ts`; subject-page contract forbids a fixed first slice masquerading as a complete list.                            |

Kernel paths with a module prefix are relative to `services/kernel/src/`; unprefixed names are within the named
owning module. Web paths are relative to `apps/web/src/`. The actual route and DTO evidence is in
[subject HTTP](../../services/kernel/src/semantic/http/subjects.ts),
[Search HTTP](../../services/kernel/src/search/http/routes.ts),
[page HTTP](../../services/kernel/src/presentation/http/pages.ts) and
[Web page data](../../apps/web/src/features/pages/data.tsx).

The grain choice is already data in [catalogue YAML](../../packages/definitions/catalogue/):

- Book work is `schema:Book`; a published book edition is `bf:Instance`, linked by `schema:exampleOfWork`.
  Work word count is an exact quantity in unit `1`; edition pages and ISBN belong to the edition. A progress page
  amount is neither the work's word count nor evidence that an edition has that many pages.
- Anime series, film, season and episode keep their creative identities. `rezics:AnimeRelease` already exists at
  this base: it describes an independently identified publication/distributed embodiment. A single-work release
  uses `exampleOfWork`; an anthology uses `animeReleaseContains`. Language/format combinations, a media file,
  personal Copy and distribution event do not automatically become release subjects. Do not copy work credits
  into release facts. This corrects the older release-grain report's then-missing-class status.
- Game/VN releases retain the shared software-release class `wd:Q20631656`; no separate VN release backend is
  needed. AnimeRelease currently has no Library annotation, so an editor must not infer Book or game progress
  behavior from its name or from being a publication.
- Recipe keeps its existing native Type and fields: ingredient monolingual text, ingredient-material links,
  integer cooking minutes, serving quantity, dietary Concept claims and an authored instruction document.
  Schema.org serialization does not reparent or change those native contracts.

**Repair input/output.** Entry from discovery or Details supplies a canonical subject ID and its current Type;
creation starts with an explicit admitted Type and a duplicate-search opportunity. Output is either the chosen
existing page or a new native subject, never an automatic merge, invented edition hierarchy or inferred release.
The subject-page contract already supplies recognizable identity, honest unresolved facts, full-view links,
server-rendered URLs and localized labels. Web should connect those to the generic editor below.

**Required states.** Distinguish loading, no matches, genuine empty relation, partial preview, failed read with
retry, unresolved claim, canonical redirect and concealed 404. Do not show raw CURIEs/document IDs in reading
views or translate a readiness failure into an empty catalogue. Independent section failures retain their own retry.

#### Type hints, member Types and Collection kind

The restricted [compiler](../../packages/definitions/src/compile.ts),
[release schema](../../packages/definitions/schema/release.json) and
[Type contract](../../packages/definitions/src/index.ts) already emit optional effective
`Type.listPresentation = {imageAspect,keyFacts}`. The nearest explicit declaration replaces the whole object;
`keyFacts: []` clears inherited facts. Portrait/landscape/square mean list frames 3:4/16:9/1:1, independently of
`coverRatio` or stored media dimensions. Zero to four ordered unique effective properties are allowed, limited
to existing Fact-compatible item/time/quantity/patterned-code values. Documents, media, arbitrary text, functions
and JSON paths are not list hints. Hints choose fields; they cannot manufacture values.

In contrast, Collection `presentationKind` is an owner-selected TypeId or a complete current-member derivation.
It does not change a member's actual Type, membership, accepted Library profile pin or permission. Each member
uses its own Type's hints even in a mixed Collection; grid/list/table are client layouts. Auto-kind counts each
canonical visible subject once across the complete admitted membership, preserves duplicate curated occurrences,
and breaks ties by exact TypeId order. `pending` is distinct from proven `empty`.

The [joint contract](../collection-presentation.md) explicitly leaves native auto-kind derivation and FULL member
fact enrichment to their registered producers. `SubjectSummary` currently has no facts. Selected, not yet callable,
`semantic/list-presentation.ts:readListPresentationFacts` takes at most 100 original IDs, returns original-keyed
terminal identities and at most four properties with three values each, using Search's existing Fact union.
Commerce's `library/collection-routes.ts` and common member producer own integration and final currentness;
Semantic owns original/terminal/source/related-value disclosure. Absent `facts` means unavailable/unrequested;
`{}` means complete visible no-facts; unproved requested readiness is 503. Web must not fill the seam with a
per-card detail waterfall or a first-page sample for Collection kind.

### 2. Create or correct a generic profile, with evidence

**Contributor outcome.** The form names the selected object and Type, renders admissible fields, validates an
authored value and its citation, and reports what was actually saved. Creation and later proposal are different
operations. Choosing a property must also expose its admissible qualifiers, item targets, units and multiplicity.

| Input/action            | Current native method and result                                                                                                                                                                                                                          | State and ownership                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New subject             | `POST /v1/subjects`, `ItemInputSchema`: `{type,labels,descriptions?,aliases?,statements?}`; returns `201 {subject}`, Location, ETag and Session. Server chooses the active effective release.                                                             | Semantic `subject.ts:createSubject`; bounded compact creation facts are already virtually accepted/adopted in Global. Do not tell the user these are pending proposals.                                           |
| Correct/add a fact      | `POST /v1/subjects/{id}/candidates`, closed body `{statement}`; returns `201 {candidate,revision}` and Session. The ordinary caller cannot supply ingestion Source metadata in this body.                                                                 | Semantic `candidates.ts:proposeStatement/writeProposal`; immutable candidate in `semantic.candidate`, proposal revision in `semantic.revision`. A successful proposal does not select it for the current reading. |
| Structured assertion    | Statement input is validated against the actual subject Type and effective release. Read `Statement` contains property/datatype, value, qualifiers, reference parts, rank and `rezics:{release,revision}`. `value`, `somevalue`, `novalue` stay distinct. | `item.ts`, definitions validation and `candidates.ts:validatedStatement`; generic controls encode actual native values, not display strings.                                                                      |
| Authored long text      | Existing authored-document input includes body/licence/language; Semantic's `authored.ts` delegates to Content and stores a document reference/digest.                                                                                                    | Content `appendAuthoredField` owns immutable body and rights; Semantic owns candidate/revision linkage. Never copy a cited site's instructions into a catalogue field as an import feature.                       |
| Correct bootstrap terms | No ordinary public labels/descriptions/aliases replacement route is mounted in `http/subjects.ts`. `subject.ts:updateSubjectIdentity` is internal and only accepts labels/Type, not a complete public term-edit protocol.                                 | Explicit Semantic HTTP/command seam. A `schema:name` candidate is not a substitute for changing the label map. Type migration and advanced identity remain closed.                                                |

The generic form is a **missing Web composition**, not another catalogue implementation. Current
[Puck editor](../../apps/web/src/features/pages/editor.tsx) and `routes/curate/presentation.tsx` edit presentation
documents. The actual Web routes and calls do not yet provide subject creation, proposal, acceptance, adoption or
revision-history screens. Reuse generated kernel types and existing page components; do not present the layout
editor as a working catalogue editor or invent a callable term-write endpoint.

**Repair input/output.** Fetch `GET /v1/definitions/active` and its immutable
`GET /v1/definitions/releases/{digest}`, then the subject when editing. Render controls from the emitted data,
localize Type/property descriptions, and keep value/qualifier/reference editing together. Submit the existing
creation/proposal method with `Idempotency-Key`; retain the returned subject/candidate/revision and Session.
For a replacement, show old assertion alongside the new candidate and its references; never mutate the old ID.
Do not enable post-create term replacement until Semantic supplies its ordinary native write contract and generated
DTO. That seam needs term inputs, current-concurrency behavior and a returned Item/revision in the owner document;
this report does not choose an uncontracted route or expose the internal Type-update function.

The eight launch locales are `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, `de`, `fr`, `es`. Definition labels and
descriptions, field wording, choice labels and validation messages must work through the same locale mechanism.
Subject-language values are data: preserve originals and explicit language tags, and use the existing fallback
rules rather than overwriting an unavailable translation. Do not assume every source supplies eight translations.
Definitions' Type/property labels and descriptions are distinct from a subject's multilingual term maps.

**Required states.** Draft, invalid field with pointer, saving, created, proposed-awaiting-review, denied,
current release unavailable, and retryable failure must differ. Keep the draft after failure. The server's active
release can change after form load; handle returned validation and reload definitions without claiming that the
client's cached release was pinned by a request field that does not exist.

Immutable release storage and the active pointer already belong to
[definitions.ts](../../services/kernel/src/semantic/definitions.ts) and `semantic.definition_release` /
`definition_activation`. Candidate release/slot bindings retain historical meaning; activation does not rewrite
old assertions or accepted personal Library profile pins. `packages/definitions/release/rezics.json` and Web's
`kernel/recorded/definitions-active.json` / `definitions-release.json` are the bundle handoff, not evidence that
custom publication is publicly enabled. New verticals remain definitions/presentation data in this stack.

### 3. Compare claims, review, accept and adopt

**Reviewer outcome.** See competing assertions and their evidence for one exact slot, record acceptance or
rejection, and separately select the current values and ranks for an authorized Context. The UI must explain a
proposal that is accepted but not adopted, and a community reading that inherits or suppresses Global.

| Operation        | Actual DTO/output                                                                                                                                                                                                                                              | Owner/data                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read competition | `GET /v1/subjects/{id}/candidates?property=…&context=…` plus relation slot address and limit/cursor. Rows include `id,source,retracted,retraction,statement,release,revision,decision,head,rank`; response also has adoption `{mode,head}` or null and `next`. | `candidates.ts:listCandidates`; `candidate`, `source_candidate`, `retraction`, `acceptance_current`, `adoption`. No separate candidate-by-ID HTTP read is mounted. |
| Accept/reject    | `POST /v1/subjects/{id}/candidates/{candidate}:accept` or `:reject`, body `{context,expected_head}`; result `{acceptance:{context,candidate,decision,head},revision}`.                                                                                         | `decideCandidate`, `semantic.acceptance` plus `acceptance_current`; native Context `context:accept`. Acceptance alone does not choose the reading.                 |
| Adopt/rank       | `POST /v1/subjects/{id}:adopt`, body `{context,property,target?,sameAs?,key?,mode,selection:[{candidate,rank}],expected_head}`; result `{adoption,revision}`.                                                                                                  | `adoptCandidates`, `slots.ts`, `semantic.adoption`; native Context `context:adopt`. Selection is at most 32; actual selected ranks are normal/preferred.           |

`expected_head` is the current candidate decision head for accept/reject, or slot adoption head for adoption;
null means no existing head. Stale heads return 409 `stale_editorial_head`; reload that comparison and preserve
the intended draft rather than silently resubmitting against a new head. Replaying an identical authorized command
uses its original receipt; a different action after review uses a new key.

Global supports `replace`. Community Contexts support `inherit`, `replace` and `suppress`; inherit/suppress require
empty selection. The HTTP input enum includes `deprecated`, but the native adoption function explicitly rejects
that selection rank. Rejected candidates can appear as deprecated in Global's display view; they are excluded
from `effectiveGlobalSlotFacts` for Search. Do not offer a successful-looking "adopt deprecated" action or equate
rejection with deleting the underlying assertion. For a single-valued property, native adoption rejects multiple
selected entries. The unresolved community-inheritance state is already produced when its rejections eliminate
the inherited reading; Web must render returned resolution rather than choose a winner by date or array order.
[Native selection](../../services/kernel/src/semantic/candidates.ts),
[slot views](../../services/kernel/src/semantic/slots.ts).

Relation competition must address the same slot as the assertion: target ID or `sameAs` placeholder, and where
declared the item qualifier `key` (for example a character on a voice credit). `target` and `sameAs` are mutually
exclusive; scalar slots reject relation addressing. Comparing all credits under a property as one scalar slot
would erase valid distinct roles. Existing definitions relation metadata and `item.ts` slot functions own this.

**Repair input/output.** Link a contested Details field to a paginated, evidence-bearing comparison for that exact
slot. Display each row's value, qualifiers, references, release interpretation, current decision and selected rank;
show Context and actual allowed actions. Use the two existing write methods and then refresh the actual subject
and competition with Session continuity. Output is an updated decision/selection and an explainable current page,
not a simulated preview of a write. No new moderation queue or discussion engine is required.

**Required states.** Unreviewed, accepted-unselected, rejected, adopted normal/preferred, inherited, suppressed,
unresolved, retracted, hidden, stale comparison and denied action remain distinct. A reader may inspect disclosed
competition without having review authority. An editor's private visibility must not enlarge public page output.

### 4. Read the current result, history and attribution

**Reader outcome.** Overview remains readable; Details explains the current Context, claim selection and sources.
A contributor can navigate from the saved candidate/revision back to its current status without being told that a
revision-number list is a complete historical comparison.

Current `Item` has terms, statement references, per-statement release/revision and resolution. The revision endpoint
`GET /v1/subjects/{id}/revisions` returns only paginated `{revision,kind,release,source}` rows. Its
[SQL](../../services/kernel/src/semantic/candidates-read-revisions.sql) reads `semantic.revision`; it does not expose
full snapshots, a diff, or the sequence of past acceptance/adoption bodies. No full revision/diff HTTP contract is
mounted. The precise seam is an authorized explanation of a change and its relationship to today's reading,
owned by Semantic's existing revision/candidate modules, then rendered by Web. The manager can adopt a minimal
explanation read there; this report does not claim an existing `?revision=` API or authorize a second history store.

Reference parts on statements, an ingestion Source tuple, displayed provider metadata, authored Content rights,
and cover/media attribution are separate:

| Information                         | Current authority and exact gap                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Citation                            | `Statement.references[].parts` supports the assertion. Web `features/pages/data.tsx` renders presentable values and gathers reference URLs only from displayed nongated statements. A URL is not a verification badge.                                                                                                                                    |
| Ingestion provenance                | `semantic.revision.source` / `source_candidate` identify exact source-record support and retraction. A source tuple is not the human contributor or a grant to edit the subject.                                                                                                                                                                          |
| Source name/URL/licence/attribution | The [Source-record contract](../../services/kernel/src/semantic/source-record-attribution-contract.md) explicitly marks `source-records.ts`, `http/source-records.ts`, `semantic.source_record`, `Item.sourceRecords` and generated types as missing producer work. Web's optional `Reflect.get(subject,'sourceRecords')` and fake data do not supply it. |
| Authored document                   | Content owns body, language, licence, current read/erase authority and source fences; Semantic owns its ID/digest and contribution anchor. `GET /v1/documents/{id}` and document DELETE remain Content operations.                                                                                                                                        |
| Cover/media                         | Content/UI cover contracts govern selected asset metadata, download rights and credits; a structured-data licence never licenses the image or recipe prose.                                                                                                                                                                                               |

The selected metadata endpoint is **not mounted yet**: `POST /v1/source-records:setMetadata` accepts
`{source,external_id,metadata:{name,url,licence?:{id,url?},attribution?},expected_metadata_revision}` and returns
`{record,metadata_revision,effect:'filled'|'corrected'|'noEffect'}` under trusted `subject:batch_write`.
Identity is the exact `(source,external_id)`
tuple; null revision fills missing metadata without silently overwriting conflicting fields, and a positive revision
is an explicit CAS correction. Existing receipt/rollback semantics apply. This is the existing producer's work.

Its selected projection is `GET /v1/subjects/{id}` → `subject.sourceRecords`, derived only from exact support for
actually returned terms and adopted statements. Bootstrap terms require their original revision Source support;
they have no candidate ID, and a later selected `schema:name` claim does not erase their provenance. Current
`read-subject.sql` / `asFacts` do not carry that complete support, so filtering only statement IDs is insufficient.
Do not infer support from metadata presence or attach every provider record to every field. Source/Content tuple
and field-group fences must remove stale support before refresh, including term and related-value projections.

Realm reading is a separate **already selected missing binding** in [subject pages](../subject-pages.md#realm-context).
The proposed `target.realm` selects the actual Community `readRealm` and publication, then the current Context;
it is not an arbitrary client Context override. Subject and links must use that one selection. Denied Realm/ban
conceals 404; a readable Realm with genuinely null publication may fall back only to an independently authorized
Global reading with exact Global metadata. Late publication withdrawal/rejection, Context change and bans require
the existing final authority guard and bounded retry/readiness behavior. Current `pages.ts` lacks this dispatch;
`presentation/reads.ts` already supplies sticky `withPublicStatementReader` for probe and planned reads. Preserve
the real caller and Session. Do not create Realm rating/review/discussion/list population bindings: those remain
separately owned and unfrozen where the subject-page contract says so.

**Repair input/output.** Existing subject, candidate and revision reads supply a truthful initial Details/history
surface; clearly label its limits. Finish the registered Source projection and Realm dispatch through their owning
modules, then consume their generated DTOs in Web. The eventual explanation must connect a selected value to its
citation, proposal release, decision and adoption, without disclosing private candidates or erased payload.
Empty references, metadata unavailable, concealed material, incomplete history and failed reads need distinct states.

### 5. Delete, restore, take down and clean up an account

**User outcome.** A contributor can withdraw their own contribution through its native lifecycle, a moderator can
withhold reported material through moderation, and account closure removes personal payload without destroying
communal catalogue identity or pretending that provenance made the account owner of every cited fact.

| Action                           | Actual or selected method/status                                                                                                                                     | Owner and resulting page state                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Moderator hide/takedown/restore  | Mounted subject and candidate `:hide`, `:takedown`, `:restore`; reasons/notices and security revisions are native.                                                   | Semantic `moderation.ts`, `semantic.moderation` / `hidden_candidate`; public concealment, authorized moderation state and restoration. These are not ordinary contributor undo.                                                |
| Special consent                  | Mounted `POST /v1/statements/{id}/disclose` and `:retract`. Retraction is terminal for this consent flow.                                                            | `statement-disclosure.ts`, `semantic.statement_disclosure`; target consent does not transfer ownership of an independently cited fact.                                                                                         |
| Contribution soft delete/restore | Selected, missing HTTP lifecycle: `DELETE /v1/subjects/{id}/candidates/{candidate}` and `POST …/{candidate}:restoreDeleted`.                                         | [Deletion contract](../../services/kernel/src/semantic/deletion-contract.md): original native author/write-revision basis, tombstone, 30-day restore, expired409; no whole-subject owner deletion.                             |
| Community Context delete/restore | **Implemented** `DELETE /v1/contexts/{id}` and `POST /v1/contexts/{id}:restore`, `{context:{id,state}}`, receipted native commands.                                  | `http/contexts.ts`, `context-lifecycle.ts`, `semantic.context`; current direct owner grant plus Access, no personal deletion of Global. Some older status tables still say create/read-only.                                   |
| Retention/hold/legal removal     | Contribution purge/hold, automatic minimization and least-field scoped withholding remain requirements; takedown's free-text `scope` is not a structured field mask. | Semantic deletion owner, shared retention/custody contracts, Content for documents/media. Preserve eligible nonpersonal history skeleton; never infer purge completion from hidden UI.                                         |
| Account closure                  | Accounts confirmation fixes final T, with no account-level 30-day grace; Semantic already registers its local erasure WorkModule and tracks exact locators/custody.  | `account-erasure-work.ts`, `work-module.ts`, [account-erasure contract](../../services/kernel/src/semantic/account-erasure-contract.md). Local runtime is not proof of every receipt/outbox/shared-custody erasure obligation. |

`readSemanticLifecycle` in [lifecycle-state.ts](../../services/kernel/src/semantic/lifecycle-state.ts) already returns
trusted state/owner evidence; it grants no permission and performs no transition. Candidate evidence currently
returns active state, so it must not be advertised as delivered candidate tombstone/restore storage. Original
`editorial.write_basis` and native transaction attribution establish contribution authorship, not source-record
provenance, adoption, or whoever first created the subject. Context ownership uses the current native owner grant,
including transfers/revocations; creation history is insufficient.

**Repair input/output.** Contribution deletion takes the exact original subject/candidate and author evidence;
output is the specified tombstone, current-read absence and deadline-aware restore, followed by eventual minimization
through existing retention ownership. Context controls can consume their delivered methods now. Moderation keeps its
separate reason/notice flow. Account cleanup joins the existing Accounts barrier and exact Semantic/Content copy
obligations; it does not cascade-delete works, releases or unrelated contributions. A page must distinguish
deleted-with-restore, expired/purged, hidden/taken-down and terminal consent retraction without leaking withheld text.

## Native authority across all five slices

The existing [anchored authorization](../../services/kernel/src/semantic/http/subjects.ts),
[Context creation](../../services/kernel/src/semantic/context.ts),
[aggregate disclosure](../../services/kernel/src/semantic/aggregate-disclosure.md) and
[Source contract](../../services/kernel/src/semantic/source-record-attribution-contract.md) apply throughout:

- Subject creation uses Global `subject:create`; proposals use Global `statement:propose`. Review and adoption use
  the selected Context's `context:accept` / `context:adopt`. Trusted bulk work uses `subject:batch_write` with its
  per-command requirements. Moderator actions use their existing moderation actions. UI capabilities never grant them.
- Parent creation authority comes from real Access on the parent/Global Context and native resource initialization.
  Community Context creation initializes current owner grants through the existing access helper; it does not accept
  a client assertion of ownership. An account/agent link and a Source tuple are not substitute grants.
- Same-partition commands authorize natively; cross-partition writes use the server-owned, validated
  `resourceAuthorization` anchor before target release/admission work. No ad hoc actor injection, boolean permission,
  second permission cache or unprotected helper bypass is appropriate for the new Web flow.
- `runCommand`, native time, request digest, `Idempotency-Key`, `core.receipt`, write basis and one owning-partition
  transaction already provide replay/rollback and Session continuity. Current authorization precedes receipt replay;
  a revoked owner cannot recover old effects by replaying a successful key. Changed-body replay returns 422
  `idempotency_conflict`, not an edit.
- Current source/field fences, subject/Context visibility, candidate disclosure and related-value authority apply to
  detail, competition, search facts, cards, links, counts, history and documents. Public aggregate readers remain
  public even when the caller privately owns an undisclosed candidate. Omit unproved counts rather than disclose a
  private inverse relation; no client filter can repair an already leaked count.
- Use actual Auth failure semantics. A genuine pre-suspension bearer becomes 401 `invalid_credentials` with
  `WWW-Authenticate: Bearer error="invalid_token"`; a defensive verified-suspended 403 path is not the same persona.
  Hidden/unreadable targets conceal 404 where contracted. Source citations do not override consent or privacy.

For properties marked `disclosure: sourceOrConsent`, a reference makes a statement eligible for ordinary public
review; without a reference, only the account linked to the target agent may assert it and it remains private until
that account discloses it. This is the existing [definition and disclosure contract](../../packages/definitions/README.md#statement-disclosure),
implemented through `semantic/statement-disclosure.ts`, not an optional editor preference. A generic form must
explain that state without exposing the private candidate through public competition, related labels or aggregates.

All reads remain bounded owner reads: batch distinct full keys by partition, use current authorization and the
existing deadlines/budgets, and avoid cross-database joins, per-row hydration and whole-history scans. A polished
editor cannot make an unavailable fact producer or an unproved source projection ready by changing its UI state.

## Adoption recommendation and remaining native outcomes

Adopt the five slices in the existing owner documents, using the following responsibility boundary. This is a
delivery map for registered work, not a request to create a duplicate implementation or another proof campaign.

| Slice                    | Precise remaining repair                                                                                                                                                                | Existing owner                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Find the right object    | Connect actual discovery/detail/edition traversal to explicit generic create/edit entry; finish common FULL facts/Collection kind without guessing.                                     | Web page routes; Semantic references/list facts; Search discovery/presentation; Commerce common Collections. Definitions grain and list hints are already present. |
| Contribute evidence      | Build the generic field/citation form on native creation/proposal and Content authored fields; freeze the missing ordinary term-correction HTTP seam before claiming full term editing. | Web; Semantic subject/candidate HTTP and definitions validation; Content document custody. No new Type migration/publication scope.                                |
| Compare and decide       | Expose exact-slot candidates, independent decision/adoption heads, valid ranks and conflict recovery; carry the saved result back to current reading.                                   | Semantic candidate/slot methods already exist; Web composition is missing.                                                                                         |
| Explain the reading      | Finish exact Source-record metadata/support projection and selected Realm dispatch; expose an owned authorized change explanation beyond today's revision-number list.                  | Semantic Source/revision modules; Search presentation; Community current Realm/publication authority; Web Details/history.                                         |
| Remove through the owner | Complete contribution tombstone/restore and retention/withholding/copy minimization; consume delivered Context lifecycle; preserve communal identity and Accounts finality.             | Semantic deletion/erasure; Accounts barrier; Content and shared custody owners; Web action states.                                                                 |

Future native outcomes must demonstrate the user's result, not merely that a mocked form changes state. Existing
`services/kernel/test/semantic/` contracts already cover subjects/candidates, compact decisions, authored documents,
anchored authorization, source-record attribution, contribution/Context lifecycle, deletion, aggregate disclosure,
account-erasure and growth. Presentation already owns `realm-context-user-cases.test.ts` and
`aggregate-authority-user-cases.test.ts`; definitions owns compiler/release/Type-list/locale/expansion contracts.
Retain their actual personas, release pins, parent/replay rules and bounds. Their presence is a requirement inventory,
not a claim that their current assertions pass.

In particular, the eventual native result must distinguish proposal from publication, accepted from adopted,
selected from rejected, stale head from successful replay, and hidden/deleted from empty. It must retain original
assertions across release activation; show actual work/edition/release identity; exclude undisclosed evidence from
every public projection; remove revoked Source support from terms as well as statements; and preserve cleanup
obligations for superseded/history/receipt copies. Recorded Web responses must then support all eight locales and
the page states specified above. Existing Source, Realm, Collection and lifecycle owners supply those outcomes;
this report creates no new source-correctness audit or native proof stage.

Decisions made for this report: current source code takes precedence over stale research implementation status
(AnimeRelease, Library annotations, Context lifecycle and local erasure registration are present); contract-selected
missing producers remain missing until their actual boundary is supplied. Generic correction means a replacement
candidate, not mutable Wikibase-style PATCH. Missing term/history APIs are reported explicitly rather than invented
as callable methods. Recipe/Library/list presentation retain their native meanings despite external vocabulary
similarity. Advanced publication/identity and reviewed seed scope stay closed.

## Source retention, licences and verification boundary

Reference repositories were read as untrusted data; none was installed, built or run. New clones are shallow and
sparse; existing clones were reused without changing their revisions. Paths below are relative to the permitted
main-checkout `.reference/` directory; its `INDEX.md` records URL, revision, licence and this research date.
No code or long source passages are proposed for copying.

| Retained repository/path                                                                                                   | Revision and licence                                                                                                                                  | Material inspected                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue-editorial-journey/wikibase` — [official repository](https://github.com/wikimedia/mediawiki-extensions-Wikibase) | `f04124242a234a3c37f96d4be3b6ace69aebde17`; inspected PHP is GPL-2.0-or-later; root `COPYING` supplies GPLv2 with nested exceptions.                  | `repo/rest-api/README.md`, `repo/rest-api/src/openapi.json`, `repo/rest-api/src/Middleware/RequestPreconditionCheck.php`; `repo/domains/crud/src/Application/UseCases/PatchStatement/PatchStatement.php`; `repo/domains/statements/src/Application/Serialization/StatementSerializer.php` (read through Git without executing it). |
| `catalogue-editorial-journey/linkml` — [official repository](https://github.com/linkml/linkml)                             | `ae3df7a455031d49f62b802d484a6c9e73f57b4c`; Apache-2.0, `LICENSE`.                                                                                    | `docs/schemas/annotations.md`, `inheritance.md`; official schema documentation.                                                                                                                                                                                                                                                    |
| `partitioned-sitemap-feeds/openlibrary` — [official repository](https://github.com/internetarchive/openlibrary)            | `37e446827465be2febad416de1bc18753b66997d`; AGPL-3.0, `LICENSE`.                                                                                      | `openlibrary/templates/books/edit.html`, `books/edit/edition.html`, `history.html`; work/edition schema and edition-list source locations.                                                                                                                                                                                         |
| `anime-release-profile-grain/schemaorg` — [official repository](https://github.com/schemaorg/schemaorg)                    | `b0b19f7fab48caa1f2cbee1f1149e2aee8dec896`, vocabulary 30.1; vocabulary CC BY-SA 3.0 (`docs/terms.html`); supporting software Apache-2.0 (`LICENSE`). | Retained vocabulary provenance reused with existing mapping research; official Recipe/term documentation supplies the comparison, without redefining native schema.                                                                                                                                                                |

Live official documentation was read on 2026-10-30–31; source links above pin implementation observations.
Wikidata help pages are documentation, not a licence grant for every referenced work; Wikidata structured data's
separate reuse terms do not license imported prose or images. The SKOS Recommendation retains its
[W3C document-use terms](https://www.w3.org/TR/skos-reference/). The discussion ADR has no identified repository-wide
licence; its requirements are restated in English, not copied. Provider/asset rights remain under existing Source
and Content contracts.

This is desk research and source inspection only. No native, database, browser, host, remote, worker or acceptance
check was run; no runtime success or source correctness is asserted. No code workspace changed, so no typecheck
applies. The declared later integration proof remains
`bun scripts/worker-check.ts --local -- test -s docs/research/catalogue-editorial-journey-design.md`.
Ordinary routing/controller owns that landing and subsequent acceptance.
