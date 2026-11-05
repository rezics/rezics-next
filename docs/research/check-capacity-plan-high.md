# Check capacity on 2026-10-28

This is research evidence and a proposed operating plan, not an adopted check policy.
Use the existing machines, reduce broad worker checks, expand small-job admission on
the workstation gradually, and coalesce promotion checks. The measured slowdown is
real: successful integrations fell from 46 in 00:00–02:00 UTC (23/hour) to eight in
03:00–05:00 UTC (4/hour). A conservative, calibrated scenario gives **about 8–13
integrations/hour** for the combined plan, not a demonstrated return to 20/hour.
No hardware, service or licence purchase is required.

## Evidence and accounting

Source checkout: `50253f81316a8e975d67971fb62ed42db3145c10`. Local operational
paths below are relative to the read-only main checkout. The state snapshot was
read at 05:50:01 UTC, 2026-10-28: 2,028 tasks, 3,247 attempts and 2,122 landing
queue records. All report times are UTC; add eight hours for the local timezone.

- Read `.temp/goal/runs/*/*.jsonl`: 3,226 logs, approximately 1.87 GB, no malformed
  JSON lines. Keep completed `command_execution` items once per log/item ID;
  exclude commands reading or searching old logs. Count an actual
  `remote-check: running on` announcement, not a quoted command or a polling turn.
  This yields 1,674 run starts in 1,673 shell executions, with 1,160 printed
  command durations. Counts are observed lower bounds: redirected, truncated,
  interrupted and older outputs do not provide a complete run ledger.
- Join successful `landing_queue.outcome` records to `worker_events` of kind
  `gate-outcome`, by task and attempt; deduplicate successful events. Join worker
  logs by task across **all its attempts**, including unsuccessful retries.
  A cohort's checks are its lifetime observed checks, not checks necessarily
  executed inside its landing interval. The raw CLI logs lack per-item timestamps.
- Here, **landing means integration into dev**. Promotion into main is separate,
  as [tools/goal/README.md](../../tools/goal/README.md) specifies. These observations
  cannot establish a 4/hour main-promotion rate. The live promotion record was
  still at `gate-head`, with 924 tasks in its candidate scope.
- Read all 66 `.temp/goal/promotion-*-head-0.log` files and 2,100
  `.temp/goal/landing-*.log` files. Only one landing log announces a remote start;
  do not charge every landing another full remote gate. For example,
  `.temp/goal/landing-2118.log` reports a batch integration check and workspace
  typechecks, kernel 85.38 seconds, rather than a kernel test suite.
- A **slot-minute** is one admitted host slot held for one minute. Worker calls
  normally request one slot; historical whole-root gates request six. Sum upload,
  install and command seconds, multiply by slots, divide by 60. Slot wait is
  latency, not slot consumption. Download and cleanup also hold the lease but are
  incompletely printed, so these service totals remain lower bounds.

The extraction scripts and read-only host snapshots used for this report remain
in this worktree's ignored `.temp/check-capacity/`: `measure.py`, `analyze.py`,
`state.json`, `events.json`, `commands.json`, `logs.json`, `host-probes.json` and
`live-{1,2}.json`. No check workload was added to the shared queue for measurement.

## Demand: runs, service time and waiting

The denominator matters: many document tasks use no remote check at all.

| Landing cohort           | Landings | Tasks with observed remote starts | Remote starts | Runs/landing | Runs/remote-using task | Observed slot-minutes/landing |
| ------------------------ | -------: | --------------------------------: | ------------: | -----------: | ---------------------: | ----------------------------: |
| October 27, full UTC day |      391 |                               107 |           654 |         1.67 |                   6.11 |                          4.91 |
| October 28, 00:00–05:00  |       66 |                                19 |            68 |         1.03 |                   3.58 |                          3.61 |
| October 28, 03:00–05:00  |        8 |                                 2 |            13 |         1.63 |                   6.50 |                          7.74 |

The first cohort has 549 printed command durations: mean 177.11 seconds, median
69.97, p95 380.97, maximum 5,179.92. Its 604 printed waits have median 61.55
seconds and p95 1,952.25. The second cohort has 61 command durations: mean 192.43,
median 69.65, p95 204.79; its 68 waits have median 606.05 seconds, p95 6,699.17
and maximum 17,189.39, **4.77 hours**. Waiting grew much faster than service time.

Among attempts **started since October 28 00:00**, including still unlanded work,
the observed host distributions are:

