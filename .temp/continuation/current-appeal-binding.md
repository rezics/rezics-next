---
goal: web
manager: web
kind: interface
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
waiting: []
paths:
  - apps/web/src/moderation/appeals-read*.ts
  - apps/web/src/moderation/appeals-tab.tsx
  - apps/web/src/moderation/workbench-appeal/**
  - apps/web/src/moderation/workbench-queue/read.ts
  - apps/web/src/moderation/workbench-queue/page.tsx
  - apps/web/src/moderation/workbench-queue/view.tsx
  - apps/web/src/moderation/appeal-resolution/**
  - apps/web/src/moderation/workbench-case.md
  - apps/web/src/moderation/README.md
  - apps/web/tests/moderation-appeal*.test.ts*
  - apps/web/tests/workbench-stable-case.test.tsx
  - apps/web/src/stories/moderation-appeal*.stories.tsx
  - apps/web/messages/*.json
  - docs/goals/web.md
  - .temp/continuation/current-appeal-binding.md
after:
  - a37d6842-bbbb-4ab0-98ba-1ae8b705fe0e
  - 8caa3c4c-a875-456b-a93e-5a44bbbaebdc
  - 0dc182bf-eee0-4467-bafa-920ccf88a667
  - b4f0a9af-e632-4069-8833-a0a93f7af754
estimate:
  lines: 950
  files: 15
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - "--private-network"
    - "--"
    - bun
    - test
    - moderation-appeal-current-selection.test.tsx
  placement: default
  tests:
    - A moderator opens a stable appeal ID through native inspect with disclosed identity, original decision and current destination and returns to the captured queue.
    - Concealed/unavailable context retains the appeal and exact pending/resolved distinction; canResolve never replaces native authorization.
    - Current native provenance and opaque session bind page and selection, preserve sparse continuation and exact uncertain resolution intent through retirement.
  failing: true
---

Finish native composed appeal inspection in the existing owners. Read
`apps/web/src/moderation/workbench-case.md`, `apps/web/src/moderation/README.md`,
`services/kernel/src/content/appeal-routes.ts`, the Appeals section of
`services/kernel/src/content/README.md` and populated/concealed/resolved/failed examples in
`services/kernel/test/content/appeals-http.test.ts` before binding.

The installed `packages/client/src/kernel/content/routes.d.ts` still exposes only cursor/limit and appeals/next.
Receive generated operations and producer/controller native response recordings first. Do not generate delivery,
author native DTOs, cast a client, add an endpoint or replace exact selection with pending-row lookup.

Bind inspect in the same board/thread GET, retaining one page <=20 and one independent selection. Preserve
appellantIdentity, original decision target, current destination (no body), exact resolutionCommand, source,
provenance and opaque session header. Map native resolution null/upheld/reversed with statement/time to the existing
presentation. Native command authorization remains final. No per-row identity/media/current-target hydration.

Complete actor/session/source/disclosure retirement across page, selection and all late effects. Reads cannot recover
lost command identity or refresh unresolved writes. Keep the selected retry and refresh fencing already implemented
in the workbench; tests currently use independent presentation inputs, not native composed delivery.

Extend the current-selection suite to the real installed adapter/panel boundaries with producer recordings: 1/10/20
rows, sparse empty-plus-next, selection absent from pending page, terminal outcomes, concealment and fixed command
components, O(rows + admitted bytes). Keep frozen files and the memory runner unchanged. Add only named populated,
concealed/unavailable, pending/resolved stories across eight locales and 390/1280 layouts. Update owner Cost
Touches/Bound/Growth. Source delivery, generated delivery, executed acceptance and public publication are distinct;
controller owns integration, full acceptance and publication. Preserve live publisher/capture handles.
