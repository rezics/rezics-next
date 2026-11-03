---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/content/feed*.ts
  - services/kernel/src/content/feed*.sql
  - services/kernel/src/content/reads.ts
  - services/kernel/src/content/model.ts
  - services/kernel/src/content/schemas.ts
  - services/kernel/src/content/README.md
  - services/kernel/test/content/*feed*.ts
  - services/kernel/test/content/support/*feed*.ts
  - docs/feeds.md
  - packages/client/src/kernel/**
  - contracts/openapi.json
  - packages/client/src/index.ts
  - packages/client/tests/feed-response.test.ts
  - services/kernel/src/content/subject-threads*.ts
  - services/kernel/test/content/*subject-thread*.ts
  - apps/web/**
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
after:
  - a99aa260-84bc-4a92-894d-dec4d184ca99
  - 61c22655-8419-4792-864c-0aa89aadc8f7
  - f0faf5f4-b4f6-48df-857b-5f6dcb788b2a
  - 8b12f621-6d53-49d4-a436-a08f89923341
  - 870b9d25-0fc6-4def-8aea-8f1810cf4f95
estimate:
  lines: 2140
  files: 17
inseparable: true
---

# Finish native Home context delivery and growth acceptance

The native feed and Subject-thread projectors already produce review and immediate-parent context. The client
declaration closure is stale, so Home cannot consume that shape yet. Preserve the product choice in
`apps/web/src/features/feed/README.md` and the behavior contract in `docs/feeds.md`.

Publish the actual generated client closure through the Kernel generator and add public aliases only after the
generated declarations expose the fields. Do not cast missing fields, add a second Web DTO, or suppress generator
errors. The current retained Kernel typecheck still reports existing type errors across client, community, Content,
Search and Semantic; resolve the source errors needed for generation without weakening the check.

Integrate the existing Home card and `FeedActionBar`. Render current review target and citation details, including
question and vote revisions, and only the exact immediate parent with its native post/revision link, disclosed
author, language and spoiler shape. A removed parent keeps its tombstone shape; withheld, absent and unavailable
context must never fall back to hidden bodies, citations or identities. Retire displayed context and pending actions
when account, source, target or request selection changes. Bind reactions from the native target, count map, viewer
selection and page freshness; do not add a reaction producer. Advice comes from mounted production resource readers
where available, and commands continue to reauthorize.

Extend native production coverage through real Access, registered effects and command-created Subjects, questions,
reviews, threads and replies. Include public nonstandard questions; private and withdrawn questions; absent,
concealed and failed citations; parent hide/removal; author erasure; Board/Realm revocation; target rebinding; and
question withdrawal between selection and final hydration. Assert exact destinations, current source revisions,
author/language/spoiler output, reaction counts/freshness/selection, and strict withholding. Cover duplicate and
mismatched keys, stale anchors, sparse pages, duplicate activities, limits, dependency retry with the same cursor,
and account switches. Use mounted readers to exercise guest, denied, unavailable and successful reply/report/revise
advice without granting commands from a readable card.

Finish the source-observation account for every nested Content, Semantic, Accounts, Access, citation, action and
reaction read, including physical homes, rows, statements, full-body/serialization bytes, transaction/pool/runner
phase and retries. Include native `readPost` ancestry/revision work. Keep strict route, identity, cursor-prefix,
withholding and native seeding assertions; measure independent 256/1024/4096 growth while holding raw/output
limits, represented homes, context keys and admitted payload bytes fixed. Cover empty, denied, stale and retry
branches.

Prepare only the named Home review-context stories as review inputs and use actual native responses. The experience
acceptance gap remains open until the existing Web Home owner reviews populated review/reply, concealed/removed
parent, signed-out actions, retry, language/spoiler and account-switch states. Native, browser and broad acceptance
remain deferred until the controller runs them.
