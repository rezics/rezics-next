---
goal: performance
manager: performance
kind: implementation
paths:
  - apps/web/src/settings/managed-accounts-read.ts
  - apps/web/src/settings/managed-account-detail-read.ts
  - apps/web/src/settings/managed-accounts.tsx
  - apps/web/src/settings/managed-account-detail.tsx
  - apps/web/src/settings/settings-page.tsx
  - apps/web/src/settings/README.md
  - apps/web/src/accounts/management/pages.tsx
  - apps/web/src/accounts/management/story-api.ts
  - apps/web/src/stories/pages/settings-managed-accounts.stories.tsx
  - apps/web/src/stories/patterns/managed-accounts.fixtures.ts
  - apps/web/src/stories/patterns/managed-accounts.stories.tsx
  - apps/web/tests/settings-managed-accounts.test.ts
  - apps/web/tests/settings-managed-accounts-regions.test.tsx
  - apps/web/messages
  - docs/accounts.md
riskAreas:
  - account
criticalPath: false
after:
  - 1d452620-3966-4794-8d33-fdd3ff52ad8a
  - 1fe35e19-d8cc-4ca8-851e-75cd8556bd5b
  - d9c5a408-5c67-4d33-bf97-76a9918a21b5
  - be500e5e-32ba-467b-8bae-b24cf67af0b2
  - 8e6b0ef9-7b6e-45a4-9a46-d0476b6adbdc
waiting: []
estimate:
  lines: 750
  files: 12
acceptance:
  tests:
    - apps/web/tests/settings-managed-accounts.test.ts
    - apps/web/tests/settings-managed-accounts-regions.test.tsx
---

# Complete native managed-directory navigation and bounded return

Owners: [Accounts](../../docs/accounts.md#managed-account-detail-presentation) and
[Settings](../../apps/web/src/settings/README.md#account-safety), relative to the repository root.

Finish the retained Settings integration after Content's controller-admitted publication and complete generated
client output are available. Consume the official current-human viewer and row-navigation observation. An exact
admitted target opens the fixed detail route; unavailable or concealed advice leaves identity rows unlinked and
shows unavailable feedback. Keep one bounded directory observation for return only under the same viewer and
Settings route. Other returns load a fresh directory. Credential, viewer, client, sign-out, disposal and A-to-B-to-A
transitions retire identity and feed state before late callbacks can restore it.

Preserve native `authActions`, no-store reads, original authorization, strict decoding, failure distinctions,
independent feed pages, exact retry operands and scoped heading focus. The managed-detail response-wait correction is
owned by `decisions/managed-detail-response-deadlines.md`. Update only the existing standalone management display,
fixture and story call sites to the official envelope. Do not add a story family, a handwritten client mirror, or a
navigation provider.

Extend the two focused test files for admitted detail/back and retirement behavior. Type-check `apps/web` and run
the changed focused tests with the landing command. Native, rendering, browser and broader acceptance remain with
the controller.
