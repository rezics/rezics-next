# Walk Realm create accepts the unlisted Space child

goal: accounts
manager: accounts
owner: Authority 89

Walk revision `c20a775de46c4920f7480490f313eab40c43e37a` at 2026-11-07T04:18Z. Space
create with the website bearer succeeded. Realm create

`POST /v1/realms` `{spaceId, title, summary, visibility:"unlisted", contextId: Global}`

returned HTTP 400 `invalid_request` / `effect_status:not_applied` (`request_id`
`01a1b43b-212d-70c7-84b0-56472acc2eef`). J16 was not reached.

Repair: accept that unlisted Realm as a child of the just-created Space so join,
protected member read, leave, ban-before-cleanup and authorized readmission can run
on this walk handle. Do not invent a second membership protocol.
