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
  - services/kernel/src/search/discovery.ts
  - services/kernel/src/search/generations.ts
  - services/kernel/src/search/indexer.ts
  - services/kernel/src/search/account-discovery.ts
  - services/kernel/src/search/discovery-filter.ts
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
  - 99299f65-9aa3-48fc-b353-c2ba5b06a60c
waiting: []
acceptance:
  tests:
    - 'Calendar precision survives prepared physical generation population, publication, current matching, API and display; stale or incomplete generations cannot compile precise ranges.'
    - 'Disclosure, redirect, date and producer changes invalidate stale group and child evidence; missing, unknown, conflicting and duplicate work links never fabricate dates or leak children.'
    - 'Reload/back navigation, filters, expansion, and both continuations preserve request meaning across all eight locales with accessible loading, repair, unavailable, empty, and terminal states.'
    - Native 1x/4x/16x release/work and high-fanout growth exercise every all-pool seek and preparation bound; absent execution remains unmeasured.
    - 'Inspect the landed page through the running app, Storybook or screenshots against the earlier-app bar, including contextual work/release cards and applicable current viewer state/actions in one bounded response; passing tests alone is insufficient.'
  workerOwned: true
estimate:
  lines: 2250
  files: 31
---

# Find matching releases in canonical work groups

Wire the mixed calendar successor through the existing resumable publication lifecycle. Population, replay,
reconciliation and continuing writes must select the format-3 writer for its mapping, while old mappings, writer
shapes and physical generations retain their existing meaning. Publish calendar readiness only after complete
population and reconciliation prove the exact physical UUID. Precise compilation must require that exact active,
ready generation. Keep the producer cut and five-producer publication owner; do not add a second protocol.

Build canonical work groups on `POST /v1/subjects:search` and mount `/search/releases`. Read platform, language,
date, rating, developer and publisher controls only from facets admitted by the active released subtype. Keep
producer meanings separate and report generic producer unavailable until Semantic admits its own property. Group
currently matching release children under canonical works, with independent bounded group and child cursors.
Recheck current work and release disclosure, redirects, dates and producer facts on every continuation. Missing,
unknown, conflicting and duplicate work links cannot invent dates or expose children; finite previews cannot claim a
complete group.

Return contextual work and release cards with native destinations, truthful date precision, platform/language/
producer summaries, available credits and ratings, and only existing viewer state or permitted actions in one
bounded response. Preserve URL-backed filters, ordered languages, sort, spoilers, reload/back navigation,
expansion and both cursors across all eight locales. Include accessible loading, repair, unavailable, empty and
terminal states. The same universal request must serve Web and direct clients.

Derive page and preparation bounds from actual source caps, relation fanout, owner calls, writes, visibility,
frontiers, physical rows and bytes, indexed seeks and final authority observations. Exercise native 1x/4x/16x pages,
preparation/resume, replacement, lost responses and stale dependency rejection; leave unavailable native execution
unmeasured. Inspect the installed page against the earlier-app bar, including contextual cards, keyboard use and
repair states. Preserve any missing authentic capability as an explicit dependency.
