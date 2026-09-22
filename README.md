# REZICS

REZICS is a semantic knowledge and content platform designed around **Apache Jena
Fuseki + TDB2 + jena-text/Lucene**. Main owns domain commands and immutable content
revisions; PostgreSQL owns private Account/Access state; object storage holds
payloads and media.

This repository currently contains the architecture, implementation contracts,
startup examples and historical research tools. Main, Account and the web client
are not implemented here yet.

- [Start the graph substrate](docs/operations/installation.md): pinned distribution,
  persistent storage, SPARQL and text-query smoke instructions.
- [Build the first authenticated journey](docs/plan/README.md#fast-start-milestones):
  safe commands, a Work/Main Version, Realm classification and public search.
- [Read the complete design](docs/README.md) and [selected architecture](docs/architecture/overview.md).
- [Restore and rebuild indexes](docs/operations/recovery.md).
- [Check documentation](docs/development/README.md): local links and document roles;
  these checks do not qualify runtime behavior.
