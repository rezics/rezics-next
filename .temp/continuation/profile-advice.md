---
goal: performance
manager: performance
kind: implementation
paths:
  - apps/web/src/settings/profile.tsx
  - apps/web/src/settings/profile-write-query.ts
  - apps/web/src/settings/editable-profile-source.ts
  - apps/web/src/settings/profile-avatar-source.ts
  - apps/web/src/settings/profile-avatar-upload.ts
  - apps/web/src/settings/profile-navigation.tsx
  - apps/web/src/settings/profile-preview.tsx
  - apps/web/src/settings/settings-page.tsx
  - apps/web/src/settings/actions.ts
  - apps/web/src/settings/profile-data.ts
  - apps/web/src/settings/profile-links.tsx
  - apps/web/src/settings/profile-write-input.ts
  - apps/web/src/settings/profile-write.ts
  - apps/web/src/settings/public-views.tsx
  - apps/web/src/accounts/profile-editor/data.ts
  - apps/web/src/kernel/fake/settings-profile.ts
  - apps/web/src/stories/accounts-profile-editor/profile.stories.tsx
  - apps/web/tests/settings-profile-journey.test.ts
  - apps/web/tests/settings-watches-view.test.tsx
  - apps/web/tests/settings-watches.test.ts
riskAreas:
  - account
criticalPath: false
after:
  - 0d2ac28d-712e-4195-a8d2-0545f480647c
  - f5964f2a-2b68-426c-8aae-327f9a48bcd7
  - 52f118d4-a8a9-48ef-9857-0ff2ced36f58
  - 36809154-70b6-4333-88f9-a762fd612337
waiting: []
estimate:
  lines: 850
  files: 20
acceptance:
  tests:
    - apps/web/tests/settings-profile-journey.test.ts
    - apps/web/tests/settings-watches-view.test.tsx
    - apps/web/tests/settings-watches.test.ts
---

# Finish current profile and watch workflows through official installed advice

The current installed `account-edit-profile.d.ts` exposes only `{ profile }`. Wait for Content's completed compiler, generation and installed-root output before wiring profile and media advice into this consumer. Keep that publisher's work independent; do not change the generated client contract here, invent an admission identifier, or replace the missing output with a local API mirror or route cast.

Use current account recognition and official `account:update` advice for permitted profile fields, public views and avatar references. Keep private decoding and serialization strict and bound to the current viewer and target, with native limits and actor/organization applicability. Read permission alone grants no command. Show missing advice as unavailable, disable denied controls, and require review when advice changes. Clear private values on denial, unknown session or retirement while retaining a same-viewer transient draft honestly. Preserve each uncertain patch, key and credential, fence late completion, and distinguish PATCH acknowledgement from fresh-GET saved confirmation.

Keep self `media:create` upload advice independent of account update advice. Retain same-file/body/purpose/container/credential/key across lost reservation acknowledgements, resume known media identity through the shared Web bridge, retire changed file/crop/target/session intents, preserve native 20 MiB objects, 4 KiB bridge input, 32 polls/60 seconds, and dispose object URLs.

After boot repair and ordinary `seed:dev`, complete the real routed current-account profile and thread/board watch journey through Web's shared composition owner. Use current native inventory and established product subscriptions, inspect disclosed targets and concealed subscriptions, remove a watch and confirm refreshed inventory, and exercise denied, unavailable and uncertain seams. Preserve bounded replacement pages, same-cursor retry and explicit cursor-free restart. Coordinate local-only exposure groups with setup through existing platform commands.

Keep the three focused tests above. The controller owns broader/native gates. Defer the supermanager visual walkthrough (390/1440 px, both themes, keyboard focus, localized long names, overflow and truthful pending/error/saved states); fixture tests do not prove it.
