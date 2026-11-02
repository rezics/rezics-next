# Permitted rating aggregates and review citations

This guide binds [Content's aggregate outcome](../goals/content.md#done-when) to native acceptance. The contracts
remain in [Rating](../../services/kernel/src/rating/README.md) and
[Content](../../services/kernel/src/content/README.md#reviews). A binding describes executable assertions; it does
not establish that they passed. Integration must run the selections below on the retained source revision and
retain the check runner's terminal result and artifacts under the [verification rules](../development/verification.md).

Decision: keep Search's existing public-rating consumer and the composed driver; measure their actual output without
adding a Search writer or treating missing numbers as publication readiness.

## Native jobs and fixtures

Paths in this section are relative to `services/kernel/test/`.

| Person's job | Native binding | Required fixture and assertion |
| --- | --- | --- |
| Reader compares a subject with its Search card | `content/user-cases-outcomes.test.ts` → `content/user-cases-driver.ts` → `specs/content-user-cases-outcomes.test.ts`, `subject-rating-context` | Real Auth registrations with independent controllers, released standard question, fifty Global prior votes, real votes and `src/worker.ts`; `/figure` and `/subjects:search` agree on question, Global population, count, units, state, mean and score. |
| Member reads a private Realm figure; anonymous and protected non-member readers see only permitted aggregates | The same composed suite; `rating/public-figure-native-publication-http.test.ts` | Protected Realm membership is changed through community commands. Public figures continue to select Global; denied Realm aggregates expose zero and no private score, histogram or update state, and population pages omit that Realm. |
| Author reads a personal vote without publishing it | The composed suite; `rating/public-figure-native-publication-http.test.ts`; `rating/vote-http.test.ts` | Authenticated caller-home GET, actual PUT/clear and idempotency. Other viewers cannot select the author's private vote. Suspension denies stale credentials and leaves denied mutations without effects. |
| Author publishes a review and later changes a vote | The composed suite, `review-from-vote`; `content/review-native-lifecycle-http.test.ts` | Native review creation and revision commands store question, units and vote revision on each immutable post revision. Vote changes never rewrite old citations or licences. |
| Author deletes, replaces and restores a review | `content/review-native-lifecycle-http.test.ts` | One live slot per author/subject/board. Opening-post deletion releases it; replacement blocks restore with conflict; restore succeeds after the replacement releases it. Retained revisions remain readable according to current disclosure. |
| Anonymous reader and reacting authors reconcile counts and freshness | `content/reaction-counts-http.test.ts`; `content/reaction-relay-convergence-http.test.ts` | Native producer events, normal relay and default work runtime; set, replace, clear, delayed delivery and replay preserve exact per-kind totals. Viewer reaction stays private; `reactionsAsOf` identifies applied work. |
| Reader compares New, Active and Hot | `content/board-ranking-native-convergence-http.test.ts`; `content/growth-board-ranking-native-convergence.test.ts` | Native threads, replies, reactions and rank refresh. Assert exact ordering and freshness before/after convergence and replay; rank only permitted candidates. |
| Moderator conceals content; a reader loses access during a page | The composed suite, `late-board-revocation-pages`; reaction/ranking native suites | Preserve every first/continuation-page takedown, protected read-grant revocation and unchanged-page control for Hot, Active, New and thread posts. Shared fixture changes require coordination with the thread-page owner. |

Do not infer persona coverage from fixture availability. The composed suite covers anonymous, reader/author,
moderator, private member, protected non-member and suspended voter jobs. Integration must also retain the native
reaction/ranking denial assertions for banned actors. If a required persona never reaches its assertion, that job
remains unmeasured; a successful setup is insufficient.

`content/support/user-cases-fixtures.ts` owns real Auth registration and the separate production worker process.
The worker's consent endpoint reads current Auth consent. The driver activates `bundledRelease`, opens the
personal-library gate, registers separate voter populations and provisions community membership through APIs.
Its Search binding requires `OPENSEARCH_URL`, uses `createPublicRatingSource` with `withPublicRatings`, waits for
worker convergence and refreshes its isolated index. Missing Search setup must fail the composed measurement,
not become a null-valued passing card. Coordinate Search consumer execution with the Search owner.

The publication suite additionally exercises independently anchored population priors across subject partitions:
ten target votes plus forty prior votes establish the fifty-vote epoch, and later publication must not regress its
prior generation. This is distinct from a directly seeded figure or a synchronous hand-written prior.

## Values and freshness

The released standard question stores integer units from 0 through 20. Two stored units represent one display
point on 0–10. Aggregate `/ratings` means and histograms use stored units; public `/figure` means use display
points. `count` is a count of eligible votes, never a score. Bayesian `score` uses the active published prior and
must be asserted independently of the arithmetic mean.

Before a public figure is ready its mean and score are null. `insufficient_data` and `updating` are distinct
states; a previously ready figure can retain its published numbers while newer work is pending. Null numbers
alone prove neither readiness nor convergence. Check the native pending/epoch/publication assertions and ETag
where the owning suite supplies them. Realm `freshness.asOf` and `freshness.updating`, reaction watermarks and
ranking freshness describe different work and must not substitute for one another.

## Cost operation map

Use the shared `test/support/growth.ts` observer and access-path classifier. Capture native rows, buffers and all
statements, including failed statements, nested reads and runner work belonging to the operation. Hold the
selected neighbourhood fixed while varying unrelated data and history independently. Keep the existing planner,
security timing and budgets. The following are measurement bindings, not recorded growth results.

Paths below are relative to `services/kernel/test/`; scales are those already declared by the owning check.

| Owning operation | Existing measurement or concrete remaining measurement |
| --- | --- |
| Put vote; capped membership selection | `rating/growth-votes.test.ts`, 64/512/4096 votes and independently growing unrelated/waiting memberships. |
| Own-vote batch, empty and denied calls | `rating/growth-own-votes.test.ts`, 256/1024/4096; also pins empty input, caller validity and caller snapshot. |
| Aggregate apply | `rating/growth-aggregate.test.ts`; retain native effect and delivery work in the operation. |
| Population-total delivery and prior republish | `rating/growth-prior-epoch.test.ts`, 256/1024/4096; total updates and a bounded epoch republish page are separate operations. |
| Aggregate read and population page | `rating/aggregate-anchored-read.test.ts`, plus `rating/growth-aggregate-read.test.ts` (64/256/1024 target voters; 256/1024/4096 populations). Preserve separate-home freshness and deep continuation assertions. |
| Segment/re-key, eligibility, merge and membership change | `rating/growth-segment-job.test.ts`, `rating/eligibility.test.ts`, `rating/subject-merge.test.ts`, `rating/voter-realms.test.ts`; keep fixed pages, capped memberships and terminal empty pages. These are supporting producers, not substitutes for mounted public reads. |
| Public figure drain | `rating/growth-public-figure.test.ts`, 64/256/1024. This fixed pending-key operation differs from an exact public read. |
| Native public figure read after publication | `rating/growth-public-figure-native-publication.test.ts`, 8/32/128; independently grows unrelated native subjects/figures and same-target population history while keeping the selected Global figure fixed. |
| Public HTTP figure, batch/page and views; own-vote/question GET | `rating/public-figure-http.test.ts` (1/64/512 voters), `rating/growth-figures-statistics.test.ts`, `rating/public-figure-views.test.ts` (1/64/256 requested subjects). The views check varies requested batch size; it alone does not measure fixed-neighbourhood unrelated growth. |
| Review creation and conflict | `content/growth-threads.test.ts`, `content/review-conflict-http.test.ts`; preserve successful creation and rolled-back conflict as separate branches. |
| Review restore conflict | `content/growth-review-native-lifecycle.test.ts`, 256/1024/4096 author/subject/board/vote and revision histories, fixed live replacement; includes the failed unique-index statement. Successful restore is an outcome in the lifecycle suite, not a three-scale success measurement. |
| Reaction slots, subject standing and subject relay | `content/growth-reactions.test.ts`, 64/512/4096; `content/subject-reaction-standing.test.ts`. Do not count a set-only measurement as clear/post coverage. |
| Joined reaction write, relay, reads and replay | `content/growth-reaction-relay-convergence.test.ts`, 256/1024/4096; compare actual projections with native slot commands. `content/reaction-projection.test.ts` also measures fixed-change aggregation. |
| Reaction count, batch and own reaction reads | `content/subject-reactions-http.test.ts`; verify each empty/denied/page branch is captured rather than extrapolating from the joined non-empty case. |
| Subject reaction merge page | `content/subject-reaction-merge.test.ts`; include command-generated changes and terminal cursor work, not directly seeded asserted totals. |
| Board projection, candidates and public board point read | `content/board-read-growth.test.ts`, `content/growth-threads.test.ts`. Candidate/projection work and final public disclosure are separate captures. |
| New/Active/Hot pages, deep/empty/denied pages and native rank refresh | `content/growth-board-ranking-native-convergence.test.ts`, 256/1024/4096; `content/growth-board-sorts.test.ts`, 256/1024/4096; `content/board-hot-refresh.test.ts`. Preserve fixed page/candidate/refresh limits and include native relay/refresh work in its own measured operation. |

Imported source-statistic writes, account erasure and other resource lifecycle operations have separate owner
acceptance; they are not evidence for publication of native vote aggregates. The rating question directory is
metadata, not public figure readiness. Its documented missing native growth measurement remains separate.

## Integration commands and remaining conditions

Run from the repository root through the owning runner with normal heavy-check admission. The first selection is
the clause's initial acceptance (ten files); later selections must contain at most twelve nearby files. Do not run
a second physical check while the first is queued or active.

```sh
bun run --cwd services/kernel check \
  test/content/user-cases-outcomes.test.ts \
  test/content/reaction-counts-http.test.ts \
  test/content/reaction-relay-convergence-http.test.ts \
  test/content/review-native-lifecycle-http.test.ts \
  test/rating/public-figure-http.test.ts \
  test/rating/public-figure-native-publication-http.test.ts \
  test/rating/growth-votes.test.ts \
  test/rating/growth-public-figure.test.ts \
  test/content/growth-board-ranking-native-convergence.test.ts \
  test/content/growth-review-native-lifecycle.test.ts

bun run --cwd services/kernel check \
  test/rating/growth-public-figure-native-publication.test.ts \
  test/rating/growth-own-votes.test.ts \
  test/rating/growth-aggregate.test.ts \
  test/rating/growth-aggregate-read.test.ts \
  test/rating/growth-prior-epoch.test.ts \
  test/rating/growth-segment-job.test.ts \
  test/rating/growth-figures-statistics.test.ts

bun run --cwd services/kernel check \
  test/content/growth-reaction-relay-convergence.test.ts \
  test/content/growth-reactions.test.ts \
  test/content/growth-board-sorts.test.ts \
  test/content/growth-threads.test.ts \
  test/content/board-read-growth.test.ts \
  test/content/board-hot-refresh.test.ts
```

Execute the remaining owning files in the operation map once in similarly bounded selections, including the
existing Search consumer acceptance with its owner. Use the runner's migrated database, Auth, work and OpenSearch
setup. Retain the exact source revision, command, reached assertion names and native growth artifacts with each
terminal result. Infrastructure exits 70/75, missing setup, queued runs and inspection do not establish a pass or
product flakiness. Minimal worker verification defers this acceptance to integration; no Goal closure or promotion
is implied by this guide. An unexecuted branch or missing three-scale branch remains an external measurement
condition until the owning runner reaches it successfully.
