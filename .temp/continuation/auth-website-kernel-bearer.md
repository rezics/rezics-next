# Website refresh family revoke on native issuer transport

goal: accounts
manager: accounts
owner: Auth c883

Walk revision `0c4c52c14eb51ff21d901d69060b1fc08d83a341` at 2026-11-07T07:56Z, deferred walk slot 5 (issuer `http://127.0.0.1:20051`, native `http://127.0.0.1:20052`, Kernel `http://127.0.0.1:20053`). Website bearer is accepted: J01 Home account GET and J05 profile save passed. First-party standing consent is not `POST /consent`.

J10 (261ms): after authorize/token, `POST` native `/revoke` (issuer identity, same transport as `/token`) with website `private_key_jwt`, resource `https://api.rezics.test`, `token_type_hint=refresh_token` and the issued refresh token returned HTTP 400 `{error:invalid_request}`. Answer HTTP 200 and raise the Access floor so `GET /v1/accounts/{id}/profile` with the old access token is no longer 200. Do not add a walk-side bypass or a third-party consent editor for `rezics-website`.
