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
  - 9f573536-fee5-478e-b7e7-4b902b04666c
estimate:
  lines: 2100
  files: 17
inseparable: true
---

# Finish the Home review and reply journey

The Content response context and native fixed-size regression already exist. The current attempt regenerated
`contracts/openapi.json` from Kernel sources and repaired two runtime initialization cycles that stopped OpenAPI
construction. The Kernel client declaration generator still fails on retained workspace type errors, so generated
feed DTO aliases and the Web consumer remain unfinished. Do not hand-edit or fork a client DTO.

Complete the remaining native journey with the registered Kernel effects, real Access, command-created Subjects,
questions, review/thread openings and replies. Cover public nonstandard, private and withdrawn questions; distinguish
absent, concealed and failed citation states; parent hide/removal, author erasure, Board and Realm revocation, target
rebinding, question withdrawal during hydration, duplicate parent/author keys, mismatched native keys, stale anchors,
empty and sparse pages, duplicate activities, raw/output limits, operational failure with exact same-cursor retry,
and account switch. Preserve safe disclosure, exact destinations and anchors, reaction totals/freshness and the viewer's
current selection. Keep the current fixed-size outcome test.

Complete the source-observation cost account with Performance for nested Content, Semantic, Accounts, Access, citation,
mounted action and reaction reads, including rows, statements, bodies/serialization, physical homes, transaction/pool/
runner phases and retry. Add seeded 256/1024/4096 growth while raw/output limits, represented homes, selected context
keys and admitted payload bytes stay fixed; independently grow unrelated feed, Subject, author, thread ancestry/revision
and authority/grant history. Retain strict plan assertions and empty, denied, stale and retry branches.

Regenerate OpenAPI and client declarations from the Kernel generator when its retained type errors are resolved. Then
bind the existing Home card and shared `FeedActionBar` to the generated response without introducing a Web DTO. Render
current review work, exact cited question/revision/units, and a disclosed immediate parent with current author and exact
post/revision anchors. Cover concealed/removed parent, guest/denied/unavailable/successful advice, retry, language and
spoiler reveal, and request retirement on source, target and account changes. Keep the experience acceptance gap open
until those states are reviewed against native responses.

The current focused Kernel test command stopped before executing its tests because the remote check reported
`Schema dump differs from db/library/schema.sql.` Kernel typecheck completed with retained declaration-generation and
workspace errors, including missing generated `packages/client` declarations. Resolve those without weakening frozen
acceptance, then run the admitted acceptance through the controller.
