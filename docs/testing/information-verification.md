# Information verification acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| FACT01 | Two sources repeat one original claim | Dependency lineage prevents false independent corroboration. |
| FACT02 | AI output is re-ingested | Not treated as an independent authoritative source. |
| FACT03 | Counterevidence or missing source | Preserve disagreement/unknown; not automatic false. |
| FACT04 | Source corrected after assessment | Bounded invalidation and exact old assessment history. |
| FACT05 | Export to an independent evaluator | Claims/evidence/method/policy and losses remain inspectable. |
| FACT06 | Paid index result challenged | Funding cannot change verdict or suppress material correction. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
