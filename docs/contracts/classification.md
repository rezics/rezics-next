# Contextual concepts, classification and Tag Paths

## Model

`Concept != Path != Expression != Sense != Application != Effective Tag`.
A Concept has stable meaning and names. A Scheme organizes a vocabulary. A Path
is one identified route through typed vocabulary relations. An Expression is a
proposition. A Sense binds a path to an expression under an interpretation scope.
An Application asserts/adopts that meaning for a Resource in a context.

Use SKOS Concept/Scheme/labels/mapping terms where their semantics fit. Distinguish
generic, partitive, instance, organizational and facet-value relations. Guide
nodes organize navigation and do not become assertable tags. `skos:broader` is
not subclassing; a path ancestor is not automatically a claim about the target.

For example, Character Traits -> Appearance -> Hair Color -> Red can mean
`facetValue(HairColor, Red)`. Bare Red and HairColor=Red have distinct claim keys.
A negative judgment on one does not contradict an application of the other.

## Identity and evolution

Paths identify an ordered sequence of node and relation references. Preserve
occurrences and exact relation meanings. A structural or semantic correction
creates a new definition/anchor rather than reinterpreting existing applications.
Synonymous presentation changes preserve proposition identity. The same Path can
have distinct Global/Realm Senses; adopting the same Sense does not duplicate it.

Validate admitted hierarchy constraints at the transaction boundary, including
self/cycle checks for profiles that require a DAG. SKOS itself does not promise
a tree or universal acyclicity. Retire definitions without making old references
unresolvable; new applications require an eligible active definition.

## Applications, votes and context

An Application records target grain, Expression/Sense, authority context,
provenance, proposer and lifecycle. Objective type assertions, source evidence,
subjective fit, spoiler judgments and moderation are independent. Imported source
votes never create native voters. Feature-specific private accountability prevents
persona switching from multiplying votes while keeping public attribution private.

Global and Realm populations remain separate. Apply [context resolution](context.md)
to accepted/rejected/absent/unavailable states and explicit inheritance. Several
supporting applications can yield one effective proposition without losing their
identities or the targets of voting controls.

## Inference and presentation

Rules are versioned and classified as entailed or retrieval-only. A retrieval
expansion can help match content but is not displayed as a directly asserted fact.
Derive within the selected context and retain evidence/rule generation. Bound
traversals and invalidate impacted roots incrementally; do not materialize the
entire Resource x Realm x Concept product.

Rendered badges choose a clear standalone expression signature, with full path
and source explanation available. Search may match an intermediate concept only
through an admitted rule. Name selection preserves language and actual context;
different Realm preferred names are not conflicting global SKOS labels.

## Operations and implementation

Commands create/revise/retire concepts, relations, paths, expressions and senses;
apply/withdraw/adopt classifications; cast/revise judgments; and change local
fallback policy. Each uses expected state, current authority and a durable receipt.
Definition graph mutations serialize only their affected scope, with a safe
concurrency check for cycles and stale topology. Public predicates remain ordinary
Fluree facts; protected acceptance and authority predicates use owning commands.

Effective-tag and inverse indexes are rebuildable. Stage a new rule generation,
process affected applications with keysets, catch up concurrent changes and switch
only complete results. Direct facts remain available while derived work is pending.

Basis: [SKOS](https://www.w3.org/TR/skos-reference/) and
[RDFS](https://www.w3.org/TR/rdf-schema/). REZICS supplies the application,
perspective, governance and workflow contracts. See [acceptance](../testing/classification.md).
