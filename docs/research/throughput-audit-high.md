# Throughput audit: worker time, queue time and repeated work

Evidence snapshot: 2026-10-28 06:02:20.558828 UTC. Window: the preceding 24 hours.
Source baseline: `d06435e227fb60b27e18244850e1c1511438ab95`.
This report proposes experiments; it does not change acceptance, routing or ownership.

## Finding

**More workers are not the first intervention.** There were **413 integrations in
24 hours, 17.21/hour**, against **1,062.56 occupied worker-hours**, or **0.389
landings per occupied worker-hour**. At the stated provision of 50–60 workers,
that is **0.287–0.344 landings per provisioned worker-hour**. Measured average
occupancy was **44.27**, including workers waiting for checks, rather than a
continuous 50–60. Snapshot occupancy was 73 running attempts. [Q1, Q2]

The largest measured exposures are rebase failures (**123.80 worker-hours**),
check-slot waiting (**at least 118.98 worker-hours**, overlapping the failure
classes), environment failures (**88.83 worker-hours**), supersession churn
(**83.93 worker-hours**) and explicit specification blockers (**59.38
worker-hours**). These are opportunities to recover capacity, not independently
additive causal losses. A landed task's predecessors consumed **49.89% of its
recorded input tokens** and **48.84% of its worker time**. [Q3, Q5, Q7]

The serial landing path also amplified an infrastructure incident into a queue
outage: **74.71 minutes without a recorded landing service interval**, with a
baseline check demonstrably waiting **2,643.244 seconds** for a slot. Fix this
amplification before increasing dispatch. Queued work is work waiting for service;
it must not be stopped merely for being quiet. [Q4, L1]

## Sources, snapshot and interpretation

The production store was opened with SQLite `mode=ro` and backed up into this
worktree's `.temp/throughput-audit/snapshot.sqlite`. No production command, check,
worker, database or container was started or stopped for the audit. The snapshot
has 2,054 tasks, 3,275 attempts, 6,172 events, 3,202 records, 2,130 queue rows and
4,478 inbox rows. The analysis artifacts are `analyze.py`, `extra.py`, `more.py`,
`logs.py`, `waits.py`, `metrics.json`, `causes.json`, `samples.json`, `timings.json`
and `wait-summary.json` in that same temporary directory. [Q0]

Primary inputs are the main checkout's `.temp/goal/goal.sqlite`, the attempts'
`logPath` and `evidencePath`, `.temp/goal/landing-*.log`, and `manager_inbox`.
Paths below beginning `.temp/goal/` resolve against that main checkout. The
README and earlier [queue](merge-queue-throughput.md),
[token](agent-token-efficiency.md), and [transport](check-host-direct-route.md)
research were read first. Earlier reports provide context; their numbers are
not substituted for this snapshot.

Definitions and decisions:

- **Landed** means the first successful `gate-outcome` with stage `merge` for a
  task. It includes integration to dev or another configured target; it does
  **not** mean promotion to main. Worker exit 0 and `pending-gate` are not landings.
- The throughput cohort uses landing timestamps inside the window. The failure
  cohort uses attempt **end** timestamps inside it, then clips worker occupancy
  to the window. The landed cohort's full lifetimes can start before the window.
  They are separate denominators, never silently combined into a pass rate.
- Tokens come from `worker_records.body.tokens`; input includes cached input.
  Cached is a subset, not an additional charge. These are recorded tokens,
  **not prices**, and exclude manager usage and unrecorded consultation spend.
- `escalation` is also a retry's **starting reason**, retained on later success
  (`tasks.ts`), so grouping it alone falsely labels recovered attempts as failures.
  Final exit-classification events and gate outcomes take precedence here.
- Briefs are mutable, and there is no complete persisted state-transition clock.
  Dependency/capacity attribution uses the snapshot's graph and is an estimate.
  Missing telemetry remains unknown; no timestamp or token count is invented.
- P50/P90 use nearest rank. Approximate minutes in tables are independently
  rounded. No product or routing decision is adopted by this report.

## Arrival, service and end-to-end latency

The consecutive hourly landing counts, anchored at the window's beginning, were
`14, 6, 19, 21, 30, 27, 21, 8, 9, 12, 17, 16, 12, 7, 17, 22, 22, 45, 26, 21, 11, 7, 1, 22`.
The last 12 hours had **453 ended attempts and 213 landings (17.75/hour)**.
This differs from the brief's earlier 482/194 observation because the interval
and definitions differ; the brief's categories also omit a remainder. Do not
reinterpret 194 exit-ok attempts as 194 integrations. [Q1, Q3]

