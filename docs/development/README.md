# Development workflow

Start at the [task reading routes](../plan/README.md#task-reading-routes) for the
contract, implementation owner and acceptance cases of one change. The
[repository map](repository-structure.md) locates workspaces and generated files;
the [toolchain](toolchain.md) records pinned tools and root commands. Frontend
owners are in [web organization](web-features.md), the [design system](design-system.md)
[Storybook review](storybook.md), the [about site](about-site.md) and
[launch journey accessibility](launch-accessibility.md).

Run commands from the repository root through Task. `task --list` shows the
current facade; `task urls` and `task env` show running addresses and masked
configuration. For a development stack and its cleanup, follow
[installation](../operations/installation.md). The [disposable local web auth
fixture](local-web-auth.md) has its own run procedure, as does the optional
[local real-world dataset corpus](local-datasets.md).

To discard and recreate this checkout's dev data, run `task dev:reset -- --yes` (it prints the exact volumes and directories first).

After merges, run `task dev:refresh` from the clean, committed `main` checkout to
build a missing pinned Fuseki image, reconcile storage with volumes kept, apply
owner migrations, align the dataset model generation and restart Account, Main
and the Main relay through Aspire. `task dev:refresh -- --dry-run` reads the live
stack and prints the plan without changing it. Refresh refuses worktrees and a
held heavy QA lock. If it reports changed environment variables or AppHost
topology, restart the AppHost with `task dev` before retrying; a resource restart
cannot reload the AppHost's configuration. A successful second refresh makes no
changes. A failed maintenance step leaves the writers stopped and records no
success checkpoint; resolve the reported error and rerun the command.

Use `task test -- <explicit test files>` for changed behavior. Preview the
dependency-selected plan with `task test -- --affected --list`, then run
`task test -- --affected` when appropriate. The [test harness](../testing/test-harness.md)
explains QA tiers, evidence and `.artifacts/qa/<run-id>/summary.md`.

For documentation changes, run `task docs:check`; it checks local links,
fragments and navigation. It does not qualify runtime behavior or check external
URLs. Use the [primary-source procedure](external-sources.md) for upstream facts.
