---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/rating/README.md
  - services/kernel/test/rating/question-management-journey.test.ts
  - apps/web/src/ratings/question-management/**
  - apps/web/src/routes/realms/$id_.questions.tsx
  - apps/web/src/community/space-page.tsx
  - apps/web/tests/question-management*.test.tsx
  - apps/web/src/stories/question-management*.tsx
  - apps/web/src/ratings/own-classifications/**
  - apps/web/src/routes/library/classification-assessments.tsx
  - apps/web/tests/own-classifications*.test.tsx
  - apps/web/src/stories/own-classifications*.tsx
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
after:
  - 3de74910-845b-4f8c-81bc-7fbd0a57d99f
  - e27d5886-80a4-4a23-8a94-10a2ed65726c
  - d7615d61-fbfe-4b0f-9cd6-1c168186b123
  - fc61a92e-ab1e-4120-a0db-31e2772c2c65
  - c294ebf5-c2e1-4974-b829-9f64a0b047c8
  - 868380ae-4919-4791-9761-fa6e839304e4
  - 5d2a9220-938d-4e94-a1d7-5d64f7d915b5
waiting: []
acceptance:
  command:
    - bun
    - run
    - "--cwd"
    - services/kernel
    - check
    - test/rating/question-management-journey.test.ts
    - test/rating/own-classification-journey.test.ts
  placement: default
  tests:
    - "Both mounted journeys abort stale reads and commands on credential replacement or away/return while retaining the original action bindings, focus, and dirty-exit behavior."
    - "The shared complete-input publisher consumes mounted management schema/OpenAPI inputs and the delivered installed declaration head is recorded."
    - "Native execution, installed method typing, browser interaction, and recorded presentation pass as separate gates."
  failing: true
estimate:
  lines: 800
  files: 8
---

Finish browser coverage for credential replacement and away/return in both journeys, including stale command retirement,
focus restoration, and dirty-exit behavior. Publish the mounted management schema and OpenAPI inputs through the shared
complete-input publisher, then record its actual installed declaration head when that declaration is delivered. Keep
native execution, installed typing, browser interaction, and recorded story presentation as separate verification gates.

The current work added those management actions and story states, plus the missing native journey and growth tests. The
native check stopped before running either journey because its schema comparison reports the existing
`services/kernel/db/library/schema.sql` mismatch; web focused tests stopped during module loading because the check host
could not resolve the existing SQL module export and `cloudflare:workers` import. The workspace typechecks also report
errors in files outside this attempt's changes.
