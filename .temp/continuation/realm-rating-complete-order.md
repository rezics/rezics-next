---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'implementation',
  'riskAreas': ['authorization', 'disclosure', 'rights', 'deletion', 'account'],
  'criticalPath': false,
  'after': ['ad62e9df-8356-44ee-bd31-8a665d466bfc'],
  'waiting': [],
  'paths':
    [
      'services/kernel/src/rating/realm-rank*',
      'services/kernel/src/rating/README.md',
      'services/kernel/src/rating/cost-realm-order.md',
      'services/kernel/db/rating/**',
      'services/kernel/src/semantic/subject-source-key-pages.ts',
      'services/kernel/src/semantic/search-source.ts',
      'services/kernel/db/semantic/**',
      'services/kernel/src/search/realm-rating-order.ts',
      'services/kernel/src/search/service.ts',
      'services/kernel/src/server.ts',
      'services/kernel/test/rating/realm-rank-order*',
      'services/kernel/test/rating/growth-realm-rank-source.test.ts',
      'services/kernel/test/rating/support/growth-realm-rank-source-fixture.ts',
      'services/kernel/test/search/second-scope-realm-rating.test.ts',
    ],
  'estimate': { 'lines': 2600, 'files': 22 },
  'acceptance':
    {
      'tests':
        [
          'Complete scored/unscored canonical Realm traversal uses native selected-question publication, current disclosure and coherent invalidation across pages.',
          'Three-scale native growth at 256/1024/4096 validates source-derived physical row, statement, transaction-control, memory and ordered-index bounds, including selected-question observations and the actual question_identity prefix.',
          "Search consumes the producer's delivered method while retaining query admission, predicate semantics, cross-partition composition, useful-page accounting, public response and signed outer cursor.",
        ],
    },
}
---

Complete the native Realm scored and unscored canonical traversal for Search's existing reader. Preserve
`createRealmRankSource.page` as its scored-only compatibility port; it cannot stand in for complete ordering.

The inspected Semantic `SubjectSource` exposes bounded reads by known IDs and counts. Its ID-key traversal is a
rebuild path, not a current request-time canonical name seek. Search's `name_sort` key is presently held in Search
documents, while private Realm scores must remain outside the public index. The complete-order capability is
therefore absent on this base. Keep Search at `index_not_ready` until a current, bounded native capability supplies
the canonical population/name generation and ordered population seeks. Do not scan all partitions, add a second
catalogue, infer a provider from the consumer interface, or return an empty success.

Add compatible producer observations and bounded partition-local scored-descending and unscored name/id seeks.
Have Search's existing reader compose the finite partition frontier through the producer's delivered method,
without moving request parsing, text/analyzer/Boolean semantics, filter admission, public response or outer cursor
ownership. Keep Realm scope separate from rating population. Capture and reobserve meaning, canonical generation,
selected-question revision/provenance, Realm authority, prior/figure publication and source-home observations.
Use only a complete successful native figure read to prove unscored; preserve score zero, withhold below-threshold
figures and require a complete eligibility observation before an inactive prior yields an all-unscored phase.
Current Realm and Subject disclosure remains mandatory for empty and unscored traversal. A changed name, prior,
publication, access decision, redirect or ban must invalidate or restart without exposing a consumed hidden key.

Cover the connected outcomes named by the original brief, including canonical name ties opposite UUID order, a
scored/unscored mix across pages, an admitted predicate hit beyond the first scored batch, zero, missing names,
sparse denial, and name/prior/access changes between pages. Reconcile the growth fixture and EXPLAIN to the actual
selected-question reads and `(partition_no, question_id, population_id, question_identity, prior_generation, score,
subject_id)` prefix. Keep standard and admitted custom question evidence distinct, preserve the installed publication
writer, and ask Performance to review the source-derived cost terms before acceptance.
