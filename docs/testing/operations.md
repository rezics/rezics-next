# Deployment recovery and workload acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| OPS01 | Install fresh from pinned release manifest | Idempotent provisioning and required owner readiness. |
| OPS02 | Principal host fails in two-host topology | Declared outage/manual-failover model; no invented quorum availability. |
| OPS03 | Restore graph, PostgreSQL Content/private/operations and object stores at matching and mixed cuts | Exact Content references, history/payloads, preparation pins, receipts/outbox and authority/erasure reconcile. Missing revisions remain unavailable; unused newer bodies do not become adopted. |
| OPS04 | Upgrade fails across format boundary | Qualified rollback/restore without mixed-format corruption. |
| OPS05 | Vary workload dimensions and skew; run a named host workload | Derived bounds and observed work agree under small multi-scale counterexamples; separately measure latency, lag, memory and recovery against the declared host profile. Record setup separately and qualify only the measured capacity scope. |
| OPS06 | Saturate worker/broker/object budget | Backpressure and controlled admission; no silent loss. |
| OPS07 | Rotate keys while sessions/jobs run | Audience/validity and retired-key policy enforced. |
| OPS08 | Account placed remotely | Verify network/auth failure isolation and no private DB shortcut. |
| OPS09 | Cold cache plus RDF body-projection and Lucene rebuild | API/work budgets and storage headroom remain controlled; reconstruction uses exact Content/semantic sources before text readiness. |
| OPS10 | Immutable graph erasure needs purge or sanitized compaction | Suppression and physical destruction reported separately; affected exact references never retarget. |
| OPS11 | Backup retains an erased payload before expiry or sanitization | Actual retention remains explicit; restore frontier blocks resurrection. |
| OPS12 | Restored backup lacks later authority/erasure journal coverage | Protected access/effects remain offline pending authoritative reconciliation. |
| OPS13 | Try to start another JVM on the active TDB2 directory | Operational ownership prevents it; never bypass database locks to manufacture a replica. |
| OPS14 | Run pinned graph quickstart through add, query, text, restart and delete | Expected RDF/text bindings persist and then disappear; independent index deletion query does not mask stale entries. |
| OPS15 | Crash leaves Lucene uncertain but TDB2 has a command receipt | Reconcile RDF outcome; keep text unavailable until an empty replacement index is rebuilt and qualified. |
| OPS16 | Rebuild with a changed analyzer or restore to a new state directory | Exact assembler paths, pinned modules and generation/fence pair verified before activation; original data remains isolated. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.

The [editorial-protection matrix](editorial-protection.md) specializes OPS03/12
for backup-before-protection, exact correction/application coverage and stale
quality reconstruction, and OPS05/06 for bounded dependency/fan-out work. A fresh
epoch cannot reconstruct a missing restriction or qualify that restored target
as open. Earlier restore evidence does not qualify these additional records.
