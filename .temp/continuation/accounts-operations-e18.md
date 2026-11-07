# Personal delete applies on the walk Auth host

goal: accounts
manager: accounts
owner: Accounts
reuse: SDK e18, Auth c883

Walk revision `c20a775de46c4920f7480490f313eab40c43e37a` at 2026-11-07T04:18Z.
Organization create, owner transfer, rename and software opening passed (J06–J09).
Website Kernel bearer is accepted.

J18: `POST /account-operations/approve` then execute `{kind:delete}` with the current
handle as confirmation returned HTTP 400 `{error:account_operation_denied,
effect_status:not_applied}`. Bind the Kernel account-operation receiver so a human
delete with that handle confirmation applies, then sign-in is refused and public
attribution remains without a live handle. Do not add a new denial envelope.
