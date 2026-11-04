---
{
  'goal': 'commerce',
  'manager': 'commerce',
  'kind': 'interface',
  'paths':
    [
      'apps/web/src/library/progress-reads.ts',
      'apps/web/src/library/progress-server.ts',
      'apps/web/src/library/progress-page.tsx',
      'apps/web/src/routes/library/progress.index.tsx',
      'apps/web/tests/progress-address.test.tsx',
      'apps/web/tests/progress-index-current-origin.test.tsx',
      'apps/web/src/stories/library-progress-discovery.stories.tsx',
      'docs/library-progress-discovery.md',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'account', 'deletion'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'estimate': { 'lines': 280, 'files': 8 },
  'acceptance':
    {
      'tests':
        [
          'Use the actual installed public progressSessionDiscovery.get callable for owner-wide and typed-filter reads; derive request and response types from it and preserve exact Subject-only reads and the native editor.',
          'Preserve full predicate, current viewer/client, locale, origin, cursor and operation generation through receiving, reset, retries and stale recovery.',
          'Preserve distinct owner/filtered empty, signed-out, retired, stale, concealed-context and dependency-unavailable states, repeated session IDs and response-owned allowed actions.',
          'Run changed-workspace typing and focused changed tests; leave frozen native and rendered acceptance to the controller and Web.',
        ],
      'failing': true,
      'workerOwned': true,
    },
}
---

Finish the existing Progress index through the Content-published generated method. Read docs/library-progress-discovery.md. The retained installed declaration omits progressSessionDiscovery; the runtime proxy is not a typed publication. Keep the existing explicit unavailable branch until official delivery, then map bounded native rows without substitute reads or private types. Preserve the existing subject-only reader, editor and currentness controls. Missing publication is unfinished integration, not a tool blocker. Content has the precise mounted query/response handoff. Do not restart predecessors or run generation.
