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
  - 0fd46032-a6da-4e7f-a785-e71910491441
waiting: []
acceptance:
  tests:
    - "Calendar precision survives prepared physical generation population, publication, current matching, API and display; stale or incomplete generations cannot compile precise ranges."
    - "Disclosure, redirect, date and producer changes invalidate stale group and child evidence; missing, unknown, conflicting and duplicate work links never fabricate dates or leak children."
    - "Reload/back navigation, filters, expansion, and both continuations preserve request meaning across all eight locales with accessible loading, repair, unavailable, empty, and terminal states."
    - Native 1x/4x/16x release/work and high-fanout growth exercise every all-pool seek and preparation bound; absent execution remains unmeasured.
  workerOwned: true
estimate:
  lines: 1800
  files: 30
---

Connect `calendarFormatForReadyGeneration` to the resumable physical-generation lifecycle. Universal and mixed writers must populate the successor calendar codec while old mappings, templates, and writer shapes remain unchanged. Publish only after exact incarnation and UUID checks prove every required pool and partition complete; bind query continuations to the active release and physical generation, and refuse precise ranges before readiness or after replacement.

Finish the release reader on `POST /v1/subjects:search` and the `/search/releases` page. Source release types and platform, language, date, age-rating, developer, and publisher options from admitted facets in the active released subtype. Keep producer meanings distinct and make missing admission visible. Build canonical work groups from currently matching release children, with separate bounded group and child cursors. Recheck current work and release disclosure, redirects, dates, and producer facts on every continuation. Keep previews finite; show canonical work/release destinations with exact precision and platform, language, and producer summaries.

Keep controls URL-backed and accessible in all eight locales, including language order, sort, spoilers, reload/back navigation, expansion, and both cursors. Provide loading, repair, unavailable, empty, and terminal states.

Derive and test preparation and page bounds across all touched pools, including high fanout, sparse associations, rejected candidates, and unrelated growth. Record the requested native 1x/4x/16x measurements when infrastructure is available; otherwise leave native execution explicitly unmeasured.
