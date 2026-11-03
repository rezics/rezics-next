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
  - 70cd2a89-afd1-437c-ba19-d9ebe380cc19
  - 604f81ab-cf5e-4719-869f-6653ae19573f
waiting: []
paths:
  - apps/web/src/threads/post-history-read.ts
  - apps/web/src/threads/post-history*.ts*
  - apps/web/src/threads/post-history-lifetime.md
  - apps/web/src/threads/revision-history-*.ts*
  - apps/web/src/threads/historical-reader-provenance.ts
  - apps/web/src/threads/README.md
  - apps/web/src/stories/post-history-current*.stories.tsx
  - apps/web/src/stories/post-history-current-fixture.ts
  - apps/web/tests/post-history-current*.test.ts*
  - apps/web/messages/*.json
  - docs/goals/web.md
estimate:
  lines: 400
  files: 8
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - '--private-network'
    - '--'
    - bun
    - test
    - tests/post-history-current.test.tsx
    - tests/post-history-current-navigation.test.tsx
    - tests/post-history-current-retirement.test.tsx
  placement: default
  failing: true
  tests:
    - 'Open History with admitted conversation/Board/place and current author presentation, select an immutable revision, visit its exact/comparison destinations and return only while admitted.'
    - 'Associate native context and enrichment by exact revision identity; preserve historical zero, question/revision/scale and original versus terminal target; distinguish withheld/absent/failed context and citations.'
    - 'Exercise actual actor/account/session/CSRF/exposure/locale/post/thread/cursor/source replacement, first-render disclosure and delayed retirement without trusting URL equality or unobserved ABA.'
    - 'Consume generated native envelope variants at1/20/100 in O(N+K), one replacing page and no duplicate hydration; native growth256/1024/4096 remains producer evidence.'
---

# Finish the current-context History visit after installed publication

Receive the closed revision-page response through the original native History producer and supported shared
client publication. The installed `GET /v1/posts/:id/revisions` response in
`packages/client/src/kernel/content/routes.d.ts` still declares only `revisions` and `next`; the prepared consumer
in `apps/web/src/threads/post-history-context.ts` requires `NativeHistoryPage['page']`. Keep that unavailable seam
until the installed declaration, factory and operation/exposure contract deliver it. Do not generate the client,
edit declarations, copy a DTO, cast or add a transport. Content retains its typed checks and original native
source preparation, authorization and growth acceptance.

Read `apps/web/src/threads/README.md`, `apps/web/src/threads/post-history-lifetime.md`, the Current-context post
history section of `docs/goals/web.md`, and manager decisions
`/home/edge/projects/rezics/rezics-next/.temp/goal/web/decisions/history-helper-delta-and-retirement-acceptance.md`
and `continuation-custody-and-current-source-receiving.md` in that decisions directory.

Preserve the prepared consumer, three mounted acceptance files and connected stories. After installed delivery,
fix only actual journey gaps: admitted discussion/review, Board, place and current author; immutable selected
revision; recorded zero, question revision and scale; original versus terminal targets and citations; withheld,
absent and failed presentation; admitted exact document/media and comparison destinations; and selection/focus
return only during the admitted visit. Missing bounded summaries retain original IDs with withheld presentation;
only empty recorded target lists mean absence. Operational failure retains the same history address for explicit
retry and cannot become successful empty context.

Keep exact revision-keyed enrichment, one replacing page, bounded deduplicated hydration, and page-local retirement
across actor/account/session/CSRF/exposure/locale/post/thread/cursor/source replacements, including ABA and delayed
responses. Preserve historical-reader/current-reader retirement and exact/history/media compatibility. Keep the
support helper's existing `getLocale` export and per-mount URL reset. Preserve unchanged assertions and the four
original acceptance requirements above; add only missing user-visible scenarios. Retain eight locales, 390/1280
widths, both themes, 44px targets and keyboard/exact/compare/return-focus acceptance.

Update adjacent owner Cost/documentation for delivered bounds. Consumer work remains O(N+K) at 1/20/100 with no
duplicate native hydration. Native 256/1024/4096 growth and browser/Storybook inspection remain separate controller
acceptance; source review, mocks and authored cases do not prove them. Follow the next controller launch policy
for verification. Leave unrelated outcomes and continuation files unchanged.
