# Native semantic model

## Identity and reference grains

A Resource is a stable logical identity with an owner, lifecycle and admitted
capabilities. Native facts are RDF in Fluree. No global relational parent or
mandatory universal Entity record is required. A resource can have multiple
semantic types; changing a classification does not change its identity or writer.

| Reference | Meaning |
| --- | --- |
| ResourceRef | Stable identified referent. |
| RevisionRef | Exact business component state, resolved through a retained Fluree commit anchor. |
| OccurrenceRef | One use/placement in a composition, independently identified from its target. |
| FragmentRef | Revision-qualified block, span, time interval or selector. |
| RepresentationRef | Exact encoding or artifact; a URL alone does not prove bytes. |
| DefinitionRef | Versioned meaning/operation profile. |
| ExternalRef | Provider/namespace-qualified identity, without fabricated native equivalence. |
| PrincipalRef | Private verified human/workload authority; not a public Agent description. |

Use UUIDv7 for newly allocated native identities and a deterministic canonical IRI
`https://rezics.com/id/{uuid}` at RDF boundaries. JSON-LD may abbreviate this with
the full `rezics` prefix. Public routes/slugs, physical ledgers and Fluree dictionary
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
to a serializable, versioned IR. Rust, TypeScript, JSON-LD contexts and validated
SHACL subsets consume it. Runtime definitions use the same meta-schema and review;
they cannot upload arbitrary code, SQL, validators or privilege-bearing predicates.

Semantic-definition, record, operation and storage revisions are independent.
A release manifest pins their compatible combination. Adding a semantic property
does not inherently require a new SQL table; adding executable behavior requires
an admitted operation, not just an ontology class.

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
assertions for contested/source-qualified facts, and identified relation instances
for repeated or role-qualified associations. Same-shaped values are not assumed
semantically equal. A relation join must bind participants to the same occurrence.

## Validation and query admission

Validate syntax at ingress, meaning and state in the domain command, and required
persisted invariants at the transaction boundary. Qualify the exact Fluree SHACL
and conditional-update entry points used by each writer. Shape validation is not
cross-service authorization or a concurrency protocol. Model updates stage,
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
