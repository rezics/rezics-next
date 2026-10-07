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

The shared stack's Account, Main and relay run without watch from detached
revision worktrees under `.temp/stack/rezics-dev/backend-revisions/`. The
`backend` pointer selects the last successful refresh. Merging or editing main
leaves those processes on that revision; web, Accounts and Storybook continue
hot-reloading from the main checkout. Worktree frontend and isolated backend
stacks keep their existing behavior.

After every merge, including code-only changes, the merging manager runs
`task dev:refresh -- --wait` from clean, committed main. Refresh freezes the
target commit, prepares a detached checkout, installs dependencies when the
lockfile or dependency manifests changed, and generates artifacts there before
stopping writers. With no storage or model work, it switches the pointer,
restarts Account, Main and relay through Aspire, waits for readiness and records
that exact revision. A second successful refresh at the same revision makes no
changes. A merge during refresh waits for the next refresh.

When maintenance is needed, refresh builds a missing pinned Fuseki image and
rehearses pending SQL migrations while writers still run. It then stops writers,
reconciles storage with volumes kept, applies owner migrations and aligns the
model from the candidate's artifacts before switching the backend. Maintenance
cost scales with the change; refresh takes no whole-volume snapshots and never
rewinds PostgreSQL or Fuseki.

A failure before the first storage/model-mutating operation leaves the previous
revision serving, restarting it if writers were already stopped. This includes
checkout, artifact generation, image build and migration rehearsal failures.
Once storage preparation, model alignment or Zone approval writes begin,
failures leave writers stopped and retain forward progress. The error names the
failed step and prints `task dev:refresh -- --wait` as the retry command. Those
maintenance operations are forward-only and idempotent. A small maintenance
marker retains the unfinished step and keeps writers stopped. Each retry freezes
current committed main, allowing a code fix to advance unfinished maintenance.
It repeats the unfinished step even if its model head committed before audit or
seek completion; small alignment intent/audit checkpoints are shared across
backend revisions.

The `storage-backend` pointer retains the last attempted Compose paths, so a
code-only checkout does not cause artificial container drift. An AppHost restart
after interrupted maintenance declares backend writers with explicit start;
`task dev` reports the stopped state promptly, and `task dev:refresh -- --wait`
finishes maintenance before restarting them. There is no `--recover` command.

Refresh compares installed official Zone source digests with active approvals
and submits changed packages through the demo seed's revision, independent
review and activation path, including `franchise-wiki`. Absent demo Zones and
custom themes are left alone. `task dev:refresh -- --dry-run` reads the live
stack and prints the plan without changing it. Refresh refuses worktrees;
without `--wait`, it refuses a held heavy QA lock. Dry-run lists affected
resources and each Zone's approved and source digests; when Main is unavailable,
approval inspection waits for readiness.

An existing shared AppHost needs one switch-over after adopting pinned mode:
run `task dev:stop`, then `task dev`, then `task dev:refresh -- --wait` in main.
Startup serves the last refreshed backend revision unless unfinished maintenance
holds the target revision with its writers stopped. The same
AppHost restart is required when refresh reports changed environment variables,
changed topology, or missing/dead executables. Resource restart cannot reload
AppHost configuration or recover a lost DCP executable after Docker restarts.
If a stop, restart or wait loses a resource during refresh, refresh shuts down
that AppHost and records no new checkpoint. It keeps any unfinished maintenance
marker and forward-only storage changes. Resolve a reported shutdown failure,
run `task dev` to create the AppHost with stopped writers, then retry
`task dev:refresh -- --wait`. Before maintenance, an interrupted code-only turn
can be retried after `task dev:stop` and `task dev` restart the previous revision.

Use `task test -- <explicit test files>` for changed behavior. Preview the
dependency-selected plan with `task test -- --affected --list`, then run
`task test -- --affected` when appropriate. The [test harness](../testing/test-harness.md)
explains QA tiers, evidence and `.artifacts/qa/<run-id>/summary.md`.

For documentation changes, run `task docs:check`; it checks local links,
fragments and navigation. It does not qualify runtime behavior or check external
URLs. Use the [primary-source procedure](external-sources.md) for upstream facts.
