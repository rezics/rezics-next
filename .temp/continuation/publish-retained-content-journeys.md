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
  - packages/client/tests/*board-page*.ts
  - packages/client/tests/*counted-own*.ts
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
  - e890995e-7c7e-4c40-a495-9fdaeaed865d
estimate:
  lines: 3200
  files: 39
inseparable: true
---

# Publish the retained content journeys

## Acceptance

- Publish a complete client declaration and OpenAPI closure from the supported Kernel source command. Keep compiler, construction, schema, migration, placement, and output-tree checks intact; verify the emitted declarations from a consumer import.
- Receive the retained Board and thread routes in the existing Web readers. Preserve activity witness and selected-count freshness, cursors, exact revisions, anchors, local text, credentials, request lifetime, disclosure, retry, and caller retirement.
- Receive both Home context journeys, watch inventory, publication preparation, selected-account ban review, settings, decisions, mounted source classifications, and counted own-score exports through emitted client types.
- Keep native and rendered acceptance with their existing producers and consumers; report those outcomes separately and do not treat estimates as proof.

## Remaining outcome

At the current source, the supported command `bun run --cwd services/kernel typecheck --emit-client --emit-openapi` stops in declaration generation at the existing Kernel diagnostic `src/community/routes.ts(1617,7): error TS2345`. It returns no client output tree or OpenAPI artifact. The installed client typecheck also reports the missing `./kernel/rating/own-votes-counted` declaration. Complete source publication and the remaining consumer handoffs after the base Kernel compiler errors are resolved, then record separate source, emitted declaration, installed type, native, and rendered outcomes.
