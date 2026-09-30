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

### Bounded Work scalar state profile

`work-scalar-state-v1` owns one optional `rv:scalarValue` on a metadata Work.
The [tagged codec](../../services/main/src/modules/work/scalar-value.ts) and
[semantic value codec](../../services/main/src/modules/semantic/value.ts) preserve
zero, false, empty string, absent, explicit unknown and explicit no-value as
different states. The request digest includes tag and lexical form; the exact
Work manifest and JSON-LD export retain the same distinction. An old revision
never substitutes the current head. The [MODEL02 cases](../../scripts/qa/cases/model-contracts.ts)
and [recorded qualification](../plan/qualification.md) name the exercised paths.
This profile does not grant a general semantic-change API. Its choice of the
Work component avoids a separate null-first-head relay protocol.

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
"main" maps only after review. Today the
[definition change operation](../../services/main/src/modules/semantic/change.ts)
rejects label and grammar fields and graph queries return no localized
presentation; both remain to be built.
