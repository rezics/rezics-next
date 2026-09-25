# Cross-service acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| SYS01 | Agent provisioning succeeds only in one owner | Pending explicit state; retry/compensate without authority leak. |
| SYS02 | Jena commit succeeds but response is lost | Receipt lookup/retry returns same effective result. |
| SYS03 | Unrelated transaction advances the dataset sequence | Cannot falsely report own failed CAS as successful. |
| SYS04 | Outbox publishes and consumer crashes before ACK | Duplicate delivery produces one durable effect. |
| SYS05 | Broker retention expires before consumer checkpoint | Gap detected and reconciled/rebuilt. |
| SYS06 | Revoke principal during import/export/install | Current fences constrain activation/delivery. |
| SYS07 | Erase then restore older stores and replay events | Erasure frontier prevents resurrection. |
| SYS08 | Move owner partition with old workers | Routing and lease epochs reject old writes. |
| SYS09 | Object upload succeeds but graph activation fails | Safe staged orphan cleanup; no broken published reference. |
| SYS10 | Conditional Fuseki Update returns 200/204 with no matching guard | Own receipt determines outcome; unrelated sequence progress cannot produce success. |
| SYS11 | Delayed update races terminal cancellation/rejection | Same receipt identity admits one winner; strong revocation waits for durable sealing/reconciliation. |
| SYS12 | Outbox contains zero-event batches or retention gaps | Batch counts and contiguous epoch/sequence prove coverage; missing retained work requires recovery. |
| SYS13 | Restore loses a later receipt while a client retries its old command | New data epoch rejects unproved old intent; external effects reconcile before replay. |
| SYS14 | Two requests use the same idempotency key with different digests | One recorded outcome; the conflicting digest never rewrites or replays another request. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.

The isolated `authenticated-api-journey.test.ts` fixture is the S2 API boundary
case. It obtains a real Account OAuth token, provisions scoped Access grants,
and uses Main HTTP commands for Work, native Contribution publication, two Realm
classification contexts, PostgreSQL Content draft/publication/eligibility,
search, edit and exact prior-revision reads. Its live QA result is pending the
coordinator's merged integration batch; provisioning grants in the disposable
Access database does not substitute for command admission or receipts.
