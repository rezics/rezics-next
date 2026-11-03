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
  - daf8f39e-da22-4ca6-b230-585cf4a32819
  - fbc24620-54dc-466f-bae3-2da9d357f829
  - 5ba02e2b-56fd-49c4-aa34-a616888a47fb
  - e53cdf3d-eacc-436b-8a29-55fe09fe1cc3
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
  lines: 2200
  files: 22
---

# Complete My Realms current entry and selected leave

Resume after both the mounted generated `KernelClient.me.realms.get` response and the real
`apps/web/src/kernel/recorded/my-realms.json` example expose the expanded current-entry envelope. At the bound base,
the generated response contains only `items` with `realmId`, `name` and `role: 'member'`, plus `next`; the recording
has the same installed shape. Keep the existing unavailable-entry receiver as the integration seam until both
native proof artifacts are mounted.

Use [expanded entry and selected leave admission](../../apps/web/src/community/my-realms-lifetime.md#expanded-entry-and-selected-leave-admission)
and [the current-entry boundary and cost](../../docs/goals/web.md#my-realms-current-entry-boundary) as owner
contracts. Once the precondition holds, admit current Space, presentation and independently admitted media from the
returned page; explain unavailable entry without inferring deletion or lost membership; and send readable entry and
actual management destinations to their canonical Realm owner. Keep owner leave unavailable until its native
invariant predicate is observable.

Implement explicit leave selection with immutable original-operation operands, exact Account and opaque
Account-scoped membership episode, advice and credential/CSRF lifetime. Require reselection on advice or episode
replacement; keep accepted execution pending until supported readback confirms the original operation; distinguish
unknown from rejected; and retry only the original selection. Preserve caller, Query, page, session, locale,
credential, exposure, presentation and retirement fences, including late callbacks and review retirement. Keep null
CSRF read-only, same-cursor retry, sparse continuation, first-page recovery and the reserved private SSR/hydration
boundary. Format each returned 1/10/20-row window in O(N) without per-row enrichment, polling, refill or private-page
cache. Add the named tests and stories, update the owning boundary and cost, then run the frozen acceptance after
integration.
