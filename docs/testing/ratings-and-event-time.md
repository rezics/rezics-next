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

G-025 registers a complete RATE01 candidate across the
[exact-reduction units](../../services/main/tests/rating-aggregate.test.ts) and
the existing real Account/Access/Main/Jena
[API/recovery fixture](../../tests/qa/fault-recovery/rating-daily.test.ts).
The [aggregate scenarios](../../tests/qa/support/rating-aggregate.ts) exercise
A's 2,2,8 through two personas and B's 6 through another private principal,
separate policy labels, exact fractions, rational distributions and denominators.
They correct an older experience without changing latest order, withdraw/restore
the latest, resolve equal trusted evaluation instants, add a deliberate new
occasion, and retry both an aggregate and an older sealed command. Empty and
all-withdrawn populations remain distinct from unavailable data. Contexts, Realms
and MainVersions remain separate; private historical reads and existing
standing/daily receipts remain intact.

The private inventory and admission seal are one Access transaction. A real
PostgreSQL trigger fails outbox insertion after both writes, proving rollback,
then the original API retry seals the existing graph effect. Until sealing,
aggregation is unavailable. Losing a graph slot, reverting a head, corrupting or
removing immutable bytes, altering a private principal binding, losing inventory,
or engaging either recovery hold must not return a complete partial score.
Reverse faults remove a private inventory slot or roll it back while retaining
the current graph. Both return unavailable; Access state coverage changes its
count/digest and returns to the original digest after exact repair. That is the
same inventory coverage consumed by the authenticated owner-cut release gate,
but this selected fixture does not execute that entire release protocol.
Shared call/byte budgets and a real blocked SQL read/pool checkout exercise
deadline and dependency failure branches.

The fixture bulk-builds background once and checks 0/16/64/256 unrelated graph
observations, revision anchors and private inventory/admission rows. PostgreSQL
EXPLAIN ANALYZE evidence requires the Context/target/slot index with exactly the
six selected rows and no post-filter discard; private admission joins use primary
keys. Graph calls, response bytes and five actual SQL statements stay bounded.
A separate bulk cohort succeeds with exactly 100 slots and rejects 101. These
fixtures qualify aggregate reads, not the interactive writes bypassed during bulk
preparation. Native Jena physical work, hot-node contention and capacity remain
unmeasured.

After an isolated graph cut, the fixture replays retained receipts twice from one
immutable backup and compares aggregate content with the original. It checks
unavailability under hold, then reopens only the disposable fixture through its
maintenance boundary to inspect reconstructed results. This does not qualify the
production owner-cut release gate. The private inventory remains in the retained
Access owner and is included in Access recovery coverage. Pre-inventory Contexts
are explicitly unavailable; their backfill is separate work. Only final recorded
backend QA on merged source can qualify RATE01; selected checks remain partial.
Matching corruption or rollback of both owners outside the authenticated recovery
boundary is not independently detected by this aggregate; a matching inventory
alone is not proof of a valid recovery cut.

Selected G-025 API/recovery run `20260926t094907-256a55` passed on its independent
worktree. It retained the reference and recovered results, actual graph and SQL
costs, PostgreSQL execution plans and the inventory coverage counterexamples in
`rating-aggregate-evidence.json`. Selected native model run
`20260926t093847-04e4d8` preserved the experience/daily variants and 66 historical
outcomes. Standing and Access compatibility run `20260926t094622-c8b533` passed.
These are partial evidence; source integration and the final backend matrix remain.
Merged source `4cfe239` passed 17 selected unit/coverage cases, native model
`20260926t095622-9cf8cb` and three-cadence real API/graph recovery
`20260926t095641-79d76f`. Standing withdrawal and Access compatibility passed
on the later documentation-only source `d070f96` in
`20260926t095929-a3bf2b`; Main API contract, generation and backend static
checks also passed. RATE01 is therefore an affected-verified complete-case
candidate, not a recorded backend pass. Production signed owner-cut release,
pre-inventory Context reconstruction, native Jena operator work and deployment
capacity retain their stated boundaries.

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
has a complete candidate declaration requiring that real-owner fixture, the
experience native matrix and the occasion identity unit. RATE03 and RATE04 retain
their own daily model/calendar and standing withdrawal declarations.
Only final recorded backend QA on merged source may
qualify the row; selected runs remain partial evidence.

G-022 extends the same isolated API/recovery fixture with the separately versioned
experience Context and Observation. A UUIDv4 occasion marker persists across
correction, withdrawal and restoration. It checks deliberate new occasions,
same-key changed payloads, different-key reuse, persona switching, another private
principal, exact original/revision retry, competing first submissions, stale and
cross-occasion heads, denied authority, revoked registered admission, inactive
principal, unavailable Context, exact private reads and all four timestamps.
RDF and retained envelopes must omit raw occasion markers and private principals.
All three profiles replay under hold twice with byte-identical original envelopes
and unchanged current heads; tampered daily/experience admission timestamps deny
replay. Existing standing/daily manifest bytes and original receipts remain
readable. The [experience native matrix](../../model/tests/experience-rating.test.ts)
rejects missing/foreign occasion references, mismatched predecessor ownership,
changed original times, valueless available revisions and valued withdrawals;
invalid candidates leave receipt/outbox/sequence effects rolled back.

Selected native `20260926t090200-a6109e` passed 18 tests, including 21 experience
variants and the 66 historical outcomes. Selected API/recovery
`20260926t090251-7b7a83` passed its 334 assertions in 35.3 seconds; fixture
startup/readiness took 15.9 seconds. Selected standing withdrawal
`20260926t090346-d32b96` also passed. These runs are partial evidence on the
independent G-022 source, not merged-source or final backend qualification.

Daily commands use bound Context/slot/revision lookups. The API fixture records
Main-to-Fuseki read calls and actual response bytes with a 24-call/64-KiB ceiling
per measured branch, and grows one observation's revision history at 1/4/8
additional revisions. Exact-head edits must retain the same read-call count and
within 1 KiB of response size. A deliberate over-budget read validates the meter.
Experience adds 0/16/64 unrelated fixture slots and measures both exact historical
reads and current-head correction with stable call counts and less than 1 KiB
variation. The shared meter also limits actual command calls to two and command
JSON to 32 KiB per measured branch. Fixture background comes from bounded bulk
imports, not repeated public command seeding. In the selected G-022 fixture,
experience correction stayed at 11 reads/10,747 response bytes and one
14,957-byte command at all three sizes; historical reads stayed at three
reads/1,945 bytes with no writes. The maximum across measured standing/daily/
experience branches was 14 reads/12,237 bytes and one 15,470-byte command.
Recovery used a single copied immutable manifest backup and an isolated restored
object directory. Account session expiry and an unavailable Account owner also
denied new effects. This checks the point-query cost contract; native operator work, hot-node
contention at scale and physical capacity remain unmeasured.
