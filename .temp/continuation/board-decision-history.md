---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'implementation',
  'paths':
    [
      'apps/web/src/moderation/workbench-history',
      'apps/web/src/moderation/workbench-history.md',
      'apps/web/src/moderation/workbench-queue/read.ts',
      'apps/web/src/moderation/workbench-queue/scope.ts',
      'apps/web/src/moderation/workbench-queue/view.tsx',
      'apps/web/src/routes/moderation/workbench.tsx',
      'apps/web/messages',
      'apps/web/tests/workbench-history.test.tsx',
      'docs/goals/web.md',
    ],
  'riskAreas': [],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'estimate': { 'lines': 650, 'files': 9 },
  'acceptance': 'Consume the actual delivered Content private board history method and complete the native list, decision detail, current-target, sparse cursor, disclosure retirement, and recovery journeys without inventing an endpoint or reconstructing history.',
}
---

# Remaining outcome

Complete the board decision-history journey once Content delivers its native private history reader. Let Content own
the method, row meaning, ordering, cursor and current disclosure. Show immutable submitted evidence and the original
decision separately from an independently readable current target. Continue only with the native opaque cursor,
preserve permitted historical metadata when the current target is hidden, and provide local detail plus existing case
or appeal destinations only when the native page supplies them and current access allows them. Retire pages, pending
delivery and retries when the board or session changes. Cover sparse pages with continuation and explicit preparing,
empty, denied, unavailable, stale and recovery states. Keep the current queue and decision actions unchanged.
