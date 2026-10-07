# Current reviewed profiles

Authored `definitions/*.ttl` and the remaining TypeScript profile definitions
are the current reviewed SHACL basis. Turtle companions carry command metadata
and may expose named readers of the exact authored source. `task gen` publishes
their reviewed Turtle bytes into
`generated/model/shapes/`, computes profile SHA-256 digests, and
publishes the profile registry with shape IRIs and focus roles used by Main and
the Fuseki command module.
`task gen:check` fails if any generated file has drifted.
After `task toolchain:install`, run `task gen` to refresh generated artifacts;
`task gen:check` verifies committed output. The QA model tier runs with
`task qa -- --tier model` on an isolated Fuseki project. A generated schema or
successful model tier does not
by itself qualify admission, Content publication or the full product journey.

The same run generates:

- `generated/model/contexts/*.jsonld`: a JSON-LD context for each profile, with
  explicit prefix and predicate mappings;
- `packages/model/src/generated/schemas.ts`: TypeBox schemas and inferred
  TypeScript types for each named shape's node-local JSON-LD value envelope;
- `packages/model/src/generated/vocabulary.ts`: namespace and expanded IRI
  constants from the authored predicates and fixed terms;
- `generated/model/manifest.json`: the current profile shape digests and a
  SHA-256 entry for every other generated artifact except Facets;
- `packages/model/src/generated/facets.ts`: the admitted
  [Facets](../docs/contracts/queries.md) from `definitions/facet-*.ts`, which Main
  serves at `GET /v1/facets`. They define queries, not shapes, so they stay out of
  the manifest and the Fuseki image.

`@rezics/model` exports those generated values and
`checkNodeLocalCandidate(shapeIri, candidate)`. This checker is useful for
preflight and fixture construction. It checks local cardinality, fixed and
enumerated values, integer bounds, current language and pattern constraints,
and the rating revision disjunction. Its JSON-LD representation uses compact
predicate keys, arrays of values, `@id` for the node, and `@value` plus
`@language` for language literals. Each shape retains the authored open or
closed property boundary.

**Jena's transactional SHACL check remains authoritative.** The TypeBox schema
cannot establish `sh:class` links to other nodes, reciprocal relationships,
distinct focus identities, caller authority, current heads, or full RDF lexical
validity. Its date-time pattern is lexical, and its current language tags use
the authored spelling; it may disagree with SHACL on other RDF lexical variants.
Tests use explicit domain fixtures and boundary cases. A valid node-local
fixture does not establish a conforming multi-node graph. The command module
validates the poststate graph before commit.

The 66 previously recorded valid and rejected candidates are now static
TypeScript fixtures under `tests/fixtures/native/`. The structural
`tests/native-equivalence.test.ts` case checks every fixture name, outcome and
profile digest against `tests/evidence/`. `task qa -- --tier model` starts an
isolated QA Fuseki project and runs the native case in strict mode. It stages each
candidate through the QA-only fixture update service, calls command module
0.5.6 with generated profiles, and checks each outcome, expected `sh:resultPath`,
and receipt rollback. It also proves that omitting a required binding rejects
the command without a receipt. It writes counts, digests and discrepancies to
`model-equivalence.json` in the QA artifact directory.

Command module 0.5.6 retains a fixed `binding` map on each affected profile
validation. It checks role foci, reciprocal links, exact heads, policy terms,
optional predecessor absence, rating value, and the English question against
the poststate graph. The server chooses all predicates and allowed binding keys;
callers cannot submit shapes or query text. Main sends these bindings from its
verified dependencies and retained recovery payload. The module also requires a
bound focus when a command changes a subject governed by one of the five bound
profiles. SHACL remains authoritative for the authored static constraints.

The isolated and merged 0.4.0 command image reproduced all 66 recorded outcomes
and every expected report path. The original validation scripts are retired.
Their recorded SHA-256 digests, candidate payloads, conforming/rejected outcomes
and historical reports remain in `tests/fixtures/native/` plus `tests/evidence/`.
The generated manifest describes current bytes; native qualification reruns the
recorded candidates against the installed current shapes. QA records the
strict native matrix as a separate model tier.

The profile set covers Work metadata, draft Contribution and publication,
Main and Realm selection, Space/Realm creation, shared classification,
Realm classification contexts and decisions, and standing rating contexts and
observations. For example, a rating revision's `sh:or` admits an available
revision with a 1–10 value or a withdrawn revision with none. Optional
properties and relaxed constraints refine the same profile or Facet.
Tightened constraints need a new constraint revision and an admission coverage
check; different meaning needs a new term. Block payload changes version only
that block. Review covers both the authored and generated diffs; there is no
append-only authored digest lock. Exact stored artifacts stay immutable through
the [owner revision resolver](../docs/implementation/graph-records.md#revision-anchor-resolver),
independently of current build shapes. See
[profile validation practice](../docs/implementation/model-profile-validation.md#choose-the-revision-boundary)
for the current custody limits.

`content-publication-v1` adds a distinct Content-backed revision pin. Its
`variant` focus is in the current graph and its `decision` focus is in revisions;
the command module requires both canonical foci, reciprocal head/component and
matching resource, decision graph position equal to the committed control
position, and exact decision/receipt fields before commit. The profile constrains the Content revision IRI, digest, owner
position, model, format and language identity. It neither asserts a public
disclosure nor creates a MatchUnit or public search activation.

`content-search-eligibility-v1` records an explicit public release decision for
the active Content publication. It requires an exact variant and publication
link, `rv:OriginalContribution` rights basis, `rv:Public` disclosure, and the
retained admission actor, scope and authority epoch. `content-match-unit-v1`
defines both the immutable projection anchor and the bounded public text unit.
The native command gate checks their reciprocal links against the current
publication and eligibility heads, exact source revision, receipt fields,
language tag, one-unit-per-variant poststate and graph position. These shapes
validate records; Access supplies the actor's authority before the decision is
written, and Content supplies the exact body before the projection is built.
