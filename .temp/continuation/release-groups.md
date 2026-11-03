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
  - 22ba6e31-30b9-4496-9367-7251ec8ad4c6
waiting: []
acceptance:
  tests:
    - 'Calendar precision survives mixed physical generation population, publication, current matching, API and display; stale or incomplete generations cannot compile precise ranges.'
    - 'Disclosure, redirect, date and producer changes invalidate stale group and child evidence; missing, unknown, conflicting and duplicate work links never fabricate dates or leak children.'
    - 'Reload/back navigation, filters, expansion, and both continuations preserve request meaning across all eight locales with accessible loading, repair, unavailable, empty, and terminal states.'
    - Native 1x/4x/16x release/work and high-fanout growth exercise every all-pool seek and preparation bound; absent execution remains unmeasured.
    - 'Inspect the landed page through the running app, Storybook or screenshots against the earlier-app bar, including contextual work/release cards and applicable current viewer state/actions in one bounded response; passing tests alone is insufficient.'
  workerOwned: true
estimate:
  lines: 2100
  files: 28
---

# Finish grouped release discovery

Complete the mixed discovery producer with the calendar successor codec. Its population, replay, reconciliation,
publication and continuing writes must use the matching projection, and precise range compilation must bind to the
active release and exact ready physical incarnation. Keep prior mappings, templates, codecs and physical generations
immutable.

Build the release journey on `POST /v1/subjects:search` and `/search/releases`. Read controls from facets admitted by
the active released subtype. Group current matching release children under canonical works, use independent bounded
group and child cursors, and recheck disclosure, redirects, dates and producer facts on every continuation. Never
infer complete groups from finite previews. Keep missing, unknown, conflicting and duplicate work links truthful.

Mount accessible URL-backed controls and contextual work/release cards in all eight locales. Preserve filters,
language order, sort, spoilers, reload/back navigation, expansion and both continuations. Include only existing
current viewer state and permitted owner actions in one bounded response. Cover loading, repair, unavailable, empty
and terminal states; keep native growth and physical seek bounds grounded in actual source contracts.

Finish native 1x/4x/16x first, next, final and empty-page measurements, preparation/resume and change invalidation
cases. Inspect the installed page through the running app, Storybook or screenshots against the earlier-app bar,
including keyboard use and repair states. Missing native execution remains explicitly unmeasured.
