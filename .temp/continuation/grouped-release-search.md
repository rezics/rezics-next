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
  - f37dbf4b-d01c-48e9-b69c-7122e07883e3
  - af9ae6c7-1378-431c-927d-8e91de48e4d0
waiting: []
acceptance:
  tests:
    - 'Install grouped discovery on POST /v1/subjects:search with independent authenticated and encrypted group/child cursors; current calendar precision, disclosure, redirects, dates and producer changes invalidate both.'
    - 'Native complete work-link selection distinguishes missing, unknown, conflicting and duplicate links without leaking children; precise ranges require the exact ready physical generation and active release.'
    - 'Mount /search/releases with active-release controls and contextual work/release cards; filters, language order, sort, spoilers, expansion, reload/back and both continuations preserve meaning across eight locales and accessible response-grounded states.'
    - 'Native 1x/4x/16x first, next, final and empty pages measure every all-pool seek, high-fanout bound, preparation/resume and invalidation case.'
    - 'Inspect the installed page through the running app, Storybook or screenshots against the earlier-app bar, including keyboard use and repair states.'
  workerOwned: true
estimate:
  lines: 1500
  files: 24
---

# Complete the native and installed grouped release journey

Continue from `services/kernel/src/search/release-search-cursor.ts`, which wraps the source-independent grouping policy in the viewer-bound encrypted cursor lifecycle. Implement the native all-pool group and child source with complete adopted work-link evidence, exact physical generation checks, current disclosure and permitted viewer actions. Mount it on `POST /v1/subjects:search`, then build `/search/releases` with the active-release controls, contextual cards, preserved filter and language order, accessible response-grounded states and all eight locales. Add native growth coverage at 1x, 4x and 16x, including high fan-out, preparation, resume and invalidation. Inspect the installed page against the earlier-app bar, including keyboard use and repair states. See [Release search](../../services/kernel/src/search/release-search.md) for the owner contract; do not claim unmeasured native or visual results.
