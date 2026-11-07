# Recovery complete and credential replace on the walk stack

goal: accounts
manager: accounts
owner: Auth c883

Walk revision `0c4c52c14eb51ff21d901d69060b1fc08d83a341` at 2026-11-07T07:56Z on deferred slot 5. J02 passed native sign-in, session review and revoke. Local assemble writes recovery `{accountId,token,url}` under `.temp/local-stack/recovery`. HTTP start stays `{"success":true}` with no token in the body.

J03 (1819ms): `POST /recovery/complete` with that privately delivered token returned HTTP 503 `{error:authentication_denied}`. Authorize recovery complete through Access so new-password sign-in succeeds and the old password/session are refused.

J04 (1843ms): `POST /credential-effects/stage` with a fresh login-client session returned HTTP 403 `{error:credential_effect_denied, effect_status:not_applied}`. Stage and apply password replace through that login session, then review and revoke sessions. Human proof still rejects automated and operator callers.

## Integrated ordinary round

Goal: accounts. Manager: content. Tested source `0eb618cfd609c2abb281bbd3ced29e73e685fd71` includes Auth40c038, native fixtures65d590 and allocator6948a892. Ordinary `REZICS_WALK_DEFER_FRONTENDS=0 bun apps/web/scripts/accounts-goal-walk.ts --launch` ran on the worker host, without a remote check ID; observation began2026-11-07T11:53:10.775Z, launcher completed2026-11-07T12:12:11Z with exit0 after supported teardown. Exit0 is process completion, not nineteen-outcome acceptance. Admission succeeded in1320ms on allocated slot1; database, migrations, native Auth, real Kernel worker/relay and API driver were reached. Auth pages became ready. Evidence: `.temp/accounts/journeys.json`, `.temp/accounts/launcher.log`, `.temp/walk/e249c4cc-302e-4529-8b4a-d7453450a8fa/stack.log`. Full per-row UTC/persona/revision/elapsed values are retained in the table and JSON. No screenshots.

Native/API census:12/19 PASS (J01,J02,J05,J06,J07,J08,J09,J11,J12,J17,J18,J19),7 FAIL. These are API-stage assertions, not complete native/browser/growth or promotion acceptance. Slowest FAIL J13,32319ms, public target omitted subject.id. Authoritative launcher next hourly due2026-11-07T12:50:52Z is based on round start; the inner driver printed provisional13:09:49Z before launcher teardown, which is not a second schedule. No watcher or second walk was created.

Auth c883 owns complete recovery and fresh security effects. J03 POST /recovery/complete returned503 authentication_denied after actual private proof delivery; next sign-in and old credential/session invalidation remain unexecuted. J04 fresh login credential-effects sequence returned403 credential_effect_denied/not_applied; exact failing subphase was not recorded. Do not attribute it to a guessed stage. Reach replacement and credential/token review/revocation with real fresh proof and retain native authority, replay, uncertainty and bounded lifetime assertions. Actual Auth40c038 is integrated; the old fixed54329/SQL-before-database failures do not describe this run.

## Retained API receiving on the Library candidate

Actual source `70f7c7e9c7fc6ff08025044be46763221763f9d3`, native observation began `2026-11-07T13:27:02.282Z`. Ordinary supported same-handle walk, actual Auth/Access and native Kernel worker/relay; no worker-check ID. Evidence `.temp/accounts/journeys.json` and `.temp/accounts/launcher.log`. This API-stage result does not establish complete native/browser/growth or promotion acceptance. Original requirements above remain.

- J03: FAIL, 2026-11-07T13:27:06.554Z, 1976ms; recovery complete returned HTTP 503: {"error":"authentication_denied"}. Persona: j039d76a3af7a (416f2240-850c-8cc3-adbb-3f3c150f7eca), account 416f2240-850c-8cc3-adbb-3f3c150f7eca.
- J04: FAIL, 2026-11-07T13:27:08.947Z, 2392ms; credential effect HTTP 403: {"error":"credential_effect_denied","effect_status":"not_applied"}. Persona: j04532beb6154 (adba91cb-e80f-831f-aee1-ce2b1e918f1d), account adba91cb-e80f-831f-aee1-ce2b1e918f1d.

Keep the exact first failing operation and unreached downstream assertions from the prior causal brief. Receive the existing producer repair through controller integration on this handle; no substitute authority or reduced acceptance. Browser startup and final resource settlement are recorded separately after this round ends.
