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
