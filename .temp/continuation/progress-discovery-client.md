---
goal: commerce
manager: commerce
kind: implementation
paths:
  - apps/web/src/library/progress-reads.ts
  - apps/web/src/library/progress-server.ts
  - apps/web/src/library/progress-page.tsx
  - apps/web/src/routes/library/progress.index.tsx
  - apps/web/tests/progress-address.test.tsx
  - apps/web/tests/progress-index-current-origin.test.tsx
  - apps/web/src/stories/library-progress-discovery.stories.tsx
  - docs/library-progress-discovery.md
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
after:
  - b78389f1-67a5-4fad-9e6a-15a39b59633f
waiting: []
acceptance:
  tests:
    - Consume the generated typed KernelClient.progressSessionDiscovery method after Content publishes it; remove the unavailable owner-read seam and preserve the subject-scoped reader.
    - Map bounded owner responses and exact predicates into the existing page model; keep filters, locale, origin, viewer and cursor bound to the current page generation.
    - Render owner-wide sessions and allowed actions, with distinct empty, signed-out, account-retired, stale and unavailable states.
    - Run focused Web page tests and the seeded rendered review using the installed generated client output.
  failing: true
estimate:
  lines: 280
  files: 8
---

Once the Content-owned generated client includes `progressSessionDiscovery`, use that typed KernelClient method for owner-wide and filtered reads. Preserve the existing subject-specific reader, remove the unavailable owner-read seam, and keep each response tied to its current filters, locale, origin, viewer and cursor. Render the returned sessions, safe Subject summaries and allowed actions, and prove the named empty, signed-out, retired, stale and unavailable states in the route stories and seeded review. Keep the acceptance check, installed generated output and rendered review as separate evidence.
