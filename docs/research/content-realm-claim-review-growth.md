# Realm claim review growth binding

The selected operation is `GET /v1/realms/:realmId/claimRequests`, under ordinary
current Global `realm:approve_claim`. Its authority and bounds remain in
[Pending Realm claim review](../../services/kernel/src/community/README.md#pending-realm-claim-review).
This document does not change that contract or register another gate.

The inspected base source is `7611eb8d97eafcc58b5bcbf410b8fa626386f105`. Its registered
membership phase dispatches to `eraseAccountMembershipsPage`, which qualifies each retained owner locator and
calls `eraseAccountRealmOwnership` with installed worker Access before membership cleanup and locator retirement.
This source wiring satisfies the native prerequisite in the owning
[continuity contract](../../services/kernel/src/community/README.md#realm-ownership-continuity); controller execution
is still required to establish the registered runtime outcome.

The focused test composes the existing Community driver, production Access,
native Auth account deletion and registered default worker. A deletable account
receives creation authority through `/v1/grants`, creates a Space and Realm
through HTTP, then deletes itself through Auth's approved operation transport.
After native completion, the test requires an orphan episode at the immutable
erasure root with the original 720-hour deadline and unchanged source head.
It writes no ownership decision, grant result, committed event or locator in SQL.

The native fixture still begins with an Auth-deleted owner and requires the default registered participant to produce
the orphan episode. The selected Realm is never orphaned through SQL, direct succession, synthetic events or
permissive Access. The source remains active with its original head, orphan instant, 720-hour deadline,
lifecycle version and public-source epoch.

Decision: use the native fixture's trusted command clock to bracket the original
eligibility deadline without rewriting the orphan source or its episode identity.
After registered erasure supplies that source, the authored scenario requests
through the actual POST route, verifies same-episode pending deduplication with a
fresh key, and lists through the actual GET route with ordinary native Global
grants. It asserts the exact operational DTO, the full one-candidate page's empty
successor, viewer/limit cursor binding, claimant denial, and revoked review
authority with an independently allowed control. Forty native HTTP requests now
exercise the twenty-candidate cap at limit 100, a full deep page and its terminal
empty successor. Exact DTO assertions apply to every populated page. Fully
filtered pages still consume raw keys at limits 1 and 100; restoring the read
clock resumes after those keys rather than refilling them. An existing SQL
observer holds the actual HTTP candidate query while an ordinary grant revocation
commits, requiring final disclosure to deny the page and an independent current
reviewer to retain access. These authored semantic assertions are separate from
future growth observation; no Access implementation is replaced.

Decision: use the trusted read clock after original eligibility but before native request time to test ineligible candidates without rewriting request or episode sources.
The final source comparison retains the original head, lifecycle state, orphan
instant and 720-hour deadline. This does not measure a three-scale bound or cover
concurrent head, lifecycle, public-source, partition or native episode changes
between snapshots.

The focused test and private fixture now author three independent HTTP listing growth series for unrelated Realms,
pending requests on an unrelated orphan Realm, and retained requests from older episodes of the selected Realm, each
at 256/1024/4096. The selected candidate neighbourhood stays fixed. The shared growth harness observes
the actual registered Kernel route with production Access for populated, deep, terminal, fully filtered,
empty-successor, denied, and mid-read revoked-authority paths with an allowed control. Population and authority setup
are outside measurement. The growth assertion rejects sequential scans once either measured relation exceeds eight
pages. A native cursor also rejects a changed partition epoch; viewer and limit binding and raw-key
continuation remain outside measured work. Each source read retains the original head, deadline, lifecycle version
and public-source epoch.

Acceptance command:
`bun run --cwd services/kernel check test/community/growth-realm-claim-review.test.ts`.
Native/browser/acceptance launch remains deferred to controller admission. The authored assertions establish neither
native request/listing outcomes nor a three-scale growth bound. At admitted execution, bind the then-current committed
source revision and private fixture to the command above, and record reached assertions and native rows, buffers and
statements at all three scales. No measured revision or growth observation is claimed here.
