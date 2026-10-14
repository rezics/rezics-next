# Field meaning, content forms and adoption

Design proposal for the supermanager, 2026-10-14. Repository basis:
`1d7d0ccda47a03663b68d71152dca99ad38bfa8f`. This note recommends a boundary;
it does not activate profiles, change public scope, or claim a migration has
passed. Recipe is the inspected implementation. Book publication, Work metadata,
Zone presentation and character wiki below are bounded samples, not completed
audits of those domains.

## Decision proposed

Decide a field's **semantic role** before deciding the **forms** its values may
take. An instruction, description, preparation note, quantity, source citation
and resource reference have different operations. Some admit content in several
forms; an exact quantity used by scaling cannot be replaced by an audio clip.
Adoption into a field, derivation of content, and references inside that content
are independent relationships. Recipe instructions are one application of this
rule, not its scope boundary.

Use the existing Resource, Content, Post, Structure, Work/MainVersion, Semantic,
Source and Media owners. Use standard predicates where their meaning fits, with
application constraints in authored SHACL. Keep local terms only for genuinely
different meaning, including occurrence substitution and scaling policy. Do not
introduce a universal field wrapper, executable definition runtime, or another
composition mechanism. This follows the existing decisions on one authoritative
meaning, standard vocabulary, bounded operations and pre-public convergence in
[target architecture](target-architecture.md), and the grain/authority rules in
[semantic model](../contracts/semantic-model.md) and
[model profiles](../contracts/model-profiles.md).

