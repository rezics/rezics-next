---
goal: commerce
manager: commerce
kind: implementation
paths:
  - services/kernel/src/library/reading-insights-*
  - services/kernel/src/library/progress-store.ts
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
  - b5f8b62c-b231-4040-af3b-776372c8ffce
waiting: []
acceptance:
  tests:
    - "A reachable private insights page composes independently identified all-time/year summaries, retained-profile distribution, and current progress and assessment panels with explicit coverage, response-provided actions, and typed viewer states."
    - "Current units preserve exact native decimal/integer values and separate exact, estimate, lower-bound, unknown-total, absent-value, unsupported-meaning, cursor, percentage, active, and backlog coverage; incompatible profile and assessment revisions never merge."
    - "Assessment receiving distinguishes new absent, null, and value states while historical nulls remain unavailable for the presence distinction; native correction, retirement, restoration, and receipt replay update aggregates exactly once."
    - "Finite funded installation and repair account for every participating pool, replay, failure, terminal cleanup, SQL statement, row/block/index seek, lock, dispatch/receipt, hydration, serialization, and retained child-work cost without GET scans."
    - "Focused native/page tests and stories cover heterogeneous units, assessment revisions, source-generation invalidation, unsupported history, partial repair, failed panels, stale responses, and independent 64/512/4096 populations."
  failing: true
  workerOwned: true
estimate:
  lines: 2100
  files: 20
---

The profile-distribution API and its existing native receiver remain in place. New native session writes now retain the
accepting unit descriptor and profile pin in a private sidecar; older sessions have no captured descriptor and must
stay unavailable for dimensional interpretation.

Finish the retained current-progress aggregate and bounded read. Keep exact decimal and integer values, native
precision, declared dimension, cursor meaning, percent meaning, exact/estimate/lower-bound coverage, unknown totals,
absent values, and active/backlog scope distinct. Do not reconstruct history from labels or current profiles. Invalidate
the panel with source generations, reconcile lifecycle changes and original receipt replay once, and delete meaning
snapshots with their native session.

Add independent private assessment coverage and revision receiving. New native writes must distinguish absent, explicit
null, and value while preserving zero. Leave historical null presence unknown, keep incompatible revisions separate,
and do not infer assessments from votes or activate conditional vote effects. Do not change the existing journal read or
command contract.

Compose the existing independently identified all-time and reported-year summaries, retained profile distribution,
current progress, and assessment panels in one bounded response without claiming a common snapshot across generations.
Expose viewer status and allowed retry/navigation actions. Keep usable panels when another fails; fence stale responses
by origin, owner, locale, resource, year, operation, and generation. Retry failures independently and retain immutable
command identity through uncertainty.

Deliver a finite funded installation/backfill/repair schedule through the installed maintenance port. Account for all
participating pools, successful and failed replay, terminal cleanup, SQL statements, rows and blocks, index seeks, locks,
dispatch and receipts, hydration, serialization, and retained child work. Keep GETs pure and disclose exact initialized,
retained, missing, and remainder counts.

Use the installed Content-generated client output only after its matching publication exists; provide Content the actual
mounted signatures and examples. Do not add a hand-written client declaration, root export, generator, cast, or raw fetch.
Build the reachable `/library/insights` page and overflow destination with the selected reported year, historical meaning
disclosures, lossless values, accessible text/tables beside charts, keyboard and phone behavior, locale strings, original
summary/month navigation, and unchanged diary allocation. Add focused real-receiver API tests, page tests, and stable
render-review stories. Broader acceptance, heavy-growth campaigns, client publication, and rendered review remain with
the integration owner.
