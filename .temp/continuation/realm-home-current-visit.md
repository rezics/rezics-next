---
goal: web
manager: web
kind: interface
riskAreas:
  - authorization
  - disclosure
  - account
  - deletion
  - rights
criticalPath: false
waiting: []
paths:
  - apps/web/src/community/space.ts
  - apps/web/src/community/space-actions.ts
  - apps/web/src/community/space-queries.ts
  - apps/web/src/community/space-page.tsx
  - apps/web/src/community/space-page-lifetime.tsx
  - apps/web/src/community/space-page-lifetime.md
  - apps/web/src/community/realm-home*.ts*
  - apps/web/src/community/realm-membership.tsx
  - apps/web/src/community/publication-controls*.ts*
  - apps/web/src/stories/realm-home*.stories.tsx
  - apps/web/tests/space-page*.test.ts*
  - apps/web/tests/realm-home*.test.ts*
  - apps/web/tests/realm-shelf-continuation-focus.test.tsx
  - apps/web/messages/*.json
  - docs/goals/web.md
  - services/kernel/src/community/realm-home.ts
  - services/kernel/src/community/routes.ts
  - packages/client/src/kernel/community/routes.d.ts
after:
  - 67d35a0b-0266-40a7-ad13-76769a662e5a
  - ad9468d7-c356-4bbc-b09f-680d0de12de9
  - 65a4b80c-e821-4afe-b6df-4e4aefb5e973
estimate:
  lines: 1100
  files: 18
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - '--private-network'
    - '--'
    - bun
    - test
    - tests/space-page-render.test.ts
    - tests/space-page-lifetime.test.tsx
    - tests/realm-home-header-interface.test.tsx
    - tests/realm-shelf-continuation-focus.test.tsx
  placement: default
  tests:
    - Default Space and Realm destinations consume the mounted home with its current native viewer observation and generated Client operation.
    - 'Native advice alone admits participation, join, leave, claim and management; anonymous, member, denied, banned, orphaned, concealed, missing carrier and operational failure remain distinct.'
    - 'Complete visits retire on credential, locale, route, container, lifecycle, presentation and native-observation replacement; native batches and independent continuations retain keyboard retry and return focus.'
  failing: true
---

Complete the current Realm-home visit using Content's composed viewer observation and Client's generated home,
boardShelf and publicationShelf declarations. Preserve the original prepared reader and route admission described
in [the lifetime guide](../../apps/web/src/community/space-page-lifetime.md#realm-home-source-boundary).

The retained producer still exposes only anonymous/unavailable viewer states and advice in
`services/kernel/src/community/realm-home.ts`; the generated community declarations still omit all three operations.
Separate standing reads cannot supply the missing composed observation. Build against the delivered contract or a
minimal seam without synthesizing member standing. The controller owns generated delivery and frozen acceptance.

The prepared consumer remains injectable in `realm-home-native.ts`. Its route lifetime now captures the exact page,
container, lifecycle, presentation and native observation before mounting. Nested replacement or an outer page copy
retires that admission, including media and pending shelf callbacks. Authored consumer cases cover these retirements
and rejection of an initial native result after session replacement. They do not establish generated/default delivery
or native/browser acceptance.

Bind the generated operations in existing server actions after address resolution, retaining one session preparation,
reader origin and language selection. Replace default legacy home/shelf reads and their per-publication Subject reads.
Replace the local unavailable-only DTO with the delivered composed DTO. Preserve canonical redirects, absent versus
concealed carrier identity, operational failure, source/container/head/presentation binding, existing command owners,
Space following and independent source-bound raw cursors.

Render standing, participation, join, leave, claim and management only from admitted native advice. Preserve orphan
read-only identity. Require a fresh admitted response after credential, locale, route, Realm/Space, lifecycle,
presentation or native-observation replacement. Do not substitute standalone rendering comparisons for route/session
admission. Retain sparse continuation, same-cursor retry, keyboard/return focus, 1/6/12 native batches, shared cards and
safe body/media rendering. Complete mounted member/denied/banned advice, default route binding, missing carrier and
membership replacement cases. Use all eight locales, wrapping 44px actions and phone390/desktop1280 layouts; add only
stories for named states. Keep frozen files unchanged.

Run only the verification authorized by the launch context: changed-workspace typechecking and changed test files;
the controller runs deferred acceptance after integration.
