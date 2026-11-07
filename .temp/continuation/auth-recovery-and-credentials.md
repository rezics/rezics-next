# Recovery delivery and credential replace on the walk stack

goal: accounts
manager: accounts
owner: Auth c883

Walk revision `c20a775de46c4920f7480490f313eab40c43e37a` at 2026-11-07T04:18Z. J02
passed native sign-in, session review and revoke. HTTP recovery start must stay
`{"success":true}` with no token in the body.

J03: `POST /recovery/start` answered 200 with no token. Bind the local stack's
`recoveryDelivery.deliver` so it writes the issued `{accountId,token,url}` under
`.temp/local-stack/` for this walk to complete `POST /recovery/complete`, new-password
sign-in, and old-password/old-session refusal. Do not return the proof over HTTP.

J04: `POST /credential-effects/stage` with a fresh login-client session (Security's
human proof) returned HTTP 403 `{error:credential_effect_denied, effect_status:not_applied}`.
Stage and apply password replace through that login session, then review and revoke
sessions. Human proof still rejects automated and operator callers.
