# Delivery

Start from the tracked Goal brief and current owner contracts. Estimate a large outcome before dispatch and identify
a smaller viable slice without silently reducing scope.

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

Use the controller's retry and consultation process. Report specification conflicts with the conflicting outcomes
and evidence. Do not create informal gate exceptions.

Verify through [verification](verification.md). Completion requires the scoped outcomes on main and recorded checks
covering the promoted commit.

Managers read, act on and acknowledge inbox events. Before idling, establish the supported wakeup path. Use the
engine's idle mechanism rather than repeated model turns.

A wrap-up instruction means checkpoint and pause promptly. Preserve work and write a continuation containing current
state, owner links, blockers and next actions. Resume only when authorized.
