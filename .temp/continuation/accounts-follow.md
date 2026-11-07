# Public person row includes the agent Subject

goal: accounts
manager: accounts
owner: Accounts
reuse: Identity 4ff

Walk revision `0c4c52c14eb51ff21d901d69060b1fc08d83a341` at 2026-11-07T07:57Z.
J12 passed public person/organization/agent reads without private fields. Follow
writes the public agent Subject with no body. The walk waited 30s after signup
for `GET /v1/accounts?handle=` to publish `subject.id`.

J13 (31730ms) and J14 (30481ms): that public row still omitted `subject.id`, so
follow and outgoing counts could not name the target. After signup 201, the
handle's public row must include the bound agent Subject so `PUT /v1/follows/{id}`,
Following, unfollow, unavailable-target unfollow, and own `followingCount` can
run. Do not reject the eligible public agent Subject.
