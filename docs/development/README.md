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
and the Main relay through Aspire. It compares installed official Zone source
digests with their active approvals and submits changed packages through the
demo seed's revision, independent review and activation path, including
`franchise-wiki`. Absent demo Zones and custom themes are left alone.
`task dev:refresh -- --dry-run` reads the live
stack and prints the plan without changing it. Refresh refuses worktrees and a
held heavy QA lock. If it reports changed environment variables or AppHost
topology, or names a missing or dead executable behind a running resource, run
`task dev:stop`, then `task dev` from the main checkout before retrying. A resource
restart cannot reload the AppHost's configuration or recover a lost DCP
executable after Docker restarts. Dry-run lists the affected resources and each
Zone's approved and source digests; when Main is unavailable, it reports that
approval inspection must wait for readiness. If a stop, restart or wait loses a
resource during refresh, refresh stops that AppHost with `task dev:stop`, keeps
data volumes and records no checkpoint; start it again with `task dev` before
retrying. A shutdown failure is reported explicitly and must be resolved first.
A successful second refresh makes no changes. Other failed maintenance steps
leave the writers stopped and record no success checkpoint; resolve the error
and rerun the command.

Use `task test -- <explicit test files>` for changed behavior. Preview the
dependency-selected plan with `task test -- --affected --list`, then run
`task test -- --affected` when appropriate. The [test harness](../testing/test-harness.md)
explains QA tiers, evidence and `.artifacts/qa/<run-id>/summary.md`.

For documentation changes, run `task docs:check`; it checks local links,
fragments and navigation. It does not qualify runtime behavior or check external
URLs. Use the [primary-source procedure](external-sources.md) for upstream facts.
