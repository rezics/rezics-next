# Operation design

Start with [the local installation guide](installation.md): pinned Compose
services plus host Main and Account through root commands. Its separate S0
substrate drill uses a versioned [raw-update example assembler](examples/fuseki-text.ttl)
for Fuseki/TDB2 and jena-text/Lucene restart and restore checks. The product
[assembler](../../infra/jena/fuseki-text.ttl) uses the guarded command endpoint.

- [Deployment](deployment.md): initial host placement, private endpoints and budgets.
- [Recovery](recovery.md): offline backup/restore, epochs and Lucene rebuild.
- [Observability](observability.md): graph/text readiness, progress and diagnosis.
- [Security](security.md): private service access, admission and disclosure.
- [Erasure](erasure.md): current RDF, revision payloads, indexes and retained copies.
- [Executable theme access](custom-theme-external-live-access.md) and
  [incident response](custom-theme-review-and-incident-response.md).

The local stack and scoped drills have executed; their evidence and remaining
acceptance gaps are in the [plan](../plan/README.md). They do not qualify a
production deployment or the complete product recovery contract.
