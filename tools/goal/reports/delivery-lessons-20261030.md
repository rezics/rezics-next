# Delivery lessons from 2026-10-30

Evidence window: 2026-10-30 00:00 to 10:30 UTC. Measures come from the Goal store
(`worker_attempts`, `landing_queue`, `flow_events`), the remote check hosts and the hourly efficiency report.
Line counts exclude generated files, recorded responses and fixture JSON.

The hourly landing rate is the measure of the delivery system: lines integrated on dev in the hour, against a
target of at least 15,000, never padded. In the hour to 10:14 UTC dev took 36,679 lines in 34 landings, after
hours of 1,000 to 15,000. Nothing in the product changed between those hours; only the rules below did. Each lesson
names the cause, the evidence and the rule that follows; new findings are added as they are measured.

## 1. Tests bound throughput before workers do

Web acceptance leased a full database stack on a remote check host for nearly every slice, including tests that
needed no database. Attempts waited for slots for hours, and the longer an attempt ran, the more often it
conflicted with other landings. Since 2026-10-28 12:00 UTC web lost about 450 of 820 attempt-hours: rebase
conflicts 157 h, environment failures 165 h, stalls 71 h, specification conflicts 57 h.

Rule: an interface slice's acceptance is its own focused tests that need no database stack, plus the workspace
type check, on the worker's machine, under 10 minutes. Full suites and native browser journeys run once per
promotion candidate. Visual quality is judged by screenshot review, not by tests. After the change web landed
25,271 lines in one hour.

## 2. Check once, after integration

Landing batches ran the affected checks of every changed workspace before integrating, and the dev verifier ran
the same checks again afterwards. Batch checks queued in the same slot queue as workers: one kernel check waited
33 minutes with 23 ready landings behind it. With the pre-landing copy removed, nine tasks landed within minutes.

Rule: before dev moves, a batch runs only the changed-workspace type check, which takes seconds to minutes. The
type check stays because a conflict resolution once kept two identical imports and the web build stopped parsing.
Every other check runs after integration, and a failure returns to the owner as a fix.

## 3. A landing conflict is not a failed attempt

A landing conflict ended the attempt and queued a new one, which resolved the conflict in minutes, then reran
acceptance and queued for hours, by which time the integration branch had moved and the conflict returned. One
reorganisation of about 100 files took eight attempts over 22 hours, four of them lost this way. Two stop rules
made it worse: an attempt started for a conflict was stopped if it met another, and a repeat detector compared
the redacted error line, so every conflict looked like a repeat.

Rule: the owning worker resolves a conflict in its own session and the resolution lands in the same pass, without
rerunning acceptance or requeueing. A conflict against a newer integration head never stops a task; only the same
conflicted file set against the same head with no new commit does, and it is reported once. Recorded resolutions
are reused.

## 4. Priority loses meaning when everyone has it

Managers marked 65 of about 120 open tasks critical. Critical checks formed one queue in which only the oldest
waiter could be admitted on a host, so ordinary checks, including every visible fix the product owner asked for,
were never admitted while that queue had members. One host admitted nothing at load 9 on 64 cores.

Rule: critical is granted centrally and only for promotion blockers, explicitly requested visible fixes, privacy
leaks and host breakers. Admission backfills: a waiter that cannot use a host's free capacity within one poll does
not block it, and a marker whose holder has gone is ignored.

## 5. Every remote run needs a lifetime

Browser tests hung for 1.5 to 4.7 hours at more than 100% processor, one test process held 18.7 GB, and package
postinstalls stalled for 44 minutes downloading binaries. Each pushed its host over the admission load limit, and
with two hosts affected nearly every check waited. Stopping or reshaping an attempt left its checks running.

Rule: every remote run has a bound derived from its estimate and a hard cap, and on expiry its whole process tree
ends as an infrastructure failure naming the step. Stopping, cancelling or reshaping an attempt ends its checks.
Installs use the shared dependency store, not per-run downloads.

## 6. The control plane needs the same discipline as the product

- A squash landing replaced the worker prompt with an older text that told workers to poll their checks, which
  silently disabled suspension and wake-up for about 14 hours. The prompt protocol needs a test.
