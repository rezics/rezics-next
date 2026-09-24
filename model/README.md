# Fixed first profiles

The 12 `definitions/*-v1.ts` files are the authored SHACL subset for the first
delivery. `yarn gen` renders their reviewed Turtle bytes into
`generated/model/shapes/`, preserves the pinned profile SHA-256 digests, and
publishes the profile registry with shape IRIs and focus roles used by Main and
the Fuseki command module.
`yarn gen:check` fails if any generated file has drifted.

The same run generates:

- `generated/model/contexts/*.jsonld`: a JSON-LD context for each profile, with
  explicit prefix and predicate mappings;
- `packages/model/src/generated/schemas.ts`: TypeBox schemas and inferred
  TypeScript types for each named shape's node-local JSON-LD value envelope;
- `packages/model/src/generated/vocabulary.ts`: namespace and expanded IRI
  constants from the authored predicates and fixed terms;
- `packages/model/src/generated/arbitraries.ts`: fast-check candidates for each
  named shape, sampled with an explicit seed in tests;
- `generated/model/manifest.json`: the unchanged profile shape digests and a
  SHA-256 entry for every other generated artifact.

`@rezics/model` exports those generated values and
`checkNodeLocalCandidate(shapeIri, candidate)`. This checker is useful for
preflight and fixture construction. It checks local cardinality, fixed and
enumerated values, integer bounds, current language and pattern constraints,
and the rating revision disjunction. Its JSON-LD representation uses compact
predicate keys, arrays of values, `@id` for the node, and `@value` plus
`@language` for language literals. Shapes remain open to additional properties,
as in the authored SHACL.

**Jena's transactional SHACL check remains authoritative.** The TypeBox schema
cannot establish `sh:class` links to other nodes, reciprocal relationships,
distinct focus identities, caller authority, current heads, or full RDF lexical
validity. Its date-time pattern is lexical, and its current language tags use
the authored spelling; it may disagree with SHACL on other RDF lexical variants.
The generated arbitraries satisfy the node-local envelope; they are
not guaranteed to form a conforming multi-node graph. The command module
validates the poststate graph before commit.

The 66 previously recorded valid and rejected candidates are now static
TypeScript fixtures under `tests/fixtures/native/`. The structural
`tests/native-equivalence.test.ts` case checks every fixture name, outcome and
profile digest against `tests/evidence/`. With `MODEL_NATIVE_EQUIVALENCE=1` and
`FUSEKI_URL` set to an isolated QA Fuseki endpoint, its diagnostic case stages
each candidate through the QA-only fixture update service, calls the command
module with generated profiles, and checks both the outcome and receipt
rollback. It writes discrepancies to `.temp/native-equivalence-result.json`.
`MODEL_NATIVE_EQUIVALENCE_STRICT=1` makes any discrepancy fail the test.

Each historical `definitions/*.ttl` file remains a byte-for-byte equivalence
baseline. The Python validators and their tests remain until every recorded
candidate outcome reproduces through native command validation. Several old
helpers bound exact references with additional `sh:hasValue` constraints, and
the current command request cannot yet express those bindings. See
[the execution plan](../docs/plan/README.md#execution-program) for that remaining
P0.3 gate.

The profile set covers Work metadata, draft Contribution and publication,
Main and Realm selection, Space/Realm creation, shared classification,
Realm classification contexts and decisions, and standing rating contexts and
observations. The rating revision profile is the only current `sh:or`: an
available revision has a 1–10 value, while a withdrawn revision has none. New
semantics require a new profile revision rather than silently changing the
reviewed shape bytes.
