# Continue Accounts API capture after owner diagnosis

goal: accounts
manager: content
owner: existing runtime, Auth and Access owners

The capture repair is committed and the native run collected J03, J04 and J10 on the supplied durable runtime without
reboot, reset or reseed. `capture.json` is at `.temp/goal/accounts/post-seed-api-capture/capture.json`. It records
source revision `cd7a7e3224e97df35a63b4b5fa3eab864ffa8f4a`, runtime revision
`5dbf15efbd3c857b7a3d51cebe3aead863c57903`, service `rezics-page-review-20261109.service`, lease/stack PIDs
2513293/2513319, and seed `completed:false/state:failed`.

- J03 signed up, signed in, received local recovery mail and started recovery (HTTP 200); recovery completion returned
  HTTP 503 `authentication_denied`, retained as unknown overload. Later password/session checks were not reached.
- J04 signed up and signed in; credential stage returned HTTP 200, then approval returned HTTP 403
  `credential_effect_denied` with `effect_status:not_applied`. Apply and independent password/session reads were not
  reached. This is the captured assertion failure; it does not yet identify an Auth or Access defect.
- J10 signed up, obtained website authority, and read the profile with its bearer (HTTP 200). Revoke sent all six
  original fields with client/resource/issuer/token-kind bindings and returned HTTP 400 `invalid_request`, retained
  as unknown setup. The post-revoke same-bearer read was not reached.

Capture request correlation is local only; no service request ID was sent or returned. The runtime owner and owning
Auth/Access maintainers must supply actual request-correlated evidence or an approved receiving reproduction before
assigning a service defect. Then collect any service repair in one causal batch and schedule a new admitted capture;
do not infer cause from adjacent logs, or reboot, reset, reseed or reuse the prior humans. The current run establishes
no J03/J04/J10 pass and does not promote API, native, browser or full-Goal evidence.
