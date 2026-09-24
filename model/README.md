# Fixed first profiles

The authored `definitions/*-v1.ts` files are the SHACL subset for the first
delivery. `yarn gen` renders their reviewed Turtle bytes into
`generated/model/shapes/`, preserves the pinned profile SHA-256 digests, and
publishes the profile registry with shape IRIs and focus roles used by Main and
the Fuseki command module.
`yarn gen:check` fails if any generated file has drifted.
After `yarn toolchain:install`, run `yarn gen` to refresh generated artifacts;
`yarn gen:check` verifies committed output. The QA model tier runs with
`yarn qa --tier model` on an isolated Fuseki project. A generated schema or
successful model tier does not
by itself qualify admission, Content publication or the full product journey.

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
profile digest against `tests/evidence/`. `yarn qa --tier model` starts an
isolated QA Fuseki project and runs the native case in strict mode. It stages each
candidate through the QA-only fixture update service, calls command module
0.5.5 with generated profiles, and checks each outcome, expected `sh:resultPath`,
and receipt rollback. It also proves that omitting a required binding rejects
the command without a receipt. It writes counts, digests and discrepancies to
`model-equivalence.json` in the QA artifact directory.

Command module 0.5.5 retains a fixed `binding` map on each affected profile
validation. It checks role foci, reciprocal links, exact heads, policy terms,
optional predecessor absence, rating value, and the English question against
the poststate graph. The server chooses all predicates and allowed binding keys;
callers cannot submit shapes or query text. Main sends these bindings from its
verified dependencies and retained recovery payload. The module also requires a
bound focus when a command changes a subject governed by one of the five bound
profiles. SHACL remains authoritative for the authored static constraints.

The isolated and merged 0.4.0 command image reproduced all 66 recorded outcomes
and every expected report path. The handwritten `definitions/*.ttl` profiles and
Python validators are retired. Their SHA-256 digests, candidate payloads,
conforming/rejected outcomes, and historical reports remain in the generated
manifest and `tests/fixtures/native/` plus `tests/evidence/`. QA records the
strict native matrix as a separate model tier.

The profile set covers Work metadata, draft Contribution and publication,
Main and Realm selection, Space/Realm creation, shared classification,
Realm classification contexts and decisions, and standing rating contexts and
observations. The rating revision profile is the only current `sh:or`: an
available revision has a 1–10 value, while a withdrawn revision has none. New
semantics require a new profile revision rather than silently changing the
reviewed shape bytes.

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
