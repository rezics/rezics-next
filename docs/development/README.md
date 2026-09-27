# Development workflow

Start at the [task reading routes](../plan/README.md#task-reading-routes) for the
contract, implementation owner and acceptance cases of one change. The
[repository map](repository-structure.md) locates workspaces and generated files;
the [toolchain](toolchain.md) records pinned tools and root commands. Frontend
owners are in [web organization](web-features.md), the [design system](design-system.md)
and [Storybook review](storybook.md).

Run commands from the repository root through Task. `task --list` shows the
current facade; `task urls` and `task env` show running addresses and masked
configuration. For a development stack and its cleanup, follow
[installation](../operations/installation.md). The [disposable local web auth
fixture](local-web-auth.md) has its own run procedure.

Use `task test -- <explicit test files>` for changed behavior. Preview the
dependency-selected plan with `task test -- --affected --list`, then run
`task test -- --affected` when appropriate. The [test harness](../testing/test-harness.md)
explains QA tiers, evidence and `.artifacts/qa/<run-id>/summary.md`.

For documentation changes, run `task docs:check`; it checks local links,
fragments and navigation. It does not qualify runtime behavior or check external
URLs. Use the [primary-source procedure](external-sources.md) for upstream facts.
