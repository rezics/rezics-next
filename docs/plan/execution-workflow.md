# Design and implementation execution workflow

## Program authority

The maintainer authorizes autonomous architecture research, complete documentation
reconciliation and coherent local commits for the active documentation task.
The [plan](README.md#active-execution) names its scope. Designing implementation
protocols does not activate runtime implementation, deployment or unrelated work.
Later implementation scopes explicitly select their owners and required consumers.

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

Use coherent commits with required consumers and links together. Inspect the exact
staged diff, exclude unrelated work and state deferred checks when committing during
implementation. Inspect hooks; disclose any command-scoped skip of paused checks.
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