The following decomposes **all 413 landed tasks**, including every predecessor
attempt before the winning one. Dependency time ends at the later of task
creation and the latest dependency integration, capped by first launch. The
remaining prelaunch interval is admission/release overhead, an upper bound on
capacity waiting. Retry gaps include judgment, recovery and admission. [Q4]

| Component | Mean minutes | P50 | P90 | Summed task-hours |
| --- | ---: | ---: | ---: | ---: |
| Dependency wait, reconstructed | 49.28 | 0.00 | 117.93 | 339.18 |
| Capacity/release/setup residual before first launch | 11.36 | 0.006 | 6.30 | 78.20 |
| Worker attempt lifetimes, including tool/check waits | 93.52 | 31.35 | 245.71 | 643.74 |
| Gaps between attempts | 21.18 | 0.00 | 53.25 | 145.82 |
| Final exit to landing request: settlement/affected checks | 0.004 | 0.002 | 0.008 | 0.03 |
| Landing request to inferred service start | 33.94 | 26.09 | 76.38 | 233.65 |
| Final recorded train service | 1.96 | 1.56 | 3.37 | 13.49 |
| **Creation to integration** | **211.25** | **109.62** | **455.88** | **1,454.12** |

Check-slot time is a **subset of worker time**, not another row to add. The
available worker stream has no universal timestamps on command starts/finishes,
so an exact per-task split between thinking, check execution and slot waiting
cannot be recovered. The log-based bound below measures the part actually known.
Attempt bookkeeping overlaps sum to 13.81 seconds across this cohort; the largest
per-task reconciliation error is 1.20 seconds. [Q4, Q7]

A raw queue-row count is misleading: 48 rows had no outcome, but only 29 belonged
to tasks then in `landing`; the others belonged to 11 integrated, 4 cancelled,
2 merged, 1 stopped and 1 running task. Even the latter classification does not
prove its queued attempt is current. Superseded rows can be obsolete. The real
task-state inventory was 31 landing, 73 running, 115 held, 3 stopped, 171
cancelled, 1,558 integrated and 103 merged. [Q2, Q4]

Recorded train intervals occupy **14.735 wall-hours** after unioning overlaps;
summing member times gives 15.740 hours because a batch shares a check. There
were 413 passing outcomes, 73 rebase failures and 27 gate failures. Dividing
413 by 14.735 gives **28.03 landings per recorded service-hour**. The remaining
9.265 hours are **unattributed**, not proven idle: failed/superseded service,
cleanup, retries and lease handoff can lack a final interval. Likewise the
571.49 queued task-hours and apparent 24-hour backlog are upper bounds because
unsettled obsolete requests are censored at the cutoff. [Q4]

### The long train gap was not simply a slow successful check

**L1:** `.temp/goal/landing-2083.log` is an unfinished affected-test baseline.
Its queue request contains one failed check with **138 failing files** and
`durationMs=12590618` (**209.84 minutes**) from the worker-side sweep. The
baseline then recorded a slot wait of **44.05 minutes** (line 19), upload of
**331.667 seconds** (line 20), and remote dependency installation of **1.512
seconds** (line 33). The log has no final gate outcome. The previous service
ended at **04:07:23.602 UTC** (`landing-2082.log`); the next recorded interval
begins **05:22:05.908 UTC** (`landing-2097.log`, outcome minus `hostMs`). [Q4, Q6]

Inbox row 4440 independently describes a storage-full sweep being interpreted as
hundreds of code failures and a baseline running in the serial train. It says
756 files and 72 minutes; the persisted request inspected here says 138 files.
**Use the persisted 138 and measured 74.71-minute interval**, without asserting
that either summary identifies every internal step. `merge-train.ts`'s affected
baseline path awaits a remote check while holding the train lease. This explains
how a check-capacity/storage problem can stall otherwise unrelated landings.
The snapshot already contains recovery messages and a classifier fix in flight;
verify what is deployed before commissioning a duplicate fix. [L1, Q6]

## Attempts and tokens per landed task

The 413 winners and their historical predecessors comprise **732 attempts**, or
**1.772 attempts per landing**. **253 (61.26%)** landed on attempt 1. Total recorded
input is **7.872 billion**, cached input **7.744 billion**, and output **28.289
million**. Nonwinning attempts account for **3.928 billion input tokens** and
**314.41 of 643.74 worker-hours**. All 732 have records, but **32 have zero input**;
zero is an instrumentation caveat, not evidence of free work. [Q5]

