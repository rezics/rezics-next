---
goal: web
manager: web
kind: interface
hostileInput: true
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
waiting: []
after:
  - ce4d74f2-a15f-4dcc-ba12-ec4bd7cf4177
  - eda59d58-d2b6-4674-a92c-3b5cc345c2cb
  - 9baab464-5087-47e7-b977-326b470d5fb3
  - ab2fc3d5-d8f1-42a0-aeb1-58dc425fe062
  - e552970d-d451-4c1a-bde9-ff9bbaebd904
paths:
  - apps/web/src/ratings/own-classifications/**
  - apps/web/src/routes/library/classification-assessments.tsx
  - apps/web/src/features/pages/subject-classification-assessment.ts
  - apps/web/src/features/pages/subject-classification-assessment-actions.ts
  - apps/web/src/features/pages/subject-classification-assessment-commands.ts
  - apps/web/src/stories/own-classification-assessments.stories.tsx
  - apps/web/tests/own-classification-assessments*.test.ts*
  - apps/web/tests/subject-classification-assessment.test.tsx
  - apps/web/tests/composed-account-navigation-targets.test.tsx
  - apps/web/messages/*.json
  - docs/goals/web.md
estimate:
  lines: 700
  files: 10
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - '--private-network'
    - '--'
    - bun
    - test
    - tests/own-classification-assessments-journey.test.tsx
    - tests/own-classification-assessments-currentness.test.tsx
    - tests/own-classification-assessments-recovery.test.tsx
    - tests/subject-classification-assessment.test.tsx
    - tests/composed-account-navigation-targets.test.tsx
  placement: default
  tests:
    - 'A signed-in person reaches their private current retained classification assessments from existing personal navigation, inspects an admitted exact association, changes an admitted ballot or withdraws it, and returns to the same native frontier with current focus.'
    - 'Native available, withheld, empty, sparse continuation, selected promotion, dependency unavailable, revoked and moved-home outcomes preserve original immutable keys and never infer complete account history or public permission.'
    - 'Native action advice and current browser admission gate writes; withheld withdrawal reveals no concealed labels or links, visible binding mismatch never promises withdrawal, and exact uncertain clear retries preserve method, operands, credentials and key before distinct supported readback.'
    - 'Account, credential and CSRF episode, delegation, scope, locale, cursor, selected association, exposure and source replacement retire private rows, editors, intents and late effects; unknown acknowledgements cannot be silently refreshed away.'
  failing: true
---

Once the installed Client publishes the native own-page read and exact assessment advice operations, connect the existing private destination to those typed operations. A signed-in person should see current retained assessments rather than complete history, inspect an admitted original Subject/association pair, change or withdraw a ballot only when current native advice permits it, and return to the same frontier with fresh admission and focus.

Preserve native order, sparse continuation, opaque cursors, the page limit and selected promotion, and immutable association keys when summary destinations move. Keep withheld rows free of concealed labels and links. Distinguish unavailable dependencies, revoked access, stale continuation and moved-home. Keep aggregate absence, suppression and published zero distinct.

Bind each read and command to the current account, credential/authn/CSRF episode, client/delegation/scopes, exposure, locale, full address and native observation. Retire private rows, editors, intents and late effects when that visit changes. Retry uncertain writes with their exact original request and credentials; show supported readback separately. Add the mounted account-row, command, withheld-withdrawal, uncertain-clear and open/return tests, plus the two connected stories with existing locale/theme controls. Keep the typed unavailable seam until the generated operations are delivered.
