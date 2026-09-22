# Operation design

Start with [the graph substrate quickstart](installation.md): one Apache Jena
Fuseki JVM, persistent TDB2, and jena-text/Lucene. It includes a versioned
[assembler example](examples/fuseki-text.ttl), HTTP smoke probes, restart and
explicit boundaries between this dependency and the unimplemented product services.

- [Deployment](deployment.md): initial host placement, private endpoints and budgets.
- [Recovery](recovery.md): offline backup/restore, epochs and Lucene rebuild.
- [Observability](observability.md): graph/text readiness, progress and diagnosis.
- [Security](security.md): private service access, admission and disclosure.
- [Erasure](erasure.md): current RDF, revision payloads, indexes and retained copies.
- [Executable theme access](custom-theme-external-live-access.md) and
  [incident response](custom-theme-review-and-incident-response.md).

The documented commands are reviewed recipes, not a claim that a deployment was
started or qualified. Product recovery and activation become executable alongside
Main, Account and their required consumers in the [plan](../plan/README.md).
