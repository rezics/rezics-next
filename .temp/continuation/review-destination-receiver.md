---
goal: content
manager: content
kind: claim
paths:
  - apps/web/src/threads/review-board-choices.ts
  - apps/web/tests/review-destination-journey.test.tsx
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
waiting: []
after:
  - 27537a14-d321-4549-a636-9247a64bc858
  - 9fa8bde9-ab24-46e5-bd17-d8457fbfe116
estimate:
  lines: 20
  files: 2
criticalPath: false
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - '--private-network'
    - '--'
    - bun
    - test
    - tests/review-destination-journey.test.tsx
  tests:
    - The receiver calls the installed public native route and derives its response type from that declaration.
    - 'Runtime validation, private transport options, cancellation, sparse continuation, exact-cursor retry, and deliberate sole-choice inspection remain intact.'
---

# Finish the installed review destination receiver

The public route declaration is not present yet in `packages/client/src/kernel/content/routes.d.ts`. Begin this work after its owning change installs `GET /v1/realms/:realmId/review-destinations`; do not add or edit the declaration here. Then replace the local route mirror and preparation DTO in `review-board-choices.ts` with the declared callable and a response type derived from its public return type. Keep the runtime validator, unavailable states, request signal, no-store and credentials-omit transport, abort guards, reader and CSRF provenance, exact Board inspection, and existing composer. The existing journey covers the required transport, cancellation, pagination, retry, and inspection behavior.