- A task-level notice written through an attempt fence threw for one held task, and because the notice ran before
  every command and host sweep, every command failed for 20 minutes. One task's error must never stop a sweep.
- One malformed local configuration note made every command fail for a minute. Local configuration is validated
  before it is saved, not when it is next read.

## 7. Verification after integration must not outrank the work it verifies

The dev verifier ran with landing priority and started every check at once. After 34 landings one run started about
48 kernel checks; landing waiters set ordinary admission to zero on every host, so workers' checks waited about an
hour while the hosts ran at load 1 to 12. A kernel check took a median of 31 to 37 minutes, almost all of it waiting.

Rule: verification after integration runs at ordinary priority with a small fixed concurrency (three checks), so it
takes a share of the hosts, never all of them. Any class that outranks workers' checks needs a bound on how many
checks it may hold at once.

## 8. Measure what the hour produced

Report the hour's integrated lines, landings, check failures, slot waiting and the queue ages. Exclude generated
files, recorded responses and fixture JSON, so one generated fixture never makes an hour look productive. When a
measure moves, find the rule that moved it and record it here.

## 9. Measured promotion placement and delivery lessons

The retained measurement window was 2026-10-29 11:04:52 UTC through 2026-10-30 11:04:52 UTC. No gate or check was
started or stopped to collect it. The original retained data remains available at these paths in the read-only main
checkout; hashes identify the exact inputs:

| Input | SHA-256 |
| --- | --- |
| `.temp/goal/performance/findings/worker-waits-gate-windows-24h.json` | `e5d9ebed8c3343862662c276ac848e3b3c86032bd6c1020d64b38956e49b2261` |
| `.temp/goal/performance/findings/gate-host-resources-initial.json` | `4b68dd798a7b3dac486223738ee6eb3606c007ca799c2b0182e04aac162cbf76` |
| `.temp/goal/performance/findings/gate-current-cpu-sample.json` | `ee88bff45c71574b671cd9afe868881a0375496b135203cbdc8a6e033e68a046` |
| `.temp/goal/performance/findings/gate-resource-log-lines-24h.json` | `1640693b21bb8dc08c9c70b1a3a3e578d3a1056d285e6625d9b5f557fd75f7f9` |
| `.temp/goal/performance/findings/admission-delivery-vs-current-check-source.json` | `7ce8eb7356292a51e1a3f8d72244947327ec39205f2001935d671ab83089ecf8` |
| `.temp/goal/performance/findings/admission-integrated-source-receipt.json` | `520d230c68f884d697103cd1a93cd542c9e6218eef5d0171f97fe945f9abc675` |

The analysis found 1,858 retained wrapper logs. Of those, 1,480 had a first outer admission marker and 378 did not;
the missing 378 are unknown waits, not zero. Total first-admission waiting was 609.140 worker-hours. Among requests
with first admissions, 773 were requested during observed parent promotion activity and 707 outside it:

| Request time | Count | Median wait | Mean wait | p90 wait |
| --- | ---: | ---: | ---: | ---: |
| During parent promotion activity | 773 | 9.16 min | 27.18 min | 87.89 min |
| Outside parent promotion activity | 707 | 10.22 min | 21.98 min | 67.84 min |

These are associations, not causal gate costs. The parent intervals run from log birth through last output or current
native-live observation; they are not exact gate-host occupancy, and an outside request can wait into a gate window.
The median was lower during promotion activity while the mean and p90 were higher. Twenty-three exact live
runner/cwd/`--run` identities were separately right-censored, 21 during promotion activity, at ages 350–8,856 seconds;
they are excluded from completed-admission medians. Missing or deleted logs prevent a complete census. Verifier
ordinary priority early in the window, host install/browser outages and the Root stale-probe intervention confound the
cohort. An outside-group observation is not proof that the request was outside every gate.

Eight exact native intervals were recovered; one lacked its left edge. The retained comparison labels 336
known-physical requests and 1,144 requests without known physical evidence. Those counts do not establish which
requests were outside all gates. Backfilled ledger zeros, sparse success-cache entries and missing promotion events
were not used as wait evidence.

