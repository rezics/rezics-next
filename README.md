# REZICS

REZICS is a semantic knowledge and content platform designed around **Apache Jena
Fuseki + TDB2 + jena-text/Lucene**. Main owns domain commands and immutable content
revisions; PostgreSQL owns private Account/Access state; object storage holds
payloads and media.

The application target is TypeScript with Elysia 2.0 on Bun, managed through Yarn
workspaces. The web client uses React and vinext on Vite for Cloudflare Workers.
The [stack review](docs/research/application-stack.md) records the selection,
alternatives and bounded framework evidence.

This repository contains the architecture, implementation contracts, a qualified
Fuseki graph substrate and the first internal Main storage command. Account,
Access admission, product HTTP routes and the web client remain to be delivered.

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
