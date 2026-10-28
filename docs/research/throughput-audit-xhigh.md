# Throughput audit: worker time to integrated tasks

Research snapshot: **2026-10-28 06:02:32.229925 UTC**. Measurement window: the preceding 24 hours.
Repository baseline: `d06435e227fb60b27e18244850e1c1511438ab95`. This report is evidence for adoption by the
control-plane owner; it changes no scheduling, routing, acceptance, or product contract.

**The principal limit is conversion of occupied workers into accepted work, compounded by check queues.**
There were **413 integrations, 17.21/hour**, from **1,062.73 worker-hours**, or **0.389 integrations per worker-hour**.
Failed, interrupted, and replaced attempts occupied **516.50 hours, 48.60%** of that time. In the winning task
histories, preceding attempts consumed **48.84% of worker time and 49.90% of recorded tokens**. More workers alone
did little: mean occupancy rose from **36.02 to 52.54** between the two halves of the window, while integrations
rose from **16.67 to 17.75/hour**. These are observations, not a causal experiment. [Q1–Q4]

## Definitions and evidence boundaries

- A landing means a unique task with a passing `gate-outcome` in the window: integration onto `dev`, including
  direct control-plane landings. All 413 passing events have stage `merge`; their current states are 407
  `integrated` and six `merged`. A worker's successful exit is not a landing. The store's `merged` state and
  promotion to product `main` are separate measures. [Q1]
- The source was opened with SQLite `mode=ro` and copied with the backup API into this worktree's
  `.temp/throughput-audit/snapshot.sqlite`. The snapshot has 2,055 tasks, 3,275 attempts, 3,203 records, 6,173
  events, 2,131 landing entries, and 4,478 inbox entries. SHA-256:
  `b977c29d91814dd0e9f66aaccbe4b3d48054733b658e811ca213123c2b6f8954`. [Q0]
- Calendar-window resource accounting clips each attempt to the window. Winning-cohort latency and token
  accounting includes its entire preceding history, even before the window. Those denominators must not be mixed.
  No manager-model time, consultation tokens, or unregistered dispatch time is charged as worker time.
  Worker-hours mean persisted attempt residence, including lifecycle-detection delays, rather than CPU time or
  independently verified live-process occupancy.
- Historical labels are mutable and can be inherited by retries. **57 of the 411 ended passing records still
  have an escalation label**: 31 environment, 21 rebase, five early-stop. Two pending records also carry old
  labels. Classify final `passed`, `pending-gate`, `cancelled`, and `superseded` outcomes before escalation. [Q2]
- The prompt's earlier 12-hour figures are context, not this snapshot's denominator. This snapshot's last
  12 hours contain 454 ended attempts, including 212 passing and 30 pending records, and 213 integrations.
  The corrected classification and moving window explain why an exit-label count is not comparable directly. [Q1–Q2]

The analysis scripts and extracts remain under `.temp/throughput-audit/` in this worktree: `analyze.py`,
`logs.py`, `failure-audit.py`, `metrics.json`, `decomposition.json`, `failure-audit.json`, `log-metrics.json`,
and `direct-waits.json`. The query recipes below make the report independently reproducible without those files.
Raw production paths below are relative to `/home/edge/projects/rezics/rezics-next/.temp/goal/`.

## Where the elapsed time goes

For the 413 winning tasks, creation-to-integration mean is **211.25 minutes**, median **109.62**, p90 **455.88**.
The following main rows sum to the mean; percentiles of components do not sum. Retry gaps include earlier
failed landing attempts and management/admission delays between attempts. [Q3]

| Component             | Mean minutes | Median |    p90 | What is actually measured                                       |
| --------------------- | -----------: | -----: | -----: | --------------------------------------------------------------- |
| Before first worker   |        60.64 |   0.01 | 156.86 | First start minus task creation                                 |
| All worker attempts   |        93.52 |  31.35 | 245.71 | Sum of attempt end minus start; includes checks and their waits |
| Final landing queue   |        33.94 |  26.08 |  76.38 | Final request to inferred train start                           |
| Final train residence |         1.96 |   1.56 |   3.37 | Passing outcome's `hostMs`                                      |
| Retry/other gaps      |        21.19 |   0.00 |  53.25 | Residual after the preceding components                         |
| Total                 |       211.25 | 109.62 | 455.88 | Creation to passing event                                       |

