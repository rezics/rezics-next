# Graph records, shapes and history resolution

## Namespaces and identity

Native identity expands to `https://rezics.com/id/{uuid}`. The JSON-LD compact
prefix `rezics` may represent that namespace. Vocabulary terms use
`https://rezics.com/vocab/` and the distinct prefix `rezics-vocab`; never bind one
prefix to both meanings in the same context. Context documents are versioned,
reviewed artifacts with captured bytes; ordinary input cannot redefine protected
terms, writer ownership or query policy through a remote context.

Use direct typed predicates for ordinary state; identified records below carry
independent meaning/lifecycle. Names in the table identify application interfaces,
not a requirement for one local RDF class per row. The
[model profiles](../contracts/model-profiles.md) select native types and properties;
the model IR fixes their exact declaration before generation.

| Record | Required identity and fields | Persisted invariant |
| --- | --- | --- |
| Work | ID, continuity profile, lifecycle, MainVersion reference | One active native main-version identity per admitted Work scope. |
| MainVersion | ID, Work, selection-policy revision, current composition/adoption head | Head changes by expected-version command, not arbitrary graph replacement. |
| Contribution | ID, kind/language, author Agent, applicability, current draft/published heads | Same-language alternatives coexist; contributor control independent of adoption. |
| RevisionAnchor | ID, component/owner reference, predecessor, originating operation, model/shape revision, immutable manifest reference | Exact payload meaning never retargets; visibility begins with its committed activation receipt. |
| Space | ID, lifecycle and admitted capability references | Realm/Zone configuration independently owned and retired. |
| ContextPolicy | ID, role, governance authority, definition revision, fallback dependencies | Role is explicit and fallback graph cycle-free. |
| Concept | ID, meaning definition, scheme membership, name records | Identity independent of path/label; no capability grant from type. |
| Expression | ID, kind, typed argument roles and canonical proposition key | Semantic arguments remain exact; display form independently revisioned. |
| Application | ID, target grain, expression/sense, context, source/proposer | Application existence differs from accepted/rejected decision. |
| Decision | ID, application, context/policy revision, outcome, evidence, predecessor | One selected decision head per admitted slot; absence differs from rejection. |
| RatingObservation | ID, context, target, counting handle, slot, value/scale/time | Feature-specific uniqueness and exact question basis. |
| Occurrence | ID, structure, parent, order, target/selection policy | Repeated targets have distinct occurrences; parent belongs to same structure. |
| SourceObservation | ID, source-record identity, capture reference, coverage/profile/time | Failure or missing field never masquerades as complete observation. |
| OperationReceipt | ID, idempotency scope/key/digest, outcome, result refs, dataset/epoch/sequence | Same key/digest replays one effect; different digest conflicts. |
| OutboxBatch | ID, dataset/epoch/sequence, event count and bounded event references | One batch accompanies each sequenced mutation; zero-event batches still advance the relay safely. |

## Contextual example

This Turtle describes accepted and rejected contextual applications without
flattening either into a global `Work -> Concept` claim. Example IDs are descriptive
for readability; production allocation uses the native ID contract.

```turtle
@prefix ex: <https://example.org/rezics-design/> .
@prefix rezics-vocab: <https://rezics.com/vocab/> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix oa: <http://www.w3.org/ns/oa#> .
@prefix schema: <https://schema.org/> .

ex:work a schema:CreativeWork ; rezics-vocab:mainVersion ex:main .
ex:main a rezics-vocab:MainVersion ; rezics-vocab:work ex:work .
ex:science-fiction a skos:Concept ; skos:prefLabel "Science fiction"@en .
ex:expression a rezics-vocab:Expression ;
    rezics-vocab:concept ex:science-fiction .

ex:application-a a oa:Annotation ;
    oa:motivatedBy oa:classifying ;
    oa:hasTarget ex:main ;
    oa:hasBody ex:expression ;
    rezics-vocab:classificationContext ex:realm-a-classification ;
    rezics-vocab:decisionHead ex:decision-a .
ex:decision-a rezics-vocab:outcome rezics-vocab:Accepted .

ex:application-b a oa:Annotation ;
    oa:motivatedBy oa:classifying ;
    oa:hasTarget ex:main ;
    oa:hasBody ex:expression ;
    rezics-vocab:classificationContext ex:realm-b-classification ;
    rezics-vocab:decisionHead ex:decision-b .
ex:decision-b rezics-vocab:outcome rezics-vocab:Rejected .
```

An effective-result projection retains target, context, resolved policy, source
decision and rule generation. It may expose convenient selected predicates inside
a qualified context dataset. It cannot discard that scope and become a new global
fact. Query compilation chooses target grain consistently across classification,
rating and selected full-text units; an explicit relation is needed to compare
a Work-level claim with MainVersion-level content.

## Shape and transaction responsibilities

Generate the admitted SHACL Core/SPARQL profile. The Fuseki command module
validates the declared focuses over the listed named graphs of the post-state,
inside the writing transaction. Neither a stored shape nor Fuseki's optional
`/shacl` operation is automatic enforcement on updates.
[Validation blueprint](model-profile-validation.md) owns focus selection and
validation coverage. Preserve three boundaries:

