---
{
  'goal': 'commerce',
  'manager': 'commerce',
  'kind': 'implementation',
  'paths':
    [
      'packages/client/src/**',
      'services/kernel/test/library/progress-discovery-*',
      'apps/web/src/library/progress-reads.ts',
      'apps/web/src/library/progress-server.ts',
      'apps/web/tests/library-progress-discovery*',
      'apps/web/tests/progress-index-current-origin.test.tsx',
      'docs/library-progress-discovery.md',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'account', 'deletion'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'acceptance':
    {
      'tests':
        [
          'Consume the Content-owned generated progress discovery client signature in Web and render the owner-wide index through the typed client; keep dependency-unavailable distinct while that delivery is absent.',
          'Exercise native sessions across subjects and modes, bounded continuation, predicate changes, deleted anchors, membership changes, retirement and restore, owner credential changes, and existing command lost-acknowledgement recovery.',
          'Measure independent 64, 512 and 4096 session cases and derive inclusive bounded costs across every participating pool, including authorization, SQL, hydration, serialization, locks, dispatch, receipts, maintenance, retention and cleanup.',
          'Reconcile the six current-origin focused test failures against the base revision; preserve existing command authority and keep the combined focused Web command green for feature-caused changes.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 900, 'files': 8 },
}
---

Complete the typed client delivery after Content publishes the mounted discovery route. The current page and Kernel API
are implemented, but Web intentionally reports owner-wide and typed-filter reads unavailable until that generated route
exists; do not add raw fetch, casts, handwritten declarations, or a second generator.

Then finish the native API lifecycle and scale cases, price all participating pools with an inclusive bounded model,
and investigate the six failing current-origin tests against the base revision. Keep each session occurrence and
original receipt identity intact. Record whether the failures are pre-existing or caused by this discovery integration,
and fix only regressions introduced here.
