---
goal: web
manager: web
kind: interface
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
criticalPath: false
after:
  - 896fa32e-44c5-46dc-b0e1-1f61aaec8647
  - 0770e852-d943-4dbc-b893-b9474356fa83
  - f735d4f6-d53e-4fd7-bdee-19d638e8479a
waiting: []
paths:
  - apps/web/src/features/pages/subject-community*.ts*
  - apps/web/src/features/pages/subject-ratings*.ts*
  - apps/web/src/features/pages/subject-slots.tsx
  - apps/web/src/features/pages/README.md
  - apps/web/src/subjects/community/*.tsx
  - apps/web/src/subjects/community/*.ts
  - apps/web/src/stories/subject-community-current*.stories.tsx
  - apps/web/tests/subject-community-current*.test.ts*
  - apps/web/messages/*.json
  - docs/subject-pages.md
  - docs/goals/web.md
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - '--private-network'
    - '--'
    - bun
    - test
    - tests/subject-community-current.test.tsx
    - tests/subject-community-current-actions.test.tsx
    - tests/subject-community-current-retirement.test.tsx
  placement: default
  tests:
    - 'A person opens Subject discussions or reviews in the exact Global or Realm place, recognizes current context and recorded citation scale, opens a readable conversation and chooses only native-admitted actions.'
    - 'A readable card never grants reply, creation or reaction authority; exact historical zero, retired question and original target remain distinct from current personal vote and selected population.'
    - 'Sparse continuation and same-cursor retry retain Subject/place/kind; source, viewer, credential and disclosure replacement retire private context, media, selected actions, mutation and delayed effects.'
    - 'One bounded native page composes current cards at 1/5/20 rows with O(N) projection, no per-card native hydration, no refill and no local totals. Native raw80 and growth256/1024/4096 remain producer evidence.'
  failing: true
estimate:
  lines: 1750
  files: 18
---

# Finish the Subject community card binding

Complete the reader after Content publishes its generated full card response and populated, withheld and failed
examples. The installed client declaration still exposes only `threads` and `next`; do not edit it by hand or invent
action, citation or activity authority in Web.

Show recorded rating value, exact scale, question revision and original target independently from the current
question, the reader's current vote and selected population. Keep zero, retired questions and merged original targets
distinct. Render native media, current activity, reactions and citation disclosure through their existing owners.

Mount reply, creation, reaction, watch and overflow controls only when native advice admits the exact viewer and
target. Preserve the original actor, credentials, operation, body, idempotency key and target until uncertain commands
have an authoritative readback. Keep Board directory, composer, reply and common reaction command owners unchanged.

Finish visit retirement against actual credential and CSRF epochs, locale, exposure, descriptor, place, kind, cursor
and native observation replacement. Retire private context, media, citations, selected actions, commands and delayed
effects; old cleanup must not retire a replacement. Keep focus on the current heading or card through continuation,
retry and return.

Complete Touches, Bound and Growth with actual text, media, action, cursor and retained-memory caps. Separate session,
page read, command and readback costs. Content still owns native raw80 and growth256/1024/4096 producer evidence.

Complete the three mounted journeys for Global/Realm and discussion/review, historical citations, admitted and denied
actions, sparse retry, account/source replacement and late effects. Add connected Global/Realm, anonymous/member/writer,
zero/changed-scale/retired-target and concealed-context stories. Review 390px and 1280px layouts, light/dark themes,
all eight locales, 44px controls, wrapping, keyboard open/action/return and truthful recovery. Keep native authority and
producer evidence with Content, Realm membership with Accounts, and identity/context with Semantic.
