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

When maintenance is needed, refresh builds a missing pinned Fuseki image,
rehearses pending SQL migrations while writers still run, then stops writers and
snapshots PostgreSQL and Fuseki. It reconciles storage with volumes kept, applies
owner migrations and aligns the dataset model from the candidate's artifacts
before switching the backend. A maintenance failure restores the stopped owner
snapshots, private configuration and previous executable revision, restarts it,
and leaves the success checkpoint unchanged. Failed dependency installation or
generation leaves the serving revision alone. A failed recovery is reported
explicitly; retained `refresh-recovery` snapshots block startup and further
refreshes until `task dev:refresh -- --recover` restores the recorded revision
and restarts its AppHost. Recovery of a committed refresh or a completed rollback
cleans obsolete snapshots while preserving all subsequently accepted writes.
Interrupted code-only refreshes use the same recovery command to restore the
previous executable without rewinding storage. Immutable uploaded artifacts are retained. Public
traffic receives 503 during switchover until readiness, Zone approvals and the
success checkpoint finish; only readiness and the private refresh client bypass
that fence. The `storage-backend` pointer retains the last reconciled Compose
paths, so a code-only checkout does not cause artificial container drift.

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
Startup prepares and serves the last refreshed backend revision. The same
AppHost restart is required when refresh reports changed environment variables,
changed topology, or missing/dead executables. Resource restart cannot reload
AppHost configuration or recover a lost DCP executable after Docker restarts.
If a stop, restart or wait loses a resource during refresh, refresh shuts down
that AppHost, restores the previous storage and executable pointers when
possible, and records no new checkpoint. Resolve any reported shutdown failure
before restarting; use `task dev:refresh -- --recover` if recovery snapshots
remain after a failed or interrupted recovery.

Use `task test -- <explicit test files>` for changed behavior. Preview the
dependency-selected plan with `task test -- --affected --list`, then run
`task test -- --affected` when appropriate. The [test harness](../testing/test-harness.md)
explains QA tiers, evidence and `.artifacts/qa/<run-id>/summary.md`.

For documentation changes, run `task docs:check`; it checks local links,
fragments and navigation. It does not qualify runtime behavior or check external
URLs. Use the [primary-source procedure](external-sources.md) for upstream facts.
