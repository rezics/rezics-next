# REZICS Main service

## Domain modules

Rust/Tokio/Axum hosts explicit modules for Resource identity, Work/Main Version,
Space, Context, classification, ratings, content/composition, catalog/source
adoption, package metadata, community/governance and query/render selection.
Each module owns its predicates/commands and invariant tests. They can share one
Fluree product ledger to preserve joint query and local transaction opportunities.
Splitting a module into another process is not required for modular ownership.

## Request execution

Validate typed input; bind Account and Access context; resolve exact target and
context/profile; perform guarded Fluree command with receipt/outbox or an admitted
query; serialize declared API results. Use reusable transaction/query HTTP clients
with deadlines, correlation and receipt-based retry. Backend/query admission remains
effective even when a client bypasses the BFF.

Fluree adapters own supported transaction/query syntax, source snapshots,
validation profiles and error translation. A CAS no-op does not become success.
Public graph queries cannot alter protected predicates, choose root policy or
fetch raw private storage. Full-text stays in Fluree's operator plan.

## Content, source and package integration

Objects are activated only after verified upload/processing. Source workers
preserve observations and submit mapped proposals; native adoption is a Main
command under target/human epochs. Package runtime receives snapshot-bound
requirements and records resolution/installation references through owner APIs;
it is not a second catalog writer.

Emit accepted-native and published-selection events separately from observation
or staging events. Consumers maintain bounded projection generations. Current
disclosure applies to exact history, media, search and exports, not only root pages.

## Failure behavior

Search/index/delivery lag cannot lose durable content writes. Missing exact
dependencies prevent publication; they do not cause fallback to unrelated content.
Unknown write outcomes reconcile by operation receipt. Tests cover the integrated
Space/classification/Main Version journey and all five indexing domains.