Split of pre-worker time is reconstructible for **403 tasks** using current `brief.after` and predecessor pass
events: dependency time mean **40.50 minutes**, median zero, p90 **94.86**; ready-to-start time mean **11.64**,
median **0.007**, p90 **6.35**. These sum to **52.15 minutes** on that subset. The other ten tasks contribute
**4,028.25 pre-worker minutes** whose dependency history cannot be reconstructed. Current briefs can have been
reshaped, and the store does not retain dependency-edge or hold-transition history. [Q3]

**Ready-to-start is an upper bound on capacity delay**, also containing scheduling, manager release, and checkout
preparation. Its pure capacity contribution is between zero and the observed ready-to-start interval. Capacity
tickets disappear on admission; `awaitHostCapacity` records neither a historical admission start nor end. A
precise capacity-only decomposition is unavailable. Do not relabel the entire interval as capacity. Likewise,
the residual is not pure manager thinking. One residual is negative by 1.14 seconds, indicating publication/timing
overlap; it is retained rather than silently adjusted. [Q3; `tools/goal/src/launch.ts`, `tasks.ts`]

Check-slot waiting is substantial inside the worker row. A conservative direct-command sample has **234 ended
attempts and 745 distinct reported waits**. For each attempt, the largest wait, less any lifetime outside the
window, gives a lower envelope; the sum, capped at its in-window duration, gives an upper envelope for those
observed waits. The totals are **148.76–214.10 worker-hours**. This is a coverage-limited envelope, not a confidence
interval or the total delay of all checks. Checks can overlap; uncompleted queued checks have no duration yet.
Within passing/pending attempts alone, the envelope is **69.03–97.77 hours**. [Q5]

A worker can edit or inspect other results while a check waits. These envelopes bound time with an outstanding
queued check in the observed sample; they do not establish exclusive worker idleness or time saved automatically
by adding capacity. The throughput conversion below is consequently a planning scenario.

The wider discovery scan found busy-slot messages in **538 of 877 non-research attempt logs**. It found 1,649
distinct printed duration/host pairs, but displays of old logs repeat them, so those prints are not added as
worker time. The direct sample excludes `cat`, `head`, `tail`, `rg`, `sed`, and Python commands and all research
tasks; it also excludes running attempts from the envelope because their logs can advance after the snapshot.
This misses legitimate checks launched in background and later inspected. It avoids charging research reads of
other workers' logs to their own waiting time. [Q5]

There were 554 landing requests and 513 gate outcomes in the window: 413 passes, 73 rebase-stage failures, and
27 gate-stage failures. Their summed `hostMs` is **15.75 hours**, but the union of their residence intervals is
**14.73 hours** because batch members overlap. **54** passing logs mention a batch integration check. Dividing
passes by that union gives **28.03/hour of recorded train residence**, not a sustainable capacity forecast.
The remaining **9.27 hours** are not proved idle: completed outcomes omit in-flight/restarted work and promotion.
The largest uncovered span is **74.7 minutes**, starting at 04:07:23 UTC; 29 new requests arrived during it.
Persisted start/end events are needed before attributing that span to a stopped train. [Q1, Q6]

At cutoff, only **30** of the 49 null-outcome landing rows are undelivered current `landing` tasks. Their mean
request age is **55.86 minutes**, range **0.22–410.49**. The other 19 null-outcome rows are already delivered;
counting all 49 as current backlog exaggerates pressure. Two more tasks have state `landing` without such a
current row. Queue residence affects latency and branch age even when it does not consume a worker. [Q6]

The promotion singleton is at `gate-head`, with **924 task references**, four-way promotion parallelism, and no
head results persisted. That is a pending promotion inventory, not 924 new landings in this window. The singleton
and mutable task state do not supply a complete promotion-completion time series. Track integration throughput
and product-main promotion separately. The last two hours produced **23 integrations, 11.5/hour**, despite mean
worker occupancy **56.50**. [Q1, Q6]

## Attempts, tokens, and repeated work

878 attempts ended, 932 started, and 950 overlapped the window. Thus ended-attempt flow divided by integrations
is **2.13**, while the **413-task winning cohort actually required 732 attempts, 1.77/task**. The difference is
work on tasks that have not landed and boundary crossings. **253 winners, 61.26%,** have one attempt; 160 have
predecessors. Their 319 preceding attempts used **314.41 of 643.74 worker-hours**, and **3.942 of 7.900 billion
raw recorded tokens**. These measure repeated attempts, not identical code written twice: retries may preserve
commits, while different task identities can repeat earlier design work. Exact semantic duplication is not logged. [Q2–Q4]

