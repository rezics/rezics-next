---
{
  'goal': 'search',
  'manager': 'search',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/search/service.ts',
      'services/kernel/src/search/scope-source.ts',
      'services/kernel/src/search/realm-scope.ts',
      'services/kernel/src/search/scope-preparation.ts',
      'services/kernel/src/search/scope-preparation-store.ts',
      'services/kernel/src/search/scope-preparation-ordered.ts',
      'services/kernel/src/search/scope-ordered-native.ts',
      'services/kernel/test/search/second-scope-realm.test.ts',
      'docs/search-conditions.md',
    ],
  'riskAreas': ['authorization', 'disclosure'],
  'criticalPath': false,
  'after':
    [
      'a3a15b66-ff20-47da-8e00-01381abffc64',
      'abb69dbc-1128-4ebb-8199-d464384d0320',
      'be2bbbad-c7d6-4635-aa59-ff5e7ca0ebec',
      '394fc56a-838d-477e-8193-398cc8712361',
      '24516db5-c748-4024-8ce0-bdad583e4b50',
      '800447a2-241e-474c-af1c-953d5dd17067',
      'b1e06240-d4d3-4b6c-aae3-92cb5b8a60fb',
      '58b57961-357c-4384-973f-dc21c05faad8',
    ],
  'waiting': [],
  'acceptance':
    {
      'tests':
        [
          'Complete finite retained preparation from the Content Realm prefix and full current catalogue evaluator; raw prefixes remain input only, with no unbounded refill or per-request budget transfer.',
          'Produce first/next/final canonical-name pages from indexed actual-name tuples after complete text/catalogue refinement; preserve three-valued authority and reobserve every dependency at final consumption.',
          'Add the named native discussion/review, protected-board grant, ban, withdrawal, hidden-reference, sparse-continuation, canonical-duplicate, redirect, text/filter, changed-meaning and changed-authority outcomes; run the 1x/4x/16x native growth check against the derived bound.',
        ],
    },
  'estimate': { 'lines': 1800, 'files': 9 },
}
---

# Complete retained canonical pages for readable Realm subjects

Continue the Search request integration from this worktree. The request-only Realm predicate now reaches the
registered service-bound Scope for preparation with the caller's actual reader options; even a
`population_ready` handle cannot produce a public page yet. Complete the reader path by consuming Content's finite
32-row prefixes into retained canonical identity preparation, refining the complete text/catalogue predicate,
and serving indexed actual-name tuple windows that fill each page or prove exhaustion. Keep `population_ready` as
preparation input only and keep unknown or withheld resource evidence unavailable under NOT and OR.

Content still owns the live disclosure/maintenance composition. Use its documented `RealmSubjectSource` once that
adapter is available; do not add another producer or infer membership from structural census rows. Add the actual
native outcomes and the three-scale growth acceptance together with the connected Search path. A missing native
capability remains typed unavailability, and native measurements remain unmeasured until the connected source is
installed.
