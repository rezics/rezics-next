# Recommendation generation acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| REC01 | Build candidate ranking from private/source signals | Only admitted data and declared population participate. |
| REC02 | One target receives extreme activity | No global exact-counter bottleneck or unbounded per-event fan-out. |
| REC03 | Fail second ranking generation | First valid active generation remains. |
| REC04 | Stale worker resumes | Cannot activate or overwrite newer generation. |
| REC05 | Candidate becomes private/erased after ranking | Delivery excludes it without leaking counts/reasons. |
| REC06 | Cursor references expired generation | Explicit restart; no mixed-order pagination. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
