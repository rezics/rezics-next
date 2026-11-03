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
waiting: []
paths:
  - packages/client/src/kernel/content/routes.d.ts
  - apps/web/src/threads/post-history-read.ts
  - apps/web/src/threads/post-history*.ts*
  - apps/web/src/threads/post-history-lifetime.md
  - apps/web/src/threads/revision-history-*.ts*
  - apps/web/src/threads/historical-reader-provenance.ts
  - apps/web/src/threads/README.md
  - apps/web/src/stories/post-history-current*.stories.tsx
  - apps/web/tests/post-history-current*.test.ts*
  - apps/web/messages/*.json
  - docs/goals/web.md
estimate:
  lines: 1450
  files: 19
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - "--private-network"
    - "--"
    - bun
    - test
    - tests/post-history-current.test.tsx
    - tests/post-history-current-navigation.test.tsx
    - tests/post-history-current-retirement.test.tsx
  placement: default
  failing: true
  tests:
    - "Open History with admitted conversation/Board/place and current author presentation, select an immutable revision, visit its exact/comparison destinations and return only while admitted."
    - "Associate native context and enrichment by exact revision identity; preserve historical zero, question/revision/scale and original versus terminal target; distinguish withheld/absent/failed context and citations."
    - "Exercise actual actor/account/session/CSRF/exposure/locale/post/thread/cursor/source replacement, first-render disclosure and delayed retirement without trusting URL equality or unobserved ABA."
    - "Consume generated native envelope variants at1/20/100 in O(N+K), one replacing page and no duplicate hydration; native growth256/1024/4096 remains producer evidence."
---

Complete the current-context history visit using the generated Kernel client response for `GET /v1/posts/:id/revisions`. The Kernel handler now returns a closed `page` context beside the compatible `revisions` and `next`, and its recorded history-page tests cover current context, score scale, zero, and same-cursor retry. The generated client declaration in `packages/client/src/kernel/content/routes.d.ts` still exposes only `revisions` and `next`; do not hand-write or guess the missing response variant. Regenerate from the published Kernel route once its database URL is available, then consume that exact generated type.

Show the admitted discussion or review, Board and place, and current author disclosure. Associate nested authors, mentions, subjects, media, score citations, and navigation by exact revision identity. Preserve the recorded citation including zero, scale and question revision; show original and terminal targets distinctly; distinguish concealed, absent, and failed required context with same-address retry. Keep the existing exact document/media readers and immutable revision identity. Offer exact and admitted comparison destinations with return selection and focus, without head or write authority.

Finish native-key projection in O(N+K), source/account/session/exposure/locale retirement and delayed-response coverage. Add the three mounted acceptance files and connected stories only for the named discussion/reply/review, zero/scale/retired/merged target, changed-head/comparison, and account/source-retirement states. Preserve the existing bounded-page, retry, hydration, exact-reader, media, and unchanged assertions. Run focused Web typecheck and the frozen acceptance after integration; native growth and browser/Storybook inspection remain controller work.
