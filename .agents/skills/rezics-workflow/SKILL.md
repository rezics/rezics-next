---
name: rezics-workflow
description: Follow REZICS's development workflow when designing features, researching behaviour, writing Goal briefs or acceptance, implementing changes, verifying APIs or Storybook pages, reviewing delivery, or measuring efficiency in this repository.
---

# REZICS workflow

Use this skill for repository development, including documentation and tooling. Start at the stage the assigned
contract has reached; an implementation worker consumes adopted design rather than reopening it. Read only the
stage references needed for the current work. This skill supplies procedures; [development
rules](../../../docs/development/README.md), owner documents and [AGENTS](../../../AGENTS.md) retain authority.

1. **Orient.** Workers and units: the Goal or brief is the orientation; read only what it links. The manager and designers read the
   owner documents for the decision at hand. Follow [agent conduct](../../../docs/development/agent-conduct.md).
2. **Design and adopt.** Use [feature design](references/feature-design.md) to derive capabilities from the shared
   architecture, survey mainstream products, write acceptance in user terms and adopt the result in its owner doc.
3. **Brief and implement.** Use [briefing](references/briefing.md) and
   [phase ownership](../../../docs/development/delivery.md#implementation-and-acceptance) to separate source delivery
   from acceptance. Units consume native Codex Goals; each unit and its helpers share one worktree.
4. **Prove.** When assigned acceptance, use [verification](references/verification.md) for the selected API, page,
   interaction, accessibility and visual evidence. Source assignments do not automatically enter this stage.
5. **Review and deliver.** Use [review](references/review.md) to assess the diff and evidence, repair defect classes,
   commit and hand off. Units merge source under the delivery rules; promotion and product Goal closure stay separate.
6. **Measure and improve.** The manager uses [efficiency](references/efficiency.md) at checkpoints to compare accepted
   outcomes and test corrective decisions at the existing progress checkpoint.

For example, when adding Collection filters, design their behaviour across every Collection surface, link the
adopted filter contract, and assign native acceptance and recorded-response page stories separately from source.
Do not infer backend support from a working mockup.

For dependency or shared-tool work, also read [maintenance](../../../docs/development/maintenance.md). For dispatch,
native-unit registration, resident wakeups and promotion, read the applicable [Goal tooling](../../../tools/goal/README.md) section;
use its current commands rather than legacy `goalctl` or `task goal` commands.
