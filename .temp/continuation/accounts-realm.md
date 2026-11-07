# Protected Realm member add is readable before the walk deadline

goal: accounts
manager: accounts
owner: Authority 89

Walk revision `0c4c52c14eb51ff21d901d69060b1fc08d83a341` at 2026-11-07T07:58Z.
Space create and protected Realm create with the website bearer succeeded. Owner
`POST /v1/realms/{id}/members` `{accountId}` was accepted (not the earlier 503
`deadline_exceeded`). `GET /v1/realms/{id}/members/me` then stayed HTTP 404
`not_found` / `effect_status:not_applicable` for 30s (`request_id`
`01a1b503-bf96-77ca-8576-dab5e9e5b447`). J16 was not reached.

This deferred walk serves Kernel HTTP from the Auth host and omits the Kernel
worker. Make that accepted member add visible on `members/me` so join, leave,
ban-before-cleanup and authorized readmission complete on that host before the
request deadline. Do not invent a second membership protocol.


## Integrated ordinary round

Goal: accounts. Manager: content. Tested source `0eb618cfd609c2abb281bbd3ced29e73e685fd71` includes Auth40c038, native fixtures65d590 and allocator6948a892. Ordinary `REZICS_WALK_DEFER_FRONTENDS=0 bun apps/web/scripts/accounts-goal-walk.ts --launch` ran on the worker host, without a remote check ID; observation began2026-11-07T11:53:10.775Z, launcher completed2026-11-07T12:12:11Z with exit0 after supported teardown. Exit0 is process completion, not nineteen-outcome acceptance. Admission succeeded in1320ms on allocated slot1; database, migrations, native Auth, real Kernel worker/relay and API driver were reached. Auth pages became ready. Evidence: `.temp/accounts/journeys.json`, `.temp/accounts/launcher.log`, `.temp/walk/e249c4cc-302e-4529-8b4a-d7453450a8fa/stack.log`. Full per-row UTC/persona/revision/elapsed values are retained in the table and JSON. No screenshots.

Native/API census:12/19 PASS (J01,J02,J05,J06,J07,J08,J09,J11,J12,J17,J18,J19),7 FAIL. These are API-stage assertions, not complete native/browser/growth or promotion acceptance. Slowest FAIL J13,32319ms, public target omitted subject.id. Authoritative launcher next hourly due2026-11-07T12:50:52Z is based on round start; the inner driver printed provisional13:09:49Z before launcher teardown, which is not a second schedule. No watcher or second walk was created.

Authority89 retains the complete membership outcome. J15 owner member add was accepted, but protected GET /v1/realms/{id}/members/me stayed404 not_found for30446ms (request_id01a1b5dc-bb42-757f-b716-48c734fd3664). J16 was not reached. This ordinary stack includes the real Kernel worker/relay, so the older deferred-stack explanation no longer applies. Make accepted membership visible under actual current authority, then complete leave/next-read refusal, ban/revoke before cleanup, denied banned self-join, unban and authorized readmission on the same original personas.

## Retained API receiving on the Library candidate

Actual source `70f7c7e9c7fc6ff08025044be46763221763f9d3`, native observation began `2026-11-07T13:27:02.282Z`. Ordinary supported same-handle walk, actual Auth/Access and native Kernel worker/relay; no worker-check ID. Evidence `.temp/accounts/journeys.json` and `.temp/accounts/launcher.log`. This API-stage result does not establish complete native/browser/growth or promotion acceptance. Original requirements above remain.

- J15: FAIL, 2026-11-07T13:29:01.167Z, 30633ms; protected member read returned HTTP 404: {"type":"https://rezics.com/problems/not_found","title":"Not Found","status":404,"code":"not_found","retryable":false,"effect_status":"not_applicable","request_id":"01a1b632-bced-76a7-95f5-1fac1b7aa07b"}. Persona: account 6ba786e1-f5f3-89c0-a721-9c60f1d136d6.
- J16: FAIL, 2026-11-07T13:29:01.169Z, 0ms; protected member read returned HTTP 404: {"type":"https://rezics.com/problems/not_found","title":"Not Found","status":404,"code":"not_found","retryable":false,"effect_status":"not_applicable","request_id":"01a1b632-bced-76a7-95f5-1fac1b7aa07b"}. Persona: not reached: no persona used.

Keep the exact first failing operation and unreached downstream assertions from the prior causal brief. Receive the existing producer repair through controller integration on this handle; no substitute authority or reduced acceptance. Browser startup and final resource settlement are recorded separately after this round ends.
