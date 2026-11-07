# Follow a public person from the website bearer

goal: accounts
manager: accounts
owner: Accounts

Walk revision `301e67097ba1d64de62172fed70f318ba65791df` at 2026-11-07T01:42Z. J13 now PUTs the
public agent Subject from GET /v1/accounts with no body (`t.Optional(t.Never())`). The previous
HTTP 400 `invalid_request` was that empty JSON body. After the next round, accept follow of that
subject, list it on Following, unfollow, then unfollow after the target is stored as unavailable.
Do not reject the eligible public agent Subject. Website-bearer Kernel 401 remains Auth c883.
