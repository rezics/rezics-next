# Cross-service acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| SYS01 | Agent provisioning succeeds only in one owner | Pending explicit state; retry/compensate without authority leak. |
| SYS02 | Fluree commit succeeds but response is lost | Receipt lookup/retry returns same effective result. |
| SYS03 | Unrelated transaction advances ledger t | Cannot falsely report own failed CAS as successful. |
| SYS04 | Outbox publishes and consumer crashes before ACK | Duplicate delivery produces one durable effect. |
| SYS05 | Broker retention expires before consumer checkpoint | Gap detected and reconciled/rebuilt. |
| SYS06 | Revoke principal during import/export/install | Current fences constrain activation/delivery. |
| SYS07 | Erase then restore older stores and replay events | Erasure frontier prevents resurrection. |
| SYS08 | Move owner partition with old workers | Routing and lease epochs reject old writes. |
| SYS09 | Object upload succeeds but graph activation fails | Safe staged orphan cleanup; no broken published reference. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