The table attributes the complete history to the **winning model and task class**. A predecessor can use another
model. Input includes cached input; output includes reasoning where supplied. Do not add cached input or reasoning
again. There are only **170 session-ledger usage records among the 878 ended attempts**, and 40 have zero recorded
input/output. Winning histories have 97 ledger-bearing records among 732 attempts. Older normalized counters and
profile-model labels are fallbacks, not proof of zero spend or actual model identity. No billing estimate is made. [Q4]

| Winning model     | Class          | Landings | Attempts/task | Input M/task | Cached/input % | Output K/task |
| ----------------- | -------------- | -------: | ------------: | -----------: | -------------: | ------------: |
| gpt-6.1-sol       | claim          |      104 |          1.80 |        17.57 |           98.5 |          57.6 |
| gpt-6-luna        | implementation |       76 |          1.71 |        17.08 |           98.3 |          72.1 |
| gpt-6.1-sol       | specification  |       63 |          1.46 |        10.52 |           98.5 |          28.1 |
| gpt-6-luna        | claim          |       40 |          3.15 |        58.21 |           98.4 |         212.6 |
| gpt-6.1-sol       | research       |       29 |          1.07 |         3.03 |           95.1 |          25.5 |
| gpt-6.1-terra     | interface      |       15 |          1.67 |        13.11 |           98.0 |          24.9 |
| gpt-6.1-sol       | implementation |       14 |          1.36 |         4.29 |           97.8 |          20.2 |
| claude-sonnet-5-5 | claim          |       13 |          1.46 |        13.65 |           98.7 |          66.2 |
| gpt-6-luna        | interface      |       12 |          1.50 |        34.17 |           98.7 |         106.3 |
| claude-sonnet-5-5 | interface      |       11 |          1.91 |        13.00 |           98.4 |          53.9 |
| gpt-6.1-sol       | interface      |        8 |          3.38 |        70.17 |           98.5 |         210.0 |
| gpt-6-luna        | bulk-text      |        6 |          1.50 |         3.69 |           95.6 |          37.6 |
| gpt-6.1-terra     | research       |        6 |          1.00 |         0.74 |           91.2 |           7.0 |
| gpt-6.1-sol       | critical-path  |        6 |          1.67 |        11.01 |           98.4 |          31.0 |
| claude-sonnet-5-5 | implementation |        3 |          1.33 |         0.70 |           94.3 |           8.6 |
| gpt-6-luna        | research       |        3 |          1.33 |         6.88 |           93.9 |          76.4 |
| claude-sonnet-5-5 | specification  |        1 |          1.00 |         0.96 |           95.0 |           7.1 |
| gpt-6-luna        | critical-path  |        1 |          1.00 |         1.10 |           95.3 |          12.3 |
| gpt-6.1-sol       | bulk-text      |        1 |          1.00 |         0.73 |           91.0 |           3.6 |
| gpt-6.1-terra     | claim          |        1 |          1.00 |         0.34 |           85.4 |           6.3 |

Luna-winning claims average **3.77 worker-hours/task**, versus **1.84** for Sol-winning claims. This supports
a controlled routing trial for difficult claims; it does not establish a model effect. Task complexity, repeated
failures, timing, and model changes are confounders. Sol interfaces are also costly. Route by measured task
features and the first substantive failure, and compare within class rather than choosing one model globally. [Q4]

## Failure classes and inspected causes

The table uses corrected final classification. Hours are worker residence inside the window, including waits;
the passing, pending, and running rows are not waste. These rows reconcile to 1,062.73 hours. [Q2]

| Final class        |   Ended attempts | In-window worker-hours |
| ------------------ | ---------------: | ---------------------: |
| Passed             |              411 |                 326.87 |
| Pending gate       |               30 |                  79.57 |
| Spec conflict      |               92 |                  90.42 |
| Environment        |               88 |                  72.11 |
| Superseded         |               91 |                  95.12 |
| Stalled            |               55 |                  98.01 |
| Rebase conflict    |               52 |                  84.98 |
| Cancelled          |               24 |                  36.38 |
| Scope growth       |               23 |                  28.05 |
| Early stop         |                8 |                   8.51 |
| Repeated assertion |                2 |                   0.46 |
| Other stopped      |                2 |                   2.46 |
| Still running      | 0 ended; 72 open |                 139.79 |