Change this boundary **before Recipes open publicly**, while retaining the
current useful behaviour and task APIs where they still earn their existence.
The implementation should be commissioned as bounded owner changes after this
review. Opening should depend on replacement API proofs, not merely a new shape
or successful data conversion. Recipes are first-public-scope work under
[the API Goal](../goals/api/GOAL.md) and [target architecture §13](target-architecture.md#13-決定記錄與剩餘事項).

## What exists, and what is missing

The following table distinguishes implementation from a proposed binding. A
schema's ability to store a reference does not establish that an operation can
adopt it, publish it, or resolve its disclosure dependencies.

| Existing owner / sampled field | Present admitted forms and role | Derivation / internal references already expressed | Smallest missing change, if commissioned |
| --- | --- | --- | --- |
| Content: revision body; Post: language-local notes | Exactly one input `body` string or `document` snapshot; document text is a projection. Notes use the same text/document distinction. Documents admit text, lists, tables, images, audio/video/file media nodes and versioned extension blocks. This is a bounded authored document, not a free-form RDF value. [Body validation](../../services/content/src/document-body.ts), [document schema](../../packages/document/src/schema.ts). | Immutable revision custody and document-local identities already exist; managed image uses are checked against Media identities. A media URL node alone does not prove exact retained media bytes. [Media validation](../../services/content/src/document-media.ts). | A bounded procedure block/profile using existing extension payload validation; an explicit reference to a retained media representation where the field requires reproducible audio/video. Do not pretend today's URL-only media nodes provide that pin. Content/Document and Media own these changes. |
| Post publication | Post owns Content and discussion; it is not a Work. A reused Post retains one text and conversation. Post labels are language strings, not arbitrary content. [Post shape](../../model/definitions/post-v1.ttl), [four-layer contract](../contracts/work-and-release.md#posts-texts-and-works). | The existing Work reference block carries a Work IRI and authored language-labelled name within the document. It is not a general tomato-resource mention. [Block schema](../../packages/document/src/schema.ts), [block shape](../../model/definitions/work-reference-block-v1.ttl). | A narrowly defined general Resource reference inline/block payload, with revision-qualified placement/selector when needed, admitted by Content; use Semantic/Media to resolve it. Do not broaden a Work-only term's meaning silently. |
| Book: chapter placement, chapter label and author note | Chapter occurrence targets a Post; selection is contextual or revision-fixed; label is language text. The Book adopts the selected Post content at that placement. Author notes stay Post parts and are excluded from Work text/release counts. [Composition](../contracts/composition.md), [Structure format](../../services/main/src/modules/structure/format.ts), [Post contract](../contracts/work-and-release.md#posts-texts-and-works). | Fixed/sealed dependencies pin revisions; occurrence identity remains distinct from Post identity. Reuse is adoption, not proof of creative derivation. | No change to chapter adoption is needed for this proposal. A narration of a chapter would need an admitted media realization/binding with its own operations; do not replace the chapter label with audio or automatically identify a new Work. |
| Work: localized `description`, title; edition statement and languages | Metadata schema admits bounded localized text and language identifiers, not documents, Posts or media. A description's role is descriptive text today; the title is a naming field. [Metadata schema](../../services/main/src/modules/work/metadata-schema.ts). | Source support/control can distinguish imported metadata from native acceptance; it does not make a description an independently versioned Post. [Source lifecycle](../contracts/source-lifecycle.md). | If a synopsis genuinely needs an audio explanation or Post, add an explicitly admitted synopsis-content relationship under Work/Content, keeping the title and text-search summary contracts. This is a candidate, not a launch requirement inferred from the existence of media. |
| Zone: page document versus route segment / module query | An exact Content document is resolved against selected modules; original document survives export. Local blocks carry presentation; route segments are constrained routing strings. [Zone document resolver](../../services/main/src/modules/presentation/zone-document.ts), [mount qualifier](../../services/main/src/modules/structure/format.ts). | Document-local block references and module reads are bounded; selecting a page does not authorize a module or rewrite Content. | Reuse the existing page adoption path. A route segment cannot admit video. New instructional content should be a Content block, not a Zone-specific procedure store. |
| Character wiki: claim value and evidence | Wiki extraction validates native resources, admitted predicates, Work/continuity applicability and evidence locators. Claims use typed semantic values; evidence passages are not the value of every claim. [Wiki validation](../../services/main/src/modules/wiki/validate.ts), [extraction schema](../../packages/wiki-toolkit/protocol/wiki-extraction.ts), [value codec](../../services/main/src/modules/semantic/value.ts). | Exact source locators, resource relationships and Statements carry evidence and scoped facts. A resource's wiki is assembled from these; it is not a Recipe-owned copy. [Statement shape](../../model/definitions/statement-v1.ttl), [locator contract](../../packages/wiki-toolkit/protocol/locator.ts). | A wiki narrative in a Post may mention a resource via Content references. A character's numeric age remains an exact typed fact; audio evidence does not become the age value. No character model redesign is authorized here. |
| Work derivation | `work-derivation-v2` pins target Work/MainVersion/revision, source Work, exact or explicitly unresolved source version, relation DefinitionRevision, evidence, linking actor and correction. [Derivation shape](../../model/definitions/work-derivation-v2.ttl). | Work transformation already differs from adoption and transfers no facts/authority. `linkedBy` records the linker, not necessarily the person/AI that transformed content. | Do not force a Post transcript to become a Work to use this shape. Content's existing revision workflow should own a small derivation record for exact input revision/fragment, output revision, activity kind and responsible public Agent; principal authorization stays private. |
| Semantic / Source / Media | Semantic values admit exact numbers, quantities, strings, language strings, resource/external refs, temporal values and explicit missingness. Source observations retain exact bytes; conversion classifies fields; support joins exact evidence to a native slot. Media separates assets, representations and uses. [Semantic codec](../../services/main/src/modules/semantic/value.ts), [Source lifecycle](../contracts/source-lifecycle.md), [Media contract](../contracts/media.md). | Reference grains are Resource, Revision, Occurrence, Fragment and Representation, not interchangeable locators. Source conversion/support is not general human/AI authorship provenance. [Grains](../contracts/semantic-model.md#identity-and-reference-grains). | Field-specific shapes/bindings for Recipe facts and content selection. Reuse owner authorization, CAS, revision and disclosure paths; do not add a second semantic fact store. |

These samples falsify an unrestricted “every field accepts every form” design:
Book labels, Work titles, Zone routes and character ages all have operations
that require a narrower representation. Conversely, fixing instructions to a
RecipeStep tree would exclude an authored Post or a recording without a
semantic reason. This is an inference from the cited implementations, not a
claim that every other domain has the Recipe defect.

### Relationships and minimal bindings

For Recipe, bind `schema:recipeInstructions` to the adopted content or ordered
procedure. Schema.org admits Text, CreativeWork or ItemList, rather than only a
step class. A Post can supply authored instructions through its Content; a
recording can supply them through a retained media representation; a procedure
can use HowToSection/HowToStep with text and media. A combination needs ordered
uses of those existing resources, not a parallel Recipe composition engine.
[recipeInstructions](https://schema.org/recipeInstructions),
[HowToStep](https://schema.org/HowToStep),
[HowToSection](https://schema.org/HowToSection).

Recipe's current profile forbids step targets and requires `instructionText` in
the step qualifier. It therefore does **not** already implement this adoption
choice. Add the field-specific binding and admitted target/selection forms in
the existing Recipe profile and Content/Structure paths. Procedure facts live
under Semantic; expressive payload stays Content; Structure keeps order and
selection. The precise choice of Content extension payload versus referenced
HowToStep resources needs a fixture proving reuse, exact revision selection,
export and bounded reading before activation. Do not create both as competing
authoritative representations. [Current registration](../../services/main/src/modules/recipe/structure-profile.ts),
[target placement](target-architecture.md#2-數據放置與表示).

Record derivation using PROV-O's Entity/Activity/Agent and qualified derivation
terms, with existing revision-qualified fragments as inputs. It should express
“transcribed”, “summarized” or “structured”, actor and exact inputs/outputs,
without asserting equality, correctness or publication authority. A recording
may independently yield a Post and a structured procedure; a directly authored
procedure needs no invented source. A human edit produces another output
revision, not a rewrite of the input. [PROV-O](https://www.w3.org/TR/prov-o/),
[revision grains](../contracts/semantic-model.md#identity-and-reference-grains).

An internal mention belongs to Content: tomato entity, ingredient occurrence,
intermediate preparation, or wiki resource, each at the appropriate grain.
Use the existing locator's block/span/time/selector forms for exact placement,
and Web Annotation where its body/target semantics fit. A media segment's
mention does not require parsing its transcript into Recipe fields. A reference
to a preparation's recipe points to that resource/content revision and leaves
its wiki, acquisition information and process with their owners.
[Web Annotation](https://www.w3.org/TR/annotation-model/),
[locators](../../packages/wiki-toolkit/protocol/locator.ts),
[semantic relations](../contracts/semantic-model.md#values-relations-and-admission).

### Standard vocabulary and constraints

Use Recipe's `recipeIngredient`, `recipeYield`, `prepTime`, `cookTime`,
`totalTime` and `nutrition` by their standard meaning. Instructions use HowTo
terms; supplies and tools use `supply`, `tool` and `requiredQuantity` where the
grain fits. `recipeIngredient` admits text as well as richer supply/property
values. HowToSupply describes a consumed supply, not a global food catalogue
identity; do not put “two tomatoes for the sauce” on the reusable tomato entity.
Keep its occurrence identity and entity target distinct.
[Recipe](https://schema.org/Recipe), [HowToSupply](https://schema.org/HowToSupply),
[HowToDirection](https://schema.org/HowToDirection).

QuantitativeValue/PropertyValue supply value, range and unit terms; their
vocabulary does not implement exact arithmetic, scaling, substitution or
nutrition coverage. The existing exact codec supports integer/decimal/rational
lexicals and quantity units/uncertainty, but has no quantity range endpoints in
its value union; rational quantities require their own canonical lexical.
It is not a drop-in reader for arbitrary `amountLexical: "about half"`, unitless
counts, or Recipe's bounded number pairs. Reuse exact number values; add only
the needed range/measurement profile and separate source wording, rather than
overloading uncertainty as an upper endpoint.
[QuantitativeValue](https://schema.org/QuantitativeValue),
[PropertyValue](https://schema.org/PropertyValue),
[exact profile](../../model/definitions/value-exact-v1.ttl),
[codec](../../services/main/src/modules/semantic/value.ts),
[Recipe rational bounds](../../services/main/src/modules/structure/format.ts).

SHACL can constrain admitted classes/forms, cardinalities, nonnegative bounds,
paired endpoints, units and local reference membership over a bounded candidate.
Keep existing transactional CAS, deletion/reference checks, authority, receipts,
pagination and recovery in their owners. Shapes neither grant authority nor
make a cross-owner transition atomic. A tightened constraint needs its own
revision/admission check, while a genuinely different meaning needs a new term.
[SHACL](https://www.w3.org/TR/shacl/),
[profile responsibilities](../contracts/model-profiles.md).

## Classification of the current Recipe structures

Role key: **F** domain fact; **P** content payload; **D** derivation;
**R** reference within content; **E** source/extraction metadata; **O** storage
or operation detail. Multiple roles mean the current field conflates them or
its role depends on authorship. “Forms” names what the meaning should admit;
it is not a claim that current ingress supports them. A migration must preserve
an unresolved distinction until reviewed, rather than guessing.

### IngredientLine

Inventory source: [shared qualifier definition](../../services/main/src/modules/structure/format.ts),
[route schema](../../services/main/src/routes/recipe-qualifiers.ts),
[RDF mapping](../../services/main/src/modules/recipe/structure-profile.ts).
The enclosing [OccurrenceRecord](../../services/main/src/modules/structure/format.ts)
already owns occurrence, state, parent, order, target, selection, labels,
sourceKey, introduction/removal and subtree metrics. None is a food entity ID.

| Part | Role | Admitted forms and fitting owner / term |
| --- | --- | --- |
| `type: ingredient-line` / `rv:IngredientLine` | O | Implementation discriminator; does not justify a new ontology class. Existing supply/use occurrence plus admitted shape. |
| occurrence `target` | F | ResourceRef for the ingredient entity or prepared resource; optional if unresolved. Semantic relationship on the use. Never infer entity identity from a food name. |
| `originalText.value`, `.language` | E or P | Source wording: exact Source revision/fragment and language. Directly authored ingredient prose: Content text with its own language/revision. Preserve both cases; do not blindly delete the only text of an unparsed line. |
| `name` | F or E | Authored language text naming this use; extracted name belongs to the extraction result/support until adopted. Resolved entity name remains with the entity's name owner. Current string has no independent language; retain its ingredient-language association. |
| `textParts.amount`, `.unit`, `.name`; each `start`, `end` | E | Revision-qualified UTF-16 source spans, not ingredient facts. Source extraction/Content locator; retain coordinate convention, text digest and bounds. Never rerun a display parser to recover them. |
| `amountLexical` | E | Source quantity wording as text/span, even when not canonical numeric evidence. Source owner; a native authored approximation can be text annotation on the exact fact, not its arithmetic value. |
| `amount.numerator`, `.denominator` | F | Exact nonnegative number, unitless count or quantity; `requiredQuantity`/QuantitativeValue using existing exact codec with Recipe bounds. No media alternative in an arithmetic slot. |
| `amountUpper.numerator`, `.denominator` | F | Exact upper endpoint paired with lower endpoint, ordered and same unit; QuantitativeValue `minValue`/`maxValue` profile. No upper endpoint means a scalar, not a zero or unknown upper endpoint. |
| `unit` | F | Unit IRI/code from admitted unit vocabulary, associated with the exact amount. QuantitativeValue/PropertyValue `unitCode`; preserve inert identity, not a network fetch. |
| `unitText` | F or E | Authored unit label: `unitText`; source spelling: Source text/span. Neither converts units nor proves unit membership. |
| `preparation.value`, `.language` | P or F | Note (“finely chopped”): language text or referenced note content, including audio if admitted for the note role. A full intermediate preparation is a Resource/content reference, not copied process text. Use `description` for a note, Content references for a process. |
| `optional` | F | Boolean optionality of this occurrence, not the food entity. Keep a small local use qualifier if no standard term matches; audio cannot replace a machine decision. |
| `scaling` (`linear`, `non-linear`, `not-scalable`) | F | Enumerated arithmetic policy on this quantity/use; local policy term under measurement operation. No generic HowTo term proves this behaviour. |
| `substituteFor[]` | F | OccurrenceRef relation with direction and finite membership, not an entity synonym and not merely a mention. Existing qualified relation owner; small local term preserves the meaning. Content may separately refer to it. |
| `parseStatus` (`parsed`, `partial`, `unparsed`) | E | Extraction outcome enum; Source/derivation result metadata. The scaling operation still needs explicit numeric availability/eligibility; relocating metadata must not make every quantity scalable. |
| `residual` | E/O | Digest of retained extraction/source material. Source custody and retention; not a universal source-support proof and not a content identity. |

### RecipeStep and RecipeMeasure

Inventory source: [qualifiers and measures](../../services/main/src/modules/structure/format.ts),
[Recipe shapes](../../model/definitions/recipe-structure-v1.ttl),
[operations](../../services/main/src/modules/recipe/operations.ts).

| Part | Role | Admitted forms and fitting owner / term |
| --- | --- | --- |
| step `type: recipe-step` / `rv:RecipeStep` | O | Codec discriminator; use HowToStep/HowToDirection when the instruction is structured. A Recipe instruction field need not have steps at all. |
| `instructionText.value`, `.language` | P | Authored language text/document or adopted Post/procedure/audio/video content, at exact selection where required. HowToStep `text` is the text case; Recipe's `recipeInstructions` is the field binding. |
| `usesIngredient[]` | R | References to precise ingredient occurrences from the instruction, not the tomato entity alone. Content reference/selector plus existing occurrence grain; HowToDirection `supply` is useful vocabulary but does not preserve this occurrence binding by itself. |
| `media[]` | R/P | Referenced media used by instructions; asset/use/RepresentationRef with optional segment selector. Media owner; HowTo media terms only after representation and access are resolved. Arbitrary URLs are not exact revisions. |
| step `scaling` | F | Stored policy enum; retain as a local policy if used. The inspected scaler never interprets it to change step temperature/time. Do not claim adaptive cooking exists. |
| measure `kind` | F/O | Select predicate: `recipeYield`, servings count, `prepTime`, `cookTime`, `totalTime`, or nutrient quantity. A tagged storage record is not one necessary RecipeMeasure ontology class. |
| `nutrient` | F | Nutrient definition/resource IRI, required only for nutrient facts; use NutritionInformation named predicates when they match, PropertyValue identifier for other nutrients. |
| `value.numerator`, `.denominator` | F | Exact number or quantity; durations additionally need explicit duration/unit semantics. Yield may be display text, but the serving denominator used by scaling must be exact and positive. |
| `valueLexical` | E or P | Source evidence wording in Source; authored yield wording can be text in the yield field. Never treat arbitrary wording as canonical number evidence. |
| `unit`, `unitText` | F/E | Measurement unit and authored label or source spelling; exact quantity/unit vocabulary plus Source. Duration and nutrient units must not become interchangeable from matching text. |
| `basis` (`per-serving`, `whole-recipe`) | F | Explicit denominator/scope, boolean-like enum or qualified relationship to serving/whole recipe. Local measurement qualifier if necessary; never infer from display position. |
| `coverage` (`complete`, `partial`, `unknown`) | F/E | Explicit completeness assertion about the measured input scope, not a nutritional guarantee. Existing measurement/quality owner; local qualifier with evidence. |
| `provenance` (`declared`, `source-stated`, `computed`) | E/D | Origin enum: declared attribution, Source support, or derived calculation. A computed result needs derivation inputs/activity and its own result identity if retained. |
| `evidence` | E/D | Exact source/support or calculation input revision reference. Current single IRI is not a complete multi-input derivation history; reuse Source support and Content/Semantic provenance record. |

### RecipeComposition and its registration

Inventory source: [registration](../../services/main/src/modules/recipe/structure-profile.ts),
[registration interface](../../services/main/src/modules/structure/profiles.ts),
[Structure format](../../services/main/src/modules/structure/format.ts).
The local RecipeComposition name currently describes a Structure binding;
it must not become a universal wrapper around every field's value.

| Parts | Role | Forms and replacement responsibility |
| --- | --- | --- |
| `id`, `graphProfile` | O | Profile identifier and graph validation class. Retain existing profile admission; move ordinary Recipe facts to standard predicates/shapes. |
| `ownerType`, `componentType`, `componentPredicate`, `workPublication` | F/O | Recipe Resource/Work, MainVersion selection and publication flag. ResourceRef/RevisionRef and explicit publication state; Work owner retains native MainVersion meaning. Adoption into instructions is a separate field relationship. |
| `roles`: `group`, `ingredient`, `step`, `equipment` | F/O | Ordered section/use roles. HowToSection, supply, HowToStep and tool vocabulary; existing Structure/qualified occurrences retain order and duplicate uses. |
| `catalogTargetTypes` | O | Admitted target class list (Recipe, HowToStep, HowToSection, Thing). A class allowlist is neither runtime capability nor disclosure authorization. Profile shapes/owner admission. |
| `targetRoles`, `optionalTargetRoles`, `selectionRequiredRoles` | O | Whether a use needs a resource target and revision selection. Current steps have no target; configure admitted instruction forms and selection in this profile, without changing every profile. |
| `qualifiers.ingredient`, `.step`: `type`, `required` | O | Current required custom payload definitions. Replace mixed facts/payload/source fields with owning shape/Content binding; do not just rename the same JSON as a universal qualifier. |
| `measures: true`; manifest `measures[]` | F/O | Current storage supports RecipeMeasure in every Structure manifest. Quantities belong to Semantic/measurement owner; keep only revision dependencies in the composition manifest. |
| `editScopePrefix`, `editPermission`, `editAction` | O | Authority/action configuration, unchanged Access responsibility. No RDF Recipe type grants editing. |
| `receiptFamily` | O | Existing atomic command result/replay; retain owner receipt family. |
| `projectQualifier`, `hydrateQualifier`, `qualifierValidations`; generated qualifier ID / generation | O | Current JSON↔RDF codec, shape invocation and projection generation. Remove the duplicate semantic fact encoding when the standard graph facts become authoritative; keep immutable revision resolution and bounded validation. |

### Import intermediates and source conversion

These interfaces are adapter/operation data, not custom ontology classes.
Inventory source: [importer](../../services/main/src/modules/recipe/importer.ts),
[file intake](../../services/main/src/modules/recipe/file-intake.ts),
[conversion](../../services/main/src/modules/recipe/source-conversion.ts),
[source support attachment](../../services/main/src/modules/source/support-attach.ts).

| Structure / every part | Role | Forms and owner |
| --- | --- | --- |
| RecipeImport `sections[]`, `ingredients[]`, `steps[]` | E/O | Bounded normalized adapter arrays. Retain a Recipe exchange adapter emitting commands to existing owners; these arrays need no RDF class. |
| RecipeImport `residual` | E/O | SHA-256 of serialized import source; keep with exact Source observation, not as a claim that all imported facts are supported. |
| ImportedIngredient `sourceKey`, `qualifier` | E; F/P/E | Source occurrence key plus the mixed IngredientLine above. Keep stable source correspondence; split normalized fields by their destination owner. |
| ImportedStep `sourceKey`, `sourcePointer` | E | Bounded source occurrence key and exact JSON pointer. Preserve pointer independently of preorder index. Source owner. |
| ImportedStep `text`, `language` | P/E | Source instruction expression and language; Content adoption at exact Source support, or retained source only until accepted. |
| ImportedStep `section`, `order` | F/O | Parent section index (`-1` root) and shared preorder; existing Structure ordered occurrence commands, not independent content identity. |
| ImportedSection `sourceKey`, `label`, `language`, `parent`, `order` | E; P; F/O | Source key, authored/source section name with language, parent index and interleaved order. HowToSection/Structure; preserve empty sections and nesting. |
| RecipeSourceConversion `conversion`, `observation`, `record`, `mappingRevision`, `sourceDigest` | E/O | IDs for classified source result, exact observation/record, reviewed map revision and digest. Source conversion/support owner; not “Recipe derived from video” authorship. |
| RecipeSourceConversion `replayed` | O | Boolean receipt/replay outcome; retain operation semantics. |
| ConversionRow `id`, `source_digest`, `projection`, `field_inventory`; two-field `SLOT` mapping | E/O | Immutable conversion identity/bytes, classified fields and pointers into current native text slots. Remap slot IDs to Content/Semantic owners; unknown fields remain explicitly unmapped. |
| support candidates `sourceKey`, `sourceField`, `sourcePointer`, `slot` | E/O | Exact correspondence, source field, JSON pointer and native destination slot; Source attaches support against native revision after checking the text match. No fabricated support for structured values that lack that match. |
| RecipeImportability `status`, `code`, `limit`, `measured`, `allowed`, or unsupported `unit`; byte/occurrence/depth limits | O | Typed capacity/unsupported-unit facts, not Recipe facts. Preserve in exchange API and client recovery. Export capacity does not imply synchronous importability. |

### ScaledIngredient and the bounded work page

Inventory source: [scaled result and nutrition](../../services/main/src/modules/recipe/operations.ts),
[display](../../services/main/src/modules/recipe/display.ts),
[page/cursor](../../services/main/src/modules/recipe/work-page.ts),
[cost contract](../../services/main/src/modules/recipe/cost-contract.md).

| Every part | Role | Forms and owner |
| --- | --- | --- |
| ScaledIngredient `occurrence` | F/O | Exact use identity to correlate the read result; never a new food identity. |
| `originalText`, `sourceLexical` | E/P | Returned source/authored text for display; resolve exact source/content, preserving access and language context. |
| `amount`, `amountUpper`, `unitText` | F/D | Exact derived quantity/endpoints and resolved unit label. Measurement calculation read model; computed in memory, not a second authoritative stored Recipe fact. |
| `scaled`, `reason` (`unparsed`, `non-linear`, `not-scalable`) | O | Calculation outcome and explicit hold reason; preserve distinctions. |
| `line`, `alternateLine`, `alternateSystem`, `hint`, `judgment` (`seasoning`, `leavening`) | P/O | Derived kitchen display, optional unit-system presentation, retained wording hint and cooking judgment. Keep display operation; text/enum outputs, not Content identities unless deliberately saved as an authored result. |
| page `profile`, `structure`, `revision`, `occurrences`, `measures`, `ingredients`, `next` | O/F | Typed bounded response, pinned revision, ordered use records, measurement view, scaled read results and opaque continuation. Retain a task facade if generic reads cannot provide its bounded cross-owner result. |
| page `cost.pages`, `pagesRead`, `occurrences` | O | Report actual bounded traversal/read costs, never nutrition or content metadata. |
| cursor `v`, `structure`, `revision`, `servings`, `factor.n/d`, `stack[].parent`, `after`, MAC | O | Versioned authenticated continuation fixing revision, exact factor and traversal stack. Do not expose it as a semantic content object or drop its pin during a new read. |
| stale `profile`, `structure`, `revision`, `cursorRevision` | O | Explicit stale continuation outcome; do not join two revisions. |
| transient WalkFrame `pending`, `at`, `more`; hierarchy child response `occurrences`, `next`, `pagesRead` | O | In-memory page traversal and owner read protocol. Reuse existing bounded Structure reader. |
| NutrientAmount `nutrient`, `unit`, `amount`; NutritionResult `nutrients`, `basis`, `coverage` | F/D/O | Exact computed buckets and explicit scope/completeness. Retain measurement algorithm and typed result; storage only if a separately identified result is requested. |

### Recipe semantics entering shared layers

| Site and current coupling | Replacement within existing owners |
| --- | --- |
| [Structure format](../../services/main/src/modules/structure/format.ts): Recipe profile/roles, IngredientLine/RecipeStep union, text spans, RecipeMeasure and manifest measures; qualifier reference validation | Recipe facts in standard graph profiles; expressive/extracted text in Content/Source; Structure owns placement/order/pins. Remove Recipe arithmetic and extraction vocabulary from the shared format. Keep existing finite profile admission, not a new universal payload runtime. |
| [Structure change](../../services/main/src/modules/structure/change.ts): `recipeRemoval` permits update+remove batches; `usesIngredient`/`substituteFor` membership and deletion checks; qualifier comparison sorts those arrays and media | Existing owner transition must atomically detach/retire referenced uses, or refuse. Use qualified relation/Content reference integrity in its owning operation; shared Structure command checks structural invariants only. Local, bounded post-state shapes can check membership; do not replace a transactional reverse-reference check with eventual cleanup. |
| [Change/admission](../../services/main/src/modules/structure/change-admitted.ts), [read](../../services/main/src/modules/structure/read.ts), [profiles](../../services/main/src/modules/structure/profiles.ts): Recipe-only measure writes and RecipeMeasure reads | Measurement/Semantic owner writes exact facts at a pinned revision; Structure revision binds dependency. Reuse Access, CAS and receipts; thin task wrapper may coordinate a recoverable owner workflow. |
| [Composition routes](../../services/main/src/routes/compositions.ts) and [Recipe routes](../../services/main/src/routes/recipes.ts), [qualifier schema](../../services/main/src/routes/recipe-qualifiers.ts): custom public payload/operation contracts | Profile-bound general edits/reads for ordinary facts; keep named scaling, nutrition and bounded exchange/read operations where they perform real work. Generate schemas from the owning contracts; do not make every field a new endpoint. |
| [Recipe projection](../../services/main/src/modules/recipe/structure-profile.ts), [custom shapes](../../model/definitions/recipe-structure-v1.ttl): ordinary facts copied between qualifier JSON and `rv:*` predicates | Standard predicates as authoritative current semantics; exact immutable history remains owner payload bytes, as target architecture requires. Delete custom project/hydrate fact mirroring, not revision custody. |
| [Source slot mapping](../../services/main/src/modules/recipe/source-conversion.ts): support tied to `qualifier.originalText.value` / `instructionText.value` | Bind support to the destination Content/Semantic field and exact revision. Keep Source mapping/exact evidence checks and independent withdrawal. |
| [Editor model/ingredient adapter](../../apps/web/features/recipe-editor/model.ts), [ingredient lines](../../apps/web/features/recipe-editor/ingredient-line.ts), [reading](../../apps/web/features/recipe-editor/reading.ts): mixed qualifier drives editing/display | Task UI consumes owner contracts, can retain Recipe vocabulary, and preserves unedited richer forms. No client-side adoption/provenance store or quantity reparse. |

These replacements are obligations for a future change, not proof that a generic
edit operation currently provides all of them. Structural ordering, concurrent
relation removal and cross-owner publication are the risky seams.

## Mature products and real exchange boundaries

Observed 2026-10-14 from producer documentation, source schemas/serializers and
the public iFixit JSON example. Mealie `mealie-next` and Tandoor `develop` are
moving source branches, not frozen release guarantees. Paprika evidence is its
version-3 Windows guide. No logged-in product task or round-trip import was run.
“Not established” below means the cited format/evidence does not establish the
capability, not that no release of the product can provide it.

**A**: configure/use existing general models, predicates, shapes and owner paths.
**B**: a missing behaviour requiring bounded owner implementation and tests.
**C**: outside this task/first-public Recipe replacement. These are REZICS
classifications, not labels used by the products. A standard term may be A
while operational adoption or lossless exchange of it remains B.

| Product | Observed model and actual exchange | Preservation/loss and lesson |
| --- | --- | --- |
| Mealie | Recipe schema has ingredient and step lists, nutrition, notes and assets; ingredient occurrences have quantity, unit/food, referenced recipe, original text and occurrence reference ID. Steps contain text/title/summary and ingredient/note references. They do not expose a Post or audio/video instruction alternative. [Recipe schema](https://raw.githubusercontent.com/mealie-recipes/mealie/mealie-next/mealie/schema/recipe/recipe.py), [ingredients](https://raw.githubusercontent.com/mealie-recipes/mealie/mealie-next/mealie/schema/recipe/recipe_ingredient.py), [steps](https://raw.githubusercontent.com/mealie-recipes/mealie/mealie-next/mealie/schema/recipe/recipe_step.py). | Native export writes the recipe model's JSON into ZIP and copies its asset directory, preserving richer fields than ingredient strings. [Exporter](https://raw.githubusercontent.com/mealie-recipes/mealie/ce0be528e7cfce4bf1fa846c3c136186dd719af5/mealie/services/exporter/recipe_exporter.py), [JSON writer](https://raw.githubusercontent.com/mealie-recipes/mealie/ce0be528e7cfce4bf1fa846c3c136186dd719af5/mealie/services/exporter/_abc_exporter.py). Native ZIP import recreates a recipe from JSON/image data; this does not establish exact source derivation or portable referenced-recipe closure. [Import implementation](https://raw.githubusercontent.com/mealie-recipes/mealie/mealie-next/mealie/services/recipe/recipe_service.py). |
| Tandoor | Separate Food, Ingredient and Step; ingredients have decimal quantity/unit/note, steps have instructions, ingredient links, file and `step_recipe`; Food also links a Recipe. Food properties include nutrition categories. [Models](https://raw.githubusercontent.com/TandoorRecipes/recipes/develop/cookbook/models.py). Default exchange is ZIP containing per-recipe ZIPs with `recipe.json` and image. [Default adapter](https://raw.githubusercontent.com/TandoorRecipes/recipes/develop/cookbook/integration/default.py). | Actual export serializer carries steps/ingredients, quantities, times, servings, source URL and nutrition. Its step fields omit `step_recipe` and file; food fields omit recipe link; ingredients omit `original_text` and IDs. Thus default export cannot preserve those links/media/source wording/occurrence identity, despite the documentation's broad transfer claim. [Serializer](https://raw.githubusercontent.com/TandoorRecipes/recipes/develop/cookbook/serializer.py), [exchange documentation](https://docs.tandoor.dev/features/import_export/). |
| Paprika 3 | Ingredients, directions, notes, description and nutrition are editable text with formatting/photos and embedded recipe-name links. Scaling expects quantity–unit–ingredient wording and accepts fractional factors. Export is HTML with hRecipe/schema metadata or `.paprikarecipes` for reimport. [Producer guide](https://www.paprikaapp.com/help/windows/). | HTML is a real portable textual representation; native format is a distinct reimport path. The guide does not specify stable ingredient IDs, exact arithmetic, link revision pins or portable audio/video. Do not claim name links survive renaming or transfer. Tandoor's importer recognizes ZIP/gzipped Paprika contents, but that is consumer evidence, not a Paprika preservation specification. [Importer documentation](https://docs.tandoor.dev/features/import_export/). |
| Allrecipes | Lasagna page combines video, prose, ingredient lines, numbered directions, ½×/1×/2× controls and qualified per-serving nutrition. [Producer page](https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/). | Web representation preserves displayed expression; native ingredient identity, exact arithmetic, linked preparations, audio, Post export and source revisions are unverified. Direct HTML/schema capture returned HTTP 402; no JSON-LD round-trip or structured export guarantee was verified. |
| iFixit | Guide API has raw/rendered introduction/conclusion, numbered steps with line IDs, media, tools/parts, prerequisites and revision IDs. Prerequisites may bind release IDs; parts include quantity/notes/optionality. [Guide API](https://www.ifixit.com/api/2.0/doc/Guides). | Real [guide 1220 JSON](https://www.ifixit.com/api/2.0/guides/1220) has guide/step revision IDs, text lines and media alongside prerequisite resources. API supports editing with current revision preconditions and links an oManual archive. This proves structured interchange, not preservation of every version or private state. [API introduction](https://www.ifixit.com/api/2.0/doc/). |
| protocols.io | API represents steps with GUID/order linkage and Draft JSON containing text blocks and entity ranges. Entities include reagent, amount, duration, temperature, concentration, embedded protocol/document, image and video; separate reagent identities carry vendor/SKU. [Producer API](https://apidoc.protocols.io/). | API content can be requested as Draft JSON, HTML or Markdown; the UI documents JSON/PDF/print exports. Draft JSON preserves typed entities that a rendered format cannot prove it preserves. Ordinary step updates reject step cases; export availability is not complete editor round-trip support. Audio, recipe nutrition and whole-protocol scaling are not established here. [Export help](https://www.protocols.io/help/editor), [API](https://apidoc.protocols.io/). |

Capability mapping, using the evidence above without copying product-specific
storage designs:

| Capability | Evidence scope | REZICS disposition |
| --- | --- | --- |
| Authored prose/steps, headings and mixed media | Mealie text steps/assets; Tandoor instructions/files; Paprika formatted fields; Allrecipes video beside steps; iFixit step media; protocols.io rich entities | **A** Content document/HowTo profiles and existing media relationships; **B** bounded Recipe adoption/read/export of all admitted instruction forms. No evidence here requires a RecipeStep-only body. |
| Audio or video as the adopted instruction rather than an attachment | Allrecipes page shows video; protocols.io API names video; Mealie documents transcription/building of recipe data from supplied content. None establishes REZICS exact recording adoption | **A** standard CreativeWork/media identity; **B** exact media selection, delivery, segment references and derivation binding. Generic URL embedding does not satisfy it. [Mealie migration/AI pipeline](https://mealie.io/contributors/developers-guide/migration-guide/). |
| Post as instructions or as a note | Paprika text/link fields and protocols.io document embedding are analogies; none proves REZICS Post identity semantics | **A** existing Post/Content/selection model; **B** Recipe field admission and consumers. A new Recipe-owned Post subtype is unnecessary. [Post contract](../contracts/work-and-release.md#posts-texts-and-works). |
| Linked sub-preparation / prerequisite | Mealie referencedRecipe, Tandoor Food.recipe/step_recipe, Paprika in-text recipe links, iFixit prerequisites and protocols.io protocol entities | **A** Resource/Occurrence/Content refs with optional exact selection; **B** bounded cross-resource resolution, publication dependency checks and loss-aware export. Never inline an unbounded recursive closure. |
| Ingredient entity versus occurrence | Mealie Food/reference ID and Tandoor Food/Ingredient distinction; iFixit part quantities; protocols.io reagent entities and amount entities | **A** existing Resource plus distinct use/relation occurrence and exact value. Source's row key is not a global identity. |
| Scaling | Paprika factors/text grammar and Allrecipes ingredient controls; Mealie explicitly states nutrition values are static when servings/yield change | **A** exact values/servings profile; **B** retain REZICS scaler and its cooking policy. Nutrition scaling cannot be inferred from ingredient scaling. [Mealie FAQ](https://mealie.io/documentation/getting-started/faq/). |
| Scaling amounts embedded in instructions | Tandoor's server-rendered Markdown implements ingredient templating/scaling; its external-file recipes differ from structured internal recipes | **A** content occurrence references and exact measurement values; **B** derived display of referenced quantities without rewriting authored text. This does not establish automatic time/temperature adaptation. [Tandoor FAQ](https://docs.tandoor.dev/faq/), [internal/external distinction](https://docs.tandoor.dev/features/external_recipes/). |
| Nutrition and denominator | Tandoor/Mealie schemas, Paprika text field and Allrecipes qualified per-serving display | **A** NutritionInformation/measurement scope and evidence; **B** exact aggregation/coverage and exchange preservation. Tandoor asks importers to choose Mealie's serving-versus-recipe interpretation, demonstrating real ambiguity. [Import documentation](https://docs.tandoor.dev/features/import_export/). |
| Derive new content from source | Mealie's compile/transcribe/build flow; iFixit revision history and protocols.io editing do not by themselves prove human/AI transformation provenance | **A** PROV vocabulary and exact existing reference grains; **B** Content derivation record/operation, separately attributed result and retained history. No forced video→Post→steps pipeline. |
| Repair execution, laboratory runs/branching, grocery/meal planning, remote scraping and medical dietary guidance | Different product jobs; protocol run state is separately exposed in its API | **C**. Do not expand launch scope because another product models them. A later owner brief can reuse this boundary. [Protocol record API](https://apidoc.protocols.io/#records-api). |

The strongest counterevidence to a “standard export preserves everything” claim
is Tandoor's serializer: useful native links exist but are omitted from its
export. Likewise, “nutrition text exists” does not imply a computable scope.
This supports explicit directional exchange mappings and unsupported/loss
outcomes, rather than choosing an ontology by product feature count.

## Behaviours a replacement must preserve

These are current API/contract behaviours, not a claim that all personas have
already succeeded in the UI. Falsifiers below belong in future implementation
tests alongside the existing owner/outcome tests; none was run for this note.

| Behaviour and repository evidence | Concrete counterexample that rejects a replacement |
| --- | --- |
| Display without reparsing; exact values independent of source wording. [Display](../../services/main/src/modules/recipe/display.ts), [exchange contract](../contracts/recipe-exchange.md), [ingredient-name tests](../../services/main/tests/recipe-ingredient-name.test.ts). | Double `1.50 cups cream` → amount 3 with food name cream; `200 克 牛奶` → 400 克 牛奶. `salt to taste` with name `salt` but no numeric amount remains the whole unchanged line. `7up soda`, `3M tape`, `200g butter`, `½cup flour` stay unparsed. A structured name beginning “2 fluid ounces milk” must not have its numeric prefix removed. An old nameless qualifier keeps source line plus separate amount/unit fields; inventing a name fails. |
| Exact range scaling, eligibility and cooking judgment. [Scaler](../../services/main/src/modules/recipe/operations.ts), [quantity codec](../../services/main/src/modules/recipe/quantity.ts), [scaling tests](../../tests/qa/unit/recipe-operations.test.ts). | Scale ⅓ by 3 exactly to 1, and scale both ends of a range without binary rounding. A not-scalable count can still scale; non-linear quantities stay held. Seasoning/leavening beyond doubling/halving retain written amounts with a judgment hint. Unparsed text never becomes scalable because its parse status moved owners. Step temperature/time must not silently change: current scaler does not implement it. |
| Exact nutrition aggregation and truthful coverage. [Operation](../../services/main/src/modules/recipe/operations.ts), [measure tests](../../tests/qa/integration/recipe-measures.test.ts), [cost contract](../../services/main/src/modules/recipe/cost-contract.md). | Same nutrient+unit values ⅓ and ⅔ sum to 1; grams and milligrams remain separate without an explicit conversion. Empty input is unknown; one unknown input makes coverage unknown, partial input makes otherwise complete coverage partial. “Per serving” cannot be silently treated as whole-recipe. Current calculation takes caller-supplied nutrient inputs; it does not automatically fetch an ingredient catalogue or validate dietary accuracy. |
| Occurrence substitution and reference-safe deletion. [Change checks](../../services/main/src/modules/structure/change.ts), [update tests](../../tests/qa/integration/recipe-update.test.ts). | Two tomato occurrences, sauce and garnish, remain distinct. Replacing garnish cannot retarget sauce's step mention. Removing a referenced use either atomically updates the relation or refuses; a concurrent added reference cannot be orphaned. A food-level synonym is not a substitution for one recipe occurrence. |
| Import/export expression, structure, support and bounded refusal. [Importer](../../services/main/src/modules/recipe/importer.ts), [exporter](../../services/main/src/modules/recipe/export.ts), [contract](../contracts/recipe-exchange.md), [exchange tests](../../services/main/tests/recipe-exchange-kernel.test.ts). | Root step, empty section, nested section and trailing root step retain shared preorder, parent and inherited language. Exact JSON pointer differs from normalized order. Unsupported element is refused, never dropped. Export's 4,096-occurrence/1 MiB capacity cannot promise synchronous reimport above 128 occurrences/256 KiB; section depth 16 and JSON depth 32 remain different checks. Inert admitted units survive without fetching remote URLs. Unknown nutrition/media/reference fields must be retained as source or reported unsupported, not invented as accepted facts. |
| Independent source support, native control and withdrawal. [Conversion](../../services/main/src/modules/recipe/source-conversion.ts), [Source lifecycle](../contracts/source-lifecycle.md), [withdrawal tests](../../tests/qa/integration/recipe-withdrawal.test.ts). | With two independent supports for one adopted instruction, withdrawing one preserves the other and native adoption. Source wording remains resolvable at the supported revision under its retention/disclosure policy. An AI transcription is credited as transformation, never original source authorship or clearance. |
| Bounded Work page, revision and disclosure. [Reader](../../services/main/src/modules/recipe/work-page.ts), [cost contract](../../services/main/src/modules/recipe/cost-contract.md), [page tests](../../services/main/tests/recipe-work-page.test.ts). | A 1,001-occurrence hierarchy traverses every occurrence once in depth-first order across sections, at ≤100 per response, ≤1 MiB, ≤34 composition/measure reads at depth 16, with measures read once each page. A cursor pins revision and servings factor, resumes mid-section, refuses tampering and reports stale on changed revision. Hydration/revocation cannot leak private instructions or substitute another revision. Referenced sub-recipes cannot cause unbounded expansion. |
| Authority/retry/publication and bounded editing. [Recipe cost contract](../../services/main/src/modules/recipe/cost-contract.md), [author outcome](../../tests/qa/integration/outcomes/recipes/author-a-recipe.test.ts), [read outcome](../../tests/qa/integration/outcomes/recipes/read-a-recipe.test.ts). | Replay uses the same receipt without duplicate occurrences; stale expected heads conflict. Public publication remains pinned while later drafts stay private. Moving content owners cannot turn a multi-batch partial import into a reported atomic success. Omitted audio/advanced references on an ordinary edit remain preserved. |

## Migration, cost and the open wave

### Evidence and estimate

Static inventory at the repository basis counted 10 backend Recipe `.ts` files /
1,709 lines; two Recipe route files / 810; 37 editor `.ts`/`.tsx` files / 4,217
(includes locale/fixture modules, excludes files named `.test.`/`.stories.`);
two Recipe profile sources / 105. That is **51 files / 6,841 lines**, excluding
shared Structure code, separate reading components, generated files and other
exchange pages. A path-based `recipe` + `.test.ts` inventory excluding
`projection` found 59 files / 9,470 lines; it excludes `.test.tsx` and is not a
complete regression plan. Paths: [backend](../../services/main/src/modules/recipe/),
[routes](../../services/main/src/routes/recipes.ts),
[qualifier route](../../services/main/src/routes/recipe-qualifiers.ts),
[editor](../../apps/web/features/recipe-editor/),
[profile](../../model/definitions/recipe-structure-v1.ts),
[shape](../../model/definitions/recipe-structure-v1.ttl).
The inventory/script and inspected external snapshots are temporary evidence
under `.temp/content-adoption-evidence*`, not new product tools. Counts measure
surface area, not removable code or elapsed implementation time.

Planning estimate, **not measured**: remove 700–1,400 production lines of mixed
qualifier schemas, custom RDF project/hydrate and Recipe-specific shared-layer
branches; add 1,200–2,400 lines across constrained standard profiles, content
adoption/reference/derivation binding and destination-owner adapters; revise
1,500–3,000 existing lines in exchange, page reading and editor consumers.
Retain most quantity/display/import validation and pagination code. Allow
another 1,500–3,000 test/fixture lines changed or added. Net production code may
initially grow: source attribution, richer forms and loss-aware exchange are real
capabilities, not free consequences of vocabulary reuse. Estimates are inferred
from the cited file inventory and the owner gaps above; a one-recipe vertical
slice should revise them before a schedule is promised.

Indicative effort is 12–22 engineer-days: 2–3 for profile/owner contract and
counterexample fixtures; 4–7 for adoption, exact references and derivation seams;
3–5 for adapters/read/editor changes; 3–7 for corpus rebuild, outcome records
and owner/recovery checks. These are work estimates, not a calendar prediction
on the shared QA host. A scoped first slice can omit unrelated synopsis,
repair/lab execution and media-production features. It must still represent an
admitted recording/Post without misidentifying it as a RecipeStep or Work.

### Existing data and retained history

[Recipe exchange practice](../contracts/recipe-exchange.md) says there is no
production Recipe data requiring a compatibility reader/migration and that
retained corpora, including thirty Gutenberg recipes, are reimported. This note
did not inspect live storage or prove that every local user edit is disposable.
Before choosing reset, the manager should inventory owned drafts, publications,
supports and exact revision pins through their owners; use a consistent backup
and isolated restore. The pre-public policy is convergence of the current
definition and rebuilt seeds/fixtures, not a permanent dual reader.
[Target architecture §4](target-architecture.md#4-版本與演進),
[preparation budget](../storage/workload-budgets.md#data-preparation-and-import).

For disposable imported fixtures, replay retained Source observations through
the revised mapping and normal Main commands. For any non-disposable authored
content, convert a bounded snapshot into new owner revisions, preserving stable
resource/occurrence IDs where the meaning is unchanged; keep a correspondence
for source keys, revision-qualified references and support slots. Do not mutate
old exact payload bytes, silently retarget pins, or label reimport as human
confirmation. If existing signed/public pins must survive, retain their original
owner resolution and explicitly qualify the local historical adapter needed;
this changes the cost estimate and must be decided from the inventory.
[Immutable profiles](../contracts/model-profiles.md),
[Source adoption/control](../contracts/source-lifecycle.md).

Migration needs these explicit decisions and checks:

1. Transfer `originalText`/lexicals/spans into Source or authored Content according
   to their actual origin; keep unparsed text and language. Convert numbers to
   canonical exact lexicals, preserving bounds, range endpoints, absent units
   and arbitrary source wording separately. [Current fields](../../services/main/src/modules/structure/format.ts).
2. Keep duplicate occurrence identity, parent and order; map substitutions and
   step ingredient references to those occurrences. Resolve ingredient entity
   targets only with evidence. Attach the adopted procedure/Post/recording to its
   instruction role at exact revision selection. [Current registration](../../services/main/src/modules/recipe/structure-profile.ts).
3. Rebind Source field support to exact destination revisions and remap only
   justified correspondence. Preserve withdrawal, rights marks, author versus
   transcriber, erasure custody and replay. [Support attachment](../../services/main/src/modules/source/support-attach.ts),
   [source erasure migration](../../services/content/migrations/2131_recipe_file_source_erasure.sql).
4. Preserve measurement basis/coverage and computed evidence; rebuild derived
   graph/search/page projections through existing owners. Compare old and new
   user-visible answers against the falsifiers above on an isolated restore;
   never promote a missing or unbound field to a known fact. [Measurement operation](../../services/main/src/modules/recipe/operations.ts),
   [content projection worker](../../services/main/src/content-projection-worker.ts).

### Effect on wave/1 Recipe rows

The checked-in [program state](../goals/program/state.md) records wave/1 and
Recipes hub/reading as pending. At this basis,
[the hub declaration](../../scripts/qa/cases/outcomes/recipes/work-hub-and-reading.ts)
has six pending persona cells; its prerequisite descriptions are proposals,
not a current implementation inventory. Other Recipe declarations below say
proved. This note does not inspect the live wave branch, demote cells, or certify
current prove-run status. The manager must reconcile against the wave's latest
records; nearby pool/deadlock fixes are independent of this semantic decision.

| Existing row | Effect of commissioned replacement |
| --- | --- |
| [work-hub-and-reading](../../scripts/qa/cases/outcomes/recipes/work-hub-and-reading.ts) | Directly affected: preserve public-domain source credit, author/transcriber distinction, nested instructions, exact adopted revision and private boundaries. Prove all six personas after owner changes. Do not postpone source attribution until after a model change. |
| [read-a-recipe](../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts) | Reprove scaling, traversal, publication pin and private drafts; add Post/recording and occurrence-reference counterexamples to the row's authorised proofs. |
| [author-a-recipe](../../scripts/qa/cases/outcomes/recipes/author-a-recipe.ts) | Update producer fixtures/contracts and reprove duplicate occurrences, ordered content, publication and restoration for each persona. |
| [exchange-recipes](../../scripts/qa/cases/outcomes/recipes/exchange-recipes.ts) | Remap normalization/source support; reprove hierarchy, language, retry/partial outcome, native fidelity and explicit loss/unsupported forms. A Schema.org file cannot silently flatten a recording or relational preparation. |
| [collection-tracking-and-progress](../../scripts/qa/cases/outcomes/recipes/collection-tracking-and-progress.ts) | Keep stable Recipe Work identity and private standing; reprove dependent reads/position references if revision/occurrence selection changes. It does not authorize a new cooking-session product. |
| [catalogue-browse-and-search-in-its-zone](../../scripts/qa/cases/outcomes/recipes/catalogue-browse-and-search-in-its-zone.ts), [catalogue-pagination-in-its-zone](../../scripts/qa/cases/outcomes/recipes/catalogue-pagination-in-its-zone.ts) | Semantics should remain stable; re-record changed summaries/schema reads, check source/publication eligibility and existing count/pagination/disclosure invariants. No new browse scope. |

Following the [Goal method](../goals/method.md), revised API proof comes before
surface adoption. Existing
[Recipe outcome tests](../../tests/qa/integration/outcomes/recipes/) and
[recorded editor/read consumers](../../apps/web/features/recipe-editor/)
will need new answer records and surface verification when contracts change;
current recorded answers cannot certify new content forms. This is proposed
work, not permission to edit those files in this task.

### Launch recommendation and decision gates

Choose a pre-public owner-by-owner change now. Waiting until after public opening
would turn the mixed custom payload, source slots and required step form into
real client/history obligations. The current architecture explicitly allows
pre-public convergence, and the current exchange contract reports no production
compatibility requirement. Those are the reasons for the timing recommendation,
not an assumption that standard vocabulary removes engineering work.
[Evolution policy](target-architecture.md#4-版本與演進),
[exchange practice](../contracts/recipe-exchange.md).

The supermanager should settle (1) the field-specific adopted forms and one
authoritative structured-procedure representation, (2) the smallest local terms
for use substitution/scaling/basis, (3) exact Content derivation and reference
contracts, and (4) the non-disposable data inventory. Commission one vertical
slice proving an exact quantity plus a note, authored Post/recording/procedure
instructions, a tomato occurrence mention and a referenced intermediate recipe.
Use its owner API outcomes to revise the estimate, then migrate the Recipe
fixtures/consumers and reprove the affected rows. If that slice cannot preserve
the listed behaviours or bounded reads, keep Recipes closed and revise the
design; do not grow a universal mechanism to conceal the failure.

Validation performed for this design is static repository inspection, primary
source/schema/serializer inspection, a temporary line inventory and the actual
public iFixit JSON shape. Remaining validation is implementation API behaviour,
loss-aware exchange round trips (especially Paprika and Allrecipes), owned-data
inventory, cross-owner recovery and human surface tasks. Documentation checks
validate links/navigation only; they cannot qualify the replacement.