| Host | Calls with starts | Mean printed command seconds | Median wait seconds | p95 wait seconds |
| ---- | ----------------: | ---------------------------: | ------------------: | ---------------: |
| a    |                90 |        108.37 (87 durations) |            2,205.02 |        11,884.81 |
| b    |                19 |        394.24 (19 durations) |            2,207.70 |         9,112.25 |
| c    |                20 |         99.64 (20 durations) |               93.91 |         1,228.89 |

These are different workloads, not a controlled host-speed comparison. They do
show that c is already useful express/worker capacity, and that stopping a silent
worker after a few minutes can discard an otherwise healthy queued check.
[scripts/remote-check.ts](../../scripts/remote-check.ts), `waitRecorder`, now
records queue waiting in increments of at most 60 seconds. Preserve that liveness
signal through the worker supervisor; never equate a slot wait with a tool failure.

### Broad checks and repeated work

For the October 27 landed cohort, explicitly targeted kernel calls account for
522 starts and 1,241.30 observed slot-minutes; other work for 104 starts and
312.42. Full-selection kernel calls account for 25 starts across 11 tasks,
including **14 calls beyond the first per task**, and 363.61 slot-minutes.
Three affected-selection calls add 1.79. Total measured service is 1,919.12
slot-minutes. This does not prove every repeated call was redundant: some followed
edits or checked a base. Deduplicate only when the inputs and command are equal.

For the 66 recent landings, 39 targeted kernel calls cost 88.45 slot-minutes,
23 other calls 19.76, three full-selection calls 3.52 and three affected-selection
calls **126.78**. Two affected runs selected 333/864 and 546/734 files and ran
2,605.77 and 4,751.21 seconds respectively. The full-selection runs with printed
durations stopped after 63.87 and 75.74 seconds on failures. An invocation named
“full” is not evidence that the whole suite passed.

The current [services/kernel/scripts/check.ts](../../services/kernel/scripts/check.ts)
already caps affected selection at **60** files, ranking dependency distance,
then recorded wall time, then name. An unknown dependency boundary returns
“unverified, 0” rather than a full suite. This is newer than several expensive
observations. Credit this existing change; do not predict the whole historical
333/546-file saving again. Unverified selection is not proof of unaffectedness.

Measured broad-call replacement sensitivity, using each cohort's own mean
targeted cost, is:

| Cohort                  | Broad calls and slot-minutes | Replacement targeted cost/call | Replacement total | Reduction in all observed worker service |
| ----------------------- | ---------------------------- | -----------------------------: | ----------------: | ---------------------------------------: |
| October 27              | 28; 365.40                   |             2.378 slot-minutes |             66.58 |                                   15.57% |
| October 28, 00:00–05:00 | 6; 130.30                    |             2.268 slot-minutes |             13.61 |                                   48.93% |

This is a counterfactual sensitivity range, not measured savings after rollout.
Use it only for discretionary broad calls that can be replaced by sufficient
targeted evidence. Keep every contract-named acceptance test and every required
full gate. The cap of 60 already removes part of the upper-end opportunity.

## Supply: configured slots are not usable slots

The task brief described a/b/c as 7/8/4 slots. At measurement,
`.temp/goal/remote-check-hosts.json` instead contained **7/7/4**. Read-only SSH
probes at 05:49:42–05:49:47 verified the actual cgroup limits, not just the JSON.

| Host | Processors | Physical RAM GiB |   Slice CPU quota | Slice RAM GiB | Configured slots | Resource-backed capacity | Ordinary / express slots |
| ---- | ---------: | ---------------: | ----------------: | ------------: | ---------------: | -----------------------: | ------------------------ |
| a    |         12 |            31.35 | 1,100% = 11 cores |            24 |                7 |                        5 | 4 / 1                    |
| b    |         16 |            62.80 | 1,400% = 14 cores |            48 |                7 |                        7 | 6 / 1                    |
| c    |         64 |            62.64 | 2,400% = 24 cores |            24 |                4 |                        4 | 3 / 1                    |

In `remote-check.ts`, `hostCapacity` takes
`min(configured slots, floor(slice RAM / 2.5 GiB), floor(slice cores / 2))`.
`rankHost` reserves one express slot per host. Only a non-gate, one-slot run with
an estimate at most 120,000 ms may use it; unknown/long estimates cannot.
Thus the current fleet provides **16 resource-backed slots, only 13 ordinary**,
not 18 configured or the brief's 19. Raising b from seven to eight in JSON alone
adds nothing; its 14-core quota still caps admission at seven. a is CPU-capped.

