---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/{access,command,commerce,community,content,library,rating,search,semantic,work}/**
  - services/kernel/test/{content,search,semantic}/**
  - packages/client/src/kernel/**
  - packages/client/src/index.ts
  - contracts/openapi.json
  - packages/client/tests/feed-response.test.ts
  - docs/feeds.md
  - apps/web/src/features/feed/**
  - apps/web/src/features/pages/home-feed.tsx
  - apps/web/test/feed-review-context.test.tsx
  - apps/web/src/stories/**
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
  - 1999e5da-60c2-4a04-bd0d-1d85b2bc88b1
estimate:
  lines: 1900
  files: 40
inseparable: true
---

# Finish native Home context delivery and growth acceptance

The retained source now renders native review and immediate-parent context on Home through the existing card and
action bar, projects reactions from the native response, and has focused receiving coverage. The owner docs record
the exact vote-unit, disclosure, and spoiler-reveal behavior. OpenAPI contains the closed context shape. The
generated client declaration closure is still stale: Kernel generation stops on retained TypeScript errors. Fix the
source errors needed for generation without weakening checks, then publish the actual generated declarations. Add
public aliases only after those declarations expose the native fields. Do not cast missing fields or add a Web DTO.

Complete native lifecycle coverage through real Access, registered effects, and command-created Subjects,
questions, reviews, threads, and replies. Include public nonstandard questions; private and withdrawn questions;
absent, concealed, and failed citations; parent hide/removal; author erasure; Board/Realm revocation; target
rebinding; and question withdrawal between selection and final hydration. Assert exact destinations, current source
revisions, author/language/spoiler output, reaction counts/freshness/selection, and strict withholding. Cover duplicate
and mismatched keys, stale anchors, sparse pages, duplicate activities, limits, dependency retry with the same
cursor, and account switches. Use mounted resource readers for guest, denied, unavailable, and successful
reply/report/revise advice without granting commands from a readable card.

Finish the source-observation account for every nested Content, Semantic, Accounts, Access, citation, action, and
reaction read, including physical homes, rows, statements, full-body/serialization bytes, transaction/pool/runner
phase, and retries. Include native `readPost` ancestry/revision work. Keep strict route, identity, cursor-prefix,
withholding, and native seeding assertions. Measure independent 256/1024/4096 growth while holding raw/output
limits, represented homes, context keys, and admitted payload bytes fixed. Cover empty, denied, stale, and retry
branches.

Prepare only the named Home review-context stories with actual native responses. Experience acceptance remains open
until the existing Home owner reviews populated review/reply, concealed/removed parent, guest and denied/unavailable/
successful advice, retry, language/spoiler, and account-switch states. Native lifecycle, three-scale growth,
performance review, browser, and broad acceptance remain deferred until the controller runs them.
