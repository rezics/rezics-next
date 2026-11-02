# Delivery

Start from the tracked Goal brief and current owner contracts. Size a task by its outcome, not by a line limit: a
large task is fine when it is clear. State what it delivers in user terms and design it on the best abstraction before
dispatch. A failure must not lose work: a retry resumes the same session with its commits and evidence and continues
from where it stopped, so the cost of failing is the remaining work, never a restart.

Prepare user and API outcome acceptance before implementation. A brief states the outcome, owner links, boundaries,
dependencies, affected consumers, acceptance and estimated size. Use the schema in
[Goal tooling](../../tools/goal/README.md); do not maintain another schema here.

Link each capability to its `docs/goals/<goal>.capabilities.md` evidence entry under
[verification](verification.md#capability-evidence). Every interface brief names the page stories it adds, including
states, viewers, viewports and their recorded API evidence. Missing user scenarios are frozen red before implementation.

## Brief preflight

Before dispatch or reshape, verify every concrete premise against the recorded repository base: paths, counts,
package ownership and where stories or fixtures actually live. A claim that all stories share one Storybook must
be checked rather than assumed. Check:

- required exports, fixtures and dependencies exist on the recorded base;
- the acceptance agrees with current contracts;
- declared risk areas cover the paths;
- the target is recorded in parsed metadata;
- dependencies are real code dependencies;
- overlap is not encoded as a dependency; use `after:` only when code needs another task's API, schema or component.

Declared paths never hold a task. Overlapping tasks run side by side; the controller's rebase process resolves
conflicts with agent assistance. Shared READMEs, fake data, messages, `package.json` and routes are not dependencies
merely because multiple tasks edit them. See [integration mechanics](../../tools/goal/README.md#integration-promotion-culprit-isolation-and-attempt-fencing).

Prefer the oldest ready dependency. Do not restart a live attempt for an unchanged contract. Check actual task state
immediately before changing it.

A behaviour-changing brief owns every existing test depending on the old behaviour. Frozen acceptance is changed by
its contract owner, never weakened by the implementation worker.

Declared paths guide scope. A minimal adjacent correction must respect risk ownership, include its affected checks
and notify its owner. Agree shared interfaces before consuming them; include consumers and fixtures in the change.

## Checkout and landing discipline

Any change under `tools/goal/` is a control-plane task that lands on `main`, where the control plane runs. Put companion
changes outside `tools/goal/` in a separate task targeting `dev`; integrating a control-plane change only into `dev`
does not make it live. Follow the [control-plane landing mechanics](../../tools/goal/README.md#integration-promotion-culprit-isolation-and-attempt-fencing).

In an explicitly assigned shared module workspace, commit your own paths often using `<task name>: <message>` and a
`Goal-Task: <id>` trailer. Keep identifiers in commit metadata, never code or documents. Never reset, checkout, stash,
clean or rebase that shared workspace. This mode does not authorize workers to move other workers' changes.

Use assigned worktrees. Keep the live checkout stable. Address Git operations explicitly to their worktree.
The controller owns rebasing, integration and promotion. Resolve conflicts without dropping the other side's required
changes; ref updates preserve the current head.

Managers are resident roles, like staff in a company: the maintainer is often unreachable and the supermanager can
be too. Never wait for either. When a decision would go to the supermanager and it does not answer, the managers
concerned settle it among themselves (the producer decides its interface; for a shared choice the owner of the
outcome decides after one exchange), record the decision and its reasons in the owner document or continuation, and
proceed. If a choice truly cannot be made without the supermanager or the maintainer, park that item and keep working
on everything else; the supermanager reviews recorded decisions when it returns.

Use the controller's retry and consultation process. Report specification conflicts with the conflicting outcomes
and evidence. Do not create informal gate exceptions.

Verify through [verification](verification.md). Completion requires the scoped outcomes on main and recorded checks
covering the promoted commit.

Managers read, act on and acknowledge inbox events. Before idling, establish the supported wakeup path. Use the
engine's idle mechanism rather than repeated model turns.

A wrap-up instruction means checkpoint and pause promptly. Preserve work and write a continuation containing current
state, owner links, blockers and next actions. Resume only when authorized.

# Delivery ownership

The [Goal delivery journey](../../tools/goal/README.md#roles-and-delegation) assigns implementation to producers and
outcomes to resident managers. Producers choose interfaces; outcome owners decide shared choices after one exchange
with concerned managers. Record the reason and proceed when the supermanager or maintainer is unreachable. Park only
work that genuinely depends on an unavailable decision.

Performance owns efficiency. Every 30 minutes it measures useful landings per Goal over 30 minutes and two hours,
worker width against four per Goal, held and idle work, check wait on both check hosts, host memory, repeated
failures, dispatch-to-integration latency, manager token share and allowance per useful landing, then acts on the largest waste in that
same round. It may dispatch or retry for a Goal whose manager has not acted within 30 minutes. Control-plane owns
delivery-tool defects; Performance owns check-host health. Managers keep complete ready briefs available for free width.

Performance keeps an optimisation plan with measured waste, change, owner, metric, expected effect, status and measured
result, with at least two experiments running. Its private round log records time, numbers and action in three lines.
Hourly reports to the project's Telegram group use Traditional Chinese and lead with new product code landed in the
last full clock hour under apps, services and packages, excluding tests, stories, fixtures, recordings, generated files, JSON, evidence
and documents, against the steady 20,000-line target and 40,000-line aim, with quality signals alongside. Useful
landings, short-window trends, width, manager allowance share and allowance per landing provide supporting evidence.
Internal tooling counts when it unblocks product outcomes. Follow up on the previous round's intervention.

No product landing in the last 30 minutes, or fewer than ten running tasks, requires action immediately: use the
first-scope backlog and review classes to fill available width, wake idle managers and dispatch/retry where the owning
manager has not acted within 30 minutes. Apply the standing default policy exception after agreement between owners.
For a reversible owner-recommended choice awaiting only the supermanager for 30 minutes, take the choice, record it
and notify afterwards. Announce a stall and the action immediately in the reporting channel; do not wait for the hour.
Measurement without action is a failed review.

Performance also [supervises and recovers the resident supermanager](supermanager.md). Runtime release, authenticated
authority receiving, physical custody, workflow execution and delivered evidence are distinct facts. Source integration
and a successful compiler command do not certify native runtime release or consume an operational allowance.
