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
  - 7b76457c-c0f2-4228-a698-15ab16ce14f8
  - 3aa159ed-461b-4045-80af-ef5dbc9a08a6
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
    - '--private-network'
    - '--'
    - bun
    - test
    - tests/realm-ban-current-review.test.tsx
  placement: default
  tests:
    - 'Installed composed page renders disclosed target/moderator identities, safe concealed/erased fallbacks, supported destination, actual reason/time and native advice without suppressing rows.'
    - 'Exact selected-account inspection binds Realm/account/current episode without moving the cursor; absence, denial and unavailable remain distinct; unban absence and reban new episode preserve independent command receipts.'
    - 'Writers retain immutable uncertain intent, original credentials, native reauthorization, protected-role refusal, accepted-removal meaning and Stay/Leave/focus recovery across replacement and late results.'
    - 'Consumer 1/10/20 growth covers installed composed adapters, exact inspection, retry, unban/reban and retirement with no per-row lookup; producer evidence stays separate.'
  failing: true
estimate:
  lines: 1300
  files: 16
---

# Complete installed composed Realm ban review

The remaining outcome is the installed composed review, including all four acceptance requirements above.
Keep the existing unavailable default until normal generated delivery publishes the mounted response and query.
The retained installed declaration in `packages/client/src/kernel/community/routes.d.ts` still admits only
limit/cursor and the four original row fields. The current observation seam already supports explicit episode
review through the original unban writer; it is not installed/native acceptance. Do not substitute a copied
schema, structural cast, second generator or edits to generated declarations or foreign compiler/schema files.

Owners: `services/kernel/src/community/README.md`, “Current ban review page”,
`services/kernel/src/community/ban-review-page-schemas.ts`, and
`apps/web/src/community/realm-ban-lifetime.md`. Preserve
`.temp/goal/web/decisions/continuation-custody-and-current-source-receiving.md`, using the read-only main checkout
fallback when absent locally. Read these owners before implementation; no broader survey is needed.

The named Content source b6a6a47a1933fbb2550418f80a2a0e423effdc06, producer
d9eab148268c53833aef230eb5bf0fe0aa272638, route 8cf2471dbcfcf521f62683017ca4acdc71e36879,
Kernel d9e1b2f893bbf65a1b9cd0d46549705d5ee3463f, OpenAPI
8907617958f5280ebe26d26152fdad6597496d63 and root exports
bec81ade813131f0029ba522ec975979cb147a70 are already ancestors of the retained base. The mounted source uses
the expanded schemas; these integrated commits still do not supply the expanded installed client declaration.
Inspect actual installed closure before binding it. Do not reapply these commits or treat source7097c506 or
unchangedfc3d628 as installed/native acceptance. Do not rebase; merge or cherry-pick only named changes.

Once supported delivery exists, derive every new response/query type from the installed route. Bind the default
Panel/Control, original server functions, QueryClient and generated native HTTP adapter. Render every operational
row, disclosed target/moderator identities and supported destinations, concealed Account/key fallbacks without
links, erased moderators, actual reason/time, context and native advice. Non-null membership removal stays
pending until Accounts establishes completion.

Map installed exact selection into the existing inspection seam without moving the list cursor. Preserve
Realm/account/frontier/current episode and exact retry input. Distinguish admitted absence, denial and
unavailable; list exhaustion never establishes exact absence. Preserve selected episode confirmation, immutable
uncertain command intent and keys, original credentials, native reauthorization, protected-role refusal,
duplicate exclusion, independent bounded ban/unban receipts, Stay/Leave, focus recovery and replacement/late
result fencing. Deliberate reban creates a new intent. Keep every unchanged writer assertion. Observations
cannot become command receipts, and unban restores neither membership nor grants.

Add only missing non-frozen tests and named stories. Cover available200, concealed beyond-page selection
preserving items/next and Account without destination, denied403 and identity-home503 withholding the page,
and exact retry preserving cursor/selectedAccountId. Consumer 1/10/20 growth must exercise actual installed
composition, exact retry, unban/reban and retirement with no per-row lookup. Preserve original producer
preparation, authority/all-pool growth and physical growth obligations separately from rendered integration
review. Caller acceptance is not native proof.

The controller runs the unchanged frozen acceptance, native and browser verification after integration.
Do not edit the frozen acceptance file or weaken its four outcomes. The worker-relative focused-command
example does not change acceptance placement. Local verification is changed-workspace typing and changed
non-frozen tests only: commit before checks, type-check each changed workspace from the worktree root, and
run changed Web tests once with `bun apps/web/scripts/focused.ts --private-network -- bun test <files>`.
Wait for long checks in their original sessions with a yield of at least 300 seconds. Never start duplicate
checks, force alternate placement, write under node_modules or alter processes this attempt did not start.
