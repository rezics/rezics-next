---
goal: content
manager: content
kind: claim
paths:
  - packages/client/src/kernel/**
  - packages/client/src/index.ts
  - packages/client/tests/*board-page*.ts
  - contracts/openapi.json
  - services/kernel/scripts/client.ts
  - services/kernel/scripts/client.test.ts
  - services/kernel/scripts/typecheck.ts
  - services/kernel/README.md
  - packages/client/tests/*reading-page*.ts
  - packages/client/tests/feed-response.test.ts
  - packages/client/tests/watch-management.test.ts
  - packages/client/tests/publication-preparation-client.test.ts
  - packages/client/tests/*ban-review*.ts
  - packages/client/tests/*counted-own*.ts
  - packages/client/tests/*diary*.ts
  - services/kernel/src/http/kernel.ts
  - services/kernel/src/http/problem-error.ts
  - services/kernel/src/http/problem.ts
  - packages/client/tests/*reading-insights*.ts
  - packages/client/tests/*reporter-history*.ts
  - packages/client/tests/*library*.ts
  - services/kernel/src/content/appeal-routes.ts
  - services/kernel/src/content/reports.ts
  - services/kernel/src/content/subject-threads-cards.ts
  - services/kernel/src/content/watch-management.ts
  - services/kernel/src/community/routes.ts
  - services/kernel/src/community/realm-home*.ts
  - services/kernel/src/content/realm-board-home.ts
  - services/kernel/src/content/realm-community*.ts
  - services/kernel/src/library/*.ts
  - services/kernel/src/rating/*.ts
  - services/kernel/src/search/*.ts
  - services/kernel/src/search/http/routes.ts
  - services/kernel/src/semantic/http/subjects.ts
  - services/kernel/src/content/schemas.ts
  - services/kernel/src/content/routes.ts
  - services/kernel/src/content/author-contribution-actions-schema.ts
  - services/kernel/src/content/media.ts
  - services/kernel/src/semantic/scope-leaf-selection.ts
  - services/kernel/test/**
  - packages/client/src/preference-page.ts
  - packages/client/tests/preference-page.test.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
waiting: []
after:
  - e9314e51-a782-43e9-b55a-017dcc1bac53
  - d9c5a408-5c67-4d33-bf97-76a9918a21b5
  - 440b8c83-d099-456c-9981-e066260cfde7
estimate:
  lines: 2400
  files: 48
inseparable: true
criticalPath: false
acceptance:
  tests:
    - "Official complete-input compiler, construction, schema, migration, placement, output-tree and generator gates succeed without declaration filtering or hand-edited output."
    - "Existing client installed-callable/root-import checks cover Collection structure and metadata history, complete member personal actions, FULL Copies/Following inputs, Progress discovery, selected-account bans, and Reading Insights."
    - "Keep diary, counted, preparation, watch, feed, reporter-history, preference decoding, Reading/notification/shelf envelopes, malformed-shelf isolation and actual update advice."
    - "Retain verification-stall-recovery and notification-preference-page receiving with their current owners; deliver generated callable/root types independently of consumer completion."
    - "The exact frozen acceptance remains controller-owned after integration."
---

# Complete the retained native client publication

Realm Home's closed-response type mismatch is repaired in the retained source. The response helper now returns the
existing Realm Home schema type, and the board page schema preserves the native BoardRecord type without changing
its runtime schema or read policy. No installed declaration, OpenAPI document or public client root was generated.

Finish the remaining source-correct compiler repairs in the admitted Content, Library, rating, search and Semantic
contracts, including Collection history SQL cardinality/nullability, importer implementations, Copy/Following types,
rating query results and scope-leaf provenance. Preserve current authorization, disclosure, rights, deletion and
account behavior. The current Kernel workspace typecheck also reports existing test-fixture type errors across
community, imports, library, rating, search, semantic and work; repair those only where required to restore the
supported workspace typecheck, retaining every assertion of unchanged behavior.

Once source and workspace compilation succeed, run the supported complete-input compiler, construction, schema,
migration, placement and output-tree gates with the official client and OpenAPI generators. Replace handwritten
preference, ban, Copy, account and Inbox envelope/root overrides only together with successful complete output.
Publish the native callable closure through the existing public client entry and preserve all current decoder,
header, error, abort and operation-name behavior. Keep the installed-callable/root-import acceptance families
listed above and add only the smallest missing assertions. Do not introduce a second compiler, descriptor, package,
generator or runtime policy.
