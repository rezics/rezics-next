# Follow a public person from the website bearer

goal: accounts
manager: accounts
owner: Accounts

Walk revision `5b3cf6755af0d3058f41eb7577624d22d304507b` at 2026-11-07T00:25Z. J13 created a native
signup target then `PUT /v1/follows/{id}` with a website bearer returned HTTP 400 `invalid_request`
(`request_id` `01a1b365-b5fb-71e9-95c0-1afaab2dab08`), not 401. Repair: accept follow of that
person account id, list it on Following, unfollow, then unfollow after the target is stored as
unavailable. Do not reject the eligible public target.
