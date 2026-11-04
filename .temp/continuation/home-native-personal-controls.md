---
goal: web
manager: web
kind: interface
paths:
  - apps/web/src/features/feed/home-work-library/**
  - apps/web/src/features/feed/home-feed-item.tsx
  - apps/web/src/features/feed/action-bar.tsx
  - apps/web/src/features/pages/home-feed.tsx
  - apps/web/src/features/pages/home-feed-read.ts
  - apps/web/src/stories/home-work-library*.stories.tsx
  - apps/web/tests/home-work-library*.test.ts*
  - apps/web/messages/*.json
riskAreas:
  - authorization
  - disclosure
  - account
  - rights
  - deletion
criticalPath: false
waiting: []
after:
  - f676d56b-6ef8-4dc7-93d3-6c3942008c5e
  - b4fe8cc0-e42c-4c6f-8d95-f909e254c5fd
estimate:
  lines: 450
  files: 6
acceptance:
  tests:
    - Home consumes the generated admitted personal-actions page once by original occurrence key and original Subject; repeated rows remain distinct while acknowledged personal state reconciles.
    - 'Current allowed=[] is successful; current exact Entry/progress and standard manual vote operations alone install existing writers, and unavailable facts retain public Home and its exact Library return.'
    - 'Final source admission withholds affected occurrences without refill and preserves the original retry frontier; withdrawn occurrences and reader replacement retire command callbacks and delayed completions, preserving unresolved operands, credential and key.'
    - Focused tests cover existing-writer dispatch, unresolved-command retry and delayed retirement using generated command operands.
---

Complete Home's native personal controls after the generated client publishes the `viewerPersonalActions` response and its currentness exports. Bind those generated exports to the existing Home page request and shared observation adapter. Keep the local presentation model separate from the transport, preserve original occurrence keys, Subjects, cursor and source filters, and use the existing Entry/progress and manual vote writers. Do not add a query or endpoint, handwrite browser DTOs, or regenerate another owner's exports. Keep fact display independent from permission, review citations independent from the reader's counted vote, and public-owner cards on their existing continuation. Preserve the original command operands, credential and idempotency key across unresolved retries. Final native source admission owns withholding, no refill and the retry frontier. Keep the existing locale, keyboard/focus, theme and responsive behavior.