Root-cause audit uses persisted exit detail, then blocker/failure/result, then a manager-event summary. Pattern
buckets identify evidence, not a guaranteed ultimate cause. The important corrections are: [Q7]

- **Environment:** 37 transport/admission reports occupy **44.27 hours**; nine model-capacity refusals **4.71**;
  22 killed-without-success reports **7.25**; six missing-file/input reports **3.49**; two file-descriptor failures
  round below **0.01**. The remaining 12 account for **12.38 hours**. A killed process is not proof of OOM.
- **Stalled is overloaded:** 19 class-limit exits occupy **46.40 hours**, 15 explicit quiet-watchdog exits
  **34.05**, eight transport reports **10.43**, three model-capacity refusals **0.03**, three killed reports
  **1.07**, three missing-input reports **0.55**, and four other diagnostics **5.49**. Only the explicit 15
  should be described as quiet-watchdog exits, and even those do not establish whether a check was still queued.
- **Spec conflict:** 17 are repeated rebase conflicts occupying **31.34 hours**; three are check-transport
  reports occupying **2.98**. The remaining 72 occupy **56.10 hours**, mainly incompatible contract/assertion
  expectations. Calling all 92 product decisions would send the wrong work to managers.
- **Rebase:** 73 rebase-stage gate failures are distinct from the 52 attempts finally labelled rebase conflict.
  Some repeats become spec conflict. Conflicted-path counts include `.oxfmtrc.json` **10**, Library schema **7**,
  Access README **6**, Web isolated-check script **5**, and Semantic README **4**. Shared scaffolding contributes
  alongside domain overlap. [Q6]
- **Replacement:** 79 of 91 superseded attempts have no persisted explanatory diagnostic, accounting for
  **88.38 hours**. Replacement is measured; the store cannot reliably distinguish manager reshape, mechanical
  retry, and cancellation intent. Do not equate the whole superseded count with manager mistakes.

Inspected examples below use content selectors rather than embedding task identifiers. Q7 returns the actual
run path; line numbers refer to that JSONL file. Landing log names directly identify retained artifacts.

| Source selector / log                                                                                                   | Read evidence                                                                                                                                                      | Interpretation                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Exit detail contains `Both attempts waited for and acquired a test slot on host b`; run lines 250–252                   | Upload connection closed, retry waited 977.653 seconds, execution SSH then closed with exit 255                                                                    | A real transport failure after admission, not a failing product assertion                        |
| Latest quiet-watchdog sample with maximum attempt duration; run lines 41–45, detail `stalled: no output for 40 minutes` | A kernel check starts; another command prints a diff; the check has no completion item before termination                                                          | Quiet check/control-plane handling needs evidence; this log alone cannot prove a dead worker     |
| Exit detail starts `Existing tests contradict the requested behavior`; run lines 95–99                                  | New thread-frame outcomes pass while older read-cost expectations fail on the additional board read                                                                | Contradictory acceptance expectations require reconciliation before dispatch                     |
| Detail starts `Two frozen outcomes still fail on actual APIs`; run lines 3022–3025                                      | Revocation returns 201 where 403 is expected; another path rejects a taken-down media value before the tuple fence                                                 | Cross-owner semantics, not a reason to loosen the acceptance assertion                           |
| Superseded result contains `Rebuild now validates the canonical 32-byte route key`; run line 142                        | A successful committed change was nevertheless superseded                                                                                                          | Preserve successful artifacts and record why another attempt is needed                           |
| Early-stop sample with maximum duration; run line 39                                                                    | 17,189.391 seconds of slot wait, then 95.465 seconds of remote command time; worker reports a commit; persisted failure names removed `sealSitemapPosition` export | Nearly all this check's time is admission; worker success alone still does not establish landing |
| `landing-1588.log`                                                                                                      | Rebase cannot apply the squashed worker change                                                                                                                     | Rewriting the task from scratch is more expensive than resolving integration-only conflict       |
| `landing-2091.log`                                                                                                      | Batch check and shared candidate, then workspace typecheck output                                                                                                  | Batch residence overlaps; summing member times overstates train utilization                      |

