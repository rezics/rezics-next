# Design and implementation execution workflow

## Program authority

The root [Goal](../../GOAL.md) states the current outcome. A running Goal's
manager follows the [manager charter](../goals/manager.md), which gives it the
maintainer's authority and standing directions, and runs workers through the
[Goal program](../goals/README.md). This page records delivery practice from the
backend phase for the manager to use or change.

There is no old-system compatibility requirement for schemas, APIs, SDKs, IDs,
URLs, data formats or deployment layouts. New-system integrity, live-source
conversion, installation and recovery remain acceptance requirements. Respect
released artifact immutability and preserve unrelated user work.

## Context and agent coordination

Efficiency covers the entire delivery time: model interactions/context, tools,
verification and repair. Centralizing tests addresses only one part. Keep the
root commands and shared harness as the single way to set up and check work;
do not multiply manual runners.

Use the plan's current slice row and brief as a compact working context:
deliverable, owning contracts/files, affected IDs, module boundaries, blocker
and next action. Load those owners and relevant code sections; follow further
links only when the change affects them. Do not reload the complete plan,
toolchain, research history and global acceptance matrix on each step. After
compaction, recover the current row, `goalctl status`, checkout state and needed
owners instead of reconstructing the conversation.

For the active Goal, the manager coordinates worker processes under the
[delegation policy](#delegation-and-worker-lifecycle). Ordinary maintenance
tasks outside the Goal work locally in the main task. Keep noisy exploration
and intermediate logs with their owner; the manager reads a concise handoff and
relevant diffs rather than repeating that work. Independent review still checks
consequential claims and required consumers.

Batch independent searches and reads, request bounded output, and let root
commands orchestrate dependent setup/run/cleanup. Read summaries and failing logs
instead of replaying all output into the model. Poll only for actionable progress;
do not create extra status documents or request routine per-edit decisions.
Use generators for repeated model/schema/client/fixture work once their current
consumers are defined. Keep consequential reviews and meaningful diagnostics.

At checkpoints, use existing task statistics, `goalctl status` and harness
timings under [efficiency measurement](#efficiency-measurement). Record only
material bottlenecks and the next correction; do not build another telemetry
system or manually log every turn.

## Delegation and worker lifecycle

During a Goal, the manager dispatches separate worker processes through
`bun scripts/goal/goalctl.ts`, as the [Goal program](../goals/README.md#worker-processes)
describes, and chooses each task's engine, model and effort from the need and
the remaining usage ([charter](../goals/manager.md#resources)). Workers follow the
[worker protocol](../goals/worker.md). Outside a Goal, delegate only a complete,
bounded deliverable whose benefit justifies its startup, review and integration
cost.

- **Unit of work.** A brief delivers a complete outcome: for the backend phase,
  two to six cases following owner schema, verified write/read API template,
  then template-based bulk work. Small dependent repairs stay with the owning
  worker session instead of a new worker.
- **Exclusive claims and isolation.** Each brief claims case IDs, path globs,
  migration ranges and shared slots, and each writing worker has its own
  worktree. The manager alone rebases, fast-forwards `main`, runs wave QA and commits.
- **Concurrency.** Widen or narrow from merged, verified results and rework, not
  from occupied slots, within the [usage governor](../goals/README.md#capacity-and-usage).
- **Lifecycle.** A worker returns one handoff and exits. The manager waits on the
  process in the background, changes a worker's instructions only by stopping
  and resuming it, and starts a replacement only after the previous process exited.

A handoff is not verification. Merged source and recorded test evidence decide
status. Long-running commands own their logs and completion; do not assign an
agent merely to tail logs or recalculate estimates.

## Efficiency measurement

Judge the program by accepted behavior per elapsed hour and total token usage,
holding acceptance scope constant. Include the manager, every worker, handoffs,
integration and repairs. Separate cached input, uncached input and output where
the usage data allows it. Preserve the source and scope of each metric; missing
data is unknown. Do not turn raw token sums into unsupported quota claims.

Use existing statistics for response counts, context size/compactions, setup,
QA and repair time. Repeated retrieval, status polling, idle workers, growing
merge queues and repeated scope conflicts are reasons to narrow assignments or
fix ownership boundaries. A worker's generated code or occupied slot is not
accepted progress.

The paused 2026-09-26 Codex program is the baseline: about 2.5 candidate cases
per hour with at most two workers and one shared QA stack. The 2026-09-25
paused-Goal audit reconciled 22,845,252 uncached-input-plus-output tokens across
the main task and 61 children, with extensive coordination and model-driven
monitoring. These are retrospective observations, not measured savings of the
current program.

## Batch cadence

The maintainer's 2026-09-26 direction supersedes full-suite-per-batch verification.
Ordinary work restores prepared fixtures within 600 seconds and checks affected
backend behavior. Fresh construction and comprehensive backend verification belong
to final acceptance.

1. **Worker implementation.** A worker writes code and tests together for its
   claimed cases, then runs only its claimed test files through
   `goalctl test` and the relevant typecheck/lint once the bundle is coherent.
   `goalctl test --affected --list` shows which other tests the change reaches;
   name them in the handoff rather than running them. Do not test after each
   file or function. Registered integration, model, fault/recovery and load
   files start their own disposable QA project.
2. **Integration wave, every 30–45 minutes.** The manager merges ready tasks,
   regenerates derived artifacts once, runs `task check:backend` once and one
   `goalctl test --affected <wave base>` run, which selects every test the merged
   changes reach. It does not run unrelated browser, full recovery, corpus or
   capacity tiers. Keep the tested source stable during the run.
3. **Repair.** Failures form one repair queue returned to the responsible worker
   sessions and fixed together before dependent work starts. Independent work on
   disjoint claims continues. `task qa -- --only-failed <run-id>` diagnoses recorded
   failures; also rerun affected tests when a shared contract changed. Do not
   rerun an unchanged passing snapshot.

Dependent briefs dispatch only after their dependency has merged and passed its
wave. Do not stack branches on an unqualified base. More workers, branches or
commits are not evidence of faster delivery.

If setup dominates a run, diagnose its smallest reproducible case and fix
fixture reuse, batching or the underlying access path. Do not increase a timeout
to turn multi-hour preparation into routine qualification. A longer capacity or
recovery experiment needs a named objective, pinned source, isolated worktree and
separate budget; it must not hold `main` unchanged for hours.

Record each slice's scope, acceptance IDs and module boundaries in its brief and
plan row. Measure throughput as accepted capability/IDs per elapsed hour and
total tokens; line count is not a delivery quota. A source file over about 800
lines needs a reason in the slice row.

Phase 0 supplies the root commands, harness and owner dependencies for product
slices. Gate each slice on the foundations it actually uses, rather than waiting
for every P0 acceptance case. Track unfinished foundation cases alongside their
consumers and retain them in the final gate. Research during a slice is limited
to a failing toolchain gate or a contract question that blocks it; record either
in the handoff.

For documentation tasks, implementation means authoring and reconciling the design,
and verification runs `task docs:check` and a source/diff review once after the
coherent edit. A subsequent fix warrants only its relevant recheck. Documentation
checks never certify runtime behavior.

At handoff or interruption, record a concrete next action in the plan row so a
resumed manager can inspect the current state and continue.

## Verification boundaries

The backend Goal excludes frontend and browser acceptance. The current unscoped
`task qa` still runs those tiers; use the explicit backend selection and recorder
described in the [harness](../testing/test-harness.md#backend-only-goal-scope).
Use documented selected tiers/paths for ordinary backend work.
UI consumes APIs; API behavior and qualification must not require a web build.
Documentation tasks do not start application servers. Every new/changed operation
includes its [cost contract and complexity checks](../testing/complexity.md).
Use small multi-scale and adversarial fixtures for routine growth verification;
fixed dataset size and latency alone cannot qualify complexity. Reuse verified
background data under the [preparation policy](../storage/workload-budgets.md#data-preparation-and-import).
Test the operation itself through its real owner boundary.

Keep complexity, bounded latency/contention and physical capacity qualification
separate. A selected host profile can require a larger experiment, but is not a
mandatory command-seeding precondition for unrelated backend batches. Passing
small tests does not qualify deployment of the current 500 million entities.

## Progress commits and completion

The maintainer selects implementation in the existing checkout on `main` and
authorizes autonomous local commits. Goal workers commit on their own
`goal/<id>` branches in `.temp/worktrees/`; the manager rebases and
fast-forwards them into `main` one at a time through `goalctl merge` and removes
the worktree at `goalctl close`. Do not push or switch the main checkout's
branch. The maintainer may edit files in the main checkout at the same time:
stage explicit paths, never revert those edits, and state in the message when a
commit includes them.

Commit coherent merged waves. The central run's static result supplies
`task check:backend` evidence without running it again for the commit. Record the batch's
affected verification scope and repair queue; a selected pass does not qualify the
whole backend. Continue without waiting for another user instruction.

Inspect the exact staged diff and hooks, and exclude unrelated work. A checkpoint
commit made before `task qa` says so in its message and is not acceptance evidence.
For final acceptance, exercise fresh construction, checkpoint the source and
run the complete backend scope once with recording on that clean tree. The
backend selector/recorder is available; unscoped `task qa -- --record` still
includes frontend. The final run generates qualification without an
identical preliminary full run.
Commit the generated page separately. Its commit reference remains the tested
source commit; source changes invalidate that final qualification.
Do not claim completion from a passing structural checker alone when material
design contradictions remain.

The plan owns scope, batches and status. Contracts own meaning; the harness and
the [qualification page](qualification.md) own executed evidence; research owns
unresolved decisions. Do not write narrative evidence into the plan or commit
hand-written evidence files.
Research uncertain consequential choices using primary sources, preserve evidence
limits and define experiments that could falsify the implementation assumption.

## Instruction assessment

Apply user scope before skill defaults and keep guidance scoped to the task.
Assess behavior with a substantial design task and an ordinary maintenance task:
the former should reconcile owners and evidence; the latter must not activate
unrelated runtime work, global research or approval loops. Link/structure checks
alone do not establish those behavioral properties.

For this cadence, trace a cross-owner implementation through a claimed brief,
a pinned worker process, its handoff, a scoped merge and one manager-owned wave. Trace an ordinary maintenance edit through local execution
and only its relevant checks; trace a long command through completion without a
model polling loop. Continuation loads only the active slice; a blocking defect
uses minimal diagnosis and batched repair.

When evaluating savings, compare a representative ordinary task and a cross-owner
task on isolated equivalent starting snapshots, with the same acceptance gates.
Measure all participating agents, elapsed time and repairs using the accounting
above. Do not run that experiment as a side effect of a documentation edit.
These defaults remain an instruction walkthrough until observed; documentation
checks do not establish improved throughput or a percentage token saving. A
Claude Code `/goal` condition keeps the manager working but does not implement
this repository's harness or enforce its run budget.