Group by the **winning model and recorded task class**; predecessor costs follow
that winner even if the predecessor used another model. Input/cached are
millions per landing; output is thousands per landing. Small cells are not
routing experiments. [Q5]

| Winning model | Class | Landings | Attempts/landing | Input M | Cached M | Output k |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Claude Sonnet 5.5 | claim | 13 | 1.46 | 13.653 | 13.477 | 66.15 |
| Claude Sonnet 5.5 | implementation | 3 | 1.33 | 0.696 | 0.657 | 8.56 |
| Claude Sonnet 5.5 | interface | 11 | 1.91 | 13.000 | 12.788 | 53.87 |
| Claude Sonnet 5.5 | specification | 1 | 1.00 | 0.955 | 0.908 | 7.13 |
| Luna | bulk-text | 6 | 1.50 | 3.687 | 3.526 | 37.57 |
| Luna | claim | 40 | 3.15 | 58.206 | 57.292 | 212.62 |
| Luna | critical-path | 1 | 1.00 | 1.096 | 1.044 | 12.28 |
| Luna | implementation | 76 | 1.71 | 17.084 | 16.796 | 72.14 |
| Luna | interface | 12 | 1.50 | 34.172 | 33.717 | 106.28 |
| Luna | research | 3 | 1.33 | 6.878 | 6.460 | 76.36 |
| Sol | bulk-text | 1 | 1.00 | 0.725 | 0.660 | 3.55 |
| Sol | claim | 104 | 1.80 | 17.570 | 17.305 | 57.63 |
| Sol | critical-path | 6 | 1.67 | 11.007 | 10.830 | 31.01 |
| Sol | implementation | 14 | 1.36 | 4.292 | 4.196 | 20.16 |
| Sol | interface | 8 | 3.38 | 70.174 | 69.129 | 210.03 |
| Sol | research | 29 | 1.07 | 3.029 | 2.879 | 25.46 |
| Sol | specification | 63 | 1.46 | 10.525 | 10.362 | 28.06 |
| Terra | claim | 1 | 1.00 | 0.344 | 0.294 | 6.33 |
| Terra | interface | 15 | 1.67 | 13.112 | 12.851 | 24.90 |
| Terra | research | 6 | 1.00 | 0.743 | 0.677 | 6.98 |

Exact model strings are `claude-sonnet-5-5`, `gpt-6-luna`, `gpt-6.1-sol` and
`gpt-6.1-terra`. The ended-window cohort separately contains 46, 316, 456, 45
and 14 attempts for Claude, Luna, Sol, Terra and `grok-4.7`, respectively.
Grok has no winner in this landing cohort, so its tokens/landing are undefined.
All 877 ended attempts have records; 40 record zero input. Selection, changing
routing tables, task reshapes and cross-model predecessors preclude inferring
model superiority from these cells. A useful controlled pilot is matched claim
briefs: Luna's 3.15 attempts/landing and Sol's 1.80 justify investigation, not a
blanket switch or a promised causal saving. [Q3, Q5]

## Failures: classification and sampled roots

Final observable outcomes for the **877 ended attempts** are below. Window
worker-hours are occupied time, not necessarily discarded work: later attempts
can retain commits. Input is millions, with the same telemetry caveats. [Q3]

| Observable final class | Attempts | Window worker-hours | Input M |
| --- | ---: | ---: | ---: |
| Landed successfully | 411 | 326.89 | 3,935.91 |
| Reported success, still queued | 29 | 79.31 | 1,009.27 |
| Other exit-0 without final classification | 3 | 0.71 | 15.49 |
| Rebase-stage failure | 73 | 123.80 | 1,740.51 |
| Environment exit classification, excluding explicit silence | 105 | 88.83 | 1,021.03 |
| Superseded record without classified failure: reshape proxy | 76 | 83.93 | 749.21 |
| Explicit spec-conflict exit | 73 | 59.38 | 986.70 |
| No final event sufficient to assign a cause | 35 | 57.72 | 801.56 |
| Explicit silent timeout | 15 | 34.05 | 397.19 |
| Scope growth, exit or gate | 25 | 30.40 | 650.92 |
| Cancelled without an earlier classified outcome | 20 | 26.28 | 237.07 |
| Gate classified early-stop | 8 | 8.51 | 79.71 |
| Stopped, remaining | 2 | 2.46 | 5.54 |
| Repeated assertion | 2 | 0.46 | 4.90 |

