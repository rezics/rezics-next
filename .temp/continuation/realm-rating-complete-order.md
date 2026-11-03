---
goal: content
manager: content
kind: implementation
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
after:
  - ad62e9df-8356-44ee-bd31-8a665d466bfc
  - 800447a2-241e-474c-af1c-953d5dd17067
waiting: []
paths:
  - services/kernel/src/rating/realm-rank*
  - services/kernel/src/rating/README.md
  - services/kernel/src/rating/cost-realm-order.md
  - services/kernel/db/rating/**
  - services/kernel/src/semantic/subject-source-key-pages.ts
  - services/kernel/src/semantic/search-source.ts
  - services/kernel/db/semantic/**
  - services/kernel/src/search/realm-rating-order.ts
  - services/kernel/src/search/service.ts
  - services/kernel/src/server.ts
  - services/kernel/test/rating/realm-rank-order*
  - services/kernel/test/rating/growth-realm-rank-source.test.ts
  - services/kernel/test/rating/support/growth-realm-rank-source-fixture.ts
  - services/kernel/test/search/second-scope-realm-rating.test.ts
estimate:
  lines: 2500
  files: 21
acceptance:
  tests:
    - 'Complete scored/unscored canonical Realm traversal uses native selected-question publication, current disclosure and coherent invalidation across pages.'
    - 'Three-scale native growth at 256/1024/4096 validates source-derived physical row, statement, transaction-control, memory and ordered-index bounds, including selected-question observations and the actual question_identity prefix.'
    - "Search consumes the producer's delivered method while retaining query admission, predicate semantics, cross-partition composition, useful-page accounting, public response and signed outer cursor."
---

Complete the native Realm scored and unscored canonical traversal used by Search. Keep the existing scored-only
`createRealmRankSource.page` compatibility port unchanged. Add a current, bounded Semantic capability for canonical
population and name generation, then add partition-local scored-descending and unscored name/ID seeks. Search must
remain `index_not_ready` until that capability is complete; do not scan every partition, add a second catalogue,
infer a provider from the Search consumer interface, or return an empty success.

The Search reader must compose the finite partition frontier through the producer's explicit method while keeping
request parsing, analyzer and Boolean behavior, filter admission, public projection and outer cursor ownership in
Search. Preserve score zero, prove unscored only with a complete successful native figure read, withhold below-
threshold figures, and require complete eligibility evidence before an inactive prior starts an all-unscored phase.
Reobserve selected-question revision/provenance, Realm authority, prior and figure publication, canonical meaning/name
generation, and source-home state; changes to name, prior, publication, access, redirect or ban must restart without
exposing a consumed hidden key.

Cover canonical name ties opposite UUID order, scored/unscored pages, an admitted predicate hit beyond the first
scored batch, missing figures/names, sparse denial, zero, and between-page name/prior/access changes. Reconcile growth
costs and EXPLAIN to source-derived selected-question and provenance reads, all transaction controls, memory, and the
real `(partition_no, question_id, population_id, question_identity, prior_generation, score, subject_id)` index prefix.
Keep standard and admitted custom question evidence distinct, preserve the installed publication writer, and obtain a
Performance review of the final source-derived cost terms before acceptance.
