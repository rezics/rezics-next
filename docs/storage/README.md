# Storage design

- [Ownership and placement](ownership-and-placement.md): authoritative writers and cross-store protocols.
- [Jena binding](jena.md): Fuseki + TDB2 + jena-text/Lucene, guarded writes and application history.
- [Content PostgreSQL owner](../../services/content/src/core.ts): exact bodies/history and publication pins; [owner placement](ownership-and-placement.md) maps the separate Account, Access and operational state.
- [Immutable-object adapter](../../services/main/src/infrastructure/immutable-objects.ts): conditional writes, digest verification and owner namespaces.
- [Workload policy](workload-budgets.md): cost contracts, reusable/bulk preparation and the current 500M-entity capacity baseline.
- [Schema evolution](schema-evolution.md): model, storage, API and index generations.

[Editorial protection](../contracts/editorial-protection.md) uses the existing
Jena/PostgreSQL owner bindings for local head/decision enforcement; it does not
select another database. [Quality summaries](../contracts/information-verification.md)
remain derived and generation-bound.

## Workload owners

- [Statements and grouping](workloads/statement-capacity.md)
- [Identity and Access](workloads/identity-access-capacity.md)
- [Catalog editorial](workloads/catalog-editorial-capacity.md)
- [Governance and delivery](workloads/governance-delivery-capacity.md)
- [Source interoperability](workloads/semantic-interoperability-capacity.md)
- [Subscriptions](workloads/subscriptions-capacity.md)
- [Ratings and temporal queries](workloads/temporal-capacity.md)

One service may own multiple stores. Their transaction boundaries remain distinct.
Storage design never changes Resource, Main Version, context or authority meaning.