Memory headroom additionally limits each admission. There is no load-average
admission veto. A normal multi-slot request is capped by half the smallest
responding host capacity: presently two slots for the three-host set. A gate's
maximum is `ordinaryCapacity - 1`: a/b/c support 3/5/2 gate slots. While a gate
waits, a marker restricts new ordinary work, preserving one ordinary worker slot
and express capacity. These tokens admit jobs; they do not give each job a hard
two-core or 2.5-GiB sub-limit.

[scripts/stack-run.ts](../../scripts/stack-run.ts) places work on responding hosts
and waits for admission. Worker environment flags do not authorize a local bypass.
The current kernel placement requests one slot regardless of lane count. Its
estimate sums file **wall** times, omitting database creation, search readiness,
upload and cleanup. That can misclassify expensive startup as an express job.

### Actual processor and memory use

Nine completed new-format worker outputs in the scanned logs report 333.552 CPU
seconds over 229.077 wall seconds: **1.46 average cores weighted by wall time**.
Eight are isolated web tests, 1.35–2.41 cores and 975–3,829 MiB peak; the remaining
schema-generation call is 0.51 cores, 188 MiB. There is **no completed new-format
kernel or promotion lifetime CPU sample** in this extraction. Do not extrapolate
that web average to six-lane kernel checks or claim a measured kernel CPU speedup.

Two additional read-only cgroup samples, 05:52:31–05:53:22, measured these deltas:

| Host | Interval seconds | Whole check-slice average cores | Share of periods throttled |
| ---- | ---------------: | ------------------------------: | -------------------------: |
| a    |            44.42 |                       9.33 / 11 |                      14.4% |
| b    |            44.57 |                       8.78 / 14 |                         0% |
| c    |            46.83 |                       5.15 / 24 |                       5.2% |

The surviving old gate scope on b used 4.45 cores during its interval; an old
full-kernel scope on a used 2.79, another single-file kernel scope 0.74. **Old
scopes exclude sibling Docker containers**; the whole-slice rows include them.
New per-run slices and the Docker wrapper in `scripts/check-host/docker` fix that
accounting boundary. Neither an interval observation nor throttled-period share
is a lifetime CPU demand or a percentage slowdown.

Memory prevents simply assigning c 24 or 32 slots. The 05:49 probe found c with
only 9.08 GiB host memory available, approximately 28 GiB swap occupied, check-slice
memory 12.05 GiB and slice swap 1.81 GiB. Its memory pressure `full avg60` was
1.93%; host load exceeded 185. a had 44 historical slice OOM kills; these are
cumulative, not 44 failures in this sample. b used 31.95/48 GiB of its slice.
One surviving whole-web scope on c had a historical 14,308-MiB peak, another on b
22,950 MiB. These old peaks are warnings about job size, not current allocations.
Do not put a whole mixed gate on c merely because it has 64 processors.

## Promotion's share and the version trap

Of 66 head logs, 55 contain workspace timings. Twenty-six contain a terminal
command-duration or peak-memory marker: their command/longest-workspace duration
has mean 2,429.44 seconds, median 2,475.66. Five such logs ending on October 28
before the snapshot have mean **2,464.42 seconds, 41.07 minutes**; their mean
printed queue wait is 956.42 seconds, 15.94 minutes. Four report failed kernel
workspaces. Older peak markers cover the runner scope, not all containers.

The five durations are 2,436.878, 2,629.12, 2,324.84, 2,559.92 and 2,371.35 seconds.
Only the first prints a remote command duration; the other four are the longest
workspace's measured time, a **lower bound** on gate occupancy. Their corresponding
waits are 445.987, 262.280, 682.528, 2,282.442 and 1,108.864 seconds. Identify these
rows by the metric values in `.temp/goal/promotion-*-head-0.log`.

The last two occupy at least 82.19 of the 120 minutes in 03:00–05:00. At six
slots this is **493.13 slot-minutes**, or 4.109 average slots: 31.6% of today's
13-slot ordinary supply. While running, the old gate takes all six of b's current
ordinary slots, or 46.2% of fleet ordinary capacity. Its average is lower than
its instantaneous share because it also waits between runs.

