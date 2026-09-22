# Profile compilation, validation and command binding

Implement [the profile contract](../contracts/model-profiles.md) as one versioned
definition pipeline with separate vocabulary, validation, rule and operation
artifacts. This is a concrete implementation design; it does not claim that the
new application's compiler or domain services exist.

## Release artifact and compiler

Keep the existing seven definition contracts as compiler inputs. Their result is
a serializable IR with these explicit responsibility fields:

| IR section | Required fields |
| --- | --- |
| Term | IRI; exact definition revision; source artifact/digest; direct reuse, justified subclass/subproperty, local extension or exchange-only mapping. |
| Resource/component | Identity grain; admitted profiles; owner; lifecycle; authoritative predicates; protected fields. |
| Validation | Shape ID; target/focus selection; constraint AST; severity; graph scope; dependency footprint; engine lowering and budget. |
| Rule | Rule/algorithm ID and revision; positive entailment or domain resolver; input/output predicates; context/snapshot needs; completeness and invalidation contract. |
| Operation | Typed intent; authority/admission requirement; expected heads; allowed changes; guard/uniqueness keys; validator set; receipt/effect contract. |
| Storage | Owner and transaction entry point; dataset/shape source; index/query assumptions; concurrency and recovery mechanism. |
| Exchange | Source/target profile; direction; explicit loss/residual behavior; fixtures and conformance evidence. |

Generate from that IR: pinned JSON-LD contexts, selected ontology axioms, SHACL
Core/approved SPARQL shapes, typed Rust/TypeScript boundary models, command
validators/guard plans, trusted query/rule descriptors and mapping manifests.
Application source code still implements admitted algorithms and external effects;
the IR does not become an arbitrary code loader.

Every semantic constraint has one source constraint ID. Multiple lowerings of
that same invariant, such as preflight and transactional validation, retain the
same ID and comparison cases. Do not maintain unrelated handwritten copies of the
same rule in GUI, SHACL, Rust and SQL. Cross-field or transactional code that cannot
be generated declares its owning implementation and required equivalence tests.

The release manifest pins vocabulary/context bytes, term/profile revisions,
SHACL compiler and allowed features, rule code/parameter versions, operation
contract, engine build/config and artifact digests. It is not a promise that every
version combination works. Required features unknown to a compiler or engine are
activation errors; annotation-only metadata is the only class that may be ignored.

## SHACL execution profile

Start with Core constraints actually required by the first-stage model:
`minCount`, `maxCount`, `datatype`, `nodeKind`, `class`, numeric bounds, `in`,
`hasValue`, `uniqueLang`, admitted string/language checks, bounded `node` and
`and`/`or`/`xone`, and plain/bounded property paths. Add a particular advanced
constraint only after its exact engine path and cost pass conformance cases.

Use direct `sh:sparql` only for a bounded, local, read-only constraint that Core
cannot express. Pin the query and its read footprint. No arbitrary caller query,
remote SERVICE, network acquisition, JavaScript validator or uploaded function is
admitted. SHACL-AF Rules are not an initial mutation or policy engine; ordinary
SHACL-SPARQL constraints are not the same feature as SHACL-AF inference rules.

Profiles are open to unrelated admitted semantic types/properties on a shared
resource. Use `sh:closed` only for a fully owned component/envelope projection
with an explicit property allowlist; do not close a universal Resource and thereby
reject valid multi-type content. Native unknown executable/control fields are
rejected at ingress. Unsupported source fields stay in the separate source profile.

Required constraints use blocking violation severity. Warnings/information are
editorial diagnostics with explicit handling; a diagnostic-only run cannot activate
native state. A report with no shapes or no expected focus nodes is not evidence
of a useful successful validation. Check shape-set identity/count and coverage.

Target selection is part of the trusted owner binding. For every mutation,
calculate focus nodes from the union of pre-state and post-state ownership and
references, including affected dependents. Removing a type or the last selector
predicate must not avoid a required check. Revalidate a referencing parent when
a target's class/state changes, or prevent that change through an equivalent
guarded lifecycle rule.

Do not assume `sh:node` validates every possible reverse dependency on any write.
Maintain bounded reverse dependencies/read footprints. If impact exceeds the
admitted synchronous budget, stage the operation or reject it as too large; a
truncated validation is not conformance. Deletion has its own lifecycle command
and need not pretend a retired resource still satisfies its active-state shape.

