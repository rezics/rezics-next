---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/src/search/current-filter-plan.ts
  - services/kernel/src/search/disclosure/check.ts
  - services/kernel/src/search/character-person*.ts
  - services/kernel/src/search/discovery*.ts
  - services/kernel/src/search/public-filter-consumer.ts
  - services/kernel/src/search/service.ts
  - services/kernel/src/search/source.ts
  - services/kernel/src/semantic/search-relations.ts
  - services/kernel/src/semantic/public-filter-source-binding.ts
  - services/kernel/test/search/character-person*.test.ts
  - services/kernel/test/search/current-filter-plan.test.ts
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
  - aa21c788-dade-47e5-81d8-08a929848d28
  - 6a50ce55-4f5c-4a48-a3e6-17ee932d8c46
waiting: []
acceptance:
  tests:
    - "Each authorized finite retained Search page derives and retains its complete per-pool work bound before the first native dispatch from deduplicated indexed probe keys and every retained source cut, including distinct work/character/threshold appearance keys introduced by voice credits; any actual pool exceeding its bound retires the window."
    - "First, next, and final pages remain useful, deterministic, and repairable through dense rejections and current source or runtime release activation mutations."
workerOwned: true
estimate:
  lines: 650
  files: 11
---

Finish the page-wide finite retained bound around the per-cut voice appearance plan. Gather the complete indexed
candidate keys and retained current-source cuts for one page, count each distinct voice appearance key across that
page, and authorize each touched pool against the resulting bound before dispatch. Preserve useful continuation
pages through dense rejections, and retire retained work when source evidence or runtime release activation changes.

Native 1x/4x/16x route execution remains deferred until controller policy permits it.
