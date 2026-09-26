# Graph records, shapes and history resolution

## Namespaces and identity

Native identity expands to `https://rezics.com/id/{uuid}`. The JSON-LD compact
prefix `rezics` may represent that namespace. Vocabulary terms use
`https://rezics.com/vocab/` and the distinct prefix `rezics-vocab`; never bind one
prefix to both meanings in the same JSON-LD context. JSON-LD context documents are versioned,
reviewed artifacts with captured bytes; ordinary input cannot redefine protected
terms, writer ownership or query policy through a remote context.
They are distinct from the shared semantic Context Resources below.

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
| Shared Context | Resource ID, lifecycle/disclosure, semantic and preference component heads, exact optional base and scoped DefinitionRefs | No mandatory Realm parent. Semantic and preference revisions are independent; immutable definitions never retarget. |
| Context selection | Consumer, admitted object/relation/domain/default scope, exact published semantic revision, independent optional preference revision, selection revision | Many consumers may reference one Context. Consumer authority is separate from Context editing; private principal selections are Access-owned. |
| Concept | Shared Resource ID, exact meaning definition, optional scheme membership, name records | Identity independent of label/navigation; no capability grant from type or compulsory companion identities. |
| Statement | ID, exact target grain, speaker, relation/applied interpretation DefinitionRefs, resource/value, qualifiers, selected semantic Context revision, provenance, lifecycle/revision | Source records remain independent; canonical meaning groups only compatible claims, without asserting acceptance or using viewer defaults. |
| Relation occurrence | ID, domain profile, participant roles, release/time/canon applicability, exact revision | Repeated participants retain separate occurrences; all role predicates bind the same occurrence. |
| Decision | ID, exact statement or qualified fact slot, context/policy revision, outcome, evidence, predecessor | One selected decision head per admitted slot; absence differs from rejection. |
| RatingObservation | ID, context, target, counting handle, slot, value/scale/time | Feature-specific uniqueness and exact question basis. |
| Occurrence | ID, structure, parent, order, target/selection policy | Repeated targets have distinct occurrences; parent belongs to same structure. |
| SourceObservation | ID, source-record identity, capture reference, coverage/profile/time | Failure or missing field never masquerades as complete observation. |
| OperationReceipt | ID, idempotency scope/key/digest, outcome, result refs, dataset/epoch/sequence | Same key/digest replays one effect; different digest conflicts. |
| OutboxBatch | ID, dataset/epoch/sequence, event count and bounded event references | One batch accompanies each sequenced mutation; zero-event batches still advance the relay safely. |

