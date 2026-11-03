# Development workflow

Read [AGENTS](../../AGENTS.md), [architecture](../architecture.md), [scope](../scope.md) and the documents owning the
work; a worker reads only what its brief links. Every agent follows [agent conduct](agent-conduct.md). Repository documents own durable rules; research reports provide evidence; tracked Goal definitions own scoped outcomes; attempt briefs link them.

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

[Database restore](database-restore.md) owns isolated recovery, proof-key rotation and erasure replay before traffic.

## Commands

Run `go-task --list` at the repository root to discover developer and operator commands in
[Taskfile.yml](../../Taskfile.yml). Tasks wrap the existing scripts and package scripts; those scripts continue to own
setup, placement, cleanup and validation. go-task reads `.temp/goal/goal.env`, the same private EnvironmentFile used by
the Goal systemd units, when present. Install the services through `go-task goal:service:install` from the main
checkout as described in [Goal tooling](../../tools/goal/README.md). The pinned workspace Bun
is first on the task PATH. Workspace `.env` files and Worker configuration keep their existing roles.

Decision: Storybook and screenshot tasks select explicit local `--operator` mode, which refuses worker identities,
test runtime and check-host execution; ordinary worker entries retain their existing placement and output rules.

```sh
go-task dev
go-task storybook -- --port 6007
go-task storybook -- --ui --port 6008
STORYBOOK_OUTPUT_DIR="$PWD/.temp/storybook-static" go-task storybook:build
go-task screenshots -- --story 'pages-subjects-missing-subject--*' --locale en --theme dark --width 390 --out '/tmp/review shots'
go-task typecheck
go-task test -- tests/screenshots-widths.test.ts
go-task seed:cross-media -- --help
go-task goal:service:status
go-task goal:service:restart
go-task goal:service:logs
go-task goal:cp-sync -- --dry-run
```

Arguments after `--` pass through to the wrapped command, including repeated screenshot selectors, locales, themes
and widths. Screenshot output defaults to `.temp/screenshots`; relative `--out` paths start at the repository root,
and operators may choose an absolute directory elsewhere. Static builds include both the Web and UI catalogues and
default to `apps/web/storybook-static`. Storybook stays on loopback. These local operator commands do not register
worker checks. Use the existing package scripts from worker checks without `--operator`.

`dev` starts Web, Auth pages, Kernel and its background worker; Kernel tasks first run the existing persistent
development database and search setup. Configure Auth and service credentials through the existing workspace
runbooks. Each component is also listed separately. Ctrl-C stops the foreground commands; persistent database and
search containers remain available. Focused test tasks require explicit files, relative to their named workspace.
`goal:cp-sync` and the service tasks retain the permissions and release rules in the Goal runbook.

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
