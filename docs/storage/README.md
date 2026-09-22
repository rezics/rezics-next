# Storage design

- [Ownership and placement](ownership-and-placement.md): authoritative writers and cross-store protocols.
- [Fluree binding](fluree.md): facts, history, transactions and supported query profile.
- [Private PostgreSQL](postgresql.md): account, access and operational integrity.
- [Objects](objects.md): bytes, integrity, retention and delivery.
- [Workload policy](workload-budgets.md): bounded work now and long-term scale estimates.
- [Schema evolution](schema-evolution.md): model, storage, API and index generations.

## Workload owners

- [Classification](workloads/tag-path-capacity.md)
- [Identity and Access](workloads/identity-access-capacity.md)
- [Catalog editorial](workloads/catalog-editorial-capacity.md)
- [Governance and delivery](workloads/governance-delivery-capacity.md)
- [Source interoperability](workloads/semantic-interoperability-capacity.md)
- [Subscriptions](workloads/subscriptions-capacity.md)
- [Ratings and temporal queries](workloads/temporal-capacity.md)

One service may own multiple stores. Their transaction boundaries remain distinct.
Storage design never changes Resource, Main Version, context or authority meaning.
