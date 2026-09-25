# Rating and temporal acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| RATE01 | A rates 2,2,8 and B rates 6 | Latest-per-rater 7; mean-per-rater 5; pooled 4.5 labeled separately. |
| RATE02 | Correct standing/daily/experience observation | Same observation revision; intentional new slot creates new identity. |
| RATE03 | Daily vote around DST with persona switch | Server calendar and private uniqueness hold. |
| RATE04 | Withdraw latest opinion | Older public opinion is not resurrected. |
| RATE05 | Change question versus aggregation default | New context for meaning; policy revision for reduction only. |
| RATE06 | Compare Realm and Global scores | Distinct populations/scales and explicit synthesis policy. |
| RATE07 | Month-only event queried by day | Possible versus definite match preserved. |
| RATE08 | Named concepts point to same event | Deduplicated event/date authority, distinct topic identities. |
| RATE09 | Change date/source during histogram rebuild | Fenced generation and explicit cursor restart. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.

The registered [RATE04 owner fixture](../../tests/qa/integration/rating-withdrawal.test.ts)
creates a real Work, Realm and standing RatingContext in Fuseki, then writes two
rater slots. One slot changes from 2 to 8 before its latest revision is withdrawn;
the Main aggregate API returns only the independent rater's 6, while the older
2 and 8 revisions remain immutable and the current head points to the withdrawn
revision. Restoring that same observation to 9 yields a two-rater mean of 7.5.
Selected integration `20260925t183302-fd4807` passed; a selected run reports
RATE04 as partial until a complete run executes its declared case coverage.