The planned [editorial records](../contracts/editorial-protection.md#record-contracts)
extend these anchors with control/protection history, exact correction proposals,
review decisions and unique applications. Their current heads share the target's
owner; ordinary writes cannot add predicates to an existing immutable anchor or
delete its protection link. Acceptance reuses the applicable selection/decision
record rather than creating a parallel authority.
[Assessment records](../contracts/information-verification.md#quality-dimensions-and-records)
bind exact evidence/method/source-rating state; QualitySummary is a rebuildable
projection with a complete declared dependency basis. Generate these profiles
from model IR when implemented; no new class, shape or runtime support is implied
by this blueprint. Ordinary accepted values retain their direct predicates.

## Contextual example

This target-profile Turtle describes a Statement and independent contextual
decisions without asserting a global `Work -> Concept` claim. Example IDs are
descriptive; production allocation uses the native ID contract. The exact
replacement shapes/operations remain to be generated and qualified; installed
classification v1 still uses its retained Application/Sense profile.

```turtle
@prefix ex: <https://example.org/rezics-design/> .
@prefix rezics-vocab: <https://rezics.com/vocab/> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix schema: <https://schema.org/> .

ex:work a schema:CreativeWork ; rezics-vocab:mainVersion ex:main .
ex:main a rezics-vocab:MainVersion ; rezics-vocab:work ex:work .
ex:science-fiction a skos:Concept ; skos:prefLabel "Science fiction"@en .
ex:statement a rdf:Statement ;
    rdf:subject ex:main ;
    rdf:predicate rezics-vocab:classifiedAs ;
    rdf:object ex:science-fiction ;
    rezics-vocab:definitionRevision ex:classification-definition-v1 ;
    rezics-vocab:interpretationDefinition ex:science-fiction-definition-v2 ;
    rezics-vocab:semanticContextRevision ex:shared-genre-context-v3 ;
    rezics-vocab:speaker ex:author .

ex:decision-a a rezics-vocab:Decision ;
    rezics-vocab:statement ex:statement ;
    rezics-vocab:acceptanceContext ex:realm-a-classification ;
    rezics-vocab:outcome rezics-vocab:Accepted .
ex:decision-b a rezics-vocab:Decision ;
    rezics-vocab:statement ex:statement ;
    rezics-vocab:acceptanceContext ex:realm-b-classification ;
    rezics-vocab:outcome rezics-vocab:Rejected .
```

An effective-result projection retains target, context, resolved policy, source
decision and rule generation. It may expose convenient selected predicates inside
a qualified context dataset. It cannot discard that scope and become a new global
fact. Query compilation chooses target grain consistently across classification,
rating and selected full-text units; an explicit relation is needed to compare
a Work-level claim with MainVersion-level content.

Group equivalent qualified meanings only in the read projection. Retain
supporting Statement IDs, exact Decision basis and distinct relation occurrences.
Navigation groups and summary avatars use the existing presentation/media owners;
they create no parallel fact authority. See
[aggregation](../contracts/search.md#statement-aggregation).

### Shared Context selections and differing interpretations

The target Context profile stores semantic and preference components separately.
Its finite semantic entries reference exact existing DefinitionRefs and one pinned
base revision where applicable. Context-specific criteria can share a common
concept Resource while remaining different qualified meanings. A separately named
concept may reference an existing criterion; creating it does not remove or
rewrite the original concept's scoped interpretations.

Realm A and Realm B can both select `shared-genre-context-v3`, while an individual
selects another Context for personal statements about the same object. Store
public Realm selections in the graph and private principal selections in Access.
Neither is the statement's acceptance decision. The statement pins its speaker,
applied definitions and actual semantic revision; a subsequent selection edit
does not rewrite it. Context edits and each consumer adoption have separate
authority, CAS heads, immutable manifests and receipts. No Cartesian resource/
Context/consumer projection or compulsory per-term Sense record is created.

The fields in these examples are proposed IR inputs, not generated runtime
vocabulary. Define and qualify their exact cardinality, visibility and command
profile before admitting writes. A qualified meaning cannot lose its definition
reference when exported or materialized as an unqualified global predicate.

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

REZICS uses one component-history contract with two storage adapters: Content
revisions/manifests and bounded body bytes in PostgreSQL; semantic revision
metadata in TDB2 with sealed payloads/manifests in object storage. The table below
is their common logical format, not a requirement to store Content history twice.
TDB2 provides current
RDF storage and transactional snapshots; its MVCC/internal file generations are
not an addressable permanent revision log. A revision has the following format:

| Part | Required meaning |
| --- | --- |
| Anchor | Stable revision UUID/IRI, owning component/resource, originating operation, predecessor anchor(s), model and shape references. |
| Manifest | Immutable format-versioned bytes listing component scope, exact payload roots, digest algorithm/value, sizes, encoding/media types, and any exact dependent revision references. |
| Payload | Complete exact component state in the declared format, including stable occurrence/block IDs, typed/language literals and selection modes. Large content may reference separately retained immutable byte objects. |
| Activation | Owner-local receipt binding anchor/result to its owner source position; anchor metadata retains that original position after replay-receipt expiry. Content head/revision/receipt commit in PostgreSQL; semantic head/revision/receipt commit in TDB2. Graph publication of Content is a separate adoption step. |

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

For semantic components, prepare/verify immutable objects, then atomically insert anchor metadata and
activation evidence with the current head and command receipt. A prepared object
or staged manifest without activation is not a visible revision. Its URI/digest
cannot be presented as proof that publication succeeded.

Dispatch exact resolution to the component's logical owner behind one typed API.
The semantic adapter reads authoritative metadata through Fuseki and verifies
the referenced immutable objects. The Content adapter reads its authoritative
PostgreSQL revision, manifest and bounded retained bytes/pages. Apply current
disclosure/erasure policy and verify format, component binding and digests in both.
Batch resolution by owner with fixed item/byte limits; no per-result lookup loop.
Public revision IDs do not encode the physical database or host. Owner routing is
trusted metadata, not caller authority.
Never reconstruct an old revision from the current projection or silently follow
HEAD. Return pending only for an explicitly staged operation; a missing committed
payload is unavailable/corrupt and enters recovery. A derived locator/cache may
accelerate resolution but can be rebuilt from anchor metadata and verified objects.

Retained anchors pin their transitive payload/manifests and exact dependencies.
TDB2 compaction retains ordinary revision RDF records still in the current dataset;
object GC and Content retention separately follow complete fenced reachability
and retention policy, including unresolved publication pins.
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
    "interpretation": {
      "resource": "shared-context-ref",
      "semanticRevision": "context-semantic-revision-ref"
    },
    "acceptance": "decision-scope-ref",
    "preferenceRevision": "preference-revision-ref",
    "rating": "rating-context-ref",
    "publication": "selection-context-ref"
  },
  "where": {
    "all": [
      { "statement": {
        "predicate": "relation-definition-ref",
        "definitionRevision": "meaning-revision-ref",
        "interpretationDefinition": "applied-definition-ref",
        "value": { "resource": "concept-ref" }
      } },
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
Response metadata exposes the resolved meaning and readable selection basis.
Preference changes may alter ordering without changing the applied definition.
Saved exact filters and authored statements do not track a consumer's later
default silently; missing selected dependencies remain unavailable.
