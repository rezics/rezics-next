---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/content/board-page.ts
  - services/kernel/src/content/reads.ts
  - services/kernel/src/content/README.md
  - services/kernel/src/content/conversation-activity*.ts
  - services/kernel/src/content/conversation-activity*.sql
  - services/kernel/src/content/schemas.ts
  - services/kernel/src/content/routes.ts
  - services/kernel/test/content/*board-page*.ts
  - packages/client/src/kernel/**
  - packages/client/src/index.ts
  - packages/client/tests/*board-page*.ts
  - contracts/openapi.json
  - apps/web/src/threads/**
  - services/kernel/scripts/client.ts
  - services/kernel/scripts/client.test.ts
  - services/kernel/scripts/typecheck.ts
  - services/kernel/README.md
  - services/kernel/src/content/reading-page*.ts
  - services/kernel/src/content/reading-routes*.ts
  - services/kernel/src/content/register.ts
  - services/kernel/src/content/runtime.ts
  - services/kernel/src/content/model.ts
  - services/kernel/test/content/*reading-page*.ts
  - services/kernel/test/content/support/*reading-page*.ts
  - packages/client/tests/*reading-page*.ts
  - packages/client/tests/feed-response.test.ts
  - packages/client/tests/watch-management.test.ts
  - packages/client/tests/publication-preparation-client.test.ts
  - packages/client/tests/*ban-review*.ts
  - apps/web/tests/*reading*.test.ts
  - services/kernel/src/rating/own-votes-counted.ts
  - services/kernel/src/rating/own-votes-counted.sql
  - services/kernel/src/rating/register.ts
  - services/kernel/src/rating/README.md
  - services/kernel/test/rating/*own-votes*.ts
  - services/kernel/test/rating/support/*own-votes-counted*.ts
  - packages/client/tests/*counted-own*.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
after:
  - 5a2e66c9-3f0d-4168-a2ad-117772a89e39
  - 4c5203e7-f966-44a3-9179-0fa8665af3db
  - 9f573536-fee5-478e-b7e7-4b902b04666c
  - 49acb79e-c0a9-4c77-8c0c-d177ac8a21c8
  - 40d4d5b5-b18f-4bf6-92cd-42bda003d6c6
estimate:
  lines: 3200
  files: 40
inseparable: true
---

# Publish the retained content journeys

The retained source already contains the thread reading route. Keep its generated client method, request transport,
current selected revisions and retry behavior aligned with the mounted route. The focused client transport test added
for this slice must remain green.

## Acceptance

- Publish one complete client and OpenAPI closure from the supported Kernel source command. Keep all compiler,
  construction, schema, migration, placement and output-tree checks intact; use emitted declarations and verify them
  from a consumer import.
- Deliver the retained Board journey through the existing Web reader, including its current/withheld activity witness,
  copied selected count, freshness and retry behavior. Preserve disclosure and caller retirement across Board, Realm,
  thread, author, media, credential and membership changes.
- Complete thread reading receiver delivery while preserving `loadThreadPage`, exact revisions and anchors, the selected
  reply cursor, local text, credentials and request lifetime. Keep missing citations unavailable and disclose actions
  only while their selected source remains current.
- Receive both Home context journeys, watch inventory, publication preparation, selected-account ban review, settings,
  decisions, mounted source classifications and counted own-score exports through the actual emitted client types.
  Keep existing producers and consumers as owners of their native and rendered acceptance.
- Preserve original growth, physical-prefix, source-retirement, cost, and retry requirements. The controller and current
  owner tasks retain broad native, browser, and integration execution.

## Remaining outcome

Complete the source-derived publication and all listed Web and client receivers. Recover the counted-own-score handoff
from its producer when it is available; do not invent missing native evidence or count estimates as proof. Finish with
separate source, emitted declaration, installed type, native, and rendered outcomes and list the remaining owner handoffs.
