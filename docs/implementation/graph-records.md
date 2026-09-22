# Graph records, shapes and history resolution

## Namespaces and identity

Native identity expands to `https://rezics.com/id/{uuid}`. The JSON-LD compact
prefix `rezics` may represent that namespace. Vocabulary terms use
`https://rezics.com/vocab/` and the distinct prefix `rezics-vocab`; never bind one
prefix to both meanings in the same context. Context documents are versioned,
reviewed artifacts with captured bytes; ordinary input cannot redefine protected
terms, writer ownership or query policy through a remote context.

Use direct typed predicates for ordinary state; identified records below carry
independent meaning/lifecycle. Illustrative names are implementation vocabulary
proposals whose exact declaration is fixed by the model IR before generation.

| Record | Required identity and fields | Persisted invariant |
| --- | --- | --- |
| Work | ID, continuity profile, lifecycle, MainVersion reference | One active native main-version identity per admitted Work scope. |
| MainVersion | ID, Work, selection-policy revision, current composition/adoption head | Head changes by expected-version command, not arbitrary graph replacement. |
| Contribution | ID, kind/language, author Agent, applicability, current draft/published heads | Same-language alternatives coexist; contributor control independent of adoption. |
| RevisionAnchor | ID, component/owner reference, originating operation, model revision | Exact meaning resolves to committed state and never retargets. |
| Space | ID, lifecycle and admitted capability references | Realm/Zone configuration independently owned and retired. |
| ContextPolicy | ID, role, governance authority, definition revision, fallback dependencies | Role is explicit and fallback graph cycle-free. |
| Concept | ID, meaning definition, scheme membership, name records | Identity independent of path/label; no capability grant from type. |
| Expression | ID, kind, typed argument roles and canonical proposition key | Semantic arguments remain exact; display form independently revisioned. |
| Application | ID, target grain, expression/sense, context, source/proposer | Application existence differs from accepted/rejected decision. |
| Decision | ID, application, context/policy revision, outcome, evidence, predecessor | One selected decision head per admitted slot; absence differs from rejection. |
| RatingObservation | ID, context, target, counting handle, slot, value/scale/time | Feature-specific uniqueness and exact question basis. |
| Occurrence | ID, structure, parent, order, target/selection policy | Repeated targets have distinct occurrences; parent belongs to same structure. |
| SourceObservation | ID, source-record identity, capture reference, coverage/profile/time | Failure or missing field never masquerades as complete observation. |
| OperationReceipt | ID, idempotency scope/key/digest, outcome and result refs | Same key/digest replays one effect; different digest conflicts. |

## Contextual example

This Turtle describes accepted and rejected contextual applications without
flattening either into a global `Work -> Concept` claim. Example IDs are descriptive
for readability; production allocation uses the native ID contract.

```turtle
@prefix ex: <https://example.org/rezics-design/> .
@prefix rezics-vocab: <https://rezics.com/vocab/> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .

ex:work a rezics-vocab:Work ; rezics-vocab:mainVersion ex:main .
ex:main a rezics-vocab:MainVersion ; rezics-vocab:work ex:work .
ex:science-fiction a skos:Concept ; skos:prefLabel "Science fiction"@en .
ex:expression a rezics-vocab:TagExpression ;
    rezics-vocab:concept ex:science-fiction .

ex:application-a a rezics-vocab:Application ;
    rezics-vocab:target ex:main ;
    rezics-vocab:expression ex:expression ;
    rezics-vocab:context ex:realm-a-classification ;
    rezics-vocab:decisionHead ex:decision-a .
ex:decision-a rezics-vocab:outcome rezics-vocab:Accepted .

ex:application-b a rezics-vocab:Application ;
    rezics-vocab:target ex:main ;
    rezics-vocab:expression ex:expression ;
    rezics-vocab:context ex:realm-b-classification ;
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

Generate SHACL Core where supported for required count, reference class/value
kind and local structure. Preserve three important boundaries:

1. A shape validates the elected staged dataset, not an unreachable remote owner.
2. Uniqueness/cycle/expected-head correctness must hold under concurrent admitted
   writes; a preflight validation against an obsolete head is insufficient.
3. Assertions may preserve incomplete source data in their source profile even
   when a native command would reject it. Do not weaken native validity to ingest it.

All writers use the owning command path. Schema/config/admin operations require
separate privileged identities and cannot be reached by generic resource edits.
Track shape/profile digest with the command and resulting revision anchor.

## Revision-anchor resolver

Create the business anchor ID and its originating operation in the same Fluree
transaction as the component change. The committed receipt/commit metadata locates
that operation. A derived resolver indexes anchor -> ledger/branch/commit/component
and verifies it against committed evidence. This avoids placing a commit's own
content hash inside its hash input or requiring a separate DB write to make the
business change valid.

If resolver indexing crashes, rebuild from the retained source or return pending;
never guess the latest head. Retention registers the commit/history/payload needs
of each admitted anchor. Until engine GC honors that contract, do not retire the
needed history. A relocation supplies a verified new resolver location or exact
preserved representation before removing the old source.

## Query request shape

The following is a REZICS descriptor design, not literal Fluree FQL syntax:

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
one Fluree plan. A caller cannot inject root policy, another dataset or a larger
candidate budget. Source position and result completeness are response metadata,
not inferred from the presence of 20 returned rows.