The 411 ended-and-landed attempts differ from 413 landing events because two
winning workers ended before the window. Raw `escalation` grouping would instead
report 126 environment, 55 stalled, 94 spec-conflict, 78 rebase-conflict and 14
early-stop attempts. That includes successful recovery attempts and repeats
whose second rebase conflict became a spec-conflict. Of the otherwise unassigned
35, 19 have a `stalled` label without an explicit silence event; keep them
separate instead of claiming 55 confirmed silent workers. [Q3]

The following samples were read from real exit events **and worker/landing
logs**, not inferred from the category name. Q6 resolves each worker source to
its actual `logPath`, `evidencePath/contract.md`, and failure details without
putting task identifiers into this report.

- **Infrastructure:** exit details matching SSH/rsync/transport text cover 39
  of the 105 environment exits and **48.08 worker-hours**. One library shelf
  attempt reports host timeout and connection closure after acquiring a slot;
  another full-kernel sweep reports PostgreSQL
  `No space left on device`. Text screening finds five disk/memory cases
  (**9.07 hours**) and 12 provider-capacity/quota cases (**4.74 hours**).
  These are reproducible text buckets, not a complete causal diagnosis of all
  105 cases. Some are pre-fix incidents; a fresh probe is needed before calling
  transport currently broken. [Q6; `check-host-direct-route.md`]
- **Queue mistaken for failure:** the growth-series worker's final message says
  its required kernel check was still queued after two hours. It returned a
  tool blocker despite having no test result. This is a brief/lifecycle error,
  not evidence the acceptance failed. Q6 selects the exact phrase
  `every check slot was busy`; its run log's final answer is at line 246.
- **False or ambiguous silence:** the durable-initiator driver's attempt 10
  ends at a `git diff`/status tool result (line 43), with edited files but no
  final answer. Its event later says `stalled: no output for 40 minutes`.
  This proves the controller stopped it, not whether a remote check was alive.
  Inbox row 4468 reports loss of wait tracking across controller re-adoption;
  treat that as supporting diagnosis requiring deployment verification.
- **Spec/API mismatch:** the same driver's attempt 4 expected a Realm grant
  fixture, while the native role-grant event rejected the Realm subject with
  `schema is false`. The worker inspected `access/events.ts`,
  `grant-subject.ts` and membership code, and its final answer (line 2299)
  reports the failing native setup. Freeze fixtures against the native producer
  API before commissioning a large matrix; do not weaken that matrix in a worker.
- **Rebase rather than reasoning:** `landing-2075.log` conflicts in
  `specs/support/verify-outcome-suite.ts`; `landing-2088.log` rejects changes to
  frozen dynamic-collections acceptance. Two superficially similar rebase-stage
  failures need different remedies: coordinate writers for the former, preserve
  frozen hashes for the latter. The failure class alone cannot justify retry.
- **Early stop misdiagnosis:** `landing-2022.log` contains the actual gate
  assertion concerning `sealSitemapPosition`.
  The sitemap worker claimed success, then integration typecheck found a removed
  export used by `test/content/growth-sitemap.test.ts`. The next attempt fixed
  that stale consumer. This is base/affected-file attribution, not proof that
  the implementation was unfinished. [Q6]
- **Supersession:** 76 records without a terminal classified failure were
  superseded. This is a measurable churn proxy, **not proof of 76 brief edits**:
  `worker_tasks` holds only the latest brief. The growth-vacuum worker has
  committed work before supersession; preserving commits avoids redoing edits
  but still repeats context and checks. Exact duplicate patches below confirm
  retained work without proving every reshaping decision was avoidable.

## Checks, dependencies and repeated work

### Check slots

The audit read **864 of 877** ended-attempt logs (**0.741 GB; 200,306 JSON
records**); 13 log paths were absent. Strict extraction accepts completed direct
`bun`/`env`/`KERNEL_CHECK_…` check executions, excluding commands that read logs
or use `cat`, `rg`, `head`, `tail` or `grep`, and completed MCP tool outputs.
Deduplicate each `(attempt, phase, seconds, host)` timing line. This intentionally
misses wrapped/background executions; it avoids treating quoted calibration
captures as new waits. [Q7]

There are **581 unique completed slot-wait timing records**: median **204.827 s**,
P90 **3,407.574 s**, maximum **19,505.295 s**. Their raw sum is **180.97
check-run-hours**, compared with **29.62 command-hours**, **4.50 upload-hours**
and **0.07 install-hours** in the separately observed timing sets. The sets are
not paired or complete; do not infer a precise check utilization ratio. [Q7]

