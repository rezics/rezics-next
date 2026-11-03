---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/**
  - services/kernel/test/content/**
  - packages/client/**
  - docs/feeds.md
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
  - c4b0f225-d8b2-4886-9c57-ffc332947dbd
acceptance:
  - Kernel generation completes after retained type errors are resolved and regenerates OpenAPI/client declarations.
  - Native journey covers the named disclosure, deletion, authorization, retry, cursor, identity, and growth cases.
  - Home uses generated response fields for current review/parent context and reactions; all named Web states are reviewed.
  - Controller acceptance passes without weakening frozen checks.
estimate:
  lines: 2100
  files: 30
inseparable: true
---

# Finish the Home review and reply journey

Resolve the retained Kernel type errors that block the Kernel client declaration generator, then regenerate OpenAPI and
client declarations from that generator. Finish the native Home journey with registered Kernel effects, real Access,
command-created Subjects and questions, review/thread openings and replies. Cover public nonstandard, private and
withdrawn questions; absent, concealed and failed citation states; parent hide/removal, author erasure, Board and Realm
revocation, target rebinding, question withdrawal during hydration, duplicate parent/author keys, mismatched native
keys, stale anchors, empty and sparse pages, duplicate activities, raw/output limits, operational failure with exact
same-cursor retry, and account switch.

Complete the source-observation cost account for nested Content, Semantic, Accounts, Access, citation, mounted action
and reaction reads. Include rows, statements, bodies/serialization, physical homes, transaction/pool/runner phases and
retry. Add seeded 256/1024/4096 growth while raw/output limits, represented homes, selected context keys and admitted
payload bytes stay fixed; independently grow unrelated feed, Subject, author, thread ancestry/revision and
authority/grant history. Retain strict plan assertions and empty, denied, stale and retry branches.

Bind the existing Home card and shared `FeedActionBar` to the generated response without a Web DTO. Render current
review work, the exact cited question/revision/units, and a disclosed immediate parent with current author and exact
post/revision anchors. Cover concealed/removed parent, guest/denied/unavailable/successful advice, retry, language and
spoiler reveal, and request retirement on source, target and account changes. Keep experience acceptance open until
those states are reviewed against native responses. Preserve the current fixed-size outcome test and run the admitted
controller acceptance without weakening frozen files.

The current base's focused Kernel check stops before its tests with `Schema dump differs from db/library/schema.sql.`
Kernel typecheck also reports retained declaration-generation and workspace errors. Resolve these as part of this
continuation; failures already present on the base are not a reason to weaken acceptance.
