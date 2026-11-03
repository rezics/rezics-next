---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/src/search/character-person*.ts
  - services/kernel/src/search/character-person.md
  - services/kernel/src/search/filter.ts
  - services/kernel/src/search/current-filter-plan.ts
  - services/kernel/src/search/disclosure/check.ts
  - services/kernel/src/search/http/routes.ts
  - packages/filter/src/filter.ts
  - packages/filter/test/qualified-credit-search.test.ts
  - services/kernel/test/search/character-person*.test.ts
  - apps/web/src/search/character-person*.ts
  - apps/web/src/search/character-person*.tsx
  - apps/web/src/routes/search_.characters.tsx
  - apps/web/tests/character-person-search.test.tsx
  - apps/web/messages/*.json
  - services/kernel/src/search/service.ts
  - services/kernel/src/search/source.ts
  - services/kernel/src/semantic/search-relations.ts
riskAreas:
  - authorization
  - disclosure
criticalPath: false
after:
  - dae134b8-8345-4e65-931f-fdfb4ecfdb63
  - b1e06240-d4d3-4b6c-aae3-92cb5b8a60fb
  - 58b57961-357c-4384-973f-dc21c05faad8
  - 581ff122-5fb5-40bd-8a69-8f0f2f02f1af
  - 64fd090f-0fbf-47c3-98af-b41d09e38a07
  - d47bdd83-8f63-4778-9a7e-a4d5ff305d1f
waiting: []
acceptance:
  tests:
    - 'An admitted universal API request and installed character/person page find characters by admitted trait/gender concepts and same-statement appearance/role, and people by active released credited roles and selected works, including repeated voice credits for different characters.'
    - 'Spoiler thresholds 0/1/2 govern membership and every returned context/label/link; hidden or unavailable evidence remains unknown under mixed Boolean/NOT, stale/current mutations retire unsafe results, and first/next/final pages remain useful and deterministic.'
    - 'The installed browser page preserves applied mode, name, works, role, ordered languages, threshold, sort and pagination through reload/back navigation; request/principal/locale/release replacement retires stale output; invalid/preparing/unavailable/restart states remain repairable in eight locales.'
    - 'Native 1x/4x/16x source growth executes the installed route, including high-degree actors, sparse qualifiers, dense rejects, overflow and current mutations, and compares every touched pool to a pre-dispatch derived whole-page bound; missing execution remains unmeasured.'
  workerOwned: true
estimate:
  lines: 1750
  files: 16
---

Finish discovery through the existing universal API and an installed `/search/characters`
page. The owner contract is services/kernel/src/search/character-person.md. The source
seam in services/kernel/src/search/character-person.ts executes inverse membership from
selected works through native forward probes. It preserves independent same-statement
qualifier conjunctions, leaves unproven inverse negatives unknown, reanchors candidate
subjects and observes the runtime release head across the complete lookup. Existing
Semantic relation execution already binds runtime release capture to its selection
snapshot and checks type, selection readiness and conflicting spoiler levels. Preserve
those checks when integrating the seam. These are source steps, not installed API
inverse syntax, finite preparation, context previews or a whole-page bound.

Admit generic inverse relation syntax and execute it through retained candidates,
the current Boolean matcher, universal service and route. Find characters by released
trait/gender concepts and same-statement appearance/role; find people by active released
credited roles and selected works. Preserve separate repeated voice credits for different
characters and require permitted character appearances. Authorize original and terminal
subjects and credits. Complete preparation through the authorized lifecycle. Keep hidden,
missing and uncertain evidence unknown under mixed Boolean and NOT. Retire results and
restart continuations after evidence or runtime release replacement.

Return admitted labels, aliases, native subject links and independently capped permitted
contexts with truthful continuation. Apply thresholds 0/1/2 to membership and every label,
context and link. Make first, next and final pages useful and deterministic.

Install an accessible browser journey in eight locales. Preserve applied mode, name,
works, role, ordered languages, threshold, sort and pagination through reload/back
navigation. Retire stale output after request, principal, locale or release replacement.
Keep invalid, preparing, unavailable and restart states repairable.

Derive the whole-page bound from actual indexed keys and retained cuts before dispatch.
Exercise the installed native route at 1x/4x/16x growth, including high-degree actors,
sparse qualifiers, dense rejects, overflow and current mutations; compare every touched
pool to the bound. Follow the controller's current verification policy. Deferred native
execution remains unmeasured; do not edit frozen acceptance files.
