# Standard vocabulary profiles and application responsibility

## Decision

Reuse a standard RDF term when its referent and semantics match the application
fact. Keep a local term for a distinct domain identity or relationship, such as
a MainVersion, an acceptance decision, or a repeated relation occurrence. A
TypeScript record name does not require a matching RDF class. This avoids a
permanent conversion layer without letting superficially similar standards
change the grain or authority of native data.

The authored [profile definitions](../../model/definitions/) pin the admitted
subset of terms and shapes. The [compiler](../../model/compiler/ir.ts)
rejects conflicting reserved namespace bindings; resource IDs use
`https://rezics.com/id/`, vocabulary uses `https://rezics.com/vocab/`, and newly
authored Schema.org terms use `https://schema.org/`. Source HTTP aliases need a
reviewed mapping. The [command registry](../../model/compiler/registry.ts) selects
canonical validation independently of caller profile claims.

## Responsibility boundary

Shapes check finite candidate state. Pure functions derive answers from explicit
input scope; positive monotonic entailment alone belongs in the admitted reasoner.
Fallback, absence, latest revision, counts and permissions need domain resolvers.
Owner commands verify authority and expected heads, then commit their effects,
receipt and outbox atomically. Neither RDF type nor shape conformance grants a
capability or proves a concurrent transition. Cross-owner effects follow a
recoverable workflow.

Standard vocabularies are selected by meaning rather than imported with every
ontology axiom. In particular, SKOS broader does not imply subclass, a source
`rdf:Statement` does not assert its base triple, and `owl:sameAs` does not merge
native identities. The [model tests](../../model/tests/) and
[MODEL cases](../../scripts/qa/cases/model-contracts.ts) carry those checks.

## Mapping boundaries still owned by domains

SKOS Concepts need no compulsory Scheme, Tag, Path or Sense companion; shared
Context selection and acceptance remain independent. An identified SKOS-XL
name can coexist with same-language alternatives, while a preferred label is a
qualified selection. BIBFRAME Work/Instance, SIOC community, ActivityStreams
decision and PROV activity are mappings only where their identity and event
grains actually match. A Work author credit cannot fabricate a native Person;
component anchors cannot assert `prov:wasRevisionOf` between arbitrary pointers.
Repeated ListItems and role-qualified relations keep their own occurrence IDs.

Media assets, exact OA uses and source captures keep identity, byte evidence and
acquisition separate. Spatial selectors require world epoch and frame; geometry
does not identify a world instance. ODRL/rights descriptions, ORG memberships,
OAuth grants and package/SPDX metadata cannot become live authority, legal
validity, executable capability or a universal dependency solver by RDF typing.
These wider mappings need their owning profiles and tests before admission.

Profiles are versioned. The trusted owner chooses required validation from the
operation and affected state; deleting a type, marker or selector cannot disable
it. A change in semantic meaning creates a new exact revision or an explicit
conversion with declared losses. Existing authored interpretation stays
resolvable. See [shared Context](context.md) for selection and
[validation operations](../implementation/model-profile-validation.md) for profile
activation and rejected-command inspection.
