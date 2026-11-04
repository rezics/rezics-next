---
goal: commerce
manager: commerce
kind: implementation
paths:
  - services/kernel/src/library/reading-insights-*
  - services/kernel/src/library/progress-store.ts
  - services/kernel/src/library/progress-journal.ts
  - services/kernel/src/library/work-module.ts
  - services/kernel/src/library/erasure-owned-graph.ts
  - services/kernel/src/library/erasure-owned-work.ts
  - services/kernel/src/http/kernel.ts
  - services/kernel/db/library/migrations/*_reading_insights.sql
  - services/kernel/db/library/schema.sql
  - services/kernel/test/library/reading-insights-*
  - apps/web/src/library/reading-insights-*
  - apps/web/src/library/library-nav.tsx
  - apps/web/src/routes/library/insights.tsx
  - apps/web/src/stories/library-reading-insights.stories.tsx
  - apps/web/tests/library-reading-insights*
  - apps/web/messages/*.json
  - docs/library-reading-insights.md
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
after:
  - fdc0672b-e3d5-4acb-bd65-07135d3dc47e
waiting: []
acceptance:
  tests:
    - "Existing native aggregate cases: exact heterogeneous progress and revision-aware assessment values, coverage, deletion/restoration and receipt replay; pure bounded reads retain separately identified panel failures."
    - "Existing page receiving cases: reported year, exact native values and meaning, independent panels and response-owned actions through the current owner/origin/locale visit; retired replies cannot hydrate another visit."
    - "Existing maintenance cases: finite retained-owner installation and repair preserve the original admitted authority, exact progress/cursor and complete body-derived costs including failure/replay/cleanup; native/growth execution remains controller-owned."
  failing: true
  workerOwned: true
estimate:
  lines: 2000
  files: 21

---

# Finish the private Reading Insights journey

The retained source now has an owner-only `GET /v1/libraryReadingInsights?year=...` composition for all-time,
reported-year, retained-profile and assessment panels. Each panel keeps its own result or typed failure, and Diary
navigation is returned as its existing operation and query values. Current progress remains explicitly unavailable
until its native receiver is installed. Continue from these panels; do not create another summary or assessment
authority.

## Remaining outcome

Build the current-progress receiver from each session's accepting descriptor snapshot and exact current native
operands. Preserve decimal and integer precision, meaning revisions and dimensions, cursor behavior, coverage classes,
active and backlog scope, deletion/restoration, receipt replay, and generation invalidation. Receive only at the existing
accepted progress and journal boundaries. Keep command identity, modes, recording, imports and account authority as
they are. Use the existing bounded shelf-maintenance sessions phase for addressed retained rows.

Deliver the finite retained-owner installation and repair schedule through the installed maintenance port. Preserve
the original admission and cursor; do not make GET schedule work or add another funding protocol. Account for the
entire original frame body and every participating pool, row, SQL statement, block, lock, index, replay, failure,
dispatch, receipt, hydration, serialization and retained-child-work cost. If an admission or native operand is absent,
keep the panel unavailable and name the precise owning handoff; do not invent a frame, root, permission, final fence,
cleanup acknowledgement or price.

The matching generated callable client and root delivery are not present on the bound source. After Content publishes
that client, use it to build the reachable `/library/insights` page and overflow navigation. Include reported-year
selection, historical-meaning disclosures, lossless values, accessible tables beside charts, keyboard and phone
behavior, locale strings, original summary/month navigation and unchanged diary allocation. Keep request ownership
fenced by origin, owner, locale, resource, reported year, operation and source generation so retired replies cannot
hydrate another visit. Do not add local wire DTOs, casts, raw fetches, declaration edits or a second generator.

Add focused real-receiver and page tests and stable render-review stories for the named states. Broad acceptance,
native growth, publication and rendered review remain with their integration roles; the supermanager owns the seeded
walkthrough.
