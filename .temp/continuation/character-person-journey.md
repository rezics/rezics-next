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
waiting: []
acceptance:
  tests:
    - "An admitted universal API request and installed character/person page find characters by admitted trait/gender concepts and same-statement appearance/role, and people by active released credited roles and selected works, including repeated voice credits for different characters and permitted character appearances."
    - "Spoiler thresholds 0/1/2 govern membership and every returned context/label/link; hidden or unavailable evidence remains unknown under mixed Boolean/NOT, stale/current mutations retire unsafe results, and first/next/final pages remain useful and deterministic through authorized finite preparation."
    - "The installed browser page preserves applied mode, name, works, role, ordered languages, threshold, sort and pagination through reload/back navigation; request/principal/locale/release replacement retires stale output; invalid/preparing/unavailable/restart states remain repairable in eight locales."
    - "Native 1x/4x/16x source growth executes the installed route, including high-degree actors, sparse qualifiers, dense rejects, overflow and current mutations, and compares every touched pool to a pre-dispatch derived whole-page bound; missing execution remains unmeasured."
  workerOwned: true
estimate:
  lines: 1500
  files: 16
---

Finish discovery through the universal API and installed `/search/characters` page, following
services/kernel/src/search/character-person.md. Generic inverse syntax is
`statement: { property, inverse: true, in: [sourceWorkUuid], qualifiers? }`.
The universal Subject service, retained candidate capture and current Boolean matcher use
native forward probes for inverse membership. Other consumers must explicitly opt into inverse
admission only when they execute this current evidence. Inverse range and concept expansion
are unsupported; exact released concept UUIDs remain the classification operands.

Complete character/person discovery in user terms: characters selected by released trait/gender
concepts and same-statement appearance/role; people selected by active released credited roles
and works. Each voice credit needs its own permitted character appearance; preserve separate
credits for different portrayed characters. Authorize original and terminal subjects and credits,
retain native selection readiness, source-type facet admission and conflicting spoiler checks,
and keep unavailable evidence unknown under Boolean/NOT.

Return admitted labels, aliases, native subject links and independently capped permitted contexts
with truthful continuation. Apply thresholds 0/1/2 to all membership and disclosed context,
including labels and links. Retire stale results and restart continuations after evidence or runtime
release replacement. Complete finite preparation through the authorized retained lifecycle;
first, next and final pages must be useful and deterministic, including dense rejections.

Install an accessible `/search/characters` browser journey in eight locales. Persist applied mode,
name, selected works, role, ordered languages, threshold, sort and pagination across reload/back.
Retire output after request/principal/locale/release replacement and provide repair actions in
invalid, preparing, unavailable and restart states.

Derive the whole-page bound from indexed keys and retained cuts before dispatch. When the
controller's verification policy permits, execute the installed native route at 1x/4x/16x growth,
including high-degree actors, sparse qualifiers, dense rejects, overflow and current mutations,
and compare every touched pool to the bound. Deferred execution remains unmeasured. Do not
edit frozen acceptance. Follow the controller's current focused test and typecheck policy.
