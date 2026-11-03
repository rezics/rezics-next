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
estimate:
  lines: 1150
  files: 18
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - "--private-network"
    - "--"
    - bun
    - test
    - tests/space-page-render.test.ts
    - tests/space-page-lifetime.test.tsx
    - tests/realm-home-header-interface.test.tsx
    - tests/realm-shelf-continuation-focus.test.tsx
  placement: default
  tests:
    - "Default Space and Realm destinations consume the mounted home with its current native viewer observation and generated Client operation."
    - "Native advice alone admits participation, join, leave, claim and management; anonymous, member, denied, banned, orphaned, concealed, missing carrier and operational failure remain distinct."
    - "Complete visits retire on credential, locale, route, container, lifecycle, presentation and native-observation replacement; native batches and independent continuations retain keyboard retry and return focus."
  failing: true
---

Complete the current Realm-home visit after Content composes the viewer observation into RealmHomePage and the
Client publishes home, boardShelf and publicationShelf declarations. Preserve original ad9468d7 custody. The base
reader still supplies only anonymous/unavailable viewer/actions; source717b4184ed and separate reads do not deliver
the missing composed observation.

The prepared consumer is apps/web/src/community/realm-home-native.ts. It accepts the current unavailable-only
protocol and maps native summaries without per-Subject reads. SpacePage recognizes its nativeObservation, renders
shared presentation/shelves and suppresses independent command readers. It is injectable rather than default-bound.
Native consumer tests are apps/web/tests/realm-home-native-visit.test.tsx. These are authored consumer cases, not
native, browser, generated delivery or frozen acceptance evidence.

Bind the delivered generated operations in the existing server actions after address resolution, retaining one
prepared reader origin and language selection. Replace the local unavailable-only protocol with the delivered
composed viewer DTO rather than extending or synthesizing native standing. Replace default legacy home/shelf reads
and remove their per-publication Subject reads. Preserve canonical address redirects, missing carrier identity,
source/container/head/presentation binding, command owners and independent source-bound raw cursors.

Render standing and join/leave/claim/manage/participation only from the admitted native observation and advice.
Retain orphan read-only identity, concealed versus absent carrier and operational failure. Preserve Space following
as its own owner. Retire all media, private standing, command controllers and pending results on credential,
locale, route, Realm/Space, lifecycle, presentation and native-observation changes. Connect the prepared rendering
boundary to existing route admission rather than treating it as independent session provenance.

Add only remaining mounted cases: delivered member/denied/banned advice, default route binding and missing-carrier
behavior, lifecycle and membership replacement, native presentation/media retirement and late initial results.
Retain sparse continuation, same-cursor retry, keyboard/return focus, 1/6/12 native batches, shared cards and safe
body/media rendering. Use all eight locales, wrapping 44px actions and phone390/desktop1280 layouts; add stories only
for named states. Leave frozen files unchanged. The controller owns generated delivery and frozen acceptance.
