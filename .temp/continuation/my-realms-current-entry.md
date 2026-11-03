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
  precondition: "The mounted generated KernelClient.me.realms.get contract and recorded my-realms.json example expose the native current-entry, presentation, media, membership-episode and action-advice fields. A service-side schema/source change alone is not mounted proof. Do not invent a browser DTO or widen a cast while they are absent."
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
    - Bind the expanded generated /v1/me/realms response and real examples without an invented browser DTO or widened cast.
    - "Mounted journeys cover admitted presentation/media, readable and unavailable entry, actual manager, selected leave review, pending/unknown/rejected results and current-page return."
    - Readback and retry remain bound to the original operation and membership episode; replacement advice and all retirement boundaries discard stale actions and late effects.
    - "Sparse continuation, same-cursor retry and restart preserve inventory; one 1/10/20-row page receives O(N) formatting and one selected action with no per-row enrichment."
    - "Stories cover the named states; phone390/desktop1280 light/dark, keyboard flows, 44px controls and all eight locales remain legible and operable."
  failing: true
estimate:
  lines: 2400
  files: 24
---

# Complete My Realms after native current-entry mounting

Complete the account inventory and selected leave journey defined in
[expanded entry and selected leave admission](../../apps/web/src/community/my-realms-lifetime.md#expanded-entry-and-selected-leave-admission).
The integration seam is `formatMyRealmsInventory` in `apps/web/src/community/my-realms-native.ts`.
Activate it only when both the generated `KernelClient.me.realms.get` operation and the real
`apps/web/src/kernel/recorded/my-realms.json` recording expose the required envelope. The mounted declaration is
derived through `packages/client/src/kernel/community/routes.d.ts`; service schemas alone do not activate it.

Show the current Space, admitted description and independently admitted media. Offer readable entry and actual
management destinations through their canonical Realm owner. Explain unavailable entry without inferring deletion
or lost membership. Concealment drops old presentation and media without refilling the window. Image availability
does not authorize actions. Owner leave stays unavailable until the native invariant predicate can be observed.

Entry and management use the current page and return to a fresh admitted inventory, restoring keyboard focus
within that visit. One explicit leave selection captures immutable operands, exact Account and membership episode,
original operation, advice and credential/CSRF lifetime. Replacement advice or episode requires reselection.
Accepted stays pending until supported original-operation readback confirms its transition. Unknown and rejected
remain distinct. Retry preserves the original selection; later matching state cannot establish its success.
Treat episode tokens as Account-scoped opaque values.

Preserve caller/Query identity and every source, page, session, locale, credential, exposure and presentation
retirement fence, including late callbacks and selected-review retirement. Null CSRF remains read-only. Preserve
same-cursor retry, first-page recovery, sparse continuation and the reserved private SSR/hydration boundary.
Format each 1/10/20-row returned window in O(N) with one selected action and no per-row enrichment, polling, refill
or private-page cache. Content/controller own raw80 and growth256/1024/4096 evidence.

Complete the three mounted suites and current-entry story in acceptance using real native examples. Cover the
named outcomes, retirement boundaries, eight locales, phone390/desktop1280 light/dark, wrapping 44px controls
and keyboard journeys. Preserve unchanged assertions and frozen acceptance. Update
[the owning boundary and cost](../../docs/goals/web.md#my-realms-current-entry-boundary), including Touches,
Bound, Growth and any remaining unavailable seams.

Commit before checks and after fixes. Type-check changed workspaces and run only changed or created tests once
after the final edit with the authorized focused command. Frozen acceptance, native checks and browser checks
belong to the controller.
