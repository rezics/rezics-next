# Delivery

Start from the tracked Goal brief and current owner contracts. Estimate a large outcome before dispatch and identify
a smaller viable slice without silently reducing scope.

Prepare user and API outcome acceptance before implementation. A brief states the outcome, owner links, boundaries,
dependencies, affected consumers, acceptance and estimated size. Use the schema in
[Goal tooling](../../tools/goal/README.md); do not maintain another schema here.

Before dispatch or reshape, check:

- required exports, fixtures and dependencies exist on the recorded base;
- the acceptance agrees with current contracts;
- declared risk areas cover the paths;
- the target is recorded in parsed metadata;
- dependencies are real code dependencies;
- shared-file writers are sequenced.

Prefer the oldest ready dependency. Do not restart a live attempt for an unchanged contract. Check actual task state
immediately before changing it.

A behaviour-changing brief owns every existing test depending on the old behaviour. Frozen acceptance is changed by
its contract owner, never weakened by the implementation worker.

Declared paths guide scope. A minimal adjacent correction must respect risk ownership, include its affected checks
and notify its owner. Agree shared interfaces before consuming them; include consumers and fixtures in the change.

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