Manager inbox evidence adds concrete infrastructure context: entries **4365 and 4388** describe check-local
PostgreSQL tmpfs exhaustion and admission refusing free slots because of lagging load average. Entry **4476**
reports two dispatches failing before registration after a 30-second dispatch-lease wait. These are reported
observations, not newly verified host diagnoses; this audit ran no remote probes. They explain why worker-table
counts omit some lost time and why raising worker count or blindly adding slots is not an adequate fix. [Q8]

## Held work and dependency structure

There are **115 currently held tasks**: Commerce 36, Web 28, Search 24, Semantic 17, Content nine, Performance one.
Age since creation has median **5.42 hours**, p90 **20.54**, maximum **23.80**, mean **7.40**; summed age is
**850.54 task-hours**. These are current backlog ages, not historical continuous hold durations. Current dependency
edges include 132 held, 83 running, 22 landing, and four stopped predecessors; another 95 edges reach integrated
predecessors. None of the held tasks has all predecessors integrated/merged. Cross-target commit ancestry still
matters, as implemented by `dependenciesMet`. [Q9]

The longest unresolved chains have **ten edges / eleven tasks**. One runs from Web entry undo through Library
HTTP undo, restore, restore preparation, retained delete, built-in references, entry model, profile-entry commands,
profile source, and subject anchor to the running Semantic subject producer. The terminal producer is **19.49
hours old**; profile-source and anchor tasks are **9.92 and 10.39 hours old**. A second equally long chain ends
at entry-due work. These are serial semantic prerequisites, not worker-capacity shortages. Already integrated
nodes are excluded from the unresolved chain; following every old edge would incorrectly report a longer chain. [Q9]

The oldest held Web rating task is **23.80 hours old** (`apps/web/tests/rating-control.test.ts` among its paths).
The next held Semantic relation-facet task is **23.39 hours old**. Prioritize their actual upstream producers;
do not dispatch duplicate consumers to keep workers busy. Split a producer's stable contract/schema boundary from
independent implementation only when the consumer can be verified against that real boundary. Keep genuine
behavior dependencies, and avoid translating document-adoption or shared-file ownership into long runtime chains.

167 timed controller manager-events in the window match inbox entries. All were read; read delay median is
**0.256 minutes**, p90 **6.43**, maximum **68.44**. Thus general inbox notification latency is not the leading
measured bottleneck. 166 are acknowledged, but mean acknowledgment lag is **644.27 minutes**; acknowledgment is
not a reliable timestamp for active management. Other manager-to-manager messages lack creation timestamps, so
their last-24-hour counts and response times cannot be recovered from `manager_inbox` alone. [Q8]

## Ranked recoverable budgets and concrete fixes

There is no experiment identifying causal tasks/hour lost. The ranking below converts **observed, disjoint
worker-time budgets** into task equivalents using the current fleet conversion cost:
`c = 1,062.731867 / 413 = 2.57320 worker-hours/integration`; equivalent hourly loss is `budget / (24*c)`.
It is a conservative planning conversion, not a guaranteed speedup. The winning-attempt-only cost is 0.79740
hours/task; using that instead would imply much larger and unjustified forecasts. Failed checks, queues, and
contract failures interact. The fifth row counts only passing/pending workers so it does not double-count the
failed/replaced attempts in rows one through four. [Q2–Q7]

| Rank | Measured mechanism / budget                                                                         | Task equivalents/hour | Concrete change and proposed cost                                                                                                                                                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------- | --------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Environment + overloaded stalls + three transport failures labelled spec conflict: **173.10 hours** |              **2.80** | Persist check request/lease/progress identity across worker adoption; distinguish queued, running, transport, model-capacity, and actual class/quiet termination. Resume committed artifacts; route capacity refusals to an available permitted pool. Add preflight for missing references/tests. Allow 1–2 engineering days for telemetry and recovery cases. |
| 2    | Superseded + cancelled attempts: **131.51 hours**                                                   |              **2.13** | Require a structured replacement reason and contract revision; compare against existing active work before dispatch. Preserve commits/evidence and request the smallest remaining delta. Route difficult claims by first failure, not repeated identical relaunch. Allow half a day for control-plane fields plus manager brief practice.                      |
| 3    | Rebase-labelled attempts + 17 repeated conflicts hidden as spec conflict: **116.33 hours**          |              **1.88** | Serialize ownership of shared mutable scaffolding; centralize generated schema/format changes; let the controller repair integration-only conflicts using the preserved worker artifact. Schedule high-fan-out producers ahead of consumers. Allow 0.5–1 day; retain all frozen-file and scope checks.                                                         |
| 4    | Remaining contract/input conflicts + scope growth: **84.15 hours**                                  |              **1.36** | Preflight acceptance file existence and compatibility against the actual producer base; identify genuine expected failures before freezing. Reconcile contradictory outcomes before dispatch, and include required cross-owner changes in a concrete contract. Allow half a day for preflight, then brief review per dispatch.                                 |
| 5    | Directly observed check-slot wait lower envelope in passed/pending attempts: **69.03 hours**        |     **at least 1.12** | Admit by measured memory/CPU demand, preserve short-check express capacity, reduce repeated broad checks, and coalesce promotion demand. Retain complete affected-file coverage and the full kernel check for shared runtime changes. Measure slot-seconds and queue age before changing caps. Allow 1–2 days, initially no hardware spend.                    |

