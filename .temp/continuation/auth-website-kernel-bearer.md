# Website refresh family revoke on the issuer

goal: accounts
manager: accounts
owner: Auth c883

Walk revision `c20a775de46c4920f7480490f313eab40c43e37a` at 2026-11-07T04:18Z, deferred walk
slot 1 (issuer `http://127.0.0.1:20011`, native `http://127.0.0.1:20012`, Kernel
`http://127.0.0.1:20013`). Website bearer is accepted: J01 Home account GET and J05
profile save passed. First-party standing consent is not `POST /consent`.

J10: after authorize/token, `POST` issuer `/revoke` with website `private_key_jwt`,
resource `https://api.rezics.test` and the issued refresh token must answer HTTP 200
and raise the Access floor so `GET /v1/accounts/{id}/profile` with the old access
token is no longer 200. This round posted native `/revoke` and saw HTTP 400
`invalid_request`; the driver now posts the issuer revocation endpoint. Do not add a
walk-side bypass or a third-party consent editor for `rezics-website`.
