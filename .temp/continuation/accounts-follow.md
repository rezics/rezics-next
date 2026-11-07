# Public person row includes the agent Subject

goal: accounts
manager: accounts
owner: Accounts
reuse: Identity 4ff

Walk revision `50d6ddce544ba428e2f64de731703520790f5d9c` at 2026-11-07T06:41Z.
J12 passed public person/organization/agent reads without private fields. Follow
writes the public agent Subject with no body. The walk waited 30s after signup
for `GET /v1/accounts?handle=` to publish `subject.id`.

J13 (35506ms) and J14 (31348ms): that public row still omitted `subject.id`, so
follow and outgoing counts could not name the target. After signup 201, the
handle's public row must include the bound agent Subject so `PUT /v1/follows/{id}`,
Following, unfollow, unavailable-target unfollow, and own `followingCount` can
run. Do not reject the eligible public agent Subject.