Because commands can overlap within one worker, use **only the longest observed
wait per attempt**, cap by its lifetime, then subtract its entire possible
pre-window portion. Across **201 attempts**, this gives the conservative
**118.98 worker-hour bound**, **11.20%** of all occupied worker-hours, or an
average **4.96 workers** waiting. **36.82 hours** of that bound belong to winning
attempts. There are 209 attempts with a busy-slot message, including waits with
no completion timing. Running attempts and missing logs make the total larger,
but its exact size is unknown. [Q7]

### Held tasks and dependency chains

All **115 held tasks** were created inside the window. Their censored ages sum
to **850.16 task-hours**; mean **7.39 h**, P50 **5.42 h**, P90 **20.54 h**, maximum
**23.79 h**. None has all dependencies integrated/merged, so this snapshot does
not show a simple missed-release bug. By Goal: commerce 36, web 28, search 24,
semantic 17, content 9, performance 1. [Q8]

The longest current dependency paths have **13 vertices/12 edges**; held-terminal
maximum depths are commerce 13, web 13, semantic 11, search 10, content 3,
performance 3. The library-to-web path goes through definition profile tests,
definition compilation, kernel profile interface, profile-source, entries,
entry model, further command splits, personal routes, then web readers. Its
profile-source node has been held **9.92 h**; its profile interface is integrated,
but its other parent, `services/kernel/src/library/subject-anchor.ts`, is held.
Several downstream nodes are
successive changes to `services/kernel/src/library/entries.ts`: this is serial
writer structure, not a pool of immediately executable work. [Q8]

The oldest held web fixture task (`apps/web/src/kernel/fake/*.ts`) is **23.79 h**
old, waiting for `apps/web/src/features/pages/subject-ratings.ts`, then running.
The next two held semantic tasks are **23.38 h** and **22.79 h** old and include
landing or held predecessors. Graph depth is not a duration-weighted critical
path: historical brief changes and unfinished durations prevent that claim.
Promote the oldest **ready ancestor**, not the whole downstream fan-out. [Q8]

For 167 timestamped judgment events matched to inbox deliveries, read latency is
P50 **0.27 min**, P90 **6.43 min**, maximum **68.44 min**. The 157 followed by a
new attempt have next-start latency P50 **4.22 min**, P90 **77.75 min**, maximum
**686.59 min**. Thus message pickup is usually faster than resolution/admission.
Acknowledgment P50 is **616.27 min** (166 events): acknowledgment is not a useful
proxy for judgment completion. Manual inbox messages have no creation timestamp;
using `read_at` as one would fabricate a 24-hour history. [Q9]

### How much is repeated

Within landed task lifetimes, **319 of 732 attempts are predecessors**; their
49.89% input-token share is the strongest available repeated-effort exposure.
Among ended attempts, 748 evidence patches are nonempty, 29 empty and 100 absent.
Exact SHA-256 comparison finds **51 additional identical patch copies in 38
groups**, all within the same task, none across different tasks. This is a lower
bound on unchanged-work reruns, not evidence of 51 full reimplementations. [Q5, Q10]

The 413 landings contain **2,264 changed-file touches over 1,363 distinct files**:
**901 repeat touches (39.80%)**. The leading shared surfaces include Access
README (29), Semantic README (21), Web README (20), kernel README (19), library
schema dump (19), and remote-check source (14). Repeated touches explain conflict
opportunity but can be necessary incremental work; path overlap is not semantic
duplication. Independent paired research is intentional replication and is not
counted as waste merely because the topics overlap. [Q10]

## Ranked interventions and expected effect

There is no measured counterfactual proving exact lost landings/hour. To rank
resource exposure consistently, the **413 winning attempts used 329.33 hours**,
so define one observed winning service unit as **0.7974 worker-hours**. An
exposure of H hours corresponds to **H / 24 / 0.7974 landings/hour-equivalent**.
It includes useful retained edits and waiting; it is a ceiling on recovery at
unchanged winning service cost, not a throughput forecast. Check waiting overlaps
other rows. Savings below are **separate pilot scenarios**, never a sum. [Q5]

