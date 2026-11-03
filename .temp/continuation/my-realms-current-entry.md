---
goal: web
manager: web
kind: interface
riskAreas:
  - rights
  - authorization
  - disclosure
  - account
  - deletion
criticalPath: false
after:
  - 7c3bb4f1-8e6e-4137-8d4d-45a7a7d8760b
  - d5475d73-1059-4302-bbb0-944c842f56ad
waiting: []
paths:
  - apps/web/src/community/my-realms-*.tsx
  - apps/web/src/community/my-realms-*.ts
  - apps/web/src/community/my-realms-*.md
  - apps/web/src/community/space.ts
  - apps/web/src/community/realm-membership-actions.ts
  - apps/web/src/routes/realms/index.tsx
  - apps/web/src/stories/my-realms-current-entry.stories.tsx
  - apps/web/tests/my-realms-current-entry*.test.ts*
  - apps/web/messages/*.json
  - docs/goals/web.md
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - "--private-network"
    - "--"
    - bun
    - test
    - tests/my-realms-current-entry.test.tsx
    - tests/my-realms-current-entry-actions.test.tsx
    - tests/my-realms-current-entry-retirement.test.tsx
  placement: default
  tests:
    - "Bind the expanded generated /v1/me/realms response and real examples, without an invented browser DTO or widened cast."
    - "Mounted journeys cover admitted presentation/media, readable and unavailable entry, actual manager, selected leave review, pending/unknown/rejected results and current-page return."
    - Readback and retry remain bound to the original operation and membership episode; replacement advice and all retirement boundaries discard stale actions and late effects.
    - "Sparse continuation, same-cursor retry and restart preserve inventory; one 1/10/20-row page receives O(N) formatting and one selected action with no per-row enrichment."
    - "Stories cover the named states; phone390/desktop1280 light/dark, keyboard flows, 44px controls and all eight locales remain legible and operable."
  failing: true
estimate:
  lines: 2250
  files: 24
---

# Remaining outcome

Complete the My Realms current-entry and selected leave experience against native advice. Read the owning section
`docs/goals/web.md#my-realms-current-entry-boundary` and `apps/web/src/community/my-realms-lifetime.md`.

The generated `KernelClient.me.realms.get` response and recorded `apps/web/src/kernel/recorded/my-realms.json`
still admit only realmId, name, literal member role and next. The native producer in
`services/kernel/src/community/own-realms-view.ts` and `services/kernel/src/community/schemas.ts` now includes current
presentation/media, destination, membership since and participation, but actions remain explicitly unavailable.
Read those sources before extending the explicit `my-realms-native.ts` projection. Use a minimal documented native seam
where needed; do not infer leave or management authority from membership or fabricate real native proof.

Inventory rows now show localized unavailable entry instead of guessing Realm destinations from IDs. The named test
mounts installed inventory at 0/1/10/20 rows in all eight locales, preserving labels and sparse continuation with no
entry/action/media controls. This is not expanded response or action proof. Existing supplied-page tests and the
continuation stories were updated only for the intentionally retired ID-based links. The lifetime test also retains its
SSR, hydration and StrictMode assertions while requiring no invented row link. The new current-entry stories
cover unavailable entry and long inventory. Browser inspection remains owed.

Admit separate current entry, presentation/media, membership episode and action advice when supplied. Concealed
presentation must never expose prior metadata. Admit readable destinations and an existing management destination
only on native advice. Keep the existing caller, route, session preparation, null-CSRF read-only behavior, exact Query
retirement, cursor ownership, first-page recovery and focus restoration.

Add one selected leave review through the existing membership command owner, execution reauthorization, accepted/
unknown/rejected semantics and pending until native transition readback. Bind retries to the same operation and episode;
replacement membership or advice retires stale actions and late effects. Existing flows return to the current page.

Keep one page, at most 20 rows, O(N) formatting, one selected action, no per-row enrichment, sparse refill or private-page
storage. Account, credentials, locale, disclosure, presentation and source replacement retire labels, grants and effects.

Extend the current-entry mounted suite and add the action and retirement test files for all remaining named journeys:
permitted/long presentation and media, readable/unavailable/concealed entry, same-cursor failed retry and restart, member/
actual manager, selected leave review, pending/unknown/rejected outcomes, replacement episode/advice and all caller
retirement boundaries including late readbacks. Add only those named stories and inspect phone390/desktop1280 in
light/dark, keyboard entry/review/confirm/return, 44px controls and eight locales. Update owning pending/retry/unavailable
meanings and Touches, Bound and Growth. Content owns native raw80 and growth256/1024/4096 evidence.
