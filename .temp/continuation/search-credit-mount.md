---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/src/search/credit-search*.ts
  - services/kernel/src/search/source.ts
  - services/kernel/src/search/document.ts
  - services/kernel/src/search/indexer.ts
  - services/kernel/src/search/indices.ts
  - services/kernel/src/search/default-discovery.ts
  - services/kernel/src/search/query*.ts
  - services/kernel/src/search/service.ts
  - services/kernel/src/search/discovery-query.ts
  - services/kernel/src/search/http/routes.ts
  - services/kernel/src/search/http/*schemas*.ts
  - services/kernel/src/search/search-relations.ts
  - services/kernel/src/search/discovery-documents.ts
  - services/kernel/src/search/writer-guard.ts
  - services/kernel/src/search/public-filter-consumer.ts
  - services/kernel/src/search/public-filter-consumer-contract.ts
  - services/kernel/src/search/public-filter-custody.ts
  - services/kernel/src/search/README.md
  - services/kernel/db/search/indices/subjects.json
  - services/kernel/db/search/indices/discovery-mixed-v1.json
  - services/kernel/db/search/templates/*.json
  - services/kernel/test/search/credit-search*.test.ts
  - services/kernel/test/semantic/search-credit*.test.ts
  - apps/web/src/search/credit-search*.ts*
  - apps/web/src/search/search.tsx
  - apps/web/src/search/discovery.ts
  - apps/web/src/routes/search.tsx
  - apps/web/tests/search-credit-search*.test.ts*
  - apps/web/src/stories/search-credit-search*.tsx
  - contracts/openapi.json
  - packages/client/src/kernel/**
  - apps/web/messages/*.json
  - services/kernel/src/semantic/list-presentation-work-context.ts
  - services/kernel/src/semantic/search-source.ts
  - services/kernel/src/semantic/search-relations.ts
  - services/kernel/src/semantic/public-filter-source-contract.ts
  - services/kernel/src/semantic/public-filter-source.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
after:
  - 86fd58a7-3789-47b4-9b0d-4c581676f155
  - 9064510a-4cdb-4857-811f-2cdae25b2dda
  - c26362f5-7fa4-4ed5-9fe8-948a1b994d03
  - d2518b19-dc8b-4e98-aa64-b1ab50f167bc
  - 11c7d924-1c01-4128-9fd4-40c45f36a1a0
  - 04c9d4ac-681c-43f4-89f8-e75ade0401d6
  - a8e86e1a-0950-4924-b265-84a177786b8f
  - 36f869a6-f041-4523-ba5c-ff985cdee55c
  - a9431b6c-9146-4c20-b8db-b1fe73f867d9
waiting: []
acceptance:
  tests:
    - 'A reader can deliberately search currently public credited creator names and receive the corresponding works, even when that name is absent from the work title and description.'
    - 'Native same-statement role/target identity and creator disclosure are retained; a concealed, withdrawn, merged or changed credited name cannot justify a stale result.'
    - 'The live field choice, actual matched-name evidence and current result work through mixed/catalogue Search without changing ordinary title-query meaning or replaying incompatible cursors.'
    - 'Mount the retained bounded CreditSearchSource consumer using native complete seeks, dependency invalidation and final disclosure; demonstrate 256/1024/4096 independent growth with fixed page and byte bounds.'
    - 'Cover contributor-only and title-only searches, exact homonymous role operands, nonmatching descriptions, source replacement, incomplete coverage, relay/rebuild replay, stale cursors, and keyboard/phone selection.'
estimate:
  lines: 2350
  files: 34
---

# Mount complete credited-name retrieval

The owning search-conditions document now records the default field choice, and fresh Subject index definitions carry an additive credited-name mapping plus an explicit coverage-format marker. The retained consumer types are connected to the native Subject source contract. The live Semantic adapter, complete native seeks, index projection and invalidation, honest coverage publication, query admission, cursor/share binding, mixed and catalogue result disclosure, typed client, localized control, stories, and receiver tests remain to be completed.

Preserve ordinary all-catalogue text as the default. Make credited-creator search an explicit choice and keep it unavailable until complete coverage is published. Use released credit properties, exact same-statement target and role qualifiers, actual engine match evidence, and final current native disclosure. A hidden, retired, merged, renamed, or replaced creator must invalidate derived witnesses. Bound native selection and nested label work, retain relay/rebuild invalidation, and keep query meaning in shared captures and cursor bindings. Reuse the Content complete-input publisher for shared declarations. Keep permissions and literal-credit identity unchanged.
