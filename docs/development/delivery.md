# Delivery

Start from the tracked Goal brief and current owner contracts. Size a task by its outcome, not by a line limit: a
large task is fine when it is clear. State what it delivers in user terms and design it on the best abstraction before
dispatch. A failure must not lose work: a retry resumes the same session with its commits and evidence and continues
from where it stopped, so the cost of failing is the remaining work, never a restart.

Workers own the how; managers own the what. A brief states the outcome in user terms, owner links, what done means,
dependencies and estimated size; the worker designs the change and writes its acceptance tests. Use the schema in
[Goal tooling](../../tools/goal/README.md); do not maintain another schema here.

Link each capability to its `docs/goals/<goal>.capabilities.md` evidence entry under
[verification](verification.md#capability-evidence). Every interface brief names the page stories it adds, including
states, viewers, viewports and their recorded API evidence. Missing user scenarios of a cross-Goal contract are frozen
red before implementation; acceptance a Goal owns alone is written by its worker.

## Brief preflight

The worker of product work on dev verifies every concrete premise of its brief against its base before it designs
the change: paths, counts, package ownership and where stories or fixtures actually live. It builds on what is there
and records a premise that did not hold in its summary. Managers preflight control-plane, stabilize-target and
verification briefs before dispatch or reshape. A claim that all stories share one Storybook must be checked rather
than assumed. Check:

- required exports, fixtures and dependencies exist on the recorded base;
- the acceptance agrees with current contracts;
- declared risk areas cover the paths;
- the target is recorded in parsed metadata;
- dependencies are real code dependencies;
- overlap is not encoded as a dependency; use `after:` only when code needs another task's API, schema or component;
- a requirement that refuses, rejects, stops or fails work carries its price line ([agent conduct](agent-conduct.md#briefs)).

Declared paths never hold a task. Overlapping tasks run side by side; the controller's rebase process resolves
conflicts with agent assistance. Shared READMEs, fake data, messages, `package.json` and routes are not dependencies
merely because multiple tasks edit them. See [integration mechanics](../../tools/goal/README.md#integration-promotion-culprit-isolation-and-attempt-fencing).

Prefer the oldest ready dependency. Do not restart a live attempt for an unchanged contract. Check actual task state
immediately before changing it.

A behaviour-changing brief owns every existing test depending on the old behaviour: its worker updates those tests to
the new behaviour and lists them. When frozen acceptance contradicts the contract, an owner
document or the delivered code it depends on, the worker changes the smallest assertion that makes them agree,
lists the file and the reason, and continues.

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

A product worker on dev decides ambiguities itself, including a product choice the brief does not make: it takes the
reversible option most consistent with the owner documents, records it in its summary and the owning document, tells
its manager with an `info` message and continues. A blocker is only a contradiction between existing specs or tests,
or missing access. When its outcome does not fit one attempt, the worker lands a coherent part and writes the rest as
a continuation brief for its Goal's backlog.

Use the controller's retry process. A landing failure or a tool blocker of product work on dev resumes the same worker
session with the error and needs no manager turn while the attempts make progress; the same failure twice, or two
attempts in a row without a new commit, stop the task and notify its manager
([integration mechanics](../../tools/goal/README.md#integration-promotion-culprit-isolation-and-attempt-fencing)).
Report specification conflicts with the conflicting outcomes and evidence. Do not create informal gate exceptions.

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

A manager keeps the ordered list of outcomes for its Goal and short outcome briefs in its backlog, cross-Goal contracts
and their frozen acceptance, answers to escalations, and a review of a sample of about two landings an hour whose
defects become briefs. It synthesizes what its workers report into decisions and the next briefs. It does not
dispatch, approve retries, preflight product briefs, write per-task acceptance, receive results, track custody,
review evidence per task or send status messages and receipts.

Efficiency is measured without model tokens. An hourly report to the project's Telegram group, in Traditional
Chinese, leads with new product code landed in the last full clock hour under apps, services and packages, excluding
tests, stories, fixtures, recordings, generated files, JSON, evidence and documents, against the steady 20,000-line
target and 40,000-line aim, then width, stopped tasks, ready briefs per Goal and allowance. It raises alarms for a
two-hour total below the target, unfilled width, a Goal with fewer than three ready briefs, more than ten stopped
tasks, and no product landing for 60 minutes. The supermanager acts on alarms. When a cause is unclear, it
commissions a one-off measurement from session logs and the task store instead of a standing review. Lines are a
measure, never a goal: quality comes first.

Control-plane owns delivery-tool defects; Performance owns check-host health. Managers keep complete ready briefs
available for free width. A token-free watchdog [supervises the resident supermanager](supermanager.md).

Runtime release, authenticated authority receiving, physical custody, workflow execution and delivered evidence are
distinct facts. Source integration and a successful compiler command do not certify native runtime release or consume
an operational allowance.
