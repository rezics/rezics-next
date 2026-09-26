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

The registered [daily API/recovery fixture](../../tests/qa/fault-recovery/rating-daily.test.ts)
uses real Better Auth Account assertions, Access registration/claim/sealing, Main
HTTP handlers and isolated Jena owners. Only its disposable Access database's
registration-time default is controlled to exercise 2026 New York spring/fall
transitions. The product has no client or test clock override. It covers exact
UTC bounds, client-field rejection, two personas for one private principal,
competing first submissions, distinct principals/days, pre-dispatch and sealed
retries crossing midnight, historical correction/withdrawal/restoration, missing
scope/grant and inactive principal, authorized revision reads, held graph-loss
replay twice and byte-identical relay envelopes, including standing effects.
Tampering with the retained admission time blocks replay.

[Calendar units](../../services/main/tests/rating-calendar.test.ts) add skipped
midnight/date and repeated-hour counterexamples. The [native daily matrix](../../model/tests/daily-rating.test.ts)
checks required calendar fields, period containment, exact bindings and rollback;
the existing 66-case matrix preserves standing profile digests/outcomes. RATE03's
complete declaration requires the named real-owner, native-model and calendar
cases in a full backend run; selected checks remain partial evidence. RATE02
remains partial because experience observations are outside the daily profile.

Daily commands use bound Context/slot/revision lookups. The API fixture records
Main-to-Fuseki read calls and actual response bytes with a 24-call/64-KiB ceiling
per measured branch, and grows one observation's revision history at 1/4/8
additional revisions. Exact-head edits must retain the same read-call count and
within 1 KiB of response size. A deliberate over-budget read validates the meter.
This checks the point-query cost contract; native operator work, hot-node
contention at scale and physical capacity remain unmeasured.
