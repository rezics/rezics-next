---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/src/search/release-search*.ts
  - services/kernel/src/search/release-search.md
  - services/kernel/src/search/http/routes.ts
  - services/kernel/src/search/service.ts
  - services/kernel/src/search/source.ts
  - services/kernel/src/search/current-leaf.ts
  - services/kernel/src/search/hits.ts
  - services/kernel/src/search/request-source-snapshot.ts
  - services/kernel/src/search/filter.ts
  - services/kernel/src/semantic/scope-leaf-selection.ts
  - services/kernel/src/semantic/search-source-releases.sql
  - services/kernel/db/search/indices/*.json
  - services/kernel/test/search/release-search*.test.ts
  - services/kernel/test/semantic/search-source.test.ts
  - services/kernel/test/semantic/scope-leaf-selection.test.ts
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
  - 93c893f5-e7ca-4587-95c7-af06af2e2fd2
waiting: []
acceptance:
  tests:
    - "Calendar precision survives current matching, API and display; a precise range requires the exact ready physical generation and active release."
    - "Disclosure, redirects, dates and producer changes invalidate group and child continuations; missing, unknown, conflicting and duplicate work links remain truthful and never leak children."
    - "Reload/back navigation, filters, language order, sort, spoilers, expansion and both continuations preserve request meaning across all eight locales, with accessible loading, repair, unavailable, empty and terminal states."
    - "Native 1x/4x/16x first, next, final and empty pages measure every all-pool seek, high-fanout bound, preparation/resume and invalidation case."
    - "Inspect the installed page through the running app, Storybook or screenshots against the earlier-app bar, including contextual work/release cards, keyboard use and repair states."
  workerOwned: true
estimate:
  lines: 1900
  files: 24
---

# Finish grouped release discovery

Build the release journey on `POST /v1/subjects:search` and `/search/releases`. Use controls admitted by the active
released subtype, preserve platform/language association, and group only current matching release children under
canonical works. Give work groups and release children independent bounded cursors. Recheck disclosure, redirects,
dates and producer facts on each continuation. Never infer complete groups from finite previews; keep missing,
unknown, conflicting and duplicate work links truthful.

Mount accessible URL-backed controls and contextual work/release cards in all eight locales. Preserve request
meaning across filters, reload/back navigation, expansion and both continuations. Include only existing current
viewer state and permitted owner actions in one bounded response. Ground the loading, repair, unavailable, empty and
terminal states in real responses.

Finish native growth measurements at 1x, 4x and 16x releases and works, including high fan-out. Exercise every
all-pool seek, page-size and preparation bound; measure resume and change invalidation. Inspect the installed page
against the earlier-app bar, including keyboard use and repair states. Do not claim unmeasured native results.
