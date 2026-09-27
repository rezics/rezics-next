import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/operations.md', [
  {
    id: 'OPS01',
    scenario: 'Install fresh from pinned release manifest',
    requiredResult: 'Idempotent provisioning and required owner readiness.',
  },
  {
    id: 'OPS02',
    scenario: 'Principal host fails in two-host topology',
    requiredResult: 'Declared outage/manual-failover model; no invented quorum availability.',
  },
  {
    id: 'OPS03',
    scenario:
      'Restore graph, PostgreSQL Content/private/operations and object stores at matching and mixed cuts',
    requiredResult:
      'Exact Content references, history/payloads, preparation pins, receipts/outbox and authority/erasure reconcile. Missing revisions remain unavailable; unused newer bodies do not become adopted.',
  },
  {
    id: 'OPS04',
    scenario: 'Upgrade fails across format boundary',
    requiredResult: 'Qualified rollback/restore without mixed-format corruption.',
  },
  {
    id: 'OPS05',
    scenario: 'Vary workload dimensions and skew; run a named host workload',
    requiredResult:
      'Derived bounds and observed work agree under small multi-scale counterexamples; separately measure latency, lag, memory and recovery against the declared host profile. Record setup separately and qualify only the measured capacity scope.',
  },
  {
    id: 'OPS06',
    scenario: 'Saturate worker/broker/object budget',
    requiredResult: 'Backpressure and controlled admission; no silent loss.',
  },
  {
    id: 'OPS07',
    scenario: 'Rotate keys while sessions/jobs run',
    requiredResult: 'Audience/validity and retired-key policy enforced.',
  },
  {
    id: 'OPS08',
    scenario: 'Account placed remotely',
    requiredResult: 'Verify network/auth failure isolation and no private DB shortcut.',
  },
  {
    id: 'OPS09',
    scenario: 'Cold cache plus RDF body-projection and Lucene rebuild',
    requiredResult:
      'API/work budgets and storage headroom remain controlled; reconstruction uses exact Content/semantic sources before text readiness.',
  },
  {
    id: 'OPS10',
    scenario: 'Immutable graph erasure needs purge or sanitized compaction',
    requiredResult:
      'Suppression and physical destruction reported separately; affected exact references never retarget.',
  },
  {
    id: 'OPS11',
    scenario: 'Backup retains an erased payload before expiry or sanitization',
    requiredResult: 'Actual retention remains explicit; restore frontier blocks resurrection.',
  },
  {
    id: 'OPS12',
    scenario: 'Restored backup lacks later authority/erasure journal coverage',
    requiredResult: 'Protected access/effects remain offline pending authoritative reconciliation.',
  },
  {
    id: 'OPS13',
    scenario: 'Try to start another JVM on the active TDB2 directory',
    requiredResult:
      'Operational ownership prevents it; never bypass database locks to manufacture a replica.',
  },
  {
    id: 'OPS14',
    scenario: 'Run pinned graph quickstart through add, query, text, restart and delete',
    requiredResult:
      'Expected RDF/text bindings persist and then disappear; independent index deletion query does not mask stale entries.',
  },
  {
    id: 'OPS15',
    scenario: 'Crash leaves Lucene uncertain but TDB2 has a command receipt',
    requiredResult:
      'Reconcile RDF outcome; keep text unavailable until an empty replacement index is rebuilt and qualified.',
  },
  {
    id: 'OPS16',
    scenario: 'Rebuild with a changed analyzer or restore to a new state directory',
    requiredResult:
      'Exact assembler paths, pinned modules and generation/fence pair verified before activation; original data remains isolated.',
  },
]);
