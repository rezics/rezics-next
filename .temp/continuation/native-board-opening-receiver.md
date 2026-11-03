---
goal: web
manager: web
kind: interface
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
after:
  - d2e1f19d-a8bb-4b23-af09-b6fe9b928947
  - 5a2e66c9-3f0d-4168-a2ad-117772a89e39
  - 86e8d46e-f0a3-4a3a-930b-bc10114600ac
  - d5475d73-1059-4302-bbb0-944c842f56ad
waiting: []
paths:
  - apps/web/src/identity/page-loaders.ts
  - apps/web/src/threads/board-opening*.ts*
  - apps/web/src/threads/board-opening*.md
  - apps/web/src/threads/board-reading.ts
  - apps/web/src/threads/board-feed-data.ts
  - apps/web/src/threads/board-feed.tsx
  - apps/web/src/threads/board-page-caller.tsx
  - apps/web/src/threads/board-page-lifetime.md
  - apps/web/src/threads/board-pins.md
  - apps/web/src/threads/README.md
  - apps/web/src/routes/boards/$id.tsx
  - apps/web/src/stories/board-native-opening.stories.tsx
  - apps/web/tests/board-native-opening*.test.ts*
  - apps/web/messages/*.json
  - docs/goals/web.md
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - '--private-network'
    - '--'
    - bun
    - test
    - tests/board-native-opening.test.tsx
  placement: default
  tests:
    - 'Consume the installed typed Board page once and render current Board/community context, rules, five initial pins, twenty ordinary candidates, author/media context and admitted interactions without per-row enrichment or false count defaults.'
    - 'Continue the ordinary source without repeating the initial pin cohort; preserve sparse empty continuation, sort semantics, same-input retry and explicit invalid-cursor restart.'
    - 'Pass exact native targets and advice to existing reaction, reply, watch, pin and slow-mode owners; readability and successful transport never imply participation or moderation.'
    - 'Retire context, media grants, interactions, actions, cohort, frontier and late effects on viewer, credentials, locale, route, exposure, source and connection replacement while preserving the actual-reader transfer boundary.'
    - 'Cover current optional context failure, concealed identities, signed-out/nonparticipant/moderator advice, zero versus omitted reactions, denied actions, thread return, pin ABA, rank unavailable, and retry/restart focus.'
    - 'At fixed cohorts of 1, 10 and 25 rows, record response-proportional consumer work with one native opening request per explicit read; keep Content physical growth and authority evidence separate.'
    - 'Use authentic generated responses for populated, withheld and failed states; cover five pins plus twenty ordinary candidates, concealed and overlapping pin identities, repeated authors, continuation, empty-plus-next, exhaustion, all sorts, invalid cursor, optional context failure, denied actions, thread return, exact retry and late responses after viewer/session/locale/source replacement.'
    - 'Add named stories for current opening, concealed optional context, zero/unknown interactions, sparse continuation, invalid-cursor restart, denied actions and unavailable retry. Review only these states at 390px and 1280px in light and dark themes, by keyboard and across all eight locales.'
    - 'Measure selected cohorts 1/10/25 while varying unrelated Board size; report request count, rows, bytes and retained page state. Keep the independent-cache first-paint limit truthful.'
  failing: true
estimate:
  lines: 2400
  files: 23
---

After `@rezics/client` publishes the generated `boards({ id }).page.get` method and `BoardPageResponse`, finish the Web receiver described in [Native Board opening receiver](../../apps/web/src/threads/board-opening.md). Keep the current typed reads until that publication is installed. Bind the generated method, response, errors and examples through the existing loader and caller, then render the page data and preserve its ownership, action and return behavior.

Use only the generated client surface for the native opening. Add the generated-response tests, named stories and consumer measurements listed above, then complete the frozen acceptance. Content growth and authority evidence remain owned by Content.