| Rank | Measured exposure | Landing/hour-equivalent | Concrete change and pilot effect | Estimated cost |
| --- | --- | ---: | --- | --- |
| 1 | Rebase failures, 123.80 h | 6.47 | Coordinate simultaneous writers to the same non-derived files; preserve committed deltas and route conflicts into a bounded resolution phase instead of a fresh broad implementation brief. Refresh released worktree bases as already supported. Target 25–50% less exposure: **1.62–3.23/hour** capacity equivalent. | 1–2 engineering days plus manager path planning; can reduce apparent concurrency. |
| 2 | Proven slot waiting, ≥118.98 h | ≥6.22 | Persist check enqueue/acquire/finish identity across adoption; a queued check keeps the attempt alive without model polling. Admit against measured slot/memory demand; share exact-tree check results and avoid voluntary full sweeps for pure source-type tasks. Preserve every contracted and affected-file check. Target 30–50% of the measured bound: **1.87–3.11/hour**. | 1–2 engineering days for lifecycle/timing and one scheduler pilot; extra host cost only after measuring real resource demand. |
| 3 | Environment exits, 88.83 h | 4.64 | Separate transport/storage/provider incidents from assertions, park/retry the same committed attempt with the contract's bounded retry policy, and circuit-break the affected host/allowance. Run infrastructure baseline comparisons outside the serial train and attach exact evidence. Target half the exposure: **2.32/hour**, plus reduced landing blockage. | About one engineering day plus operational route/storage verification; deploy existing fixes first. |
| 4 | Supersession churn proxy, 83.93 h | 4.39 | Store a brief revision/hash and reshape reason; avoid restarting a live task for status or an unchanged contract. Send decision deltas once, preserve evidence/commits and group dependent interface decisions before launch. Target 25%: **1.10/hour**. Confirm the proxy really represents avoidable churn first. | Half to one engineering day and a brief-review practice change. |
| 5 | Explicit specification exits, 59.38 h | 3.10 | Preflight named test existence, frozen hashes, native fixture APIs and cross-owner exports before dispatch; return research decisions to the owning brief before resuming. Split matrices by independent mutation families when the contract allows, preserving all cases. Target half: **1.55/hour**. | Half to one engineering day, then review time per brief; dependency delay may trade against fewer failures. |

Silent stops add **1.78/hour-equivalent**, scope growth **1.59**, cancellation
**1.37**, and early-stop classification **0.44**; unassigned final events expose
another **3.02**, which cannot honestly be assigned a remedy yet. [Q3]

The landing incident is a **serial amplification priority**, separate from that
worker-resource ranking: recovering 74.71 minutes at the observed 28.03/service-hour
would provide room for about **34.9 landings**, or **1.45/hour averaged over a
day**. This is a backlog/capacity scenario, not 34.9 proven lost tasks. Recovering
all 9.265 unattributed hours would imply a 28.03/hour envelope, but those hours
are not known to be removable. Do not budget that envelope as a delivered gain.

For approximately 200 remaining tasks, 200 / 17.21 is **11.62 hours** of constant
observed-rate work; a sustained 20/hour is 10 hours and 25/hour is 8 hours.
Dependency chains, new findings and promotion can extend those arithmetic
scenarios. An intervention taking several days pays back only if it also
reduces operational risk or is needed after this scope. Prefer deploying the
already landed lifecycle/classifier fixes and tightening briefs first.

## External primary-source check and shared patterns

