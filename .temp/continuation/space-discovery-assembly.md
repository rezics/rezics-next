---
{
  'goal': 'search',
  'manager': 'search',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/search/discovery.ts',
      'services/kernel/src/search/discovery-hydration.ts',
      'services/kernel/src/search/account-discovery.ts',
      'services/kernel/test/search/second-scope-spaces.test.ts',
    ],
  'riskAreas': ['authorization', 'disclosure'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'acceptance':
    {
      'tests':
        [
          'The mixed native registry binds the Content Space adapter as a ready owner slot; missing or invalid native coverage remains typed readiness and never becomes an empty population.',
          'The shared generation and projection path consumes complete bounded Space pages and current authorized summaries, preserving Space identity, keyset positions, and lifecycle lag semantics.',
        ],
    },
  'estimate': { 'lines': 500, 'files': 4 },
}
---

Connect `nativeSpaceDiscoveryAdapter` to Search's existing mixed owner registry and generation writer. The current union has a `content/space` metadata slot, but the native page source, census, projection and current summary reader are not yet consumed by that common path. Keep the unavailable slot when producer coverage is absent, use one Space identity for Realm-backed Spaces, and validate owner observations before advancing the shared generation. Add a focused integrated test for ready and unavailable coverage, current public hydration, and delayed withdrawal/restoration. Do not add an endpoint, feed lane, or independent client-side merge.
