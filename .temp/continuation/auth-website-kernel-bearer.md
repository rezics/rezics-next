# Website bearer accepted by Kernel

goal: accounts
manager: accounts
owner: Auth c883
consumers: Identity 4ff, Preferences 4776, Authority 89

Walk revision `5b3cf6755af0d3058f41eb7577624d22d304507b` at 2026-11-07T00:25Z, deferred walk slot 1
(native `http://127.0.0.1:20012`, Kernel HTTP `http://127.0.0.1:20013`). Auth issued the website
OAuth access token: developer account `99e7b230-90dd-83ae-b5dc-c12dcb45ae35`, callback
`/auth/callback`. Kernel refused that bearer with HTTP 401 `invalid_credentials` on the first
call, `POST /v1/platform/exposure/organizations:open` (`request_id`
`01a1b365-7cc8-76a4-aecb-7ded3982adfd`).

The same refusal stopped authenticated Home (J01 `GET /v1/accounts`), profile save (J05), consented
profile readback (J10), verification open (J11), outgoing follow counts (J14), Space create (J15;
J16 not reached), preference open (J17) and gate open (J19, 20490ms). Signup, authorize and token
exchange already succeeded.

Repair: Kernel on this walk stack must accept the website client's access token for resource
`https://api.rezics.test` using the ce33 canonical issuer JWKS document. `AUTH_ISSUER` and
`AUTH_JWKS_URL` keep the same issuer origin and port (slot 1 native `http://127.0.0.1:20012`,
issuer `http://127.0.0.1:20011`, Kernel `http://127.0.0.1:20013`). Transport only that exact JWKS
through `AuthenticationConfig.fetch`; do not add a loopback JWKS exception, blanket fetch override,
substitute credential or a second Auth writer. After the bearer is accepted, Identity, Preferences
and Authority continue those operations on the same walk handle.