## Authoritative command path

1. Decode with the pinned context/profile and enforce byte/node/depth budgets.
   Owner-chosen operation/target/capability profiles override untrusted self-claims.
2. Obtain current Account/Access admission and the complete selected subject path.
   Bind operation, target, requested effects, expiry and required fences.
3. Load a coherent local base and immutable referenced dependencies. Validate
   expected component heads, model/rule generation and lifecycle prerequisites.
4. Build the proposed change. Run pure reconciliation/selection and validate the
   complete affected candidate view. Preserve denied, stale, invalid, unavailable,
   unsupported, budget-exhausted and partial outcomes distinctly.
5. Commit guarded writes with all dependencies that must remain true: target head,
   slot/uniqueness guards, affected topology generation and model generation.
   Re-run the required persisted validations inside the actual transaction, or
   qualify an equivalent optimistic/serializable commit protocol.
6. In the same authoritative transaction write the domain change, revision anchor,
   operation receipt and event/outbox intent. Failed guards produce no success
   receipt. Resolve the operation's own receipt after an uncertain response.
7. After commit, publish the event and update bounded projections. Cross-owner
   effects use the existing staged workflow and compensation contracts.

Steps 3-5 require more than checking the target's own revision: a validator reading
a parent, referenced vocabulary or mutable dependency needs protection for those
reads too. Prefer immutable definition refs; use per-aggregate generation/guard
records or a qualified transaction isolation mechanism for mutable dependencies.
Never replace a high-degree target with one global counter that serializes unrelated
incoming reactions. PostgreSQL uniqueness is local to its owner; it cannot supply
a foreign key or atomic receipt for a Fluree mutation.

### Selected Fluree mechanism for mandatory focus validation

Use the existing transaction path with a **server-generated, per-operation inline
shape wrapper**, in addition to the pinned standing shapes. A bounded probe verifies
this mechanism on the selected CLI/server binary, including an unchanged invalid
parent and a resource whose target type is removed. A Fluree fork is therefore not
a prerequisite for this first mechanism.

For each required `(focus, shape, dataGraph)` pair, the command creates an identified
validation-check node as part of its own operation receipt. It records the focus,
shape/manifest revision and the source/expected dependency basis. Generate a
transient NodeShape targeting that new check node. Its focus property uses
`sh:node` to apply the required shape directly, independently of that shape's
ordinary class/predicate targets. The required shape itself checks mandatory
semantic type where the profile requires one.

```turtle
@prefix ex: <https://example.org/command-validation/> .
@prefix rz: <https://rezics.com/vocab/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .

# Data written atomically with the guarded domain change and receipt:
ex:operation rz:validationCheck ex:check .
ex:check rz:focus ex:affectedParent ; rz:shapeRef ex:ParentProfileV1 .

# Generated opts.shapes for this operation; never a standing historical shape:
ex:CheckShape a sh:NodeShape ; sh:targetNode ex:check ;
    sh:property [ sh:path rz:focus ; sh:minCount 1 ; sh:maxCount 1 ;
                  sh:node ex:ParentProfileV1 ] .
```

All inserts, including receipt/check nodes, use the same expected-state guard.
A nonmatching guard creates no receipt. A shape failure rejects the entire
transaction. Current-state validation checks are transient: do not persist a rule
that makes every historical receipt validate a mutable target's latest state.
Retain the template/artifact digest and exact instantiation inputs so validation
can be reconstructed against the recorded historical state.

The domain adapter, not callers, determines the check set and supplies `opts.shapes`.
It cannot trust data's `shapeRef`, profile marker or claimed owner to choose checks.
Generated wrapper IRIs cannot collide with standing shape IDs. Restrict detailed
reports and validation-check records to their admitted audience; return safe domain
error codes rather than disclosing hidden focus nodes or values.
This mechanism does not discover dependencies for us: the compiler's read footprint
and bounded reverse-dependency index still need complete coverage and guards.
An unrelated invalid parent is not repaired by validating only the edited child.

The executed case uses one native data graph. A check must execute in its target's
data graph; do not assume `sh:node` traverses unrelated named graphs or ledgers.
Multi-graph lowering needs its own admission cases; cross-owner validation remains
a staged domain workflow. Shape source, reject posture and operation writer remain
protected even though the wrapper itself is additive and generated by the server.

