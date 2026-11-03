# Current membership interval growth

This binding supplements [Content Done-when 3](../goals/content.md#done-when) and the
[Community Cost contract](../../services/kernel/src/community/README.md#cost), using the
[shared observer and classifier](../../services/kernel/test/support/growth.ts).
The existing [combined history progression](../../services/kernel/test/community/growth-membership-history.test.ts)
remains separate evidence.

Decision: use a closed, expired interval as the valid empty-read control, with a fixed baseline of 256 on the
non-growing axis and all unrelated keys on the selected route.

## Read current Realm membership

- Touches: `readRealmMembershipInterval` and its production SQL on the observer pool, including the empty seek.
  Setup reuses the native Content system's production Access factory, Auth-issued actors and registered native
  runtime. The selected operation is an internal reader; it does not authenticate, accept a command or launch work.
- Bound: one statement and one examined row for a hit; one statement and zero examined rows for the expired
  control. Both use one `realm_member_open` index scan, without a history scan. Buffers grow logarithmically.
- Growth check: [independent interval axes](../../services/kernel/test/community/growth-membership-interval-axes.test.ts)
  runs separate current/expired series for each axis at 256, 1024 and 4096. Every repetition asserts exact output
  and rows/statements, and every scale captures the open-index plan separately. The shared classifier measures
  buffers as well as rows/statements; no planner settings or budgets change.

## Operation binding

The private [fixture](../../services/kernel/test/community/support/growth-membership-interval-axes-fixture.ts)
holds Realm, account, reservation, transaction, interval start and read time fixed across all series. Current
intervals start at `2029-01-01T00:00:00.000Z`; the expired control ends at `2029-12-01T00:00:00.000Z`.
All reads use `2030-01-01T00:00:00.000Z`. Older closed intervals are disjoint one-second intervals in 2020.
Each series retains exactly one selected current/expired anchor. SQL counts outside observation verify both
axes at every scale:

| Series axis | Same-key older closed intervals | Unrelated open membership keys |
| --- | --- | --- |
| Unrelated keys | 256 | 256 / 1024 / 4096 |
| Closed history | 256 / 1024 / 4096 | 256 |

Setup explicitly overrides the common selected-command instruction for these temporal membership rows.
Administrative insertion, private-row reset, population counts and statistics maintenance occur outside observation;
they prove no native join/leave transition. The other Realm holds unrelated keys in the same physical relation and
route. No page or batch is selected by this point reader. Selected output is exactly `{ since, reservationId }` or
`null`, obtained only from the production reader. Returning that awaited value completes the operation. Repeated
reads exercise idempotent read replay, with no effects or registered-runner work required or invoked. Existing
history, join, Accounts transition, ban, publication, board and Context suites retain their owners.

## Execution and limits

Run from the committed worktree root:

```sh
GROWTH_PROFILE=.temp/membership-interval-axes.jsonl GROWTH_PROFILE_REQUIRED=1 \
  bun run --cwd services/kernel check test/community/growth-membership-interval-axes.test.ts
```

At integration, bind the actual tested `git rev-parse HEAD`, command, runner check identity and exit status to the
returned profile and JUnit artifacts in `.temp/`. Retain all three scales' rows, shared-hit/read buffers, statements,
plans, classifier results and reached assertions, including the separate expired samples. Source inspection,
typechecking, a queued check or an infrastructure exit supplies no measured observations. Native growth execution
is deferred to the admitted integration run under the current launch policy; this document claims no tested
revision, reached runtime assertion or three-scale pass. Focused worker execution, if admitted by the landing
runner, must retain the same limits. This binding does not establish membership workflow completion, HTTP admission,
Access cost, Goal closure or promotion.
