# Recovery complete and credential replace on the walk stack

goal: accounts
manager: accounts
owner: Auth c883

Walk revision `0c4c52c14eb51ff21d901d69060b1fc08d83a341` at 2026-11-07T07:56Z on deferred slot 5. J02 passed native sign-in, session review and revoke. Local assemble writes recovery `{accountId,token,url}` under `.temp/local-stack/recovery`. HTTP start stays `{"success":true}` with no token in the body.

J03 (1819ms): `POST /recovery/complete` with that privately delivered token returned HTTP 503 `{error:authentication_denied}`. Authorize recovery complete through Access so new-password sign-in succeeds and the old password/session are refused.

J04 (1843ms): `POST /credential-effects/stage` with a fresh login-client session returned HTTP 403 `{error:credential_effect_denied, effect_status:not_applied}`. Stage and apply password replace through that login session, then review and revoke sessions. Human proof still rejects automated and operator callers.