The measured gate run on b had a cgroup `memory.peak` of 14,936,453,120 bytes (13.910 GiB), below c's unchanged
24 GiB slice limit. It exceeds the existing three-slot default reservation of 7.5 GiB; this is not an 18 GiB
reservation and does not justify a memory waiver or an unsupported environment variable. The same gate accumulated
8,943.652 CPU seconds
(2 h 29 min 3.652 sec); that lifetime CPU counter is a different metric from the memory peak. A late 30-second sample
from 11:11:46 to 11:12:16 UTC saw a maximum five-second interval average of 0.036 cores. It is not the gate's
lifetime CPU peak. Historical CPU peak remains unknown.

The retained topology has a/b/c at 5/7/5 total slots, each with one express slot excluded. Normal ordinary capacity is
a4 + b6 + c4 = 14. A future gate on c holding the existing supported three slots leaves 11/14 = 78.57% ordinary
capacity. Conservatively counting only a and b leaves 10/14 = 71.43%. These are structural calculations, not a
post-change throughput measurement. Both workspace groups retain full coverage and kernel concurrency five; their
three-slot admissions serialize on c's four ordinary slots, which can increase walltime by the shorter group's
duration. No host slot, CPU quota, memory limit, load threshold, verifier priority or verifier concurrency changes.

The implemented control-plane policy reads the actual ordinary host schema, takes c's existing parsed host identity
and resources, and derives a c-only gate input for future promotions. It rewrites only the promotion command to use
`GATE_REMOTE_SLOTS=3` and `KERNEL_CHECK_CONCURRENCY=5`. It leaves the source host file and live local configuration
for Root/controller to migrate, does not run a real gate, and makes no post-change throughput claim. The existing root
gate now forwards these supported environment settings through its remote invocation so the full gate keeps its
coverage and kernel concurrency. The cost is serialization; the expected tradeoff is retained ordinary-host
capacity, not a promised speedup.

Source integration and runtime client rollout were measured separately. A read-only receipt at 12:33:35 UTC verified
one valid still-running check by its exact `--run`/cwd (PID 2179139, start 51338578, process group 2179139). Its
launched checkout's `scripts/remote-check.ts` SHA-256 was
`3dff970c46e93c01eb9a1da38655c4baa53227a25da6d8d92944b0964ce00089`; that source lacked
`landingOpportunityMs`. The integrated producer revision `82bcf74eadcfa8b764959cd840c2f072340bdcfc` had source
SHA-256 `dfed906f583f04ab05339ff88e166d412ee6fe4a95a7c1f7ec354962eb9a7e8d` and five passing local cases. Those cases
prove source integration, not runtime rollout into the older queued client. That client stays on its launch source
until the controller's next ordinary source-adoption boundary. Do not copy scripts into that live run, interrupt,
retry or reopen its producer, or launch a replacement to measure it. Missing launch identity remains unknown; Git
ancestry alone does not prove deployment. The receipt included no native memory inspection or precise queue-cause
finding. This client cohort is separate from c-only future placement and the pending physical resource receipt API.

Goal now records durable logical promotion and group windows with separate wait, admission, preparation, execution and
terminal times. Physical resource fields remain null because the public `scripts/remote-check.ts` surface has no
structured current host/run/incarnation/cgroup descriptor or terminal custody event. To collect prospective physical
samples, its existing owner must provide a public typed boundary binding each current sample to the authenticated
host, run, generation/incarnation and cgroup identity, plus terminal/lost-custody notification and a bounded read of
that exact current cgroup. CPU must be calculated from bounded sampled intervals with interval and coverage; memory
must use the cgroup lifetime `memory.peak` with its scope. The observer must stop on terminal or lost custody. Until
that producer seam exists, missing custody, start/end times and resource counters stay unknown; nested log markers or
caller-owned exit 124 cannot prove physical occupancy. Actual launch revision, script hash, producer revision and
client cohort are separate nullable fields; without an authenticated launch receipt they also stay unknown. The
candidate commit records what was checked, not what a remote client necessarily ran. Post-change observations remain
pending until an ordinary gate supplies real custody and launch identity. No gate was launched just to manufacture a
measurement.