For planning only, recovering **25–50%** of each measured budget at today's conversion rate corresponds respectively
to **0.70–1.40, 0.53–1.06, 0.47–0.94, 0.34–0.68, and 0.28–0.56 integrations/hour**. These are explicit recovery
assumptions and effort estimates, not measured treatment effects. Combined arithmetic is **2.32–4.65/hour**;
accept it only if downstream train/check capacity can absorb it. First instrument the transitions, then compare
matched classes over the next day. Prioritize the long producer chains within those fixes; their latency benefit
cannot be converted to additional hourly landings from a single backlog snapshot.

Some remedies already exist at the audited baseline: batch integration, express/gate reservation, check-wait
deduction in class and silence timers, and integrated-dependency release. The owner should validate coverage of
those paths, especially re-adoption and stale processes, rather than dispatch another implementation of them.
Post-snapshot control-plane fixes do not establish an improvement in this measurement window.

## Primary-source design evidence

These sources support mechanisms, not the numerical estimates above. No reference code was installed, built,
or executed; the recommendation is for the existing Bun/SQLite controller.

- SQLite's [backup documentation](https://www.sqlite.org/backup.html) describes consistent online snapshots.
  Use the backup API rather than copying only a live database file without its journal state. SQLite is
  [public domain](https://www.sqlite.org/copyright.html). This supports the audit extraction method.
- Ninja's [pool documentation](https://ninja-build.org/manual.html#ref_pool) and
  [`src/build.cc`, `Plan::ScheduleWork`/`EdgeFinished`](https://github.com/ninja-build/ninja/blob/3ccb2270e8ef5a84bb31c4651c0df84440f30362/src/build.cc#L180)
  separate delayed work, readiness, and pool capacity; releasing work retrieves eligible queued edges. Reused
  snapshot: `.reference/check-capacity/ninja`, commit `3ccb2270e8ef5a84bb31c4651c0df84440f30362`, Apache-2.0
  (`COPYING`). Adopt explicit queued/running transitions and resource pools, preserving weighted kernel checks.
- bors-ng's
  [`lib/worker/batcher/divider.ex`](https://github.com/bors-ng/bors-ng/blob/ca725797e53a88e954998de0bbb14a8a5acb13ab/lib/worker/batcher/divider.ex)
  separates failed-batch splitting from conflict isolation. Reused snapshot: `.reference/merge-queues/bors-ng`,
  commit `ca725797e53a88e954998de0bbb14a8a5acb13ab`, Apache-2.0 (`LICENSE-APACHE`). Preserve passing artifacts and
  isolate integration conflicts instead of treating every unsuccessful train outcome as a new worker problem.
- GitLab's [official merge-train documentation](https://docs.gitlab.com/ci/pipelines/merge_trains/) explains
  cumulative candidate validation and downstream invalidation after failure. The reused snapshot at
  `.reference/merge-queues/gitlab`, commit `7f6a2f6c243fa6ea4a3aa86b1fa90fd5fa41ad57`, states in
  [`LICENSE`](https://gitlab.com/gitlab-org/gitlab/-/blob/7f6a2f6c243fa6ea4a3aa86b1fa90fd5fa41ad57/LICENSE)
  that its documentation uses CC BY-SA 4.0 (applicable code MIT; other exceptions listed there). Faster speculative
  trains can increase invalidated work; record candidate identity and affected command coverage before expanding concurrency.

The shared pattern is explicit readiness, resource admission, artifact identity, and localized failure handling.
Those mechanisms directly address the observed rework and queue evidence. They do not justify weakening checks
or assuming a linear speedup from additional workers. Reference reuse is recorded in `.reference/INDEX.md`.

## Query and log recipes

**Q0 — snapshot and bounds.** Use Python's standard `sqlite3` module, open the production source as
`file:/home/edge/projects/rezics/rezics-next/.temp/goal/goal.sqlite?mode=ro`, and call `source.backup(destination)`
with a destination under the worktree's `.temp/throughput-audit/`. The retained snapshot is the reference for all
numbers; querying the live store later will include mutations to old attempt bodies. Count the six named tables
with `SELECT count(*) FROM <table>`, and hash the snapshot bytes with SHA-256. Bind the following UTC endpoints:

```text
lo = 2026-10-27T06:02:32.229925Z
hi = 2026-10-28T06:02:32.229925Z
```

**Q1 — flow.** All SQL below runs on the snapshot. Extract JSON with SQLite JSON functions.

```sql
SELECT kind, count(*) FROM worker_events WHERE at>=:lo AND at<:hi GROUP BY kind;
SELECT task_id, attempt, at, body FROM worker_events
 WHERE kind='gate-outcome' AND json_extract(body,'$.passed')=1 AND at>=:lo AND at<:hi;
SELECT json_extract(body,'$.stage'), json_extract(body,'$.passed'), count(*)
 FROM worker_events WHERE kind='gate-outcome' AND at>=:lo AND at<:hi GROUP BY 1,2;
```

Unique task count and event count both equal 413. Join returned task keys to `worker_tasks` for current states.
Bucket pass-event times into 24 one-hour intervals starting at `lo`:
`14,6,19,21,30,28,20,8,9,12,17,16,12,7,17,22,22,45,26,21,11,7,1,22`.
This explains the 1–45/hour range for this particular window. Repeat with `hi-12h` and `hi-2h` for shorter flows.

**Q2 — attempt accounting and labels.** This query supplies the exact population and corrected classes:

```sql
SELECT a.task_id, a.attempt, a.body AS attempt_body, r.body AS record_body,
 CASE WHEN json_extract(a.body,'$.state')='running' THEN 'running'
      WHEN json_extract(r.body,'$.outcome') IN ('passed','pending-gate','cancelled','superseded')
        THEN json_extract(r.body,'$.outcome')
      WHEN json_extract(a.body,'$.escalation') IS NOT NULL THEN json_extract(a.body,'$.escalation')
      WHEN json_extract(a.body,'$.failureKind') IS NOT NULL THEN json_extract(a.body,'$.failureKind')
      ELSE json_extract(a.body,'$.state') END AS final_class
 FROM worker_attempts a LEFT JOIN worker_records r USING(task_id,attempt);
```

Parse ISO timestamps with timezone-aware `datetime.fromisoformat`. For each attempt, let `s=startedAt`,
`e=endedAt or hi`; in-window hours are `max(0,min(e,hi)-max(s,lo))/3600`. Group overlapping attempts by
`final_class`, and separately count ends/starts in `[lo,hi)`. Sum overlaps per hourly bin for worker occupancy;
rounded half-window totals are 432.27 and 630.47 hours. Count passing records with non-null escalation separately
to reproduce the inherited-label warning. Token sums use ended records, not open attempts.

**Q3 — winning latency.** For each Q1 winner, sort its attempts through the winning attempt number. With seconds
as the time unit, calculate the following, then divide by 60. All percentiles use nearest rank `ceil(p*n)-1`.

```text
created = task.createdAt; first = first attempt.startedAt; pass = passing event.at
pre = first-created
worker = sum(endedAt-startedAt for every attempt through the winner)
request = final landing-requested.at, falling back to winning endedAt if absent
train = passing event.body.hostMs / 1000
queue = max(0, pass-train-request)
other = pass-created-pre-worker-queue-train
For each current brief.after predecessor: find its earliest passing gate event.
If any predecessor lacks a pass at/before first: mark dependency split unknown.
Otherwise ready = max(created, predecessor pass times);
dependency = min(pre,max(0,ready-created)); admission = max(0,first-ready).
```

**Q4 — winning costs and rework.** Join every Q1 winning task to attempts and records with attempt number no
greater than its winner. Group by task class and winner's `usage.model`, falling back to `profile.model`.
Count tasks once, count all historical attempts, and sum `tokens.input`, `tokens.cached`, `tokens.output`.
For each group divide by tasks; cached percentage is aggregate cached/input. Raw tokens are input+output.
Rework is the same sums restricted to attempt numbers below the winning one. The detailed cohort has
7,871,988,293 input and 28,288,659 output tokens. Use actual attempt profiles rather than winner grouping if
asking which model consumed the tokens. Count `usage` objects and zero token pairs separately for coverage.

**Q5 — check waits.** Start from Q2 overlap attempts, excluding research tasks. Read each `logPath` JSONL once.
For `item.completed`, inspect `command_execution.aggregated_output` (and MCP result text for discovery).
Find `remote-check: slot wait ([0-9.]+) s on ([A-Za-z0-9_-]+)`. Deduplicate `(seconds,host)` within an attempt.
For the direct sample require a command containing `bun` or `remote-check` and `check`, `test`, or `typecheck`;
exclude word matches `cat|head|tail|rg|sed|python3` and commands mentioning `.temp/goal/runs` or
`.temp/goal/landing`. Keep ended attempts only. With `outside=(ended-started)-in_window_duration`, calculate
`lower=max(0,max_wait-outside)` and `upper=min(in_window_duration,sum_waits)`. Sum these; select only final
passed/pending classes for the fifth ranked budget. Duplicate displays, exact-duration collisions, and truncated
output can reduce coverage, so retain the envelope interpretation.

**Q6 — train and queue.** Use Q1 gate outcomes with `[event.at-hostMs/1000,event.at]` intervals, clipped to the
window; sort and union overlapping intervals. Sum `hostMs` separately. Read each returned `body.logPath`, searching
for `Batch integration check`, and count conflicted paths from `conflictedFiles`. For the largest gap, count
landing requests between adjacent union intervals. Current queue comes from:

```sql
SELECT q.*, t.body AS task_body FROM landing_queue q JOIN worker_tasks t ON t.id=q.task
 WHERE q.outcome IS NULL;
SELECT body FROM worker_promotions;
```

Filter queue rows to undelivered, current landing tasks; join `landing-requested` on task and attempt for ages.
Do not treat a candidate hash or log file modification time as a durable train-start timestamp.

**Q7 — failure roots and samples.** Select ended Q2 attempts except passed/pending, and read their events:

```sql
SELECT a.task_id,a.attempt,a.body,e.kind,e.at,e.body AS event_body
 FROM worker_attempts a LEFT JOIN worker_events e USING(task_id,attempt)
 WHERE json_extract(a.body,'$.endedAt')>=:lo AND json_extract(a.body,'$.endedAt')<:hi
 ORDER BY a.task_id,a.attempt,e.sequence;
```

Diagnostic precedence: concatenate `detail` from `attempt-exit-classified` and `driver-environment-failure`;
otherwise use attempt blocker, failure object, or result; otherwise concatenate manager-event summaries.
Classify in this order: `Selected model is at capacity`; `without a success report (killed)`; transport/admission
regex `SSH|ssh|rsync|Connection closed|Connection timed out|check host|check-host|connect.*port 22|remote-check`;
`too many open files`; case-insensitive `missing|absent|cannot access|ENOENT|No such file`; generic
`without a success report`; `out of memory`; `no output`; `class limit`; `rebase conflict|Rebasing`;
then residual spec/scope/empty/other. Group counts and clipped worker-hours. The sample table's quoted substrings
select corresponding details/results; join to attempt `logPath`. For quiet-watchdog and early-stop samples,
choose maximum full attempt duration within that class. The rebuild-key sample is selected by its exact result
substring. Read `item.started` as well as completed items to see unfinished checks.

**Q8 — inbox.** Read entries 4365, 4388, and 4476 directly for the contextual infrastructure reports. For timed
events, select `worker_events.kind='manager-event'` in the window and match inbox JSON by
`(managerId,taskId,kind,summary)`. All 167 match; subtract event time from `read_at/1000` and
`acknowledged_at/1000`. Use nearest-rank percentiles. Do not use read/ack times as message creation times.

**Q9 — held work.** Select current task JSON where `state='held'`. Age is `(hi-createdAt)/3600`. Group by
`brief.goal`. Expand `brief.after` and join predecessor tasks to count edge states. Traverse with cycle detection
through predecessors whose current state is neither integrated nor merged; sort chains by edge count. Identify
the named chains and oldest tasks from their brief paths, not a mutable task title. There were no missing-node
or cyclic chains in the reported longest paths. Historical holding intervals require new transition telemetry.
