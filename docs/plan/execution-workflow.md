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
request. The 2026-09-26 scope is backend/API only; frontend and rendered QA are
excluded, and UI consumes independently callable APIs.
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

Default to working in the main task. A coordinator is the task responsible for
integration and QA, not a requirement to create workers. Use the
[delegation policy](#delegation-and-worker-lifecycle) when independent work merits
a worker. Keep noisy exploration and intermediate logs with their owner; the main
task reads a concise handoff and relevant diffs rather than repeating that work.
Independent review still checks consequential claims and required consumers.

Batch independent searches and reads, request bounded output, and let root
commands orchestrate dependent setup/run/cleanup. Read summaries and failing logs
instead of replaying all output into the model. Poll only for actionable progress;
do not create extra status documents or request routine per-edit decisions.
Use generators for repeated model/schema/client/fixture work once their current
consumers are defined. Keep consequential reviews and meaningful diagnostics.

At batch boundaries, use existing task statistics and harness timings under
[efficiency measurement](#efficiency-measurement). Record only material bottlenecks
and the next correction in the batch row; do not build another telemetry system
or manually log every turn. Changing test frequency alone is insufficient when
model interaction dominates.

## Delegation and worker lifecycle

Delegate only a complete, bounded deliverable with stable inputs/interfaces and
an independent ownership boundary. Its expected elapsed-time or quality benefit
must justify startup context, communication, review and integration. Briefly
state the split and benefit in the existing batch row. Ordinary edits, small
repairs and serial dependent steps stay local; do not split one tightly coupled
change merely because multiple agents are available.

Start with at most two active workers across the current batch and the permitted
independent next slice. This is a ceiling, not a utilization target. Expand only
when comparable completed work demonstrates a throughput/quality benefit at an
acceptable total token cost; record that reason in the batch row. Workers do not
recursively delegate by default. The coordinator owns assignments and integrates
one qualified dependency slice at a time.

Use `fork_turns: "none"` by default when the runtime exposes that control. Give
the worker the base commit, owned paths, interfaces, applicable instructions,
selected decisions, acceptance IDs/tests and completion conditions. Inherit
bounded history only for a named dependency that the brief cannot adequately
carry; never omit the setting just to inherit everything. A fresh context still
has instruction/tool overhead, so it does not make tiny delegations economical.

Retain GPT-6 Sol. Where per-task controls permit, use medium reasoning for routine
bounded implementation, retrieval and repairs; select xhigh for difficult
algorithmic, authority, concurrency or recovery reasoning. Honor an explicit
user-selected effort and do not silently change the parent or global settings.
If effort cannot be selected, keep the active setting and reduce needless calls;
do not create a replacement task solely to change it. These are working defaults,
not measured claims of equal quality at lower effort.

A worker returns a compact handoff: result/commit, affected paths and IDs,
diagnostics actually run, unresolved blockers and the next required action. It
then finishes. It may be reactivated for a concrete follow-up; it must not keep
calling sleep, status or messaging tools while waiting for hypothetical work.
No repeated progress messages when there is no new decision, blocker or result.

Long-running commands own their logs, progress and completion result. Use the
available process-completion/wait mechanism within runtime limits, with useful
independent work where available. Do not assign an agent merely to tail logs,
recalculate completion estimates or poll an unchanged process. Inspect progress
when a deadline, failure signal or result requires a decision. Keep any necessary
polling bounded and back off; do not loop just to keep an agent active.

Parallel code writers use isolated worktrees with disjoint ownership. Read-only
workers need no extra checkout unless their task requires a pinned snapshot.
Only the coordinator runs merged QA. Workers author the required tests and may
run only the blocking diagnostics allowed by the batch cadence.

## Efficiency measurement

Judge delegation by accepted behavior per elapsed hour and total task token
usage, holding acceptance scope constant. Include the main task, every worker,
handoffs, integration and repairs. Report cached input, uncached input and output
separately; reasoning is a subset of output where the usage schema defines it
that way. Do not sum cumulative counters repeatedly or count inherited usage
twice. Preserve the source and scope of each metric; missing data is unknown.
Goal counters, raw response records, benchmark output counts and account quotas
may use different accounting. Reconcile them before comparing, and do not turn
a raw token sum into an unsupported monetary or quota claim.

Use existing statistics for response counts, context size/compactions, setup,
QA and repair time. Repeated retrieval, status polling, long-lived idle workers
and growing integration queues are reasons to narrow the next assignment or
work locally. A worker's generated code or occupied slot is not accepted progress.

The 2026-09-25 paused-Goal audit motivates these defaults: its panel reconciled to
22,845,252 uncached-input-plus-output tokens across the main task and 61 children;
the main task accounted for 32.7%. It also recorded extensive coordination and
model-driven monitoring. This is retrospective workflow evidence, not proof
that all child usage was waste or a measured saving from the new policy.
[OpenAI's subagent guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents)
describes the additional token and parallel-write coordination costs.
[Artificial Analysis's GPT-6 Sol metrics](https://artificialanalysis.ai/models/gpt-6-sol-xhigh)
describe output tokens and cost per defined benchmark task; those are not directly
comparable to a long multi-agent Goal's cumulative input/output usage.

## Batch cadence

The maintainer's 2026-09-26 direction supersedes full-suite-per-batch verification.
Ordinary work restores prepared fixtures within 600 seconds and checks affected
backend behavior. Fresh construction and comprehensive backend verification belong
to final acceptance. Runtime work proceeds in batches:

1. **Implementation, about 60 minutes.** Write code and its tests together, then
   collect changes into a coherent dependency slice. Do not execute tests after
   each file, function or agent handoff. The time box guides batch size; do not
   wait to fill it or defer a blocking diagnosis to its end. Use documented
   `yarn test` paths or selected QA tiers for affected behavior and relevant static
   checks. Do not invent backend/affected flags before the harness supports them.
2. **Affected verification.** The coordinator runs one coherent selection of
   affected backend tests and static checks. Do not run unrelated browser, full
   recovery, corpus or capacity tiers. If static QA already includes
   `yarn check:backend`, do not repeat it. Keep the tested source stable.
   Failures form one repair queue, addressed together before dependent work.
   At most one genuinely independent next slice may continue in other worktrees;
   it must not depend on unqualified changes in this batch.

Keep one active integration batch. When its QA fails, repair and close that queue
before starting dependent batches; do not accumulate a chain of B4/B5/B6-style
branches above an unqualified base. Delegate disjoint modules only under the
policy above; parallelize isolated data preparation where useful. Record existing
parked branches and reuse their work in dependency order after the base is repaired.
More active branches, agents or commits are not evidence of faster delivery.

The implementation time box is a sizing guide, not a quota to fill. The existing
30-minute full-suite ceiling belongs to final qualification, not every batch.
If setup dominates the run, diagnose its smallest reproducible case and fix
fixture reuse, batching or the underlying access path. Do not increase a timeout
to turn multi-hour preparation into routine qualification. A longer capacity or
recovery experiment needs a named objective, pinned source, isolated checkout and
separate budget; it must not hold `main` unchanged for hours.

For repairs, `yarn qa --only-failed <run-id>` diagnoses the recorded failures;
also run affected tests when a shared contract or implementation changed. Gather
repairs before these checks rather than rerunning after every fix. A targeted
pass is not a full pass of the changed tree. Run affected repair checks; reserve
full backend QA for final qualification or a concrete cross-cutting regression.
Do not rerun an unchanged passing snapshot. Preserve every retained backend
acceptance requirement.

The coordinator starts a batch by writing its row in the
[execution program](README.md#execution-program): scope, acceptance IDs and module
boundaries. It implements locally or delegates justified independent modules.
Delegated code writers use Git worktrees under `.temp/worktrees/` on local
branches; the coordinator merges them into `main` for centralized verification.
Subagents hand over code, tests, affected IDs and any diagnostic result. Only the
coordinator starts batch QA; agents do not each qualify the whole product or
start duplicate integration stacks. Test files and tiers can run in parallel
inside the harness where isolation permits.

Measure throughput as accepted capability/IDs per elapsed hour across all of the
costs above and total task tokens; line count is not a delivery quota. A source
file over about 800 lines needs a reason in the batch row.

Phase 0 supplies the root commands, harness and owner dependencies for product
slices. Gate each slice on the foundations it actually uses, rather than waiting
for every P0 acceptance case. Track unfinished foundation cases alongside their
consumers and retain them in the final gate. Extend the shared harness as coverage
grows; do not create repeated manual drills as a parallel qualification system.
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

The backend Goal excludes frontend and browser acceptance. The current unscoped
`yarn qa` still runs those tiers; use the explicit backend selection and recorder
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
authorizes autonomous local commits. When delegated, code writers use local
branches in worktrees under `.temp/worktrees/`; the coordinator merges them into `main` and
removes the worktrees after the merge. Do not push or switch the main checkout's
branch.

Commit coherent merged batches. The central run's static result supplies
`yarn check:backend` evidence without running it again for the commit. Record the batch's
affected verification scope and repair queue; a selected pass does not qualify the
whole backend. Continue without waiting for another user instruction.

Inspect the exact staged diff and hooks, and exclude unrelated work. A checkpoint
commit made before `yarn qa` says so in its message and is not acceptance evidence.
For final acceptance, exercise fresh construction, checkpoint the source and
run the complete backend scope once with recording on that clean tree. The
backend selector/recorder is available; unscoped `yarn qa --record` still
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

Apply user scope before skill defaults and keep guidance scoped to the task,
consistent with [official model guidance](https://developers.openai.com/api/docs/guides/latest-model).
Assess behavior with a substantial design task and an ordinary maintenance task:
the former should reconcile owners and evidence; the latter must not activate
unrelated runtime work, global research or approval loops. Link/structure checks
alone do not establish those behavioral properties.

For this cadence, trace a cross-owner implementation through an explicit local
versus delegated choice, bounded fresh briefs, completed worker handoffs and one
coordinator-owned run. Trace an ordinary maintenance edit through local execution
and only its relevant checks; trace a long command through completion without a
model polling loop. Continuation loads only the active slice; a blocking defect
uses minimal diagnosis and batched repair.

When evaluating savings, compare a representative ordinary task and a cross-owner
task on isolated equivalent starting snapshots, with the same acceptance gates.
Measure all participating agents, elapsed time and repairs using the accounting
above. Do not run that experiment as a side effect of a documentation edit.
These defaults remain an instruction walkthrough until observed; documentation
checks do not establish improved throughput or a percentage token saving. The
[official Goals guidance](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
allows an explicit iteration policy; the Goal itself does not implement this
repository's harness or enforce its run budget.
