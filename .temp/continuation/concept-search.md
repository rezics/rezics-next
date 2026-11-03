---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/src/search/concept-browse*.ts
  - services/kernel/src/search/concept-browse*.sql
  - services/kernel/src/search/concept-browse.md
  - services/kernel/src/search/filter.ts
  - services/kernel/src/search/current-filter-plan.ts
  - services/kernel/src/search/http/routes.ts
  - packages/filter/src/filter.ts
  - packages/filter/test/concept-descendants.test.ts
  - services/kernel/test/search/concept-browse*.test.ts
  - apps/web/src/search/concept-browse*.ts
  - apps/web/src/search/concept-browse*.tsx
  - apps/web/src/routes/search_.concepts.tsx
  - apps/web/tests/concept-browse.test.tsx
  - apps/web/messages/*.json
  - services/kernel/src/search/service.ts
riskAreas:
  - authorization
  - disclosure
criticalPath: false
after:
  - dae134b8-af9e-409d-80f2-51aefc76c6db
  - b1e06240-d4d3-4b6c-aae3-92cb5b8a60fb
  - 58b57961-357c-4384-973f-dc21c05faad8
  - 92852a9e-4704-492c-9aa2-d5fc0979d452
waiting: []
acceptance:
  tests:
    - "Connect the bounded traversal seam to Semantic's current indexed relation and configuration readers and the runtime release observation. Mount the hierarchy API and service caller; stale graph, release, scheme membership, principal, or request changes restart or retire work before negative evidence is used."
    - 'Extend the universal typed condition algebra and current matcher for exact concepts and optional descendants, include/exclude, Boolean composition, current disclosure, and spoiler-qualified same-statement witnesses. Complete descendant sets must use the existing worker and retained-plan lifecycle, with finite memory/frontier limits and no in:64 truncation.'
    - 'Install /search/concepts with scheme selection, breadcrumbs, bounded parent/child pages, editable include/exclude selections, child toggles, spoiler threshold, URL/back navigation, and useful first/next/final result pages in all eight locales. Invalid, unavailable, preparing, loading, empty, restart, and stale output states are repairable and visible.'
    - 'Run the native hierarchy and classified-subject growth acceptance at 1x, 4x, and 16x, including sparse positives, current rejects, preparation resume, mutations, and first/next/final pages. Record touched-pool work against the documented bound; missing execution stays unmeasured.'
  workerOwned: true
estimate:
  lines: 2200
  files: 14
---

Complete the Search journey for browsing current admitted concept schemes and selecting concepts with or without
descendants. Read only current Semantic relations and released configuration. Retain traversal progress through the
existing worker lifecycle, bound working memory and indexed reads, and discard evidence when its release, graph,
scheme membership, principal, or request changes. Apply exact and descendant selections as ordinary universal Search
conditions, preserving current disclosure and qualifier witnesses. Ship the localized `/search/concepts` route with
repairable hierarchy and result states, stable URL intent, and accessible controls. Finish focused backend checks and
type checks, then the connected browser journey. Native three-scale growth acceptance remains required before
broader closure.
