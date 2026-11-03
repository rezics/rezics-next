---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/src/search/release-search*.ts
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
  - 76a7cc0f-796e-497a-9c43-927b6ec2ee0a
  - 0a9e3110-9787-4db4-b958-d9a0322683fb
waiting: []
acceptance:
  tests:
    - 'Install grouped discovery on POST /v1/subjects:search with separate viewer-bound encrypted group and child continuations; active release, physical generation, disclosure, redirects, dates, credits and order changes retire both.'
    - 'Complete native grouping streams return current matching work groups and individual ungroupable releases, apply the whole admitted filter and spoiler policy, and preserve hidden-link confidentiality.'
    - 'Mount contextual work/release cards on /search/releases with independent expansion and continuations; filters, ordered languages, sort, spoilers, reload and back navigation preserve meaning across eight locales and accessible response-grounded states.'
    - 'Measure native 1x/4x/16x first, next, final and empty pages, every all-pool seek, high-fanout preparation/resume and invalidation.'
    - 'Inspect the installed page through the running app, Storybook or screenshots against the earlier-app bar, including keyboard use and repair states.'
  workerOwned: true
estimate:
  lines: 1250
  files: 21
---

# Complete native grouped release discovery and its installed page

Continue from the [owner contract](../../services/kernel/src/search/release-search.md). The current source now has a bounded native read for complete adopted `schema:exampleOfWork` evidence. It canonicalizes visible work targets, preserves unknown concealed values without their identities, and marks unready or oversized observations incomplete. It is not yet installed on the search endpoint.

Build real all-pool group and child streams from that complete evidence. Hydrate current matches using the full admitted filter, disclosure and spoiler policy; bind both continuations to the viewer, active release, physical generation and source epoch. Install the grouped response on `POST /v1/subjects:search`, then mount the grouped journey and localized repair, preparation, expansion and continuation states on `/search/releases`.

Add native 1x/4x/16x growth measurements for all seek, empty, final, preparation, resume and invalidation cases. Visual inspection and native acceptance remain unmeasured until the applicable validation policy permits them.
