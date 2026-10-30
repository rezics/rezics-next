# Delivery lessons from 2026-10-30

Evidence window: 2026-10-30 00:00 to 10:30 UTC. Measures come from the Goal store
(`worker_attempts`, `landing_queue`, `flow_events`), the remote check hosts and the hourly efficiency report.
Line counts exclude generated files, recorded responses and fixture JSON.

The hourly landing rate is the measure of the delivery system: lines integrated on dev in the hour, against a
target of at least 15,000, never padded. In the hour to 10:14 UTC dev took 36,679 lines in 34 landings, after
hours of 1,000 to 15,000. Nothing in the product changed between those hours; only the rules below did. Each lesson
names the cause, the evidence and the rule that follows.

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

## 7. Measure what the hour produced

Report the hour's integrated lines, landings, check failures, slot waiting and the queue ages. Exclude generated
files, recorded responses and fixture JSON, so one generated fixture never makes an hour look productive. When a
measure moves, find the rule that moved it and record it here.
