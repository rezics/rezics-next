# REZICS

REZICS is a semantic knowledge and content platform. Apache Jena Fuseki/TDB2
stores graph aggregates and runs graph/text queries with jena-text/Lucene.
PostgreSQL owns Content and private state; Main exposes APIs consumed by the web and Accounts apps.

Backend phase 1 passed all 276 retained backend acceptance IDs in its
[recorded run](docs/plan/qualification.md). The web journey and later scale and
deployment gates have their own status in the [plan](docs/plan/README.md#current-state).

## Start locally

Install the [pinned toolchain](docs/development/toolchain.md) and a Docker-compatible daemon. From a fresh checkout:

```sh
task toolchain:install
task dev
task urls
```

The main checkout runs Account, Main, the Accounts app, web and Storybook under
Aspire on ports 3002, 3001, 3004, 3000 and 6006. In a worktree, `task dev`
runs the frontends on assigned ports against the shared backend; use
`task dev -- --backend` for an isolated stack. `task urls` reports the actual
addresses. `task env` shows masked configuration, and each workspace has an
`.env.example`. List commands with `task --list`.

```sh
task dev:stop
task stack:down
```

`stack:down` retains the main checkout's storage volumes. For setup, isolated
QA and cleanup details, see [installation](docs/operations/installation.md).

## Find the owners

- [Design](docs/README.md) and [current plan](docs/plan/README.md#current-state)
- [Toolchain](docs/development/toolchain.md) and [test harness](docs/testing/test-harness.md)
- [Development workflow](docs/development/README.md) and [current Goal](GOAL.md)
