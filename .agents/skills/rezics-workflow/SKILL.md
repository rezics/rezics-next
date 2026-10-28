---
name: rezics-workflow
description: Follow REZICS's development workflow when designing features, researching behaviour, writing Goal briefs or acceptance, implementing changes, verifying APIs or Storybook pages, reviewing delivery, or measuring efficiency in this repository.
---

# REZICS workflow

Use this skill for repository development, including documentation and tooling. Start at the stage the assigned
contract has reached; an implementation worker consumes adopted design rather than reopening it. Read only the
stage references needed for the current work. This skill supplies procedures; [development
rules](../../../docs/development/README.md), owner documents and [AGENTS](../../../AGENTS.md) retain authority.

1. **Orient.** Read AGENTS, the development entry point, [architecture](../../../docs/architecture.md),
   [scope](../../../docs/scope.md), the relevant [Goal definition](../../../docs/goals/README.md) and owner contracts.
   Identify your role, assigned checkout, acceptance, frozen files and risk boundaries before editing.
2. **Design and adopt.** Use [feature design](references/feature-design.md) to derive capabilities from the shared
   architecture, survey mainstream products, write acceptance in user terms and adopt the result in its owner doc.
3. **Brief and implement.** Use [briefing](references/briefing.md) to preflight dependencies, freeze missing outcome
   scenarios and prepare one coherent assignment. Workers implement that contract in their assigned worktree.
4. **Prove.** Use [verification](references/verification.md) for per-persona API acceptance first, then page stories
   from recorded responses, interaction/accessibility evidence, visual inspection and the required scoped checks.
5. **Review and deliver.** Use [review](references/review.md) to assess the diff and evidence, repair defect classes,
   commit and hand off. The controller owns integration and promotion; verify the promoted revision for Goal closure.
6. **Measure and improve.** Managers use [efficiency](references/efficiency.md) at checkpoints to compare accepted
   outcomes, diagnose lost attempts, apply the linked incident method and verify class repairs in the next hourly report.

For example, when adding Collection filters, design their behaviour across every Collection surface, link the
adopted filter contract and frozen native scenarios in the brief, make API acceptance pass, then add recorded-response
page stories for the applicable filter and viewer states. Do not infer backend support from a working mockup.

For dependency or shared-tool work, also read [maintenance](../../../docs/development/maintenance.md). For dispatch,
retry, manager wakeups and promotion, read the applicable [Goal tooling](../../../tools/goal/README.md) section;
use its current commands rather than legacy `goalctl` or `task goal` commands.