Source inspection shows inline shapes disable the cross-transaction compiled-shape
cache in the current API path. Bound shape/focus counts and measure compilation
and validation on the initial host before rollout. If that cost fails the workload
budget, optimize the adapter to reuse the compiled manifest plus instantiate the
small wrapper; qualify that extension without changing the profile semantics.
This is a concrete optimization trigger, not evidence of a measured capacity limit.

### Example: adopt a reviewed contribution

`AdoptContribution` binds Work/MainVersion, publication context, exact contribution
revision, reviewed dependency manifest, expected selection head, policy/model
revision and idempotency key/digest. The owner computes the actor and admission.

SHACL verifies required IRI references and the fixed/follow selection shape. The
command verifies current authority, applicability, review basis and disclosure.
A local guard protects the expected selection and any mutable admission/read
dependencies. The committed decision/selection, anchor, receipt and event refer to
the exact result. A losing concurrent command returns stale; a retry of the winner
replays its receipt. A newer draft cannot enter the reviewed selection by inference.

### Example: classify without accidentally asserting a global fact

```turtle
@prefix ex: <https://example.org/profile-example/> .
@prefix rz: <https://rezics.com/vocab/> .
@prefix oa: <http://www.w3.org/ns/oa#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .

ex:scienceFiction a skos:Concept ; skos:prefLabel "Science fiction"@en .
ex:expression a rz:Expression ; rz:concept ex:scienceFiction .
ex:application a oa:Annotation ;
    oa:motivatedBy oa:classifying ;
    oa:hasTarget ex:mainVersion ;
    oa:hasBody ex:expression ;
    rz:classificationContext ex:realmAClassification ;
    rz:decisionHead ex:decision .
ex:decision a rz:Decision ; rz:outcome rz:Rejected .
```

No target-to-concept classification triple is asserted by this representation.
The qualified result is selected by the domain resolver. A source import, an RDF
type inference or the mere presence of an annotation cannot create acceptance.

## Fluree 4.2.1 binding and engine findings

The following are source-inspection findings, with bounded execution evidence
recorded separately below. They constrain the implementation rather than certify
every Fluree feature:

| Finding | Required binding |
| --- | --- |
| SHACL feature defaults differ between embedded API and server/CLI. | Pin build features and verify the actual entry point. |
| Bulk import bypasses transaction SHACL; a standalone validate command only reports. | Import into isolated source/staging state. Validate the exact immutable input and resulting generation before fenced native activation. |
| A shapes source can replace default-graph shapes; inline shapes are transient. | Use a controlled immutable shape artifact; record its digest in the operation. Do not infer audit provenance from transient inline shapes. |
| Request validation-mode softening may be permitted by override configuration. | Explicitly enable reject mode and set `f:overrideControl f:OverrideNone`; reject caller-supplied validation/config overrides in the domain adapter. |
| Custom SPARQL constraint-component declarations are documented as ignored; direct `sh:sparql` has a narrower supported contract. | Compile only admitted features and reject unsupported required constructs before activation; never accept a vacuous pass. |
| Transaction target selection uses post-state information; validation entry points may operate over modified subjects. | Protect immutable profile ownership and validate the complete affected focus/read footprint, including retractions and referenced targets. |
| Committed hierarchy and same-transaction schema introduction can behave differently. | Install candidate definitions separately and activate only a validated, generation-pinned model; prohibit ordinary clients from changing ontology/control triples. |
| Cookbook and crate documentation disagree on inverse composite path support. | Do not choose that construct from documentation alone. Prefer simple paths for bootstrap and probe an advanced lowering before admission. |
| Rule-budget exhaustion can still return a query result over partial closure. | Inspect completeness metadata; do not use an incomplete answer for exact selection, acceptance or counts. |
| RDF 1.2 edge-reification ingest asserts the base edge in this engine profile. | Keep unaccepted claims as identified bodies/relations; do not ingest their allegation through an asserting edge annotation. |

