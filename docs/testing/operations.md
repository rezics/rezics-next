# Deployment recovery and workload acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| OPS01 | Install fresh from pinned release manifest | Idempotent provisioning and required owner readiness. |
| OPS02 | Principal host fails in two-host topology | Declared outage/manual-failover model; no invented quorum availability. |
| OPS03 | Restore graph/private/object stores | Manifest dependencies, exact anchors and authority/erasure reconciled. |
| OPS04 | Upgrade fails across format boundary | Qualified rollback/restore without mixed-format corruption. |
| OPS05 | Run skewed practical-volume workload | Measure candidate/work growth, lag, memory and recovery on available hosts. |
| OPS06 | Saturate worker/broker/object budget | Backpressure and controlled admission; no silent loss. |
| OPS07 | Rotate keys while sessions/jobs run | Audience/validity and retired-key policy enforced. |
| OPS08 | Account placed remotely | Verify network/auth failure isolation and no private DB shortcut. |
| OPS09 | Cold cache plus index rebuild | API/work budgets and storage headroom remain controlled. |
| OPS10 | Immutable graph erasure needs purge or sanitized compaction | Suppression and physical destruction reported separately; affected exact references never retarget. |
| OPS11 | Backup retains an erased payload before expiry or sanitization | Actual retention remains explicit; restore frontier blocks resurrection. |
| OPS12 | Restored backup lacks later authority/erasure journal coverage | Protected access/effects remain offline pending authoritative reconciliation. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
