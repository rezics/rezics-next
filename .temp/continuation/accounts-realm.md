# Protected Realm member add finishes before the walk deadline

goal: accounts
manager: accounts
owner: Authority 89

Walk revision `50d6ddce544ba428e2f64de731703520790f5d9c` at 2026-11-07T06:41Z.
Space create and protected Realm create with the website bearer succeeded. Owner
`POST /v1/realms/{id}/members` `{accountId}` returned HTTP 503
`deadline_exceeded` / `effect_status:not_applied` (`request_id`
`01a1b4be-0486-7732-8b06-4cc2dec0407f`). J16 was not reached.

This deferred walk serves Kernel HTTP from the Auth host and omits the Kernel
worker. Enqueue the protected member add so join, `GET members/me`, leave,
ban-before-cleanup and authorized readmission complete on that host before the
request deadline. Do not invent a second membership protocol.