Source basis:
[compatibility](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/reference/compatibility.md),
[SHACL cookbook](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/guides/cookbook-shacl.md),
[SHACL crate](https://raw.githubusercontent.com/fluree/db/v4.2.1/fluree-db-shacl/src/lib.rs),
[validator entry points](https://raw.githubusercontent.com/fluree/db/v4.2.1/fluree-db-shacl/src/validate.rs),
[validate CLI](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/cli/validate.md),
[transaction integration](https://raw.githubusercontent.com/fluree/db/v4.2.1/fluree-db-api/src/tx.rs),
[staged focus discovery](https://raw.githubusercontent.com/fluree/db/v4.2.1/fluree-db-transact/src/stage.rs),
[reasoning](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/concepts/reasoning.md).

## Model activation and delivery sequence

1. Implement the term/profile IR and candidate manifest, with separate vocabulary,
   shape, rule and command artifacts. Bootstrap direct Concept/Label/Annotation/
   ListItem profiles plus retained MainVersion/Context/Decision/Expression records.
2. Validate the artifacts and generated examples against a reference validator and
   the exact target engine. Reject namespace/constraint/inference mismatches.
3. Stage candidate schemas and revalidation/index work while the old manifest remains
   active. Define exact affected coverage and catch-up watermark. Do not edit an
   already referenced meaning in place.
4. Stop admission or use a qualified epoch guard while switching the local shape
   source and active model manifest. Revalidate stale commands; preserve compatible
   old readers and exact historical interpretation. Cross-ledger activation is a
   staged procedure, never a fictional atomic pointer switch across stores.
5. Deliver MainVersion adoption, contextual classification and judgment operations
   with complete guard/receipt semantics. Add source reconciliation and other
   domain profiles using the same pipeline. Spatial execution keeps its existing
   later-stage activation boundary.

A model-owned immutable local shape replica is a generated artifact, not a second
independently editable authority. Prefer it at bootstrap over a floating latest
cross-ledger model reference. Rollback selects a compatible release and revalidates
current state; it must not restore revoked rights or erased payloads.

## Executed evidence and remaining qualification

The [reproducible probe](../../scripts/research/model_profiles/README.md) ran on
2026-09-22 with Python 3.14.7, pySHACL 0.40.1, RDFLib 7.6.0, OWL-RL 7.6.2 and
Fluree 4.2.1. Its [retained result](../../scripts/research/model_profiles/evidence.json)
records actual versions, binary/script/shape digests, observations and 69 successful
expectation checks: 21 reference SHACL fixtures, two additional reference semantic
checks, 21 matching Fluree file validations, and 25 transaction/report checks.

Successful expectation checks include deliberate counterexamples. They are not
69 successful production features:

| Observed result | Consequence for the selected design |
| --- | --- |
| Independent same-language Label nodes, repeated ListItem targets and open multi-type resources conform; conflicting preferred labels and invalid vote values fail. | Standard types plus profile constraints cover these distinctions. |
| An OWL functional property equates two distinct named objects; two differently targeted anchors both conform. | Database uniqueness and sealed-state immutability remain command/transaction invariants. |
| Removing the class target bypasses its ordinary shape; editing only a child commits while a later full report identifies an invalid parent. | Required focus cannot be inferred solely from post-state types or directly modified subjects. |
| Inline check wrappers reject that child edit and type-removal case with NodeConstraint violations, and create no receipt; a valid change commits with one receipt. | Select the server-generated wrapper as the first affected-focus mechanism. |
| A later operation is not constrained by a previous operation's transient wrapper. | Historical receipts retain evidence, not live constraints on mutable state. |
| Explicit OverrideAll permits a warn request and commits invalid data; switching to OverrideNone rejects the same kind of request. The unconfigured heuristic also rejected. | Pin the posture; do not generalize the configured override behavior to every default path. |
| Eight concurrent HTTP commands targeting one expected head yield one stored receipt and one version advance; nonmatching requests can still return HTTP 200. | Use the command's durable receipt to determine success; translate losing guards into the domain's stale/precondition result. |

The local loopback server was stopped and the final test ledger fully conformed.
An initial test-harness config write used the wrong JSON graph form and failed;
the executed retained run uses documented SPARQL named-graph insertion. No result
from that earlier harness failure is counted as product evidence.

These experiments do not implement or qualify the production profile compiler,
dependency-closure planner, user authorization, complete retry/recovery protocol,
multi-graph/cross-service behavior, source round trips, rule-closure completeness,
bulk activation or performance. Those remain explicit acceptance work in
[model contracts](../testing/model-contracts.md) and the owning domain test plans.
