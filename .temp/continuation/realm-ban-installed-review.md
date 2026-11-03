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
  - 5fd14871-26e3-4118-b59e-a8da965e8d28
  - cc949a58-dfa2-4711-b4bb-1c5602401039
  - f7ab95fe-f9aa-469b-ad53-b928d4765eff
  - a01c30cc-df91-4c96-8b49-cc7f9968a099
  - f5d1168f-49a6-4a35-bb1c-572b0364d31a
  - 87e87621-fdff-4dce-952a-f49e729752be
waiting: []
paths:
  - apps/web/src/community/realm-bans.ts
  - apps/web/src/community/realm-bans-control.tsx
  - apps/web/src/community/realm-bans-panel.tsx
  - apps/web/src/community/realm-ban-lifetime.ts
  - apps/web/src/community/realm-ban-lifetime.md
  - apps/web/src/community/realm-ban-current*.ts*
  - apps/web/src/community/realm-ban-current*.md
  - apps/web/src/community/space-actions.ts
  - apps/web/src/stories/realm-ban-current-review.stories.tsx
  - apps/web/tests/realm-ban-current*.test.ts*
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
    - tests/realm-ban-current-review.test.tsx
  placement: default
  tests:
    - "Installed composed page renders disclosed target/moderator identities, safe concealed/erased fallbacks, supported destination, actual reason/time and native advice without suppressing rows."
    - "Exact selected-account inspection binds Realm/account/current episode without moving the cursor; absence, denial and unavailable remain distinct; unban absence and reban new episode preserve independent command receipts."
    - "Writers retain immutable uncertain intent, original credentials, native reauthorization, protected-role refusal, accepted-removal meaning and Stay/Leave/focus recovery across replacement and late results."
    - "Consumer 1/10/20 growth covers installed composed adapters, exact inspection, retry, unban/reban and retirement with no per-row lookup; producer evidence stays separate."
  failing: true
estimate:
  lines: 1400
  files: 16
---

# Finish installed composed Realm ban review

Bind supported generated Realm ban delivery to the default Panel/Control, original server functions,
QueryClient and native HTTP adapter. The installed declaration must admit the expanded response and original
query before Web derives any composed types or sends exact selection. Use normal controller integration
from the native/shared generation owners; do not edit generated declarations, copy the native schema, run
another generator or repair foreign compiler/schema files.

Owners: `services/kernel/src/community/README.md`, “Current ban review page” and
`services/kernel/src/community/ban-review-page-schemas.ts`; Web lifetime:
`apps/web/src/community/realm-ban-lifetime.md`. Read the manager decision at
`.temp/goal/web/decisions/continuation-custody-and-current-source-receiving.md` (the main checkout's same
read-only path if absent here). Original producer preparation, authority/all-pool growth and controller
verification deferrals remain required. Source7097c506/unchangedfc3d628 do not establish installed/native acceptance.

Show every operational row, disclosed target/moderator identity and supported destination, concealed identity
fallbacks, erased moderators, actual reason/time, context and current native advice. Keep non-null membership
removal workflows pending until Accounts establishes completion. Derive all new response/query types from
the installed route rather than the native source schema.

Map the installed exact selected observation into the existing unavailable-default inspection seam. Bind
Realm/account/frontier/current episode, preserve explicit exact retries and do not move the list frontier.
Distinguish native denial, unavailable and admitted operational absence. List exhaustion never proves exact
absence. Add exact episode selection to the existing unban review. An admitted observation must not become a
command receipt or establish completed removal.

Retain immutable uncertain intent, original credentials, native reauthorization, protected-role refusal,
duplicate exclusion, Stay/Leave, focus recovery and replacement/late-result fencing. Preserve independent
command keys and the bounded accepted ban/unban receipts already retained by the writer; deliberate reban
creates new intent. Preserve every unchanged writer assertion.

Compose actual installed adapters, default Panel/Control, original server functions and QueryClient in the
original frozen acceptance without editing that file. Complete consumer 1/10/20 coverage through exact
inspection retry, unban/reban and retirement, without per-row identity/authority calls. Keep native physical
growth in Content/Accounts and rendered integration review separate. Write only missing non-frozen tests and
stories for named states. The controller runs frozen acceptance, native and browser verification after
integration. Local verification follows its current minimal policy: changed workspace typing and changed tests.
