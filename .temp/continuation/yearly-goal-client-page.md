---
goal: commerce
manager: commerce
kind: implementation
paths:
  - apps/web/src/library/yearly-goal-*
  - apps/web/src/library/library-nav.tsx
  - apps/web/src/routes/library/goals.tsx
  - apps/web/src/stories/library-yearly-goal.stories.tsx
  - apps/web/tests/library-yearly-goal*
  - apps/web/messages/*.json
  - docs/library-yearly-goals.md
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
after: []
waiting: []
acceptance:
  tests:
    - 'After Content publishes the generated @rezics/client binding, connect mounted GET/PUT reads and set, edit and clear actions. Keep exact revisions and lossless reported-year counts; known zero, missing finish coverage, unavailable summary and over-target values remain distinct. Keep target editing independent of summary availability.'
    - 'Bind drafts, requests and results to origin, current viewer/session, credential, locale, selected year and operation generation. Retain the reviewed request and original idempotency key through uncertain delivery and account/year replacement. Retry exact inputs, resolve the original receipt before readback, and require explicit refresh/review after stale revision.'
    - 'Retain localized metric explanation, bounded year selector, all history links and mounted behavior. Add native-shaped command/receipt coverage as the generated client allows. Controller runs browser and original native, growth and full acceptance.'
  failing: true
estimate:
  lines: 300
  files: 6
---

# Complete generated-client yearly completion goal journey

Use `docs/library-yearly-goals.md` as the native owner contract. The committed presentation work supplies the page
states, localized labels, stories, native-shaped fixture, mounted state tests and native HTTP boundary tests. The page
renderer accepts a typed API seam and covers independent target/progress availability, decimal-string revisions and
counts, stale review, exact uncertain retry, and year/viewer lifetime fencing.

The page is not wired yet: the route still renders its navigation with unavailable state. Content owns publication of
the shared `@rezics/client` binding for `GET /v1/libraryYearlyCompletionGoal?year=<1..9999>` and
`PUT /v1/libraryYearlyCompletionGoal`. The exact missing routes, operands, response states and status results have been
sent to Content through the existing inbox publisher. Do not handwrite declarations, cast a client, use raw fetch,
introduce another generator or substitute a different summary reader. No new native goal policy is needed.

After the shared binding is published:

1. Add the Web adapter using the generated KernelClient and existing session, credential, address, origin and mounted
   session fences. Keep native reads private/no-store. PUT must preserve the native body
   `{year, metric: "completed_consumption_occurrences", target, expectedRevision}` and the original
   `idempotency-key`; null is a revisioned clear command.
2. Connect `apps/web/src/routes/library/goals.tsx` to the adapter. Read only the selected year. Preserve submitted
   operands across uncertain delivery, resolve the original receipt before a current readback, and keep stale proposed
   targets for explicit refresh and review against the current revision.
3. Keep actual target availability separate from progress availability. Preserve native coverage/currentness meaning,
   month buckets and history destinations; use string-safe counts and revisions without lossy `Number` coercion.
4. Extend the existing mounted tests with generated-client/native fixtures where practical. Cover read, edit, clear,
   readback, unset goal with unavailable summary, stale refresh/review, exact uncertain retry, year replacement and
   current-viewer replacement. Retain refusal coverage for the native HTTP authorization and input boundaries.
5. Run the focused Web and Kernel commands, changed-workspace typechecks, and the deferred browser/controller
   acceptance. In the previous attempt, the Web focused file passed (9 tests, 161 expectations); Kernel check stopped
   at the semantic schema dump mismatch before running the selected test. Root Web and Kernel typechecks reported
   unrelated existing diagnostics outside the changed files.

Keep the existing eight locales, selected year, year bounds, History destination, repeat-finish occurrence semantics,
and current native command/receipt/erasure/cost bounds. Do not add session scans, browser recounts, statistics,
publication or balance effects.
