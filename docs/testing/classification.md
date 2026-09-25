# Space and contextual classification acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| CTX01 | Use one Work/Main Version in two Realms and Zones | Shared identity; independent tags/ratings/adopted text. |
| CTX02 | Local reject with inherited Global acceptance | Rejection suppresses; no absent-state fallback. |
| CTX03 | Local decision is unreadable or unavailable | Do not infer absence or reveal private state. |
| CTX04 | Same Path has different scoped Senses | Meanings remain independent and exact. |
| CTX05 | HairColor=Red versus bare Red | Separate propositions and judgment targets. |
| CTX06 | Union conflicting Realm rules before inference | Rejected plan; derivation stays context-bound. |
| CTX07 | Different same-language preferred names | Context label selection preserves SKOS export validity. |
| CTX08 | Cycle/reparent vocabulary concurrently | Profile topology remains valid without global corpus locks. |
| CTX09 | Retire a Sense used by old Applications | Old meaning remains resolvable; new use obeys admission. |
| CTX10 | Change one rule with many targets | Bounded invalidation/generation switch; no Resource x Realm rewrite. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.

The registered [CTX02 owner fixture](../../tests/qa/integration/public-selection-oracle.test.ts)
creates a real Work, Global decision and Realm classification context. Main's
classification resolution API first returns inherited Global acceptance, then
returns the local Realm rejection with its exact decision identity while the
Global resolution stays accepted. The Realm search result also loses the Work,
and another Realm remains unchanged. Selected integration
`20260925t183629-db4f16` passed; its CTX02 complete-case declaration awaits a
complete run.

The same real owner fixture now creates a Realm-local rejection over an accepted
Global decision, then injects two graph read faults at Main's read boundary. A
response with the local application but unreadable decision/outcome and a failed
read both return 503 from resolution and public classified search. Neither
response falls back to the Global acceptance or includes either decision ID or
the private failure text. Selected integration `20260925t194147-c1de17` passed;
CTX03 is declared for the final complete run. This does not exercise arbitrary
loss of all local application triples from a graph response.