The live candidate `a2ff2858ca7a50b854694ddaa0e6f8ca5ba920a7` still contains the
older `scripts/gate.ts`: one remote job, default six slots, all workspaces in
parallel. **The current checkout contains different code**: `runRemoteGroups`
splits into two default four-slot gate jobs. Historical single-host outputs do
not measure that new design. `hostsForGroups` partitions by configured slots,
not effective capacity; with 7/7/4 it gives one group b and the other a+c. The
latter's request is clamped to three by a's effective capacity; c cannot admit
that three-slot gate. Two gates can consequently reserve seven ordinary slots
across a and b, leaving only six ordinary slots fleet-wide.

Measured recent workspace ranges also matter: web 2,324.84–2,629.12 seconds,
kernel 1,739.95–1,961.69, auth 1,222.87–1,339.50. Splitting does not remove the web
critical path. Charge **sum(group slots × group occupied time)**, not only the
fastest group's elapsed time. Do not count the unmeasured split as a free speedup.

## Zero-budget operating plan

1. **Cut discretionary broad worker work first.** Run required acceptance after
   the final relevant edit; retain required red/green evidence. Cache a successful
   discretionary check only by command, tree/dirty-input digest, lockfile and
   environment identity. Do not rerun a full suite solely to obtain a success
   summary. Keep affected cap 60 as the existing baseline; offer a worker budget
   of **12 selected files**, prioritizing directly changed tests and nearest
   dependencies. Explicit acceptance tests bypass this budget. Label truncated
   and unverified coverage, and retain an uncapped full promotion gate. Never
   turn an existing full-check acceptance contract into a capped check silently.
2. **Use a=5, b=7, c=6 initially; aim for c=8.** Keep quotas at 11/14/24 cores and
   RAM at 24/48/24 GiB. This means 15, then 17 ordinary fleet slots, versus 13
   today. a's change documents its real cap; b stays seven. c=8 uses a nominal
   20 GiB of its slice, retaining 4 GiB beyond token accounting. c=9 is the
   mathematical RAM ceiling, leaving only 1.5 GiB, and is not recommended.
   Gate c's ramp on measured host memory and pressure: at least 8 GiB available,
   slice memory below 20 GiB, no new OOM kills and memory `full avg60` below 1%
   across a complete check wave. The captured c sample fails the pressure test;
   **do not expand it immediately**. Reduce future dispatch pressure and wait for
   owned checks to finish; do not terminate other workers or their services.
3. **Budget promotion explicitly.** Prefer one whole-gate job on b, five slots,
   at most once per **90 minutes**, only for a new candidate or changed failure
   inputs. This requires an explicit single-host mode; changing environment
   counts alone does not disable the current two-group split. Preserve full
   verification of every promoted candidate and the separate required checks
   deduplicated by `tools/goal/src/promotion.ts::commandsFor`. After a known base
   failure, repair/recheck that failing workspace before another whole root run.
   At the measured 41.07 minutes, five-slot occupancy averages 2.282 slots:
   17.6% of today's ordinary supply, 13.4% at c=8. Enforce a rolling **25% fleet
   ordinary slot-minute budget**, including prefix, retry and completion gates;
   slower gates defer the next start. Keep the express slots and gate marker.

Kernel concurrency should match the job class: **two lanes for ordinary worker
checks, six for the b-hosted full gate**, with the latter sharing that job's
reservation with the other workspaces. Set `KERNEL_CHECK_CONCURRENCY` accordingly;
`services/kernel/scripts/check.ts` already forwards this override through remote
placement. `scripts/test-lanes.ts::laneConcurrency` currently defaults to six;
on remote hosts `REZICS_STACK_LEASE=off` allows all six inside one worker slot.
`stack-run.ts` leaves the caller's general environment behind. Keep full-gate
workspace concurrency at its measured setting initially; reducing that setting
can serialize the critical path. A lane reduction alone has no demonstrated
throughput benefit: for CPU-bound independent files, six to two can triple wall
time. Pair it with the smaller selection and measure before expanding admission.

Fix resource classes before encouraging whole-web worker checks: a one-slot
reservation is insufficient for the observed 14–22-GiB scopes, and the current
normal-request cap prevents solving that just by requesting six slots. Route
whole-stack validation through the budgeted gate or shrink browser parallelism;
single-file web checks remain eligible for the small-job pool.

## Cost outliers worth fixing without dropping assertions

`.temp/kernel-check/timings/latest.json`, recorded 02:56:43, contains 779 file
entries: 645 pass, 134 fail. It is a merged historical table, not a passing full
run or the current suite inventory. Total file wall time is 19,312.15 seconds;
median 5.95, p95 85.68. The four largest entries consume **27.16%** of this sum.

