# Design and implementation execution workflow

## Program authority

The maintainer authorizes autonomous architecture research, complete documentation
reconciliation and coherent local commits for the active documentation task.
The [plan](README.md#active-execution) names its scope. Designing implementation
protocols does not activate runtime implementation, deployment or unrelated work.
Later implementation scopes explicitly select their owners and required consumers.

The root [goal specification](../../GOAL.md) supplies the retained implementation
outcome and completion criteria. Its presence does not activate execution. When
the user asks to establish that Goal, update the plan's active scope to match the
request, including the goal's explicitly requested local full-application QA.
Keep scope, current slice, remaining work, blockers and evidence in the plan;
the goal file remains the completion contract, not a second status ledger.

There is no old-system compatibility requirement for schemas, APIs, SDKs, IDs,
URLs, data formats or deployment layouts. New-system integrity, live-source
conversion, installation and recovery remain acceptance requirements. Respect
released artifact immutability and preserve unrelated user work.

## Batch cadence

Runtime work proceeds in batches. Each batch has two parts:

1. **Implementation, about 60 minutes.** Code and its tests are written together.
   Tests are code in the [executable harness](../testing/test-harness.md), so writing
   them is part of implementing a behavior, not a separate phase. Only `yarn check`
   and targeted `yarn test` runs of the code being written are allowed during this
   part.
2. **Qualification, at most 30 minutes.** One `yarn qa` run covers the merged batch.
   Failures go into the next batch's repair queue; rerun only the failed tests with
   `yarn qa --only-failed`, not the whole suite.

The coordinator starts a batch by writing its row in the
[execution program](README.md#execution-program): scope, acceptance IDs and module
boundaries. It then assigns disjoint modules to parallel agents. Each agent works
in its own Git worktree under `.temp/worktrees/` on a local branch, and the
coordinator merges the branches into `main` after `yarn check` passes on the merge.

The throughput target is about 50,000 changed lines of working code per
implementation hour. That comes from generators and parallel agents together; it
is not a single-agent rate. Measure it together with the acceptance IDs that turn
green in the batch. A line count never justifies duplicated, unconsumed or
speculative code. A source file over about 800 lines needs a reason in the batch
row.

Phase 0 in the plan precedes the first product batch. Research during a batch is
limited to a failing toolchain gate or a contract question that blocks the batch;
record either in the same batch row.

For documentation tasks, implementation means authoring and reconciling the design,
and verification runs the documentation checks for links, roles, coverage and
source/diff consistency. Documentation checks never certify runtime behavior.
Advance within the authorized scope without repeatedly asking permission.

At handoff or interruption, record a concrete next action in the batch row so a
resumed task can inspect the current state and continue.

## Verification boundaries

`yarn qa` includes the full-application end-to-end tier once the web app exists,
because the Goal requests local full-application browser verification. Outside
an activated Goal, rendered QA still requires an explicit task request.
Documentation tasks do not start application servers. Practical initial-host
tests are separate from deferred large-volume qualification.

## Progress commits and completion

The maintainer selects implementation in the existing checkout on `main` and
authorizes autonomous local commits. Parallel agents use local branches in
worktrees under `.temp/worktrees/`; the coordinator merges them into `main` and
removes the worktrees after the merge. Do not push or switch the main checkout's
branch.

Commit after each merged batch passes `yarn check`. The batch's `yarn qa` result
decides whether its row reads *qualified* or lists the repair queue. Continue to
the next batch without waiting for another user instruction.

Inspect the exact staged diff and hooks, and exclude unrelated work. A checkpoint
commit made before `yarn qa` says so in its message and is not acceptance evidence.
Do not claim completion from a passing structural checker alone when material
design contradictions remain.

The plan owns scope, batches and status. Contracts own meaning; the harness and
the [qualification page](qualification.md) own executed evidence; research owns
unresolved decisions. Do not write narrative evidence into the plan or commit
hand-written evidence files.
Research uncertain consequential choices using primary sources, preserve evidence
limits and define experiments that could falsify the implementation assumption.

## Instruction assessment

Apply user scope before skill defaults and keep guidance scoped to the task,
consistent with [official model guidance](https://developers.openai.com/api/docs/guides/latest-model).
Assess behavior with a substantial design task and an ordinary maintenance task:
the former should reconcile owners and evidence; the latter must not activate
unrelated runtime work, global research or approval loops. Link/structure checks
alone do not establish those behavioral properties.
