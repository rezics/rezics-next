# Realm claim review growth binding

The selected operation is `GET /v1/realms/:realmId/claimRequests`, under ordinary
current Global `realm:approve_claim`. Its authority and bounds remain in
[Pending Realm claim review](../../services/kernel/src/community/README.md#pending-realm-claim-review).
This document does not change that contract or register another gate.

The retained source is `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`. Inspection found
the selected native prerequisite absent: `account-erasure.ts:236–237` dispatches
the registered membership phase to `eraseAccountMembershipsPage`; that function
closes/purges memberships and unlinks their locators without calling
`eraseAccountRealmOwnership`. The latter exists at
`account-erasure-memberships.ts:21`, but its only callers are focused tests.
The owning [continuity contract](../../services/kernel/src/community/README.md#realm-ownership-continuity)
requires: “The default Community participant must invoke this segment before
retiring that locator.” A direct call to that helper cannot prove this binding.

The focused test composes the existing Community driver, production Access,
native Auth account deletion and registered default worker. A deletable account
receives creation authority through `/v1/grants`, creates a Space and Realm
through HTTP, then deletes itself through Auth's approved operation transport.
After native completion, the test requires an orphan episode at the immutable
erasure root with the original 720-hour deadline and unchanged source head.
It writes no ownership decision, grant result, committed event or locator in SQL.

The proposed owning seam is the existing membership-erasure producer: invoke
`eraseAccountRealmOwnership` with production Access before closing/unlinking each
retained owner locator, retaining pending succession work for retry. That product
change is outside this slice's authorization. The test stops at this prerequisite;
no fallback scenario or SQL-generated orphan is accepted.

The remaining listing series belongs in the same focused test and private fixture:
independent unrelated Realms, pending requests and retained episodes at
256/1024/4096; fixed selected neighbourhood and requested limit; populated, deep,
terminal, fully filtered and empty-successor pages; denied authority with an
allowed control. Use the shared growth observer/classifier around the HTTP read,
with native request/lifecycle setup and unrelated pressure outside observation.
Keep cursor semantics separate from measured work and retain the owning candidate,
snapshot, deadline, epoch, lifecycle and operational-disclosure bounds.

Eventual acceptance command:
`bun run --cwd services/kernel check test/community/growth-realm-claim-review.test.ts`.
Native/browser/acceptance launch remains deferred to controller admission. No test
assertion or three-scale observation has been executed in this attempt; authored
coverage and compiler results are not measured passes. The continuation describes
the remaining listing outcome after the native producer is supplied.
