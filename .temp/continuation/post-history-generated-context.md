---
goal: web
manager: web
kind: interface
riskAreas:
  - authorization
  - disclosure
  - account
criticalPath: false
after:
  - 19c502a0-440e-49ea-b4d8-0240c4adb682
  - 4cc53371-7041-4ddf-9f11-5aedf1531ed4
  - c2ad20ed-c184-4091-9a6e-61fc5056f9f4
  - e776baaa-ca80-432a-b160-fb1c8a47d361
  - 050ad715-3038-4386-9bb2-39c66e90c2ba
waiting: []
paths:
  - packages/client/src/kernel/content/routes.d.ts
  - apps/web/src/threads/post-history-context.ts
  - apps/web/src/threads/post-history-read.ts
  - apps/web/src/threads/post-history-lifetime.ts
  - apps/web/src/threads/post-history-current*.tsx
  - apps/web/src/stories/post-history-current-fixture.ts
  - apps/web/tests/post-history-current*.test.tsx
estimate:
  lines: 500
  files: 8
acceptance:
  command:
    - bun
    - run
    - --cwd
    - apps/web
    - typecheck
  placement: default
  failing: true
  tests:
    - 'The generated GET /v1/posts/:id/revisions response includes the published closed page context, and Web consumes that exact generated type without a hand-written response variant.'
    - 'Preserve the three mounted current-history files, including admitted context, immutable navigation and focus, recorded zero and scale, bounded target omission, same-address retry and source/account/session/exposure/locale retirement.'
---

Finish the generated-client binding for the retained current-context History visit. Regenerate the client from the
published Kernel route using its database-backed compiler and retain the generated declaration closure required by
that route. Do not hand-write, guess or cast away the missing page response. Align the retained projection, mounted
examples and stories with the resulting exact generated variant, then resolve all history-related type errors.

Readers must keep the admitted discussion or review, Board, place and current author presentation alongside the
selected immutable revision. Preserve recorded zero, question and scale identities, original versus terminal
targets, withheld versus absent versus failed context, and retry at the same history address. A recorded target
omitted from a bounded native summary keeps its original ID and withheld presentation.

Keep exact document/media reading and the admitted comparison visit, returning to the selected revision and its
focus only while the original reader remains admitted. Preserve the replacing-page and delayed-retirement behavior
and the existing bounded hydration assertions. Type-check the changed workspaces and run the three mounted files
with the focused Web command. Integration acceptance, native growth and browser/Storybook inspection remain
controller work.
