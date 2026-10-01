# Operation design

Start with [the local installation guide](installation.md): pinned Compose
services plus host Main and Account through root commands. Its separate S0
substrate drill uses a versioned [raw-update fixture](../../infra/jena/fuseki-text-quickstart.ttl)
for Fuseki/TDB2 and jena-text/Lucene restart and restore checks. The product
[assembler](../../infra/jena/fuseki-text.ttl) uses the guarded command endpoint.

- [Deployment](deployment.md): production fleet, placement, the NixOS and Nomad decision, and what must be ready to deploy.
- [Email](email.md): verified sender setup, optional-mail suppression, provider events and uncertain delivery.
- [Production installation](production-install.md): operator prerequisites, API-only launch bootstrap, bounded source intake and receipt recovery.
- [Recovery](recovery.md): offline backup/restore, epochs and Lucene rebuild.
- [Observability](observability.md): graph/text readiness, progress and diagnosis.
- [Security](security.md): private service access, admission and disclosure.
- [Trust and safety](trust-and-safety.md): launch restrictions, public intake, responders and urgent-harm procedures.
- [Erasure](erasure.md): current RDF, revision payloads, indexes and retained copies.
- [Executable theme review and incident response](custom-theme-review-and-incident-response.md).

The local stack and scoped drills have executed; their evidence and remaining
acceptance gaps are in the [plan](../plan/README.md). They do not qualify a
production deployment or the complete product recovery contract.
