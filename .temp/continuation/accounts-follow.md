# Public person row includes the agent Subject

goal: accounts
manager: accounts
owner: Accounts
reuse: Identity 4ff

Walk revision `c20a775de46c4920f7480490f313eab40c43e37a` at 2026-11-07T04:18Z. J12
passed public person/organization/agent reads without private fields. Follow writes
the public agent Subject with no body.

J13 and J14: `GET /v1/accounts?handle=` for a just-created public person omitted
`subject.id`, so follow and outgoing counts could not name the target. After signup
201, that handle's public row must include the agent Subject so `PUT /v1/follows/{id}`,
Following, unfollow, unavailable-target unfollow, and own `followingCount` can run.
Do not reject the eligible public agent Subject.
