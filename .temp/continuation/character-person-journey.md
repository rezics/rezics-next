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
  - services/kernel/src/search/public-filter-consumer.ts
  - services/kernel/src/semantic/public-filter-source-binding.ts
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
  - 5a7780cc-325c-462b-ac39-e44b3544c04c
  - 93c893f5-e7ca-4587-95c7-af06af2e2fd2
waiting: []
acceptance:
  tests:
    - 'An admitted universal API request and installed character/person page find characters by admitted trait/gender concepts and same-statement appearance/role, and people by active released credited roles and selected works, including repeated voice credits for different characters and permitted character appearances.'
    - 'Spoiler thresholds 0/1/2 govern membership and every returned context/label/link; hidden or unavailable evidence remains unknown under mixed Boolean/NOT, stale/current mutations retire unsafe results, and first/next/final pages remain useful and deterministic through authorized finite preparation.'
    - 'The installed browser page preserves applied mode, name, works, role, ordered languages, threshold, sort and pagination through reload/back navigation; request/principal/locale/release replacement retires stale output; invalid/preparing/unavailable/restart states remain repairable in eight locales.'
    - 'Native 1x/4x/16x source growth executes the installed route, including high-degree actors, sparse qualifiers, dense rejects, overflow and current mutations, and compares every touched pool to a pre-dispatch derived whole-page bound; missing execution remains unmeasured.'
  workerOwned: true
estimate:
  lines: 1400
  files: 16
---

Finish discovery through the universal API and installed `/search/characters` page, following
services/kernel/src/search/character-person.md. Preserve the thresholded native voice policy:
each matching voice-credit statement needs permitted appearances on its own work for every
portrayed character, without borrowing another credit's qualifiers. Unqualified thresholded
voice credits stay unknown. Its source seam already carries thresholds through both forward
and inverse current checks and reanchors credits after appearance checks.

Complete user-visible discovery: characters selected by exact released trait/gender concepts
and same-statement appearance/role; people selected by active released credited roles and works.
Return admitted labels, aliases, native subject links and independently capped permitted contexts
with truthful continuation. Apply thresholds 0/1/2 to every membership, context, label and link.
Preserve source-type facet admission, selection readiness, original and terminal authorization,
credit and appearance fences, conflicting-spoiler uncertainty, and mixed Boolean/NOT unknowns.
Retire stale output and continuations after evidence or runtime activation replacement.

Complete authorized finite retained preparation so first, next and final pages stay useful and
deterministic through dense rejections. Derive the entire touched-pool bound before dispatch
from indexed keys and retained cuts, including the distinct appearance keys introduced by voice
credits; a per-step raw native row limit is not that bound.

Install the accessible browser page in eight locales. Persist applied mode, name, selected
works, role, ordered languages, threshold, sort and pagination through reload/back. Retire
output on request/principal/locale/release replacement; provide repair actions for invalid,
preparing, unavailable and restart states. Generic inverse syntax remains
`statement: { property, inverse: true, in: [sourceWorkUuid], qualifiers? }`; no inverse range
or concept expansion. Other consumers opt in only when executing current inverse evidence.

When controller policy permits, exercise the installed native route at 1x/4x/16x with high-degree
actors, sparse qualifiers, dense rejects, overflow and current mutations; compare every touched
pool with the pre-dispatch whole-page bound. Execution remains unmeasured while deferred.
Never edit frozen acceptance. Follow the controller's current focused test/typecheck policy.