1. A shape validates the supplied dataset, not an unreachable remote owner.
2. Exact heads, uniqueness and absence predicates are guarded inside the same
   update that the module validates; an obsolete preflight check cannot authorize
   a commit.
3. Source profiles may preserve incomplete observations that native commands reject.
   Do not weaken native validity or merge source claims into the accepted graph.

All writers use the owning command path. Schema/config/admin operations require
separate privileged identities and cannot be reached by generic resource edits.
Track shape/profile digests with the command and revision. The
[transactional command endpoint](../storage/jena.md#transactional-command-endpoint) commits
projection changes, anchors, receipt and outbox, and validates them, in one TDB2 write transaction.
PostgreSQL, object uploads and subsequent HTTP requests are separate boundaries.

## Immutable revision representation

REZICS owns business history as retained application data. TDB2 provides current
RDF storage and transactional snapshots; its MVCC/internal file generations are
not an addressable permanent revision log. A revision has the following format:

| Part | Required meaning |
| --- | --- |
| Anchor | Stable revision UUID/IRI, owning component/resource, originating operation, predecessor anchor(s), model and shape references. |
| Manifest | Immutable format-versioned bytes listing component scope, exact payload roots, digest algorithm/value, sizes, encoding/media types, and any exact dependent revision references. |
| Payload | Complete exact component state in the declared format, including stable occurrence/block IDs, typed/language literals and selection modes. Large content may reference separately retained immutable byte objects. |
| Activation | Same-dataset receipt binding anchor/result to the application dataset ID, data epoch and sequence; anchor metadata also retains that original position after replay-receipt expiry. Current head/projection changes in that transaction. |

The initial digest profile is SHA-256 over the exact stored bytes. Serialization
format/version is pinned; this is byte integrity, not a claim that semantically
equivalent RDF serializations share a hash. A payload cannot depend on fetching a
mutable JSON-LD context. Capture the admitted context/model bytes and preserve
source lexical residuals where the profile requires them. Allocate anchor IDs
before activation; no native database commit hash is required.

Small components use one immutable payload plus a manifest. For large compositions,
use immutable bounded pages under a root manifest: interior pages contain ordered
child references/ranges/counts and leaf pages contain identified records. A bounded
edit copies affected leaves and ancestor pages and reuses unchanged pages. Enforce
fan-out/page-size and traversal limits; whole replacements stage pages as a bounded
job. The root represents complete component state, so resolution does not replay
an unbounded predecessor/delta chain or copy the entire database per revision.
The page format and lookup ordering are pinned implementation artifacts.

The manifest states which references merely identify another resource and which
pin its revision. Only the latter seal external state; a fixed release traverses
and pins all selected transitive dependencies. Following a stable target does not
silently become a fixed snapshot. A multi-dataset manifest identifies independently
sealed dependencies and does not claim a globally atomic historical instant.

## Revision-anchor resolver

Prepare/verify immutable objects, then atomically insert anchor metadata and
activation evidence with the current head and command receipt. A prepared object
or staged manifest without activation is not a visible revision. Its URI/digest
cannot be presented as proof that publication succeeded.

Resolve an exact anchor by reading its authoritative metadata through Fuseki,
applying current disclosure/erasure policy, fetching the immutable manifest and
required payload pages, and verifying their format, component binding and digests.
Never reconstruct an old revision from the current projection or silently follow
HEAD. Return pending only for an explicitly staged operation; a missing committed
payload is unavailable/corrupt and enters recovery. A derived locator/cache may
accelerate resolution but can be rebuilt from anchor metadata and verified objects.

Retained anchors pin their transitive payload/manifests and exact dependencies.
TDB2 compaction retains ordinary revision RDF records still in the current dataset;
object GC separately follows complete fenced reachability and retention policy.
Erasure may make a retained reference unavailable and leaves the permitted audit
marker; it never retargets that ID to substitute content. Restore creates a new
revision from retained bytes after current validation. Physical relocation must
copy and verify the anchor registry and referenced objects before retiring the old
owner; receipt positions retain their original epoch/sequence.

This trades engine-native arbitrary-time queries for portable explicit component
history. Temporal domain observations remain ordinary modeled facts; historical
cross-component analytics need admitted manifests/materializations, not an assumed
SPARQL time-travel parameter. See [Main Version](../contracts/main-version.md) and
[structure history](../contracts/structure-history.md).

## Query request shape

The following is a REZICS descriptor design, not literal SPARQL syntax:

```json
{
  "contractVersion": "1",
  "resultGrain": "mainVersion",
  "context": {
    "classification": "context-ref",
    "rating": "rating-context-ref",
    "publication": "selection-context-ref"
  },
  "where": {
    "all": [
      { "effectiveConcept": "concept-ref" },
      { "rating": { "operator": "gte", "value": "8", "scale": "scale-ref" } },
      { "text": { "query": "example", "fields": ["selectedBody"], "language": "zh-Hant" } }
    ]
  },
  "order": [{ "field": "textScore", "direction": "desc" }],
  "page": { "size": 20 }
}
```

The compiler adds deterministic tie-break, server ceilings, current authority and
source/index snapshot requirements. It lowers effective context and full-text into
one admitted ARQ/SPARQL plan using jena-text. A caller cannot inject root policy, another dataset or a larger
candidate budget. Source position and result completeness are response metadata,
not inferred from the presence of 20 returned rows.
