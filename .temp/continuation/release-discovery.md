---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/src/search/release-search*.ts
  - services/kernel/src/search/release-search.md
  - services/kernel/src/search/filter.ts
  - services/kernel/src/search/document.ts
  - services/kernel/src/search/source.ts
  - services/kernel/src/search/current-leaf.ts
  - services/kernel/src/search/http/routes.ts
  - services/kernel/src/search/service.ts
  - services/kernel/src/search/hits.ts
  - services/kernel/src/search/request-source-snapshot.ts
  - services/kernel/src/search/indices.ts
  - services/kernel/src/search/discovery-documents.ts
  - services/kernel/src/search/discovery-service.ts
  - services/kernel/src/search/generations.ts
  - services/kernel/src/search/indexer.ts
  - services/kernel/db/search/indices/*.json
  - services/kernel/db/search/templates/subjects-search-*.json
  - services/kernel/test/search/release-search*.test.ts
  - services/kernel/test/semantic/search-source.test.ts
  - services/kernel/test/semantic/scope-leaf-selection.test.ts
  - services/kernel/src/semantic/scope-leaf-selection.ts
  - packages/filter/src/filter.ts
  - packages/filter/src/calendar-date.ts
  - packages/filter/src/index.ts
  - packages/filter/test/release-date-range.test.ts
  - packages/client/src/kernel/search/*.d.ts
  - apps/web/src/search/release-search*.ts
  - apps/web/src/search/release-search*.tsx
  - apps/web/src/routes/search_.releases.tsx
  - apps/web/tests/release-search.test.tsx
  - apps/web/messages/*.json
riskAreas:
  - authorization
  - disclosure
criticalPath: false
after:
  - dae134b8-8345-4e65-931f-fdfb4ecfdb63
  - b1e06240-d4d3-4b6c-aae3-92cb5b8a60fb
  - 58b57961-357c-4384-973f-dc21c05faad8
  - c5c4dedd-60e6-4761-9014-3b80f41b0412
  - bb4bb409-31b5-455b-9062-c396e85cbbd8
  - 5152ab21-e646-4ba0-aef1-09fda8c43874
waiting: []
acceptance:
  tests:
    - 'Calendar precision survives prepared physical generation population, publication, current matching, API and display; stale or incomplete generations cannot compile precise ranges.'
    - 'Disclosure, redirect, date and producer changes invalidate stale group and child evidence; missing, unknown, conflicting and duplicate work links never fabricate dates or leak children.'
    - 'Reload/back navigation, filters, expansion, and both continuations preserve request meaning across all eight locales with accessible loading, repair, unavailable, empty, and terminal states.'
    - Native 1x/4x/16x release/work and high-fanout growth exercise every all-pool seek and preparation bound; absent execution remains unmeasured.
  workerOwned: true
estimate:
  lines: 1900
  files: 30
---

# Complete release discovery

Prepare calendar-precision projections through the existing resumable physical-generation lifecycle. Keep old
mappings, templates, and writer shapes immutable. Make universal and mixed producers write the successor codec, and
allow precise date compilation only after the exact physical incarnation proves complete population and readiness.
Bind every continuation to the active release and physical incarnation.

Mount the reader on `POST /v1/subjects:search` and the normal `/search/releases` page. Read platform, language,
date, rating, developer, and publisher controls from admitted facets in the active released subtype. Keep producer
meanings separate and propagate missing admission explicitly; record the Semantic configuration dependency before
enabling any additional producer control.

Build canonical work groups from currently matching release children with independent bounded group and child
continuations. Recheck current work and release disclosure, redirects, dates, and producer facts on every
continuation. Keep previews finite and never infer completion from a candidate page. Show canonical work and
release destinations with exact date precision and platform/language/producer summaries.

Make controls URL-backed and accessible across all eight locales. Preserve language order, sort, spoilers, reload
and back navigation, expansion, and both cursors. Cover loading, repair, unavailable, empty, and terminal states.

Derive per-step preparation bounds from raw source caps, bounded leaf/association fanout, complete dependencies,
owner-call bounds, writes/visibility/frontiers, transaction controls, physical rows and bytes across every touched
pool. Derive each page bound from installed work/release keys, candidate refreshes, independent child seeks, and
final authority/dependency observations. Prove rejected candidates cannot cause population-dependent refill and
keep high fanout, sparse associations, and unrelated source growth inside the limits.

Exercise native 1x/4x/16x first, next, final, and empty pages; deep, sparse, and rejected candidates; high work
fanout; preparation and resume; generation replacement; lost responses; current relation/date/disclosure/redirect
changes; and final dependency rejection. Record actual statement/control counts, physical rows, seeks, fetched bytes,
actions, and retained-memory work against the derived terms. Keep native execution explicitly unmeasured when it is
unavailable.