| File under services/kernel/                         | Wall seconds | Recorded create seconds | Result |
| --------------------------------------------------- | -----------: | ----------------------: | ------ |
| test/access/native-account-workflow-outcome.test.ts |     3,092.34 |                   95.79 | fail   |
| test/access/credential-effect-outcome.test.ts       |       826.61 |                   95.01 | pass   |
| test/access/account-authorization-outcome.test.ts   |       715.10 |                  179.16 | pass   |
| test/imports/growth-outcomes.test.ts                |       611.35 |                  438.36 | pass   |
| test/imports/api-outcomes.test.ts                   |       554.19 |                  174.25 | fail   |
| test/library/outcomes.test.ts                       |       451.49 |                  133.78 | pass   |

The native access files wrap specification suites; the imports growth wrapper
spawns another Bun suite with a 300-second test timeout and a 1,800-second outer
budget. Profile fixture/driver work and nested process lifecycles first. Preserve
the specifications, growth scales and assertions. Sharding independent cases
reduces a long-file critical path but does not automatically save CPU or slots.

Recorded creation totals 32,029.09 seconds; an invalid-argument test records
751.51 seconds of creation but only 0.75 seconds of test wall time.
`test-lanes.ts::createRecorder` times the entire create callback, which includes
`acquireStackSlot` before `CREATE DATABASE`. Do not call all of this database CPU,
add it to test wall as CPU demand, or infer suite elapsed time by summing a merged
table. Separate lane admission, template cloning and startup in future telemetry.
The current express estimate excludes these costs. Halving the four largest wall
entries would remove 2,622.70 aggregate file-seconds, 13.58% of this table's wall
sum; it is not a measured 13.58% gate or landing improvement, especially while
web remains the gate critical path.

## Throughput scenarios and the three largest changes

The survivor cohorts alone would misleadingly imply enormous spare capacity:
107 remote-using landed tasks consume only 17.94 observed slot-minutes each.
At that rate, a 50/72-worker all-stack wave needs about 897/1,291 slot-minutes,
before missing durations and unlanded attempts. Those quantities are useful for
queue sizing, not a prediction of realized landing throughput.

Use the measured 4/hour plateau to calibrate a second, explicit scenario model:

```text
S = ordinary fleet slots; historical gate average G0 = 4.109
D0 = (13 - G0) * 60 / 4 = 133.36 effective slot-minutes/landing
new gate average G1 = 5 * 2464.42 / (90 * 60) = 2.282 slots
scenario landings/hour = 60 * (S - G) / (D0 * (1 - r))
```

`D0` is **calibrated effective demand**, including unlanded work, rework and
admission inefficiency; it is not measured per-task CPU or service time. Historical
and current schedulers overlap in these observations. The model assumes the same
work mix and that additional usable admission translates proportionally into
progress. Gate times are lower bounds, missing commands remain missing, and
memory pressure can erase the projected gain. This is a planning sensitivity,
not a fitted queueing distribution or a benchmark result.

| Option, independently unless marked combined |   S | Average gate slots | Worker-service reduction r | Scenario landings/hour |
| -------------------------------------------- | --: | -----------------: | -------------------------- | ---------------------: |
| Observed plateau calibration                 |  13 |              4.109 | 0                          |                    4.0 |
| c=6, after pressure clears                   |  15 |              4.109 | 0                          |                    4.9 |
| c=8, after pressure clears                   |  17 |              4.109 | 0                          |                    5.8 |
| Five-slot b gate every 90 minutes only       |  13 |              2.282 | 0                          |                    4.8 |
| Replace discretionary broad calls only       |  13 |              4.109 | 15.57–48.93%               |                4.7–7.8 |
| c=8 plus gate budget                         |  17 |              2.282 | 0                          |                    6.6 |
| Combined, including broad-call replacement   |  17 |              2.282 | 15.57–48.93%               |           **7.8–13.0** |
| c=9 plus all changes, not recommended        |  18 |              2.282 | 15.57–48.93%               |               8.4–13.8 |

Two-lane kernel concurrency and outlier repair receive **no extra speed multiplier**
in this table. If lane changes actually triple all worker service, the combined
scenario falls to 2.6–4.3/hour; this is a reason to measure, not to promise gains.
The 90-minute period also adds promotion freshness latency, up to one scheduling
period plus queue/run time, while coalescing more tasks into each successful gate.