The reused Bors snapshot is
`.reference/merge-queues/bors-ng`, commit
`ca725797e53a88e954998de0bbb14a8a5acb13ab`, **Apache-2.0**, read as data without
installing or running it. Its
[`lib/worker/batcher/divider.ex`](https://github.com/bors-ng/bors-ng/blob/ca725797e53a88e954998de0bbb14a8a5acb13ab/lib/worker/batcher/divider.ex)
separates unmergeable patches and bisects failed multi-patch batches. A singleton
failure remains a failure. Its `.reference/INDEX.md` access date was refreshed.

[GitHub's official merge-queue documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
describes bounded build concurrency and checks against cumulative candidates.
Those are design precedents, not a throughput benchmark for this repository.
[SQLite's backup documentation](https://www.sqlite.org/backup.html) supports using
an online consistent backup for analysis instead of copying a live database file.
Official documentation was consulted as documentation, not copied implementation.
The local control-plane code is covered by the repository's **AGPL-3.0** licence
(`LICENSE`); no external implementation is proposed for copying.

The shared pattern in the local train, Bors and GitHub is an identified candidate,
bounded check work, and explicit treatment of failure/invalidation. Here batching
and parallel read-only integration commands **already exist** in
`merge-train.ts`; the earlier queue report's suggested optimizations must not be
counted as new capacity. Adopt isolation of infrastructure incidents, durable
wait tracking, and conflict-aware dispatch in the existing Bun/SQLite stack.
Do not weaken frozen tests, treat an infrastructure error as a pass, or expand
speculation until check demand and invalidated work are measured.

A pilot should compare matched backlog/class mix and deployed controller version
for a full window: landings/hour, occupied workers, attempts/tokens per landing,
queue P50/P90, slot wait, train lease occupancy, environment fingerprints, rebase
conflicts, changed brief hashes, and regressions. Persist timestamps for
`registered`, `dependency-ready`, `capacity-enqueued`, `worker-start/end`,
`check-enqueued/acquired/finished`, `landing-start/end`, `lease-release` and
`promotion`. This closes the current capacity and serial-time attribution gaps.

## Reproduction queries and procedures

These queries target the frozen local snapshot. JSON paths match the schema in
`tools/goal/src/store.ts`, `land.ts` and `inbox.ts`. `:s` is
`2026-10-27T06:02:20.558828Z`, `:t` is `2026-10-28T06:02:20.558828Z`.
Times ending in milliseconds compare correctly against these bounds here.
The production store changes after the snapshot; rerunning against live mutable
records need not reproduce historical supersession states.

**Q0 — capture and row inventory.** The source is read-only; the destination is
inside the assigned worktree. The backup completion time defines the cutoff.

```python
import sqlite3
source = sqlite3.connect(
    'file:/home/edge/projects/rezics/rezics-next/.temp/goal/goal.sqlite?mode=ro',
    uri=True)
target = sqlite3.connect('.temp/throughput-audit/snapshot.sqlite')
source.backup(target)
# SELECT count(*) FROM each of worker_tasks, worker_attempts, worker_events,
# worker_records, landing_queue, manager_inbox.
```

**Q1 — landing timestamps and hourly bins.** Decode `body` for winning attempt,
log and `hostMs`. Deduplicate before applying the window, not afterwards.

```sql
WITH first_land AS (
 SELECT *, row_number() OVER (PARTITION BY task_id ORDER BY at,sequence) n
 FROM worker_events WHERE kind='gate-outcome'
 AND json_extract(body,'$.passed')=1 AND json_extract(body,'$.stage')='merge'
)
SELECT task_id,attempt,at,body FROM first_land
WHERE n=1 AND at BETWEEN :s AND :t ORDER BY at;
```

Bin `floor((timestamp(at)-timestamp(:s))/3600)` for the hourly series; use
`:t-12h` for the last-half-window. Divide counts by elapsed hours.

**Q2 — task inventory and occupied workers.** Decode the two body columns.
Sum `max(0,min(end-or-cutoff,cutoff)-max(start,window-start))` across **all**
attempts, including still-running ones. Divide seconds by 3,600 for worker-hours
and by 86,400 for average occupancy.

```sql
SELECT json_extract(body,'$.state') state,count(*) FROM worker_tasks GROUP BY 1;
SELECT body FROM worker_attempts;
SELECT t.body FROM landing_queue q JOIN worker_tasks t ON t.id=q.task
WHERE q.outcome IS NULL;
```

**Q3 — ended-attempt causes.** Join one record per attempt. Attach the last
`gate-outcome` and `attempt-exit-classified` for that attempt. Precedence is:
passed gate; exit-classified (explicit `stalled: no output for ` becomes silent);
failed rebase gate; other failed gate's record escalation; pending-gate record;
superseded record; cancelled state; stopped state; remaining exit-0; unknown.
This reproduces the exhaustive 877-attempt table. Clip durations as in Q2.
For raw escalation counts, group the extracted escalation instead.

```sql
SELECT a.task_id,a.attempt,a.body,r.body record,t.body task
FROM worker_attempts a JOIN worker_tasks t ON t.id=a.task_id
LEFT JOIN worker_records r USING(task_id,attempt)
WHERE json_extract(a.body,'$.endedAt') BETWEEN :s AND :t;
SELECT task_id,attempt,kind,at,body FROM worker_events
WHERE kind IN ('gate-outcome','attempt-exit-classified');
```

**Q4 — decomposition and train intervals.** For each Q1 winner, retrieve every
attempt up to and including its winning attempt and its landing request below.
Let C=creation, F=first start, E=last worker end, R=request, G=gate event time,
H=`hostMs`/1000, D=latest first-pass time among its current `brief.after` parents.
Then dependency=`max(0,min(F,max(C,D))-C)` (zero without parents);
admission=`F-C-dependency`; worker=sum attempt lifetimes; retry gaps=sum positive
next-start minus preceding-end; settlement=`R-E`; queue=`G-H-R`; train=H;
total=`G-C`. Compute nearest-rank distributions. Check the additive residual.
For train occupancy, union `[G-H,G]` over all window-ending gate outcomes before
summing; gaps are the complementary intervals. Unfinished service has no interval.
For queue bounds, use `[R,G-H]`, or `[R,cutoff]` without an outcome, clipped to the
window. Queue requests from superseded attempts explain the censoring caveat.

```sql
SELECT task_id,attempt,at,body FROM worker_events WHERE kind='landing-requested';
SELECT id,task,attempt,request,outcome FROM landing_queue;
SELECT at,body FROM worker_events WHERE kind='gate-outcome' AND at BETWEEN :s AND :t;
```

**Q5 — per-winner cost.** For Q1 winners, join Q3's tables **without the end-time
filter**, keeping `a.attempt<=winning.attempt`. Group by winning
`profile.model` and task `taskClass`. Sum `tokens.input/cached/output`; divide by
winning-task count. Predecessors have `a.attempt<winning.attempt`. For window
model counts use Q3 and group by the attempt's own profile; exclude no CLI.

**Q6 — inspect failures, not just labels.** This selects the exact underlying
logs and contracts for samples. Search `detail`, `failure` or `blocker` for the
named error phrase, then read the matching source. The shelf sample is identified
by `brief.paths[0]='services/kernel/src/library/shelf-heads.ts'`; the native
matrix by `services/kernel/test/access/durable-initiator-outcome.test.ts` and
attempt 4 or 10. Use `kind='manager-event'` only for judgment delivery evidence.

```sql
SELECT e.at,e.kind,e.body,a.body attempt,t.body task
FROM worker_events e JOIN worker_attempts a USING(task_id,attempt)
JOIN worker_tasks t ON t.id=e.task_id
WHERE e.kind IN ('attempt-exit-classified','gate-outcome','manager-event')
AND e.at BETWEEN :s AND :t;
SELECT request,outcome FROM landing_queue WHERE id=2083;
SELECT id,event,read_at,acknowledged_at FROM manager_inbox WHERE id IN (4440,4468);
```

For the environment text screen, apply these ordered, case-insensitive patterns
to exit `detail`, gate failure excerpt and blocker: transport
`ssh|rsync|transport|port 22|connection reset|connection closed`; provider
`at capacity|overloaded|quota|usage limit`; disk/memory
`no space left|out of memory|out.of.memory|OOM|53100`; missing reference
`\.temp/ref|reference.*(missing|unavailable)|cannot access.*ref`; killed/missing
report `without a success report|ended without|killed|exceeded.*limit`; then
timeout/deadline. These buckets are search evidence, not universal root causes.

**Q7 — slot-wait bound.** Read Q3 attempt `logPath` JSONL. Keep
`item.completed` command-execution `aggregated_output`, with direct command
filters described above, and completed MCP result text. Match
`remote-check: (slot wait|rsync back|rsync|bun install|command) ([0-9.]+) s on (host)`.
Deduplicate by attempt/phase/duration/host. For each attempt use
`max(0,min(max_slot_wait,attempt_duration)-max(0,window_start-attempt_start))`.
This is a lower bound on window worker occupancy even with overlapping commands.
It cannot locate the exact wait interval inside an individual task. Source
emission: `scripts/remote-check.ts`'s `runLeased` and `reportDuration`.

**Q8 — dependency graph.** Decode `worker_tasks.body`, select state `held`, age
=`cutoff-createdAt`. Resolve each `brief.after` to a task; test all dependencies'
state for integrated/merged. Recursively compute
`longest_path(task)=longest(parent_paths)+task` with cycle detection. Count
vertices, and select maximum for each held terminal's Goal. The current snapshot
has no discovered cycle. Retain paths/state/age as graph evidence; do not infer
unknown future task duration.

**Q9 — inbox latency.** Match Q6 `manager-event.body` to inbox `event` using
`managerId, taskId, kind, summary, evidencePath`. Compare event `at` with
`read_at/1000` and `acknowledged_at/1000`; compare with the next later attempt's
`startedAt` for restart latency. Require `at` within the window. Inbox manual
events have no `at`, so they support case evidence, not measured delivery rates.

**Q10 — unchanged work.** Read `evidencePath/diff.patch` for Q3 attempts;
SHA-256 nonempty bytes, group equal hashes, count `group_size-1`. Count missing
and empty separately. For path overlap, expand Q1 outcome `changedFiles`, count
touches and distinct paths; repeat touches=`touches-distinct`. These procedures
are deliberately narrower than a claim about semantic duplication.

Validation: `test -s docs/research/throughput-audit-high.md` and `git diff --check`.
The only tracked change is this report. The sole persistent write outside the
report is the required date refresh in the ignored main-checkout
`.reference/INDEX.md` for the reused Bors clone; its URL, commit and licence were
verified. All analysis files stay under this worktree's `.temp/`.
