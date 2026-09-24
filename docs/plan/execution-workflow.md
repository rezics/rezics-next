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

## Context and agent coordination

Efficiency covers the entire delivery time: model interactions/context, tools,
verification and repair. Centralizing tests addresses only one part. First make
P0.1's root commands and P0.4's minimal harness run an existing real integration
path; expand the harness alongside Phase 0 rather than multiplying manual runners.

Use the plan's current batch row as a compact working brief: deliverable, owning
contracts/files, affected IDs, module boundaries, blocker and next action. Load
those owners and relevant code sections; follow further links only when the
change affects them. Do not reload the complete plan, toolchain, research history
and global acceptance matrix on each step. After compaction, recover the current
row, checkout state and needed owners instead of reconstructing the conversation.
This scoped loading follows
[OpenAI's instruction guidance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra);
its model-specific observations do not establish a measured GPT-6 Sol speedup here.

Delegate independent complete modules with explicit interfaces, owned paths,
acceptance IDs and completion conditions. Prefer fresh, self-contained agent
context over inheriting the entire research conversation; include the applicable
repository instructions and selected decisions. Avoid one agent per small edit
or overlapping ownership. Agents work through implementation and test authoring
before handing back a concise change/blocker summary; the coordinator integrates.

Batch independent searches and reads, request bounded output, and let root
commands orchestrate dependent setup/run/cleanup. Read summaries and failing logs
instead of replaying all output into the model. Poll only for actionable progress;
do not create extra status documents or request routine per-edit decisions.
Use generators for repeated model/schema/client/fixture work once their current
consumers are defined. Keep consequential reviews and meaningful diagnostics.

At batch boundaries, use existing task statistics (when available) and harness
timings to compare elapsed delivery time, model turns/context/compactions, setup,
QA and repair. Record only material bottlenecks and the next correction in the
batch row; do not build another telemetry system or manually log every turn.
Changing test frequency alone is insufficient when model interaction dominates.

## Batch cadence

Runtime work proceeds in batches. Each batch has two parts:

1. **Implementation, about 60 minutes.** Write code and its tests together, then
   collect changes into a coherent dependency slice. Do not execute tests after
   each file, function or agent handoff. The time box guides batch size; do not
   wait to fill it or defer a blocking diagnosis to its end. An early targeted
   `yarn test` or standalone `yarn check` is justified only when its result resolves
   a concrete uncertainty blocking the next implementation step. Use the smallest
   useful check and note the blocker in the existing batch row.
2. **Qualification, at most 30 minutes.** The coordinator runs `yarn qa` once on
   the merged batch; its static tier includes `yarn check`, so no routine separate
   preflight is needed. Keep that source snapshot unchanged during the run.
   Failures form one repair queue, addressed together before dependent work.
   Independent implementation may continue in other worktrees.

For repairs, `yarn qa --only-failed <run-id>` diagnoses the recorded failures;
also run affected tests when a shared contract or implementation changed. Gather
repairs before these checks rather than rerunning after every fix. A targeted
pass is not a full pass of the changed tree. Run full QA again at the next merged
batch boundary after repairs, or as final qualification; do not repeatedly run
the full suite during diagnosis or rerun an unchanged passing snapshot. Preserve
every retained acceptance requirement.

The coordinator starts a batch by writing its row in the
[execution program](README.md#execution-program): scope, acceptance IDs and module
boundaries. It then assigns disjoint modules to parallel agents. Each agent works
in its own Git worktree under `.temp/worktrees/` on a local branch, and the
coordinator merges the branches into `main` for centralized verification.
Subagents hand over code, tests, affected IDs and any diagnostic result. Only the
coordinator starts batch QA; agents do not each qualify the whole product or
start duplicate integration stacks. Test files and tiers can run in parallel
inside the harness where isolation permits.

Measure throughput as accepted capability/IDs per elapsed hour across all of the
costs above; line count is not a delivery quota. A source file over about 800
lines needs a reason in the batch row.

Phase 0 in the plan precedes the first product batch. Until P0.4 supplies `yarn qa`,
the coordinator groups the available `yarn check` and affected targeted tests into
one batch-boundary verification pass, with shared setup where available. Record
the missing harness as pending, not as a pass or a reason to repeat manual drills.
Research during a batch is limited to a failing toolchain gate or a contract
question that blocks the batch; record either in the same batch row.

For documentation tasks, implementation means authoring and reconciling the design,
and verification runs `yarn docs:check` and a source/diff review once after the
coherent edit. A subsequent fix warrants only its relevant recheck. Documentation
checks never certify runtime behavior.
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

Commit coherent merged batches. The central run's static result supplies
`yarn check` evidence without running it again for the commit. The batch's full
`yarn qa` result decides whether its row reads *qualified* or lists the repair
queue. Continue to the next batch without waiting for another user instruction.

Inspect the exact staged diff and hooks, and exclude unrelated work. A checkpoint
commit made before `yarn qa` says so in its message and is not acceptance evidence.
For the final batch, checkpoint the source first and use `yarn qa --record` as
that batch's one full run on the clean source tree. It runs all tiers and generates
the qualification page in the same invocation; no preceding `yarn qa` is needed.
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

Apply user scope before skill defaults and keep guidance scoped to the task,
consistent with [official model guidance](https://developers.openai.com/api/docs/guides/latest-model).
Assess behavior with a substantial design task and an ordinary maintenance task:
the former should reconcile owners and evidence; the latter must not activate
unrelated runtime work, global research or approval loops. Link/structure checks
alone do not establish those behavioral properties.

For this cadence, trace a multi-module batch through scoped agent briefs and one
coordinator-owned run, continuation through only the active slice, a blocking
defect through minimal diagnosis and batched repair, and an ordinary documentation
edit through only documentation checks. This is an instruction
walkthrough until observed in execution, not measured agent throughput. The
[official Goals guidance](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
allows an explicit iteration policy; the Goal itself does not implement this
repository's harness or enforce its run budget.
