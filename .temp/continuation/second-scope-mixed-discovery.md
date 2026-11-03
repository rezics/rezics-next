---
{
  'goal': 'search',
  'manager': 'search',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/search/discovery-filter.ts',
      'services/kernel/src/search/discovery-request.ts',
      'services/kernel/src/search/discovery-current.ts',
      'services/kernel/src/search/discovery-service.ts',
      'services/kernel/src/search/discovery-http.ts',
      'services/kernel/src/search/discovery-query.ts',
      'services/kernel/src/search/discovery-query.md',
      'services/kernel/test/search/second-scope-mixed-query.test.ts',
      'services/kernel/test/search/discovery-service.test.ts',
    ],
  'riskAreas': ['authorization', 'disclosure'],
  'criticalPath': false,
  'after': ['df29fac0-b261-407f-b5ca-84c529a99ce5'],
  'waiting': [],
  'acceptance':
    {
      'tests':
        [
          'One native mixed traversal executes public Collection/review/Space queries with Subject/Account using the delivered registry, strict common-generation documents and current hydration.',
          'Full text/kind semantics and three-valued catalogue predicates hold, including NOT; unavailable counts and withheld hydration never become false empty success.',
          'Native first/next/final pages preserve full-key deterministic order, exact current exclusion and opaque principal/generation ownership across withdrawals.',
        ],
    },
  'estimate': { 'lines': 700, 'files': 9 },
}
---

Finish native mixed discovery for all five registered kinds. Use Search's shared hit and summary union, registry,
generation reader and strict document codec once they are available on the bound source. Adapt the Commerce Collection
source, Content review source and Community Space source; keep each owner's public eligibility and summary hydration
checks current before Search publishes. Preserve the existing request, cursor, Search/Home finish and close invocation.
Collection raw batches continue at the last examined full key, short raw batches exhaust, and census or unverifiable
dynamic Publication witnesses remain unavailable. Keep new metadata kinds limited to text/kind; preserve three-valued
Subject-only conditions through NOT, deterministic full-key ordering, exact withdrawal exclusion and principal,
generation and scope cursor binding. Add focused positive first/next/final-page tests once the shared Search assembly
is present, and update the query page to the installed behavior.
