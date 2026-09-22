# Historical model-profile engine evidence

Retained 2026-09-23. The measurements below used reference Python validators and
the now-retired Fluree engine. They are not Jena SHACL, Fuseki guarded-update or
production validation results. Original versions, counts and artifacts remain
unchanged for traceability; do not describe the 69 checks as Jena acceptance.

The [current implementation](../implementation/model-profile-validation.md) validates
the complete affected candidate graph/focus against a coherent read snapshot and
then guards every dependency in the conditional SPARQL update. Reference validation
or an explicitly integrated jena-shacl path needs its own qualification. Ordinary
Fuseki Update does not automatically enforce SHACL; Fluree inline wrappers and
OverrideAll/OverrideNone configuration have no direct Jena equivalents.

## Executed 2026-09-22 evidence

The [reproducible probe](../../scripts/research/model_profiles/README.md) ran on
2026-09-22 with Python 3.14.7, pySHACL 0.40.1, RDFLib 7.6.0, OWL-RL 7.6.2 and
Fluree 4.2.1. Its [retained result](../../scripts/research/model_profiles/evidence.json)
records actual versions, binary/script/shape digests, observations and 69 successful
expectation checks: 21 reference SHACL fixtures, two additional reference semantic
checks, 21 matching Fluree file validations, and 25 transaction/report checks.

Successful expectation checks include deliberate counterexamples. They are not
69 successful production features:

| Historical observed result | Historical interpretation / remaining lesson |
| --- | --- |
| Independent same-language Label nodes, repeated ListItem targets and open multi-type resources conform; conflicting preferred labels and invalid vote values fail. | Standard types plus profile constraints cover these distinctions. |
| An OWL functional property equates two distinct named objects; two differently targeted anchors both conform. | Database uniqueness and sealed-state immutability remain command/transaction invariants. |
| Removing the class target bypasses its ordinary shape; editing only a child commits while a later full report identifies an invalid parent. | Required focus cannot be inferred solely from post-state types or directly modified subjects. |
| Inline check wrappers reject that child edit and type-removal case with NodeConstraint violations, and create no receipt; a valid change commits with one receipt. | This supported the former Fluree wrapper design; it does not select a Jena mechanism. |
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
