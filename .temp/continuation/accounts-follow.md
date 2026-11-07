# Public person row includes the agent Subject

goal: accounts
manager: accounts
owner: Accounts
reuse: Identity 4ff

Walk revision `0c4c52c14eb51ff21d901d69060b1fc08d83a341` at 2026-11-07T07:57Z.
J12 passed public person/organization/agent reads without private fields. Follow
writes the public agent Subject with no body. The walk waited 30s after signup
for `GET /v1/accounts?handle=` to publish `subject.id`.

J13 (31730ms) and J14 (30481ms): that public row still omitted `subject.id`, so
follow and outgoing counts could not name the target. After signup 201, the
handle's public row must include the bound agent Subject so `PUT /v1/follows/{id}`,
Following, unfollow, unavailable-target unfollow, and own `followingCount` can
run. Do not reject the eligible public agent Subject.

## Integrated ordinary round

Goal: accounts. Manager: content. Tested source `0eb618cfd609c2abb281bbd3ced29e73e685fd71` includes Auth40c038, native fixtures65d590 and allocator6948a892. Ordinary `REZICS_WALK_DEFER_FRONTENDS=0 bun apps/web/scripts/accounts-goal-walk.ts --launch` ran on the worker host, without a remote check ID; observation began2026-11-07T11:53:10.775Z, launcher completed2026-11-07T12:12:11Z with exit0 after supported teardown. Exit0 is process completion, not nineteen-outcome acceptance. Admission succeeded in1320ms on allocated slot1; database, migrations, native Auth, real Kernel worker/relay and API driver were reached. Auth pages became ready. Evidence: `.temp/accounts/journeys.json`, `.temp/accounts/launcher.log`, `.temp/walk/e249c4cc-302e-4529-8b4a-d7453450a8fa/stack.log`. Full per-row UTC/persona/revision/elapsed values are retained in the table and JSON. No screenshots.

Native/API census:12/19 PASS (J01,J02,J05,J06,J07,J08,J09,J11,J12,J17,J18,J19),7 FAIL. These are API-stage assertions, not complete native/browser/growth or promotion acceptance. Slowest FAIL J13,32319ms, public target omitted subject.id. Authoritative launcher next hourly due2026-11-07T12:50:52Z is based on round start; the inner driver printed provisional13:09:49Z before launcher teardown, which is not a second schedule. No watcher or second walk was created.

Accounts/Identity4ff retains the repair. Public handle reads200 still omitted bound subject.id for both follow and count targets after30s. J13 failed32319ms; J14 failed30516ms. Follow writes and their later checks were not reached. Publish the actual public agent Subject and complete follow→Following→unfollow, stored unavailable-target unfollow, own current count and unrelated-reader private-aggregate denial. No synthesized target or source-only pass. Current full worker/relay is present; private/public identity and deletion barriers remain.

## Retained API receiving on the Library candidate

Actual source `70f7c7e9c7fc6ff08025044be46763221763f9d3`, native observation began `2026-11-07T13:27:02.282Z`. Ordinary supported same-handle walk, actual Auth/Access and native Kernel worker/relay; no worker-check ID. Evidence `.temp/accounts/journeys.json` and `.temp/accounts/launcher.log`. This API-stage result does not establish complete native/browser/growth or promotion acceptance. Original requirements above remain.

- J13: FAIL, 2026-11-07T13:27:59.998Z, 32579ms; follow target omitted a public agent subject. Persona: j13b726c09e424 (6291a6c9-48b9-8129-b7b8-9fb3181c5078), account b1c6dc15-12e5-81f6-a8b0-b98997b37f40.
- J14: FAIL, 2026-11-07T13:28:30.527Z, 30528ms; count target omitted a public agent subject. Persona: account b1c6dc15-12e5-81f6-a8b0-b98997b37f40, account 084bc156-bffe-8771-9859-f747fda092d0.

Keep the exact first failing operation and unreached downstream assertions from the prior causal brief. Receive the existing producer repair through controller integration on this handle; no substitute authority or reduced acceptance. Browser startup and final resource settlement are recorded separately after this round ends.
