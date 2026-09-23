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

## Phases and transitions

| Phase | Work and exit |
| --- | --- |
| implementation | Complete the selected scope's design or runtime artifacts and required consumers; inspect sources and resolve material contracts. |
| test-authoring | Prepare relevant deterministic/behavioral checks and fixtures from contracts, including rejected and recovery cases. |
| verification | Run the owning checks and authorized observations; qualify only covered claims. |
| repair | Correct failures and related expectations without weakening contracts; return to verification. |

For documentation, implementation means authoring/reconciling the full design,
test-authoring means maintaining document integrity checks, and verification checks
links/roles/coverage and source/diff consistency. It never certifies runtime behavior.
Advance within the authorized scope without repeatedly asking permission.

Apply these phases to each bounded delivery slice. Complete its implementation,
author the required tests, verify and repair, then select the next unmet slice.
Do not postpone all testing until the complete product has been implemented.
At handoff or interruption, record a concrete next action and unresolved evidence
in the plan so a resumed task can inspect current state and continue.
Keep these updates concise; phases organize the work and do not require separate
user prompts. Use the goal's [delivery-efficiency policy](../../GOAL.md#delivery-efficiency)
to prioritize useful outcomes and limit repeated reading, research and checks.

## Verification timing and permitted operations

During implementation, defer test writing/execution, fixture work, test tuning,
manual/rendered QA and validation experiments, including typechecks, builds,
document checkers, schema replay, screenshots and benchmarks. Source inspection,
necessary research, editing, diff review, Git and production artifact generation
remain allowed. Do not bypass the pause through CI. Preserve generator safety
and target-protection preconditions.

Run checks during verification. Full-application rendered QA requires an explicit
task request; affected frontend integrity and scoped Storybook acceptance follow
their own authorized boundary. Documentation tasks do not start application servers.
Practical initial-host tests are separate from deferred large-volume qualification.

## Progress commits and completion

The maintainer selects direct implementation in the existing checkout on the
current branch (`main` at this handoff) and authorizes autonomous local commits.
Do not create or switch branches/worktrees unless the user changes that selection.
Commit each coherent verified batch with its required consumers and docs/tests;
continue to the next unmet slice without waiting for another user instruction.

Inspect the exact staged diff and hooks, and exclude unrelated work. If an
interruption requires an implementation checkpoint before verification, state the
deferred checks; that commit is not acceptance evidence. Disclose any command-scoped
skip of paused checks. Avoid commits for every edit and avoid holding all completed
work until the whole product is finished.
Do not claim completion from a passing structural checker alone when material
design contradictions remain.

The plan owns scope/phase/status. Contracts own meaning; tests own prospective
acceptance; research owns unresolved decisions. Do not create parallel progress
archives or place old implementation reports in the target design collection.
Research uncertain consequential choices using primary sources, preserve evidence
limits and define experiments that could falsify the implementation assumption.

## Instruction assessment

Apply user scope before skill defaults and keep guidance scoped to the task,
consistent with [official model guidance](https://developers.openai.com/api/docs/guides/latest-model).
Assess behavior with a substantial design task and an ordinary maintenance task:
the former should reconcile owners and evidence; the latter must not activate
unrelated runtime work, global research or approval loops. Link/structure checks
alone do not establish those behavioral properties.
