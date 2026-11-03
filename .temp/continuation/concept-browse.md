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
  - services/kernel/src/search/service.ts
  - services/kernel/src/search/scope-preparation*.ts
  - services/kernel/src/search/work.ts
  - services/kernel/src/semantic/search-relations.ts
  - services/kernel/src/semantic/search-source.ts
  - services/kernel/db/search/schema.sql
  - services/kernel/db/semantic/schema.sql
  - packages/filter/src/filter.ts
  - packages/filter/test/concept-descendants.test.ts
  - services/kernel/test/search/concept-browse*.test.ts
  - apps/web/src/search/concept-browse*.ts
  - apps/web/src/search/concept-browse*.tsx
  - apps/web/src/routes/search_.concepts.tsx
  - apps/web/tests/concept-browse.test.tsx
  - apps/web/messages/*.json
riskAreas:
  - authorization
  - disclosure
criticalPath: false
after:
  - dae134b8-8345-4e65-931f-fdfb4ecfdb63
  - b1e06240-d4d3-4b6c-aae3-92cb5b8a60fb
  - 58b57961-357c-4384-973f-dc21c05faad8
  - 2af65b98-af9e-409d-80f2-51aefc76c6db
  - 7c1790b6-58c2-48c7-8b58-68fb24a230e2
waiting: []
acceptance:
  tests:
    - "Implement the retained traversal storage seam within the existing plan/worker lifecycle using indexed membership/frontier rows, CAS, expiry and bounded retirement cleanup. Connect Semantic's current indexed relations/configuration and runtime release observations; mount the hierarchy API and service caller."
    - 'Extend the universal typed condition algebra and current matcher for exact concepts and optional descendants, include/exclude, Boolean composition, disclosure and spoiler-qualified same-statement witnesses. Never turn incomplete traversal into negative evidence or lower complete closures to in:64.'
    - 'Install /search/concepts with scheme selection, breadcrumbs, bounded parent/child pages, editable include/exclude, child toggles, spoiler threshold, URL/back navigation, useful result pages, accessible repair states and all eight locales.'
    - 'Run native hierarchy/classified-subject 1x/4x/16x growth acceptance after integration when authorized, including sparse positives, dense rejection, interruption/resume, mutations and first/next/final pages; measure actual all-pool work against the derived bound. Run the connected browser journey after backend checks when authorized.'
  workerOwned: true
estimate:
  lines: 2100
  files: 20
---

Finish the retained concept hierarchy and universal Search journey. The current change adds the typed one-concept statement shape, keeps that metadata through admission, and makes the existing compiler refuse concept queries until it can bind a complete retained closure and current native statement witness. Continue by storing closure membership and frontier rows under the shared `search.scope_preparation` lifecycle; use the released Semantic graph and current selection, disclosure, source-fence, scheme, principal and request observations. Add the current matcher so exact and descendant checks, including exclusions, Boolean branches and spoiler qualifiers, use the same statement witness and keep unavailable evidence unknown. Mount bounded scheme, breadcrumb, parent and child APIs and connect the existing Search service to them.

Build `/search/concepts` as a localized, accessible route in all eight locales. Support editable include/exclude values, descendant toggles, spoiler threshold, URL and browser history navigation, useful Search result pages, and repairable states when source evidence or retained preparation is unavailable. Keep native and browser acceptance deferred under the controller's policy; do not introduce a graph mirror, duplicate capture lifecycle, or `in:64` closure approximation. The owning decision is recorded in `docs/search-conditions.md` and the Search info inbox.
