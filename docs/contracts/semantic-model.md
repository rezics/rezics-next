# Native semantic model

## Identity and reference grains

A Resource is a stable logical identity with an owner, lifecycle and admitted
capabilities. Native facts are RDF in TDB2. No global relational parent or
mandatory universal Entity record is required. A resource can have multiple
semantic types; changing a classification does not change its identity or writer.

Works, characters, concepts, roles and relation definitions share this identity
contract. `skos:Concept` remains a semantic type; no Tag identity or mandatory
Scheme/Path/Expression/Sense bundle surrounds an object. The adopted
[Statement contract](classification.md) describes typed claims and acceptance.
All resource summaries expose a resolved name and
[image-or-fallback avatar](presentation.md#resource-summaries); this does not
require a universal parent table or an uploaded image for every object.

| Reference | Meaning |
| --- | --- |
| ResourceRef | Stable identified referent. |
| RevisionRef | Exact business component state, resolved through a retained immutable component manifest. |
| OccurrenceRef | One use/placement in a composition, independently identified from its target. |
| FragmentRef | Revision-qualified block, span, time interval or selector. |
| RepresentationRef | Exact encoding or artifact; a URL alone does not prove bytes. |
| DefinitionRef | Versioned meaning/operation profile. |
| ExternalRef | Provider/namespace-qualified identity, without fabricated native equivalence. |
| PrincipalRef | Private verified human/workload authority; not a public Agent description. |

Use UUIDv7 for newly allocated native identities and a deterministic canonical IRI
`https://rezics.com/id/{uuid}` at RDF boundaries. JSON-LD may abbreviate this with
the full `rezics` prefix. Public routes/slugs, physical datasets and TDB2 internal node
IDs are separate. UUID order is not causality and IDs are not access secrets.
External IRIs remain external. Identity correction retains original references
and follows [the correction protocol](identity-correction.md).

## Seven contracts and one model representation

[Standard vocabulary profiles](model-profiles.md) select direct term reuse,
minimal extensions, validation, pure rules and command responsibilities. A typed
application record name does not require a parallel RDF class. The
[compiler/transaction binding](../implementation/model-profile-validation.md)
pins generated artifacts and prevents profile/target removal from bypassing
the owner's required validation.

| Contract | Decisions |
| --- | --- |
| ResourceDefinition | Referent grain, owner, lifecycle, capability admission and reference behavior. |
| ValueDefinition | Representation, exactness, language, missing states and comparison/conversion. |
| RelationDefinition | Roles, occurrence identity, cardinality, order, qualifiers, context and provenance. |
| ConstraintProfile | Operation/data scope, severity, selected reasoning assumptions and validation budget. |
| OperationContract | Authority, preconditions, CAS, idempotency, atomicity and observable outcomes. |
| StorageBinding | Authoritative graph/fields, unique writer, supported transactions, queries and indexes. |
| ExchangeMapping | Source/target profiles, direction, residuals, losses and conformance cases. |

Built-in definitions can be authored as typed TypeScript declarations and compiled
to a serializable, versioned IR. TypeScript, optional native bindings, JSON-LD contexts and validated
SHACL subsets consume it. Runtime definitions use the same meta-schema and review;
they cannot upload arbitrary code, SQL, validators or privilege-bearing predicates.

Semantic-definition, record, operation and storage revisions are independent.
A release manifest pins their compatible combination. Adding a semantic property
does not inherently require a new SQL table; adding executable behavior requires
an admitted operation, not just an ontology class.

The first bounded multi-type profile is available on `POST /v1/works`. A caller
may supply `semanticTypes` containing `https://schema.org/Book` and/or
`https://schema.org/DigitalDocument`. The owner accepts each at most once, sorts
the set into canonical order, and binds it to the admitted creation digest. The
current Work retains `schema:CreativeWork` and the requested type triples; the
immutable Work manifest and exact revision response retain the same set. A title
edit preserves that set, and graph recovery rebuilds the triples from the retained
manifest. Classification alone grants no Access scope or executable capability.
This profile does not yet provide a general semantic-change operation.

The creation path adds at most two RDF type triples and two bounded type values
to the existing Work manifest. It uses the existing Work command, admission and
exact-revision lookup paths; its owner-call count and indexed exact lookup bound
do not grow with the number of Works. Physical engine work is qualified separately.

### Bounded Work scalar state profile

`work-scalar-state-v1` admits one `rv:scalarValue` on one metadata Work. The
request is `POST /v1/works/{id}/scalar-value` with `expectedHead`,
`actingSubject`, a stable `Idempotency-Key`, and an optional `scalarValue`.
`GET /v1/works/{id}/scalar-value` reads the current graph and exact Work manifest;
`GET /v1/works/{id}/scalar-value/revisions/{revision}` reads an exact immutable
Work revision. Both reads require current `work:read` authority and return an
expanded JSON-LD `export` object. The write requires `work:edit` and produces a
new Work component revision, leaving MainVersion and other Works untouched.
Title edits preserve the scalar field; scalar edits preserve title, type set and
MainVersion. This is one bounded property, not a general semantic-change API.

| State | API and immutable Work state | Current RDF `rv:scalarValue` and JSON-LD export |
| --- | --- | --- |
| Zero | `{ "kind": "integer", "lexical": "0" }` | `"0"^^xsd:integer`; export `@value: "0"`, `@type: xsd:integer` |
| False | `{ "kind": "boolean", "lexical": "false" }` | `"false"^^xsd:boolean`; export typed boolean lexical |
| Empty string | `{ "kind": "string", "lexical": "" }` | `""^^xsd:string`; export typed empty string |
| Absent | Omit `scalarValue` entirely; JSON null is invalid | No triple and no export property |
| Explicit unknown | `{ "kind": "unknown" }` | `rv:ExplicitUnknown` IRI; export `@id` |
| Explicit no-value | `{ "kind": "no-value" }` | `rv:ExplicitNoValue` IRI; export `@id` |

The lexical spaces above are intentionally exact for this first profile.
`0`, `false` and the empty string remain literals; unknown and known absence of a
value are separate named states. The Work manifest preserves the tagged sum so
an old revision does not rely on a mutable graph snapshot or JavaScript number
conversion. The current query compares its RDF term with the exact current
manifest. Missing or corrupt manifest/payload bytes produce a typed unavailable
response; a read never substitutes the current head for requested history.

The existing `work.edit` admission and `edit-metadata-work` receipt family bind
the new command through a distinct `work-scalar-state-v1` request digest that
includes the state tag and lexical. Identical keys replay one terminal receipt;
changed intent conflicts; the expected Work head is guarded in the Jena command.
Held-graph replay validates the retained digest against its immutable Work
manifest before rebuilding the property triple. A separate property component
was considered, but it would require another Access receipt family and relay
recovery dispatch, including a special null first head. The Work component is
the narrow owner boundary for this one-property profile.

The representation decision uses [RDF 1.1 Concepts](https://www.w3.org/TR/rdf11-concepts/)
for the distinction between literal lexical form, datatype and IRI, and
[JSON-LD 1.1](https://www.w3.org/TR/json-ld11/) for expanded typed values and
IRI objects. Those standards define exchange meaning; they do not prove this
application's admission, exact history or recovery. The tagged manifest and
fixed Work revision command are REZICS choices, checked by the MODEL02 tests.

## Values and relations

Preserve zero, false, empty, absent, unknown, no-value, inapplicable, unobserved,
erased and invalid/unsupported states according to profile. Exact integers and
decimals use lossless encodings across JSON. Quantities preserve unit definition,
kind, lexical evidence, uncertainty and precision; dimensions alone do not prove
convertibility. Preserve original calendar/timezone/precision and distinguish
valid, recorded, observation and operational time. Geometry retains CRS and axes.

Language labels use BCP 47; multiple same-language names, directions, sources and
validity belong to NameRecords. Plain RDF labels are sufficient only when those
extra distinctions are not needed. No browser locale changes content meaning.

Use direct predicates for ordinary accepted scalar facts. Use identified
Statements for contested/source-qualified facts, and identified relation instances
for repeated or role-qualified associations. Same-shaped values are not assumed
semantically equal. A relation join must bind participants to the same occurrence.

A Statement's stable ID identifies a particular claim/source record. Its
canonical meaning key groups an exact target, relation meaning, value and
semantic qualifiers for contextual resolution; it does not replace independent
source or occurrence identities. A named term's optional application pattern is
part of its versioned definition. Statement meaning never depends on which
navigation path selected that term. `prov:Attribution` is reserved for Agent
responsibility/provenance.

Definition expansion and context-bound inference use the admitted rule profile.
View grouping reuses existing Block/query descriptors and cannot assert facts.
Read models aggregate only eligible resolved statements with
[explicit count grains](search.md#statement-aggregation); they preserve role,
release, valid-time and canon correlation. The bounded scalar profile above
continues to own its direct values and distinct missing states.

The bounded `work-author-credit-v1` implementation identifies each Work credit
and its immutable revision separately. It uses `schema:roleName` and
`schema:position`, with an explicit external participant reference; repeated Open
Library author keys do not collapse into one occurrence or create native Agents.
The revision retains its profile, original Work revision, confirmer and graph
position. Its exact read is
`GET /v1/works/{id}/author-credits/{credit}/revisions/{revision}` under Work read
authority. Source support and correspondence remain separately owned private
evidence. See the [adoption contract](source-lifecycle.md#bounded-native-author-credit-adoption)
for append-only scope, authority, rights and recovery boundaries.

## Validation and query admission

Validate syntax at ingress, meaning and state in the domain command, and required
persisted invariants at the transaction boundary. Main validates complete candidate
state with the pinned SHACL profile and guards every mutable validation dependency
in its SPARQL Update; ordinary Fuseki updates do not automatically run SHACL.
Shape validation is not cross-service authorization or a concurrency protocol. Model updates stage,
validate and activate a versioned profile; rejected/partial source data remains
preserved separately from accepted native state.

Admit finite reasoning profiles with provenance and work budgets. Classification
cannot grant an account, editor or executable capability. Query templates bind
datasets, context, identity and budgets on the trusted server. Remote JSON-LD
contexts and ontology imports pass controlled acquisition, not arbitrary request-
time fetching. See [standards](standards.md) and [context](context.md).

## Sources

[RDF concepts](https://www.w3.org/TR/rdf11-concepts/),
[JSON-LD](https://www.w3.org/TR/json-ld11/),
[UUIDv7](https://www.rfc-editor.org/rfc/rfc9562.html) and
[SHACL](https://www.w3.org/TR/shacl/) supply representation/validation mechanisms.
Resource ownership, product continuity and command semantics are REZICS contracts.
