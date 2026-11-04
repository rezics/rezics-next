---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/src/search/**
  - services/kernel/src/content/document-read.ts
  - services/kernel/db/search/indices/subjects.json
  - services/kernel/db/search/templates/*.json
  - services/kernel/test/search/document-text*.test.ts
  - apps/web/src/search/**
  - apps/web/src/routes/search.tsx
  - apps/web/tests/search-document-text*.test.ts*
  - apps/web/src/stories/search-document-text*.tsx
  - docs/search-conditions.md
  - contracts/openapi.json
  - packages/client/src/kernel/**
  - apps/web/messages/*.json
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
after:
  - a8e86e1a-0950-4924-b265-84a177786b8f
  - c26362f5-7fa4-4ed5-9fe8-948a1b994d03
  - d2518b19-dc8b-4e98-aa64-b1ab50f167bc
  - 11c7d924-1c01-4128-9fd4-40c45f36a1a0
  - 04c9d4ac-681c-43f4-89f8-e75ade0401d6
  - 36f869a6-f041-4523-ba5c-ff985cdee55c
  - a9431b6c-9146-4c20-b8db-b1fe73f867d9
  - 95a7834c-df6a-4877-af0b-6276648e95f1
  - e75ab0d2-bc64-4f36-9a37-c9029243995d
waiting: []
acceptance:
  tests:
    - "Install the bounded Content reader as the native public document producer, binding exact current Subject selection and rights across generation, relay and rebuild; cover edits, replacement, rights changes and identity changes."
    - "Add per-document phrase and actual-language query semantics, nested engine windows, cursor bindings for field/generation/recipe, and verified excerpt hydration with admitted destinations."
    - "Mount explicit public-document field selection on Search, preserve catalogue defaults and existing filters/sorts/language/rating/personal state, retire stale viewer/request state and restart incompatible cursors."
    - "Prove finite selected-page, byte and raw upstream work at independent 256/1024/4096 populations, plus body-only matches, edits, revocation, replacement, stale state, 390/1280 layouts and all eight locales."
estimate:
  lines: 1900
  files: 19
---

Remaining outcome: A reader can deliberately choose public document text on the mounted Search page, find phrases
from a currently readable document, and see its actual language, a verified bounded excerpt and admitted
Subject/document destination. Wire the bounded Content reader and exact current selection/rights probe into native
indexing and lifecycle rebuilds, then finish engine query, cursor, receiver and mounted Web behavior with focused
growth and browser tests.
