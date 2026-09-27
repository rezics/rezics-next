# REZICS

REZICS is a semantic knowledge and content platform designed around
**PostgreSQL + Apache Jena Fuseki/TDB2 with embedded jena-text/Lucene**. Main owns domain
commands; PostgreSQL stores Content bodies/revisions, drafts and operational/private
state; Jena stores semantic aggregates and executes joint graph/text queries.
Object storage holds media, artifacts and large sealed payloads. The PostgreSQL
Content owner now has transactional drafts, revisions, receipts and publication
pins. Its Main publication and search projection binding is still P0.8 work;
Main's existing object-backed body and bounded search slices are recorded
separately in the plan.

The application target is TypeScript with Elysia 2.0 on Bun, managed through Yarn
workspaces. The web client uses React and vinext on Vite for Cloudflare Workers.
The [stack review](docs/research/application-stack.md) records the selection,
alternatives and bounded framework evidence.

This repository contains the architecture, implementation contracts, the Fuseki
command module, Account, Main with Access admission and product HTTP routes,
and the first PostgreSQL Content owner. Phase 0 provides a pinned local stack
and a shared QA runner. The web client, Content-to-Main binding and complete
qualification remain in the [plan](docs/plan/README.md#current-state).

From a fresh checkout with the [pinned runtimes and Docker-compatible daemon](docs/development/toolchain.md)
and [Task](https://taskfile.dev) 3.53.1 installed, run:

```sh
task toolchain:install
task dev
```

`task dev` starts the storage stack, applies Account/Access/relay migrations,
initializes the graph on first use, then starts Account, Main, the web app and
Storybook under [Aspire](https://aspire.dev) in the background: web on
<http://localhost:3000>, Main on 3001, Account on 3002 and Storybook on 6006. It
prints the resource URLs and the Aspire dashboard URL; `task urls`,
`task aspire -- describe` and `task aspire -- logs <resource>` show addresses,
state and logs, and `task --list` lists every command. In a git worktree,
`task dev` runs only the web app and Storybook on random ports against this
shared backend. Each workspace's `.env.example` documents its configuration;
`task env` shows the local values with secrets masked, and `.env.dev` (see
`.env.dev.example`) holds personal overrides. Stop the processes, then the
service containers, with:

```sh
task dev:stop
task stack:down
```

The [installation guide](docs/operations/installation.md) covers readiness,
private configuration, isolated QA runs and cleanup. `task qa` exercises its
implemented tiers in disposable projects; passing it currently leaves many
retained acceptance IDs uncovered. See the [plan's current state](docs/plan/README.md#current-state)
and the [qualification page](docs/plan/qualification.md) for results and remaining gates.

- [Toolchain lock](docs/development/toolchain.md): every tool, version, local
  service and root command (`task dev`, `task check`, `task qa`).
- [Executable test harness](docs/testing/test-harness.md): implemented tiers,
  uncovered cases and final recording contract.

- [Install the local stack](docs/operations/installation.md): root commands,
  readiness, persistent state and a separate standalone graph-substrate drill.
- [Run Main](services/main/README.md): current command boundary and scoped
  integration evidence.
- [Build the first authenticated journey](docs/plan/README.md#fast-start-milestones):
  safe commands, a Work/Main Version, Realm classification and public search.
- [Read the complete design](docs/README.md) and [selected architecture](docs/architecture/overview.md).
- [Run the Goal](GOAL.md): the current outcome for a maintainer-started Claude Code
  manager, its [charter](docs/goals/manager.md) and [worker program](docs/goals/README.md).
- [Restore and rebuild indexes](docs/operations/recovery.md).
- [Check documentation](docs/development/README.md): local links and document roles;
  these checks do not qualify runtime behavior.
