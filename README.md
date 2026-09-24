# REZICS

REZICS is a semantic knowledge and content platform designed around
**PostgreSQL + Apache Jena Fuseki/TDB2 with embedded jena-text/Lucene**. Main owns domain
commands; PostgreSQL stores Content bodies/revisions, drafts and operational/private
state; Jena stores semantic aggregates and executes joint graph/text queries.
Object storage holds media, artifacts and large sealed payloads. The selected
Content/projection binding is implementation work in P0.8; existing object-backed
body and bounded search slices are recorded separately in the plan.

The application target is TypeScript with Elysia 2.0 on Bun, managed through Yarn
workspaces. The web client uses React and vinext on Vite for Cloudflare Workers.
The [stack review](docs/research/application-stack.md) records the selection,
alternatives and bounded framework evidence.

This repository contains the architecture, implementation contracts, a scoped
Fuseki graph substrate, Account, and Main with Access admission and its first
product HTTP routes. Phase 0 now provides a pinned local service stack and the
first shared QA smoke path. The web client and complete qualification tiers are
still in the [execution program](docs/plan/README.md#execution-program).

From a checkout with the [pinned runtimes](docs/development/toolchain.md), run:

```sh
yarn toolchain:install
yarn stack:up
yarn stack:status
yarn qa --tier integration
yarn stack:down
```

The current `yarn dev` command starts Main and Account only when the host Jena
and Java paths used by Main's older validator are supplied. P0.2 replaces that
validator with the Fuseki command module. The integration tier currently checks
Account signup/session and Main/Fuseki readiness; it does not qualify the full
product. See the [active plan](docs/plan/README.md#active-execution) for current
batch results and remaining gates.

- [Toolchain lock](docs/development/toolchain.md): every tool, version, local
  service and root command (`yarn dev`, `yarn check`, `yarn qa`).
- [Executable test harness](docs/testing/test-harness.md): implemented smoke path,
  required remaining tiers and final recording contract.

- [Start the graph substrate](docs/operations/installation.md): pinned distribution,
  persistent storage, SPARQL and text-query smoke instructions.
- [Run the first Main storage slice](services/main/README.md): pinned workspace,
  live Fuseki command and scoped integration evidence.
- [Build the first authenticated journey](docs/plan/README.md#fast-start-milestones):
  safe commands, a Work/Main Version, Realm classification and public search.
- [Read the complete design](docs/README.md) and [selected architecture](docs/architecture/overview.md).
- [Run the implementation goal](GOAL.md): target scope, continuation and completion
  evidence for a maintainer-activated GPT-6 Sol task.
- [Restore and rebuild indexes](docs/operations/recovery.md).
- [Check documentation](docs/development/README.md): local links and document roles;
  these checks do not qualify runtime behavior.
