# Delivery

Start from the tracked Goal brief and current owner contracts. Size a task by its outcome, not by a line limit: a
large task is fine when it is clear. State what it delivers in user terms and design it on the best abstraction before
dispatch. A failure must not lose work: a retry resumes the same session with its commits and evidence and continues
from where it stopped, so the cost of failing is the remaining work, never a restart.

Execution units own the how; the resident manager owns the what. A brief states the outcome in user terms, owner links, what done means,
dependencies and estimated size; the worker designs and implements the change. Acceptance evidence follows the
source-integration policy below and the scheduled verification. Use the schema in
[Goal tooling](../../tools/goal/README.md); do not maintain another schema here.

For release acceptance, link each capability to its `docs/goals/<goal>.capabilities.md` evidence entry under
[verification](verification.md#capability-evidence). Every interface brief names the page stories it adds, including
states, viewers, viewports and their recorded API evidence. Missing cross-Goal scenarios and owned acceptance are
written when acceptance work is scheduled; they do not become source prerequisites under direct integration.

## Release progress

Report current release scope in two parts. Start with backend capabilities: for each unfinished outcome, give
the remaining API logic, the smallest decisive [native API check](verification.md#capability-evidence), and its
owner and evidence. Then report frontend integration and interaction: distinguish a missing API from a defect
in how the client consumes a working API, and name the shared repair where applicable. Run independent frontend
work in parallel against stable contracts. Report release qualification separately, with an estimate based on
the current critical path. Archived scope and historical task counts do not measure current completion.

## Direct source integration

When integration becomes the bottleneck, the manager assigns a resolver to repair conflicts and integrate
coherent source directly into its target branch. This applies to every task type, including product, urgent,
control-plane, stabilize, specification and verification work. Preserve the current target history, source identity
and both sides' required behavior. Keep independent implementation moving instead of waiting for a landing queue,
retry or proof workflow.

This standing policy applies whenever integration is the bottleneck. The objective is deployable code and correct
logic. Tests, typechecks, transpilation, architecture, schema and Kernel-import verification, and new test-coverage
requirements do not gate source integration. Do not
write or run them as integration prerequisites. Preserve existing tests and report acceptance as deferred; generate
an artifact needed by the implementation when necessary without turning its validation into an admission gate.
This policy takes precedence over source-stage checks and coverage requirements elsewhere in the workflow.

Prioritize follow-up repairs that restore the Storybook build or unblock continued tasks. Keep product contracts,
authorization and money invariants intact, including production validation at untrusted input boundaries. Their
implementation is required behavior, not a requirement to run a test suite before integrating source.

Direct integration does not transfer publication custody. The existing single publisher owns building and publishing
the exact integrated revision. Report integrated source, a built or published artifact, and actual functional
observations separately; none implies the others. Later acceptance and Goal closure retain their evidence owners.

## Source batches

During a maintainer-authorized code-only window, assign complete source outcomes and use the available
worker capacity for implementation. Do not spend that window writing or running tests, typing or browser matrices
unless the maintainer specifically requires them. Preserve existing tests for the asynchronous verifier, record
unverified behavior honestly, and repair reported failures in the owning module. This does not relax money movement
or authorization rules, nor turn source delivery into release acceptance.

Design for correctness before coding. State the invariant, who owns it, which state transitions preserve it, how partial
failure or retries behave, and what the cost does as data grows. Use the existing shared contract and keep the change
coherent. Tests provide evidence of behavior; they do not supply the missing design. In a code-only window,
write and review against those invariants and leave deferred verification visible.

Keep enough independent, ready source work for available workers. A brief names one coherent outcome,
the installed interfaces, the write boundary, and what the worker can complete if one seam is blocked.
Use the [sizing target](efficiency.md#output-and-flow) to avoid both fragments and oversized assignments.
The worker checkpoints its code as it goes. Follow [direct source integration](#direct-source-integration) when
integration is the bottleneck; record deferred acceptance without adding a final lint or typing prerequisite.

Around ten minutes after launch, use the existing task and worktree evidence to look for a coherent source
diff, a new commit or a concrete design decision that unlocks writing. Count new product code separately
from imported commits, generated output, tests and uncommitted changes. A blank observation is a prompt to
identify the first blocker, not a line quota or an automatic stop. Repair the brief or admission, continue
independent work, or park the blocked part with its exact next action. Use existing observations and events;
do not wake a manager or worker just to report the same state.

A worker can ask for one narrowly scoped Luna Max helper through the native Goal owner when an independent
question or slice will remove a demonstrated bottleneck. Give the helper only the necessary files and a
concrete deliverable. Use a read-only consultation for advice, or a native task with distinct write paths
for source work. Select the actual helper profile explicitly when required; the existing consultation
uses its configured profile. The original worker owns integration and keeps working on independent parts.
Do not start an unmanaged agent, duplicate a writer or bypass capacity or allowance.

## Brief preflight

The worker of product work on dev verifies every concrete premise of its brief against its base before it designs
the change: paths, counts, package ownership and where stories or fixtures actually live. It builds on what is there
and records a premise that did not hold in its summary. Managers preflight control-plane, stabilize-target and
verification briefs before dispatch or reshape. A claim that all stories share one Storybook must be checked rather
than assumed. Check:

- required exports, fixtures and dependencies exist on the recorded base;
- the acceptance agrees with current contracts;
- skill instructions distinguish reference reads from executable commands ([skill instructions](#skill-instructions));
- declared risk areas cover the paths;
- the target is recorded in parsed metadata;
- dependencies are real code dependencies;
- Use `after` with `afterSource` only for an indispensable unlanded implementation, and link its existing Goal
  contract;
- a requirement that refuses, rejects, stops or fails work carries its price line ([agent conduct](agent-conduct.md#briefs)).

Prepare the next briefs while workers write. A held outcome's brief names the outcome, first writable boundary, what is
missing, its owner and the observable release condition, and identifies which part actually needs that condition.
When an installed or adopted contract supports independent work, dispatch that coherent slice now and defer only the
dependent binding, activation or check. Shared files, review and test scheduling are not source dependencies. Make
and record reversible assumptions when justified; preserve authorization, money, data integrity and present
acceptance obligations. Do not represent a temporary adapter or mock as installed behavior.

Declared paths never hold a task. Overlapping tasks run side by side; use the controller's rebase process or
[direct source integration](#direct-source-integration) to resolve conflicts without losing required behavior. Shared
READMEs, fake data, messages, package manifests and routes are not dependencies merely because multiple tasks edit
them. See [integration mechanics](../../tools/goal/README.md#integration-promotion-culprit-isolation-and-attempt-fencing).

Prefer the oldest ready dependency. Do not restart a live attempt for an unchanged contract. Check actual task state
immediately before changing it.

A behaviour-changing brief identifies existing tests depending on the old behavior. Update them when acceptance
work is scheduled; under [direct source integration](#direct-source-integration), they are deferred rather than a
source prerequisite. When scheduled acceptance contradicts the contract, an owner document or delivered code,
change the smallest assertion that makes them agree, list the file and reason, and continue.

Declared paths guide scope. A minimal adjacent correction must respect risk ownership, include its affected checks
and notify its owner. Agree shared interfaces before consuming them; include consumers and fixtures in the change.

## Skill instructions

When a brief uses a skill, link its installed `SKILL.md` and name reference files as reads. Run only commands the
skill documents, resolving its launcher from the installed skill directory rather than assuming a bare command
exists on PATH. In Impeccable, `reference/craft-floor.md` is a document to read before UI edits, not a `craft-floor`
CLI verb. Use the documented launcher for `context` or `detect`, within the task's authorized scope.

If the launcher fails, follow the skill's documented fallback. Impeccable permits reading existing project context
and the applicable references directly and continuing the repair; a launcher failure alone does not require another
source attempt, installation, a PATH change or repetition of passed checks on unchanged inputs. Preserve the source
and valid evidence, and fix any actual product defect found during that review.

When an instruction caused the failure, correct its owning document and the affected active brief in the same
turn; a temporary decision or retry message alone does not repair future instructions. Keep archived attempts as
evidence and link subsequent briefs to the corrected owner. Verify the replacement wording against the installed
skill and state separately whether the document change has landed and reached existing workers.

## Checkout and landing discipline

Any change under `tools/goal/` is a control-plane task that lands on `main`, where the control plane runs. Put companion
changes outside `tools/goal/` in a separate task targeting `dev`; integrating a control-plane change only into `dev`
does not make it live. Follow the [control-plane landing mechanics](../../tools/goal/README.md#integration-promotion-culprit-isolation-and-attempt-fencing).

Each execution unit uses one shared worktree for its native Goal session, subagents and Grok CLI. Different units
use separate worktrees. Assign file ownership before concurrent writes and designate one integration writer for
staging and coherent commits. Keep identifiers in commit metadata, never code or documents. Preserve other writers'
unfinished changes; do not reset, stash, clean or rebase shared work. Keep the live checkout stable and address Git
operations explicitly to the assigned worktree.
The controller normally owns rebasing, integration and promotion. When integration is the bottleneck, use
[direct source integration](#direct-source-integration). Resolve conflicts without dropping the other side's required
changes; ref updates preserve the current head and publication keeps its existing owner.

The resident supermanager is the only manager. Workers may author Goals; the manager adopts the scope, acceptance
and allocation before a native execution unit consumes one. Units choose implementation order and may use native
subagents and Grok CLI without adding manager sessions or a management tier. Domain names retain product-contract
and module authority rather than identifying resident processes.

On dev, units resolve routine ambiguity reversibly from the Goal and owner documents. Record lasting decisions in
the owner and return actionable conflicts to the manager. Only the genuinely dependent operation waits for missing
authority. Preserve coherent source and propose independent repairs with their observed failure, write boundary and
smallest useful check; the manager owns allocation and cross-unit priorities.

Use [direct source integration](#direct-source-integration) when it applies; otherwise use the controller's retry
process. A landing failure or a tool blocker of product work on dev resumes the same worker
session with the error and needs no manager turn while the attempts make progress; the same failure twice, or two
attempts in a row without a new commit, stop the task and notify its manager
([integration mechanics](../../tools/goal/README.md#integration-promotion-culprit-isolation-and-attempt-fencing)).
Report specification conflicts with the conflicting outcomes and evidence. Do not create informal gate exceptions.

Release acceptance and Goal closure follow [verification](verification.md), with the scoped outcomes on main and
recorded evidence covering the promoted commit. They are separate from direct source integration.

The resident manager reads, acts on and acknowledges inbox events. Before idling, establish the supported wakeup path. Use the
engine's idle mechanism rather than repeated model turns.

A wrap-up instruction means checkpoint and pause promptly. Preserve work and write a continuation containing current
state, owner links, blockers and next actions. Resume only when authorized.

# Delivery ownership

The resident manager owns release scope, Goal allocation, cross-unit decisions, live runtime configuration, recovery,
progress reports and publication. It may use workers who author Goals to turn source gaps and unit proposals into complete
executable contracts. Keep enough reviewed independent work for usable capacity; do not require a per-domain backlog
quota or create work to satisfy a manager count. Register each executing unit's actual native Goal, pane and shared
worktree through the [Goal tooling](../../tools/goal/README.md).

Units implement their assigned outcome, coordinate their native helpers within that boundary and preserve useful
source across check failures. They return source revisions, reached native/browser observations and concrete owner
actions. They may propose valuable independent work, naming the outcome, first editable files and actual dependency;
proposals do not replace implementation or authorize another unit's files. The manager combines related proposals,
avoids duplicate ownership and allocates the next Goal. If first source stalls, inspect the prompt's first writable
function and remove irrelevant context, conflicting rules or stale check demands rather than repeating the attempt.

Product and module owners decide their interfaces. Units communicate directly when an owner can settle a routine
reversible choice; the resident resolves cross-unit conflicts, scope/resource trade-offs and faults needing live
control-plane authority. Keep independent work moving while only the dependent seam waits. Units do not maintain
manager continuations, domain-manager inboxes or recurring management turns.

The existing hourly Traditional Chinese progress report continues. Pair qualifying Web campaign additions against
the [throughput target](efficiency.md#output-and-flow) with overall product additions, accepted journeys, integrated
revisions, visible product results and the remaining completion forecast. Exclude tests, stories, fixtures,
recordings, generated files, JSON, evidence and documents from product-line counts. Report native unit/subagent starts
and actual writing separately from checks, admission/integration waits, stopped operations and allowance. Count
resumed usage once and avoid parent/child or managed/native duplication; mark missing attribution unknown.

The manager handles real delivery alarms and the existing requested scheduling checkpoint. Old domain-manager
counts, backlog quotas and coder floors do not establish useful capacity. When a cause is unclear, commission one
bounded measurement rather than a standing review loop. Lines are a diagnostic, never permission to pad code. A
[token-free watchdog](supermanager.md#resident-supervision) supervises the resident; every model wake has a counted cost.

The control plane exists to maximize useful, accepted work per time and allowance. Repair workflow defects in their
owner modules; check-host health retains its existing operational owner. Remove orchestration steps that add waiting
without improving delivery, preserving the single publisher and separate release qualification.

Runtime release, authenticated authority receiving, physical custody, workflow execution and delivered evidence are
distinct facts. Source integration and a successful compiler command do not certify native runtime release or consume
an operational allowance.
