# Development workflow

Read [AGENTS](../../AGENTS.md), [architecture](../architecture.md), [scope](../scope.md) and the documents owning the
work. Repository documents own durable rules; research reports provide evidence; tracked Goal definitions own scoped outcomes; attempt briefs link them.

The [rezics-workflow skill](../../.agents/skills/rezics-workflow/SKILL.md) supplies the operating procedures for these
rules. Keep durable rules here and command mechanics in their owning runbooks; the skill links both.

Use this workflow:

1. [Design the feature](feature-design.md).
2. [Prepare and deliver the work](delivery.md).
3. [Verify its outcomes](verification.md).
4. [Measure delivery efficiency](efficiency.md).
5. [Maintain shared tools and dependencies](maintenance.md).

[Goal definitions](../goals/README.md) describe what must be completed.
[Goal tooling](../../tools/goal/README.md) owns dispatch, task state, routing, integration, promotion and recovery.

The coordinating role resolves cross-scope decisions and workflow defects. A manager owns its Goal's scope,
contracts, briefs and acceptance. Workers implement briefed changes. Managers delegate implementation, including
tooling changes, except an explicitly authorized emergency correction.

Decide within the assigned scope and report the result. Escalate an unresolved product boundary or incompatible
contract with evidence. Routine implementation choices do not need repeated confirmation.

Put an adopted decision in its owning document before briefing dependent work. Link it from affected briefs.
Continuations record operating state and owner links, not another copy of the decision.

A topic has one authority. Correct or remove superseded text when changing it.

## Skill discovery

Keep one workflow skill in `.agents/skills/rezics-workflow/`. Codex discovers repository skills in `.agents/skills`
from its working directory to the repository root; the installed CLI 0.164.0 includes that discovery path.
Claude Code reaches the same files through the relative symlink `.claude/skills -> ../.agents/skills`.
Do not create a second workflow copy or an additional Codex skill alias. Explicit invocation is `$rezics-workflow`
in Codex or `/rezics-workflow` in Claude Code; the description also enables selection for development work.

The entry point routes to short stage references. When maintaining it, follow
[OpenAI's skill guidance](https://learn.chatgpt.com/docs/build-skills),
[Anthropic's authoring guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) and
[Claude Code discovery](https://code.claude.com/docs/en/skills): precise triggers, concise instructions and detail
loaded only for the current stage. Keep policy in these development documents and link it from procedures.

Check the single-copy discovery layout from the repository root:

```sh
test -s .agents/skills/rezics-workflow/SKILL.md
test "$(readlink .claude/skills)" = ../.agents/skills
cmp .agents/skills/rezics-workflow/SKILL.md .claude/skills/rezics-workflow/SKILL.md
```
