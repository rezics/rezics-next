---
goal: web
manager: web
kind: implementation
paths:
  - apps/web/src/library/personal-list-import
  - apps/web/src/library/personal-list-import.md
  - apps/web/src/routes/library/import-vndb.tsx
  - apps/web/messages
  - apps/web/tests/personal-list-import.test.tsx
  - docs/goals/web.md
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
after:
  - 9a318a13-05cc-4091-b724-b19eeb5b0fc6
  - 52f6851a-a994-4d30-8d0f-8fcdd6d65ce5
  - 2bb1fbdd-fd3b-4f51-a945-0faf1a112617
  - d45a389d-5107-4ef0-b7ad-7cb2d75932f5
  - 8c1bee86-cad5-47cf-a951-d090ffca2d34
waiting: []
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - '--private-network'
    - '--'
    - bun
    - test
    - tests/personal-list-import.test.tsx
  placement: default
  failing: true
  tests:
    - 'The installed generated client exposes typed VNDB score review, page and apply-result fields; Web sends only those generated requests and reports only native results.'
    - 'One selected row can review vote units or clear against the actual question and current vote, with separate explicit consent and no automatic conversion.'
    - 'State-only import leaves votes unchanged; source zero is invalid, native zero is valid, clear and absence remain distinct, and unsupported precision is preserved.'
    - 'A changed question, identity, vote observation or review requires a new confirmation and command key; an unknown result retries the original selected score review and apply command exactly.'
    - 'Partial cancellation preserves acknowledged state and vote outcomes, and retirement clears source, baseline, consent and late callbacks.'
estimate:
  lines: 1100
  files: 10
---

# Complete the published score review in the existing VNDB visit

Read [the Web owner](../../apps/web/src/library/personal-list-import.md) and
[Native score review and Caller cost and cleanup](../../docs/library-import-vndb.md#native-score-review).
Resolve these links from the repository root: `apps/web/src/library/personal-list-import.md` and
`docs/library-import-vndb.md`. The installed generated client remains state-only, although the native source has
score review and unavailable outcomes. Consume published generated fields without editing declarations, casting
the client or adding a raw endpoint. The existing generated request aliases are the minimal seam. Content atomic
vote admission remains unavailable; do not enable vote effects before its conditional writer is published.

Let the person review one selected VN row's exact original score beside the actual native question, meaning,
revision, scale and current vote observation. Explicit units and clear require separate consent; preserve the
existing vote by default. No rounding, clamping, automatic selection or exact-conversion claim for unsupported
precision. Source zero is invalid; native zero, clear and absence are distinct. Explain precisely the public and
aggregate effects of a successfully admitted choice, while showing native unavailability honestly.

Bind confirmation to the exact score review ID, upload, ordinal, target, question, revision, consent, apply
operands/key and credential visit. A changed basis needs fresh review and confirmation. Unknown retries reuse
the original command. Keep native stale, refusal, unsupported, unavailable and accepted score results separate
from Library-state results. Partial cancellation preserves acknowledged effects. Account, CSRF, exposure, locale
and source replacement erase private review context and prevent late callbacks restoring it.

Keep private notes, progress, privacy, labels, dates, release records and unknown XML as evidence. Retain the
2 MiB XML and independently escaped 12 MiB + 64-byte wire limits, eight-row native pages/results and one selected
row/intent. Derive added question, baseline and result bytes and fixed calls from the native owner contract.
Keep all eight locales, phone and desktop support, themes, wrapping 44px controls and keyboard review,
confirm, retry and return behavior. Extend the named test to exercise the generated score boundary and the
remaining acceptance cases; retain the state-only wire, exact retry and retirement assertions already present.