The three largest actionable opportunities are:

1. **Replace broad/repeated worker validation:** measured sensitivity removes
   15.57–48.93% of worker service, a 1.18–1.96× rate multiplier in isolation.
   Cost: selection/cache plumbing and explicit coverage reporting; narrower
   pre-promotion feedback. The upper end predates today's cap and is optimistic.
2. **Expand c from four to eight resource-backed slots:** four additional ordinary
   slots, 13→17 fleet-wide; calibrated 4.0→5.8/hour alone. Cost: up to 10 GiB
   additional nominal memory admission and more pressure on the agent workstation.
   Existing quotas suffice, but the measured memory-pressure condition must clear.
3. **One five-slot gate on b, coalesced to 90 minutes:** average charged gate slots
   fall from at least 4.109 to about 2.282; calibrated 4.0→4.8/hour alone.
   Cost: single-host scheduling/budget support and slower main freshness. Retain
   the complete gate; reducing its frequency does not remove its assertions.

These effects are not additive. Prioritize the first and third while c is under
memory pressure; ramp c afterwards. Reassess after two complete gate cycles using
queue wait p50/p95, slot hold time including cleanup, CPU seconds, whole-run peak
RAM including containers, OOM deltas, main promotions and dev integrations
separately. Do not promise 20/hour until those measurements support it.

## Primary-source patterns and provenance

The external sources support admission by declared resource class, bounded nested
parallelism and whole-workload accounting. They do not provide REZICS throughput
numbers; every such number above comes from the local evidence or a labeled
calculation. Implement these ideas in the existing Bun/systemd stack.

- Linux documents `cpu.max` as quota per period, `cpu.stat` as including descendant
  CPU use, and `memory.peak` as covering descendants. This supports the new
  per-run slice plus container-parent arrangement. A processor count alone is
  not the available check budget. [Linux cgroup v2 documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).
- systemd defines `CPUQuota` percentages relative to **one CPU**, and hierarchical
  controls constrain descendants. Thus 2,400% supplies at most 24 CPU equivalents,
  not 24% of a 64-processor workstation. [systemd resource control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html).
- Ninja uses finite pools alongside a global job bound. Its `Pool::EdgeScheduled`,
  `EdgeFinished` and `RetrieveReadyEdges` account for scheduled work and release
  delayed jobs when budget becomes available. Adopt the pattern of a bounded
  heavy-job class plus a global budget; no Ninja code is needed here.
  [Ninja pool implementation](https://github.com/ninja-build/ninja/blob/3ccb2270e8ef5a84bb31c4651c0df84440f30362/src/state.cc),
  [pool declarations](https://github.com/ninja-build/ninja/blob/3ccb2270e8ef5a84bb31c4651c0df84440f30362/src/state.h),
  [manual, Pools](https://github.com/ninja-build/ninja/blob/3ccb2270e8ef5a84bb31c4651c0df84440f30362/doc/manual.asciidoc).

The Ninja shallow clone is retained at main-checkout
`.reference/check-capacity/ninja/`, commit
`3ccb2270e8ef5a84bb31c4651c0df84440f30362`, Apache-2.0 (`COPYING`), indexed in
`.reference/INDEX.md` on 2026-10-28. Its files were read only; nothing from the
clone was installed, built or run. Linux's root licence is GPL-2.0 with the syscall
exception, subject to per-file terms, as its
[licensing rules](https://www.kernel.org/doc/html/latest/process/license-rules.html)
explain. The systemd manual's
[source declaration](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.resource-control.xml)
is LGPL-2.1-or-later.
These manuals were read online, not copied. Local REZICS source is AGPL-3.0-only
per the root `package.json`; no external implementation was copied into this report.

## Decisions made for this report

Use dev integration events as the landing denominator; distinguish main promotion.
Use the observed 7/7/4 configuration instead of silently preserving the brief's
7/8/4. Distinguish the running candidate's old gate from checkout code. Treat
missing durations and longest-workspace gate times as lower bounds; do not impute
kernel lifetime CPU from web samples. Recommend c=8 only after pressure clears,
leave quotas unchanged, and keep whole gates on the larger-memory host. Preserve
every required acceptance assertion while replacing optional checks. The current
60-file cap is already implemented; a 12-file discretionary budget is a proposal.
These recommendations require adoption in the owning documents and implementation;
this report changes no scheduler, host setting, acceptance test or frozen file.
