# Selected architecture

Confirmed 2026-09-24: PostgreSQL owns Content bodies, drafts and private
operational state; Apache Jena Fuseki/TDB2 owns semantic aggregates, retained
graph references and graph command receipts. The configured jena-text/Lucene
index joins text matches with graph relations in one query service. Object
storage holds media, artifacts and large sealed payloads. The selection favors
one graph service and supplied indexing machinery over a custom search engine.
[Evidence](evidence.md) records the limits of that choice.

## Owners and topology

Account owns credentials, sessions and OIDC. Main admits domain and Access
operations; Access keeps private PostgreSQL authority inside Main's process.
Content is a Main-owned PostgreSQL module. Fuseki alone opens TDB2 files; Main
calls its guarded command and query endpoints. A bounded relay materializes
derived search and delivery from owner outboxes. The executable topology is in
[AppHost](../../apphost/apphost.mts), [storage Compose](../../infra/dev/compose.yaml)
and [Main composition](../../services/main/src/app.ts). [Service boundaries](services.md)
explain when a separate process is justified.

Each fact has one authoritative writer. Exact Content revisions are prepared and
retained in PostgreSQL before graph publication pins them; RDF text is a
rebuildable projection, and Lucene indexes that RDF. This adds projection bytes
and graph writer load but preserves Jena's graph/text joins. The
[ownership map](../storage/ownership-and-placement.md),
[publication contract](../contracts/commands.md#content-publication-and-delayed-visibility)
and [search contract](../contracts/search.md#postgresql-body-projection) carry
the operational rules.

## History, authority and growth

TDB2 transactions and snapshots are not permanent product history. Main retains
immutable component manifests and exact revision references; each owner commits
its local receipt and outbox with its state. PostgreSQL and TDB2 do not share a
transaction, so publication, revocation and recovery need explicit fences and
reconciliation. See [Main Version](../contracts/main-version.md),
[authorization bridge](../implementation/authorization-bridge.md) and
[recovery](../operations/recovery.md).

The initial path uses one effective graph writer and one assessed principal
host. Redis, a broker, replicas and an external search cluster are later choices
when measured work warrants them; another host alone does not add database
availability. [Workload budgets](../storage/workload-budgets.md) and
[deployment](../operations/deployment.md) own qualification and recovery.

The shared [Context model](../contracts/context.md) lets people and Realms select
exact interpretation revisions without changing authored statements. Space,
classification, ratings and Main Version retain their product meanings across
the delivery sequence. Native language variants follow the
[content language contract](../contracts/content-languages.md).
