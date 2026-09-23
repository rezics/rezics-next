# Profile compilation, validation and command binding

Implement [the profile contract](../contracts/model-profiles.md) as one versioned
definition pipeline with separate vocabulary, validation, rule and operation
artifacts. This is a concrete implementation design; it does not claim that the
new application's compiler or domain services exist.

## Release artifact and compiler

For [S1 startup](../plan/README.md#fast-start-milestones), ship one reviewed authored
profile and pinned helper/shape artifacts. The complete reusable compiler below
is the growth design; implementing all seven definition families is not a
prerequisite for the first safe domain command. The same validation, versioning
and guard obligations apply to that small profile.

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
Core/approved SPARQL shapes, typed TypeScript boundary models and native bindings when consumed, command
validators/guard plans, trusted query/rule descriptors and mapping manifests.
Application source code still implements admitted algorithms and external effects;
the IR does not become an arbitrary code loader.

Every semantic constraint has one source constraint ID. Multiple lowerings of
that same invariant, such as preflight and transactional validation, retain the
same ID and comparison cases. Do not maintain unrelated handwritten copies of the
same rule in GUI, SHACL, application code and SQL. Cross-field or transactional code that cannot
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
Do not require unrelated reactions to compare-and-swap a shared target head. The
dataset source sequence is allocated inside TDB2's already serialized write
transaction; clients do not supply it as the expected revision of every aggregate. PostgreSQL uniqueness is local to its owner; it cannot supply
a foreign key or atomic receipt for a TDB2 mutation.

### Selected Jena candidate-validation mechanism

The first Main adapter validates a bounded candidate graph before a conditional
SPARQL Update. A pinned `jena-shacl` helper under Main's process lifecycle reads
only the supplied RDF and shape artifacts. It never opens the live TDB2 directory.
Start with a bounded local helper invocation using fixed arguments and task-owned
files; a persistent worker can later amortize JVM startup without changing the
protocol. This adds no public validator endpoint or database fork. Generated TypeScript
checks provide early diagnostics; they do not silently replace required SHACL.

1. Fetch the complete selected graph projection, required pre-state focus and read
   dependencies in one Fuseki request. If a bounded multi-request acquisition is
   necessary, bracket it with the application epoch/sequence and retry unless
   unchanged. Never treat unrelated remote requests as one transaction.
2. Apply the intended delta to this immutable candidate. Include referenced and
   reverse-dependent records required by the profile, with graph provenance kept
   explicit. Source, history and private graphs do not enter an automatic union.
3. Select required `(focus, shape, dataGraph)` pairs from both pre-state and
   post-state. Use generated explicit-target shape wrappers to validate each focus
   even if its type/target predicate was removed. Required shapes also constrain
   the semantic type when the active lifecycle requires it.
4. Run the pinned Jena SHACL validator against the candidate. Check expected shapes,
   focus coverage, completion and blocking severity; parse the report, not just
   the process exit code. Record manifest, helper/build, candidate digest and guard
   basis in private operation evidence. Timeouts or incomplete input reject or
   stage the operation; they are not a conforming report.
5. Send one trusted `DELETE/INSERT WHERE` through the configured text dataset.
   Guard each mutable read dependency, topology/uniqueness key, active model/shape
   generation, placement and data epoch, as well as receipt absence. The proposed
   projection, sealed revision, receipt and outbox share that transaction.
6. Read the operation's own receipt to resolve success or a concurrent guard loss.
   A lost response stays pending until reconciliation. External Access state uses
   the [admission bridge](authorization-bridge.md), not a fictional RDF guard on a
   private PostgreSQL row.

This is an optimistic validation protocol: a candidate is admissible only if
its complete validation basis is unchanged at commit. A negative read needs a
protected slot or collection generation; checking only records that happened to
exist cannot prevent a phantom insertion. Every writer affecting such a dependency
must advance its guard. If complete coverage cannot be established, reject/stage
the shape or add a separately qualified in-transaction server adapter.

For explicit focus, the helper can wrap each required shape with `sh:targetNode`
and `sh:node` in its transient shape graph. These are validator inputs, not
caller-selected RDF or permanent constraints on old receipt nodes. Do not rely on
a graph's self-declared `shapeRef` to choose its own rules. Detailed reports stay
behind disclosure policy because their paths and values can expose hidden data.

The [Jena SHACL documentation](https://jena.apache.org/documentation/shacl/index.html)
describes graph validation and an optional Fuseki report operation. Adding that
endpoint does not make ordinary SPARQL Update validate proposed state. Its graph
and target arguments also do not discover all reverse dependencies for Main.
The exact candidate/helper/guard composition remains a runtime acceptance gate.

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

## Jena binding and feature admission

| Boundary | Required implementation |
| --- | --- |
| Ordinary Fuseki Update / Graph Store writes | Do not automatically enforce application SHACL. Restrict native mutations to Main's validated command path; disable unused write surfaces. |
| Direct TDB2 loading | Bypasses text-index updates and command receipts. Use offline isolated loading, validate the resulting generation, build Lucene and activate only after checks. |
| SHACL data graph | The helper receives an explicitly assembled candidate, not a floating database union. Bound dependency coverage and preserve provenance. |
| Reasoning | TDB2 does not activate arbitrary RDFS/OWL/SHACL-AF rules merely by storing an ontology. Execute only admitted finite rules and record complete derived generations. |
| RDF syntax and values | Keep RDF 1.1 / JSON-LD 1.1 as the initial interchange profile. Pin parsers, preserve source lexical evidence and separately qualify optional syntax/extensions. |
| Remote transactions | One Fuseki request is one transaction boundary. Preparing a candidate or calling a report endpoint is a separate operation. |
| History | Validate restore against retained immutable component payloads and current policy. An application sequence does not permit historical TDB2 queries. |

Source basis: [Jena SHACL](https://jena.apache.org/documentation/shacl/index.html),
[remote transactions](https://jena.apache.org/documentation/rdfconnection/#remote-transactions),
[TDB2](https://jena.apache.org/documentation/tdb2/), and the selected
[storage binding](../storage/jena.md). Required feature combinations must be
qualified against the pinned release, not inferred from independent APIs.

## Model activation and delivery sequence

1. Implement the term/profile IR and candidate manifest, with separate vocabulary,
   shape, rule and command artifacts. Bootstrap direct Concept/Label/Annotation/
   ListItem profiles plus retained MainVersion/Context/Decision/Expression records.
2. Validate the artifacts and generated examples against a reference validator and
   the exact target engine. Reject namespace/constraint/inference mismatches.
3. Stage candidate schemas and revalidation/index work while the old manifest remains
   active. Define exact affected coverage and catch-up watermark. Do not edit an
   already referenced meaning in place.
4. Stop admission or use a qualified epoch guard while switching the active model/shape
   manifest under the dataset generation guard. Revalidate stale commands; preserve compatible
   old readers and exact historical interpretation. Cross-dataset activation is a
   staged procedure, never a fictional atomic pointer switch across stores.
5. Deliver MainVersion adoption, contextual classification and judgment operations
   with complete guard/receipt semantics. Add source reconciliation and other
   domain profiles using the same pipeline. Spatial execution keeps its existing
   later-stage activation boundary.

A model-owned immutable local shape replica is a generated artifact, not a second
independently editable authority. Prefer it at bootstrap over a floating latest
cross-dataset model reference. Rollback selects a compatible release and revalidates
current state; it must not restore revoked rights or erased payloads.

## Evidence and remaining qualification

The [prior model experiments](../research/model-profile-engine-evidence.md) retain
reference-validator and Fluree observations from 2026-09-22. They inform the
counterexamples for focus removal, affected parents, immutability and lost races.
They do not validate Jena, its candidate helper or the new transaction composition.

No Jena runtime experiment is reported by this documentation change. Qualification
must exercise the exact helper/build and Main-to-Fuseki path with incomplete
candidate acquisition, phantom dependencies, type removal, invalid reverse
parents, concurrent model changes, lost HTTP responses, bulk activation and
retained revision recovery. [Model acceptance](../testing/model-contracts.md)
and [backend integration](../testing/backend-integration.md) own those gates.
