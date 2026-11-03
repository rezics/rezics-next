---
{
  'goal': 'search',
  'manager': 'search',
  'kind': 'implementation',
  'paths':
    [
      'apps/web/src/routes/search.tsx',
      'apps/web/src/search/search.tsx',
      'apps/web/src/search/search-params.ts',
      'apps/web/src/search/search-request.ts',
      'apps/web/src/search/search-queries.ts',
      'apps/web/src/search/use-search-query.ts',
      'apps/web/src/search/search-session-owner.ts',
      'apps/web/src/search/header-search/header-search.tsx',
      'apps/web/src/search/header-search/shell-search.tsx',
      'apps/web/src/search/advanced-scope.ts',
      'apps/web/tests/search-second-scope.test.tsx',
      'apps/web/src/search/README.md',
    ],
  'riskAreas': ['authorization', 'disclosure'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'acceptance':
    {
      'tests':
        [
          'Realm and Collection scope use the installed session-bound reader and survive ordinary GET submission, browser history, header submission and refinement without silently broadening to Global; removing scope starts an explicit fresh traversal.',
          'Invalid resource input remains correctable, native preparing/refused states remain visible, and changing principal, scope or effective condition retires old hits and opaque continuations.',
          'Installed ConditionEditor, Refinement, SearchSort and DiscoveryResults native capabilities render through one Search page wiring owner.',
        ],
    },
  'estimate': { 'lines': 650, 'files': 12 },
}
---

Finish the Search resource-scope journey after the session-bound reader/cache and native resource-population handoffs are delivered. Remove the Search route's fail-closed unavailable seam only when the authenticated request and principal cache owner are installed. Wire their typed inputs into the existing ConditionEditor, Refinement, SearchSort and DiscoveryResults exports through SearchPage. Keep the native Realm or Collection leaf in the existing filter grammar, preserve every navigation/refinement path, and never use display labels as authority. Do not recreate any of the native producers, component bodies, BFF or session/cache helpers owned by the handoff slices.
