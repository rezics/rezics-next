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
  - 1375348c-1d32-436d-a7ae-7146fc73d552
waiting: []
acceptance:
  tests:
    - 'Classify the complete all-pool native name stream into canonical work candidates, ungroupable releases and independent per-work children; support explicit relevance order.'
    - 'Hydrate current cards with the complete admitted filter and spoiler policy, preserving concealed-link confidentiality; reserve full matching, disclosure, hydration, serialization and final-authority work on every touched pool.'
    - 'Install grouped POST /v1/subjects:search with existing viewer-bound encrypted group and child continuations; release, physical generation, disclosure, redirect, date, credit and order changes retire both.'
    - 'Mount contextual work/release cards on /search/releases with independent expansions and continuations, URL-backed operands and ordered languages, accessible response-grounded repair/preparation/restart states in eight locales.'
    - 'Under the applicable validation policy, measure native 1x/4x/16x first, next, final and empty pages, all-pool seeks, high-fanout preparation/resume and invalidation; inspect the installed page against the earlier-app bar.'
  workerOwned: true
estimate:
  lines: 2100
  files: 21
---

# Finish grouped release discovery and its installed page

Continue from [the owner contract](../../services/kernel/src/search/release-search.md).
The all-pool canonical-name traversal now exists in `release-search-name-stream.ts`. It retains every pool's
population, reserves home seeks and their internal observations, merges UTF-8 name order with bounded lookahead,
replays unconsumed keys from one shared frontier and checks all cuts before returning. It produces internal candidate
keys only. It is not installed as the grouping source and supplies no complete page work bound.

Connect those keys to the existing native complete `schema:exampleOfWork` reader, not to sampled hit facts. Build
distinct current work candidates and ungroupable releases and independent child streams; every group requires a
current matching child, and preparation must continue until explicit source EOF. Preserve existing encrypted cursor
and grouping implementations. Bind release, exact physical generation, viewer and every source cut; canonical-name
cuts alone are insufficient authority for work-link disclosure or card hydration. Retire both streams for disclosure,
redirect, date, credit and order changes.

Apply the full admitted filter and spoiler policy through the existing current matching machinery. Include current
contextual cards, viewer state and permitted actions. Reserve every underlying pool's matching, source observations,
hydration, serialization and final authority, including rejected keys, duplicate keys, replay and empty seeks. The
name traversal's dispatch reservations do not account for that remaining work. Derive the whole-page bound from
retained-cut invalidation and the native plan rather than a fitted refill cap. Add relevance order without weakening
the default work-name order.

Install the grouped response on `POST /v1/subjects:search`, then mount `/search/releases` with independent expansion
and child progress, preserved URL semantics and the eight localized states named by the owner contract. Add the
focused behaviour tests required by those changes. Product changes must exceed test changes. Leave native growth
measurements and browser inspection deferred until the applicable validation policy permits them.
