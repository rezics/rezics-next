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
  - packages/client/tests/*diary*.ts
  - services/kernel/src/community/routes.ts
  - services/kernel/src/content/appeal-routes.ts
  - services/kernel/src/content/reports.ts
  - services/kernel/src/content/subject-threads-cards.ts
  - services/kernel/src/content/watch-management.ts
  - services/kernel/src/http/kernel.ts
  - services/kernel/src/http/problem-error.ts
  - services/kernel/src/http/problem.ts
  - services/kernel/src/library/collection-bulk-capture.ts
  - services/kernel/src/library/collection-bulk-operation.ts
  - services/kernel/src/library/copy-archive.ts
  - services/kernel/src/library/erasure-owned-graph.ts
  - services/kernel/src/library/import-consumption.ts
  - services/kernel/src/library/library-archive.ts
  - services/kernel/src/library/library-export-routes.ts
  - services/kernel/src/library/list-import-anilist-routes.ts
  - services/kernel/src/library/list-import-anilist.ts
  - services/kernel/src/library/list-import-bangumi-routes.ts
  - services/kernel/src/library/list-import-bangumi.ts
  - services/kernel/src/library/list-import-entry-metadata.ts
  - services/kernel/src/library/list-import-mal-routes.ts
  - services/kernel/src/library/list-import-mal.ts
  - services/kernel/src/library/list-import-vndb.ts
  - services/kernel/src/library/personal-routes.ts
  - services/kernel/src/library/shelf-score.ts
  - services/kernel/src/rating/classification-ballot-own-page.ts
  - services/kernel/src/rating/own-votes.ts
  - services/kernel/src/rating/routes.ts
  - services/kernel/src/rating/source-observation-read.ts
  - services/kernel/src/rating/source-provider-observation.ts
  - services/kernel/src/rating/source-statistics.ts
  - services/kernel/src/search/discovery-query.ts
  - services/kernel/src/search/generation-publication.ts
  - services/kernel/src/search/generations.ts
  - services/kernel/src/search/http/routes.ts
  - services/kernel/src/search/release-search-native-stream.ts
  - services/kernel/src/search/release-search-source.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
waiting: []
after:
  - 5a2e66c9-3f0d-4168-a2ad-117772a89e39
  - 4c5203e7-f966-44a3-9179-0fa8665af3db
  - 9f573536-fee5-478e-b7e7-4b902b04666c
  - 49acb79e-c0a9-4c77-8c0c-d177ac8a21c8
  - 40d4d5b5-b18f-4bf6-92cd-42bda003d6c6
  - 280e515c-d0ad-47f6-b6c0-e090766e8309
  - 17d21ed1-070a-40c4-a6ab-a1eb450e3361
estimate:
  lines: 2200
  files: 70
inseparable: true
criticalPath: false
---

# Complete the retained content publication

## Acceptance

Continue from this attempt's merged source. Repair the remaining Kernel compiler errors from the retained source set while preserving each existing runtime and user data contract. Then publish the source-derived client declarations and OpenAPI document using the supported complete-input command. Verify the emitted declarations through actual client consumer imports, including diary unavailable versus known-null dates, optional assessment states, counted-own-vote reader types, and the mounted realm ban request and complete response with root exports.

Finish the retained Board, current-thread, reading, Home, Watch, preparation, selected-account bans, settings, exact decisions, classifications, counted-own-votes, archive assessment, reflection choices, and diary journeys. Preserve currentness, revision, cursor, retry, cancellation, disclosure, and retirement behavior. Add only focused tests for missing user-visible behavior; run the landing command and typecheck each changed workspace. Keep construction, schema, migration, placement, output-tree, and installed-consumer gates intact. Native and rendered acceptance remain with their owners; report their handoffs and any unavailable checks precisely.

This attempt consolidates the duplicate annotation-correction mapping and repairs several source typing narrowings. It also records the retained OpenAPI title choice: `Library Entry Annotation Correction Limit Reached`. The remaining compiler repairs, publication, emitted-type consumer verification, and journey delivery are still required.
