# Delivery

Start from the tracked Goal and current owner contracts. A brief uses the [Goal tooling
schema](../../tools/goal/README.md#briefs-and-routing) and states the user outcome, dependencies, write scope and
acceptance owner. The resident owns scope and allocation. Execution units own implementation. Resume failed work
from its existing source and evidence.

## Release progress

Report outstanding backend and frontend outcomes with their owners and smallest decisive checks. Distinguish a
missing API from a defect in its consumer. Report the pinned candidate and its [release time
remaining](release.md#candidate-and-time-budget) separately from source progress on `dev`.

## Direct source integration

Each execution unit manually integrates coherent committed increments as soon as they are ready. Preserve target
history, source identity and both sides' required behavior. Resolve conflicts in the owner module. An unresolved
merge stops only dependent ref publication. Product, urgent, stabilize, specification and verification-source work
can continue on `dev` while a release is qualified or repaired. Target-specific control-plane publication follows
[checkout discipline](#checkout-and-landing-discipline).

Source admission has no premerge verification. Schedule tests, typechecks, transpilation, generators, architecture,
schema and Kernel-import checks after integration. Preserve existing tests and report deferred acceptance. Implement
product contracts, authorization, money invariants and production input validation. A unit may use a focused local
probe to write or debug a change. Prioritize repairs that restore Storybook or unblock source work.

The [dev verifier](verification.md#continuous-development-checks) picks up affected checks after integration.
Red checks get owner repairs while unrelated landings continue. The publisher qualifies and advances the pinned
release independently. Behind platform grants, choose evidence by impact on shared behavior and granted users.
[Public exposure](../scope.md) follows its own scope rules.

## Implementation and acceptance

Before allocating an increment, name its observable source outcome, acceptance owner and required checks. Prepare
acceptance alongside implementation so integration can trigger it. Record feature and interface requirements in the
[capability evidence](verification.md#capability-evidence). A source assignment ends after integration and a handoff
of outstanding evidence to its owner. A worker waiting on a remote check takes ready independent work or returns the
slot. A Goal stays open until its adopted outcomes meet [release qualification](release.md).

Verification reports reached assertions, unavailable evidence and the first actionable failure on an identified
revision. Route product, fixture and runner defects to their owners. Preserve usable source and evidence on either
side of a failure. The resident resolves genuine cross-owner decisions.

## Source batches

Size work around a complete source increment that can be integrated independently. Scope tests and acceptance to
the changed behavior under [phase ownership](#implementation-and-acceptance).

Design before coding: state the invariant, owner, transitions, partial failure and retry behavior, and growth cost.
Use the shared contract; tests provide evidence rather than supplying missing design.

Keep enough independent, ready source work for available workers. A brief names one coherent outcome,
the installed interfaces, the write boundary, and what the worker can complete if one seam is blocked.
Use the [sizing target](efficiency.md#output-and-flow) to avoid both fragments and oversized assignments.
The worker checkpoints and follows [direct source integration](#direct-source-integration).

Around ten minutes after launch, use the existing task and worktree evidence to look for a coherent source
diff, a new commit or a concrete design decision that unlocks writing. Count new product code separately
from imported commits, generated output, tests and uncommitted changes. A blank observation is a prompt to
identify the first blocker, not a line quota or an automatic stop. Repair the brief or admission, continue
independent work, or park the blocked part with its exact next action. Use existing observations and events;
do not wake a manager or worker just to report the same state.

A worker can ask for one narrowly scoped helper through the native Goal owner when an independent
question or slice will remove a demonstrated bottleneck. Give the helper only the necessary files and a
concrete deliverable. Use a read-only consultation for advice, or a native task with distinct write paths
for source work. Select the actual helper profile explicitly when required; the existing consultation
uses its configured profile. The original worker owns integration and keeps working on independent parts.
Do not start an unmanaged agent, duplicate a writer or bypass capacity or allowance.

## Brief preflight

The worker of product work on dev verifies every concrete premise of its brief against its base before it designs
the change: paths, counts, package ownership and where stories or fixtures actually live. It builds on what is there
and records a premise that did not hold in its summary. The manager preflights control-plane, stabilize-target and
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

A behavior-changing brief identifies existing assertions that depend on the old contract. Update them in the
assigned acceptance. Repair a contradictory check at its smallest boundary and report the evidence and reason.

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
[Direct source integration](#direct-source-integration) owns source merging. The controller retains promotion;
publication keeps its existing owner. Ref updates preserve the current head and peers' required changes.

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

Release acceptance and Goal closure follow [release qualification](release.md).

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

Use the existing hourly Traditional Chinese report for [development, repair and release metrics](efficiency.md).
Repair workflow defects in their owner modules and use the [resident watchdog](supermanager.md#resident-supervision)
for supervision.

Runtime release, authenticated authority receiving, physical custody, workflow execution and delivered evidence are
distinct facts. Source integration and a successful compiler command do not certify native runtime release or consume
an operational allowance.
