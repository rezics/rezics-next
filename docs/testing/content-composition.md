# Composition and history acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| COMP01 | Repeated content targets in one structure | Occurrence identities survive reorder and export. |
| COMP02 | Concurrent reparent creates potential cycle | One valid fenced transition or conflict. |
| COMP03 | Large stage fails halfway | Active generation intact; resume/cancel with checkpoint. |
| COMP04 | Change target/authority during staging | Activation revalidates and rejects stale basis. |
| COMP05 | Rebalance a dense sibling order | Bounded local work and stable occurrence IDs. |
| COMP06 | Remove occurrence with progress and source mapping | Tombstone/history remains resolvable. |
| COMP07 | Move ledger holding retained revision | History resolver/payload pins survive movement. |
| COMP08 | Export a multi-source fixed manifest | Completeness and exact positions are explicit; no fabricated global snapshot. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
