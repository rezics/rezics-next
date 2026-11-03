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
  - cce8bd8f-113c-4acc-baf2-845bc9e40e17
  - 7c3bb4f1-8e6e-4137-8d4d-45a7a7d8760b
  - d6b1bd94-1216-4957-b467-bd90d8608a2e
  - bba004ce-703b-43f4-81db-de03a3ee4261
  - 59bcf562-a3c5-463b-abbc-b6f10bcbd0d8
  - e6c553d0-0a23-47ce-a99a-46456c7b84bb
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
  precondition: 'The mounted generated KernelClient.me.realms.get contract and recorded my-realms.json example expose the native current-entry, presentation, media, membership-episode and action-advice fields. A service-side schema/source change alone is not mounted proof. Do not invent a browser DTO or widen a cast while they are absent.'
  command:
    - bun
    - apps/web/scripts/focused.ts
    - '--private-network'
    - '--'
    - bun
    - test
    - tests/my-realms-current-entry.test.tsx
    - tests/my-realms-current-entry-actions.test.tsx
    - tests/my-realms-current-entry-retirement.test.tsx
  placement: default
  tests:
    - Bind the expanded generated /v1/me/realms response and real examples without an invented browser DTO or widened cast.
    - 'Mounted journeys cover admitted presentation/media, readable and unavailable entry, actual manager, selected leave review, pending/unknown/rejected results and current-page return.'
    - Readback and retry remain bound to the original operation and membership episode; replacement advice and all retirement boundaries discard stale actions and late effects.
    - 'Sparse continuation, same-cursor retry and restart preserve inventory; one 1/10/20-row page receives O(N) formatting and one selected action with no per-row enrichment.'
    - 'Stories cover the named states; phone390/desktop1280 light/dark, keyboard flows, 44px controls and all eight locales remain legible and operable.'
  failing: true
estimate:
  lines: 2450
  files: 24
---

Complete the current My Realms entry and selected leave journey once the expanded generated client and its recorded
example are mounted. Preserve the existing generated-type inventory projection and localized unavailable entry until
both provide the additional native fields. Membership alone must never supply an entry or management destination.

Consume separate native current entry, presentation, media, membership episode and action advice. Show only admitted
destinations and presentation/media, distinguishing concealment from unavailable entry without retaining prior labels.
Offer management only on actual native advice. Add one selected leave review through the existing membership command
owner, reauthorizing at execution and returning to the current My Realms page after existing flows.

Keep accepted leave pending until native readback confirms transition. Preserve unknown and rejected outcomes; retries
and readback keep the original operation and membership episode. Replacement membership or advice retires old actions.
Account, credentials, locale, disclosure, presentation and source replacement retire labels, grants, actions and late
effects. Retain the current caller, route, session preparation, null-CSRF read-only behavior, exact Query retirement,
cursor ownership, first-page recovery and focus restoration.

Use one page of at most 20 rows, one selected action and O(N) formatting, without per-row enrichment, sparse-page
refill or private-page storage. Extend the existing current-entry test and add the action and retirement files for
the journeys listed in acceptance. Keep assertions for unchanged behavior. Add only the named story states and inspect
phone390/desktop1280 in light/dark, keyboard entry/review/confirm/return, 44px controls and all eight locales when the
controller permits browser verification. Document pending, retry and unavailable meanings plus Touches, Bound and
Growth in docs/goals/web.md. Native raw80 traversal and growth256/1024/4096 remain Content evidence.

Use services/kernel/src/community/README.md, section "My Realms current inventory", for the native advice and episode
contract. The retained Web projection and unavailable-entry behavior reconcile both integrated receiving deliveries.
Do not reopen their shared caller until generated advice and the recording support this journey. Source-side advice
does not satisfy the mounted precondition.
