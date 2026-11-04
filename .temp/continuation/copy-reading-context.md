---
goal: commerce
manager: commerce
kind: interface
paths:
  - apps/web/src/library/copy-reading-context/*
  - apps/web/src/library/copies-read.ts
  - apps/web/src/library/copies-actions.ts
  - apps/web/tests/copy-reading-context-read.test.ts
  - apps/web/tests/copy-reading-context.test.tsx
  - apps/web/src/stories/copy-reading-context.stories.tsx
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
after:
  - e9314e51-a782-43e9-b55a-017dcc1bac53
  - f996048e-3fd8-4aef-8604-aa611b940715
  - 081bd2e7-0400-4de6-ba50-1f19a7d84c25
  - afa7e152-ac71-43e1-b36b-f31279dcb738
waiting: []
estimate:
  lines: 120
  files: 5
acceptance:
  tests:
    - "The installed KernelClient.copies list row declares optional context with the official closed union, and the Web receiver derives it directly without handwritten wire types."
    - "Two FULL rows of the same Subject retain distinct contexts, physical Copy IDs, revisions, source/note/location and command identities, with no Subject hydration."
    - "Qualified author/date presentation, hidden ID-free states, absent-context unavailable, current-viewer retirement and exact localized inventory return remain intact."
  failing: true
  workerOwned: true
---

# Receive the installed Copy context field

Complete this receiver after the installed `@rezics/client` declaration publishes optional `context` on
`KernelClient['copies']['get']` rows. The native Kernel route already publishes the optional closed context union, but
`packages/client/src/kernel/library/personal-routes.d.ts` in the current base does not include that field. Do not add a
local generated declaration, cast, handwritten wire type, raw request or reflective payload extraction to bridge it.

Derive the context and identity types from the installed list row, read `copy.context` directly, and map absence to
unavailable. Preserve the per-row destructuring in `copies-actions`, bounded qualified Work/fact presentation, hidden
ID-free states, physical Copy identities and revisions, current-viewer retirement, no Subject hydration, and exact
localized inventory return. Adapt the receiver test to the installed FULL fixture and retain the seeded walkthrough.
