---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/src/search/character-person*.ts
  - services/kernel/src/search/character-person.md
  - services/kernel/src/search/service.ts
  - services/kernel/src/search/http/routes.ts
  - services/kernel/src/search/source.ts
  - services/kernel/src/semantic/search-relations.ts
  - apps/web/src/search/character-person*.ts
  - apps/web/src/search/character-person*.tsx
  - apps/web/src/routes/search_.characters.tsx
  - apps/web/tests/character-person-search.test.tsx
  - apps/web/messages/*.json
  - services/kernel/test/search/character-person*.test.ts
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
  - 0fd46032-a6da-4e7f-a785-e71910491441
waiting: []
acceptance:
  tests:
    - "The installed universal API and character/person page find characters by admitted trait/gender concepts and same-statement appearances/roles, and people by active released credits and selected works, including repeated voice credits for different characters."
    - "Thresholds 0/1/2 govern membership and every returned label, context, and link; unavailable or hidden evidence stays unknown under Boolean/NOT, and stale source or release changes retire unsafe pages and continuations."
    - "The localized /search/characters journey preserves mode, name, works, role, ordered languages, threshold, sort, and pagination through reload/back navigation; request/principal/locale/release changes retire stale output and repair states remain usable in eight locales."
    - "Native 1x/4x/16x growth runs the installed route and compares every touched pool with the derived whole-page bound, including high-degree actors, sparse qualifiers, dense rejects, overflow, and current mutations."
  workerOwned: true
estimate:
  lines: 1200
  files: 14
---

The retained source and universal API already support admitted inverse statement filters, current same-statement evidence, role-qualified voice credits, spoiler thresholds, and release retirement. Finish the remaining disclosure and installed browser journey. Return admitted labels, aliases, native links, and independently capped permitted contexts with truthful continuation. Keep the threshold applied to membership and every returned label, context, and link; retire results and cursors when request, principal, locale, evidence, or release changes.

Install an accessible eight-locale `/search/characters` route with reload/back state for mode, name, works, role, ordered languages, threshold, sort, and pagination. Keep invalid, preparing, unavailable, and restart states editable. Derive the complete whole-page work bound before dispatch from actual indexed keys and retained cuts, then run native growth and browser acceptance under the current verification policy.
