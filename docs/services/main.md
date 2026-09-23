# REZICS Main service

## Domain and storage ownership

TypeScript/Elysia 2.0 on Bun hosts Resource identity, Work/Main Version, Space, Context,
classification, ratings, content/composition, source adoption, package metadata,
community/governance and admitted query/render selection. Modules own their
predicates, commands and invariants inside one Main service. A single product
TDB2 dataset permits cross-module RDF reads and guarded graph updates without
requiring one process per domain.

Main uses reusable **HTTP clients to Apache Jena Fuseki**. The JVM owns TDB2 and
jena-text/Lucene; Main does not embed Jena, open the database files or use JNI as
a bootstrap requirement. The [graph quickstart](../operations/installation.md)
starts that dependency, not an implemented Main binary. The service design and
first backend journey still require runtime implementation.

## Runtime and framework

The selected production target is Elysia 2.0 on Bun, with Yarn-managed workspaces
for installation and development commands. On 2026-09-23, the version baseline is
`elysia@2.0.0-beta.16` and Bun `1.4.2`. Resolve subsequent updates deliberately and
pin exact versions; npm's `latest` tag still selects Elysia 1.4. Keep all Elysia
plugins on compatible 2.0 releases. The [stack comparison](../research/application-stack.md)
owns the package evidence and qualification limits.

Keep domain functions independent of Elysia context, lifecycle hooks and macros.
Transport adapters validate explicit request/response schemas and translate
errors to the public contract. Elysia 2's RFC 9457 errors still need safe domain
codes, disclosure filtering and operation identifiers. Its `defer`/after-response
callbacks do not replace the durable outbox. Build-time AOT is optional; enabling
it must not connect to live stores or execute domain effects while capturing routes.

Main hosts [Access](access.md), whose private PostgreSQL authority stays behind
its own interface. Interactions such as likes/favorites persist as Main-owned RDF
with their receipts/outbox; optional caches do not become another writer. Redis
and a message broker are outside the required bootstrap dependency set. See the
[interaction/cache design](../implementation/interactions-and-cache.md).

## Request execution

Validate typed input; bind Account/Access context; resolve exact target and
profile; construct an admitted SPARQL query or guarded SPARQL Update; send through
Fuseki with bounded deadlines; reconcile the operation receipt; serialize the
public API result. Access remains effective if a caller bypasses the BFF. Main
never forwards arbitrary user-selected SPARQL, graphs or privileged credentials.

The storage adapter implements the [transaction contract](../contracts/commands.md):
a conditional update over one product dataset guards expected state and atomically
writes RDF changes, required immutable revision manifests/references, graph
sequence, receipt and outbox. The external read fence is
`{datasetId, dataEpoch, sequence}`; sequence is a lossless decimal string. A
successful HTTP response with no matching guard is not successful mutation, and
a lost response is reconciled from the receipt. Do not claim transaction scope
across separate HTTP requests or PostgreSQL/object stores.

Main validates domain invariants and explicit graph write sets. Jena's SHACL
library is available but Fuseki/TDB2 do not enforce shapes merely because shapes
were uploaded. Main's validation and commit guard are required; any additional
transactional validator is a separately qualified integration. Current RDF and
application-owned revision manifests implement [history](../implementation/graph-records.md);
TDB2 transaction snapshots are not permanent commit-addressed product history.

## Search and asynchronous work

Admitted graph/text plans use jena-text's `text:query` within SPARQL. Product
projection predicates and graph scope are explicit; the bootstrap label map is
not the complete discovery schema. Bind search to its graph/authority/index
context and enforce current disclosure before exposing matches, literals,
snippets, scores, facets or counts. No Lucene directory is an independent domain
authority or publicly reachable service.

Write through the text wrapper for normal index maintenance. Keep text health
separate from graph health: after uncertain crash/index state, fail text closed
and use the [rebuild protocol](../operations/recovery.md). If an index failure
interrupts a mutation, inspect the graph receipt before retrying; normal integrated
index updates do not establish a recoverable two-store atomic commit guarantee.

Poll committed graph outbox records in bounded batches initially, with durable
consumer checkpoints and idempotent delivery. A later broker distributes those
intents but never becomes the graph's commit authority. Source workers preserve
observations and submit proposals; adoption is a Main command under target/human
epochs. Object upload/processing verifies bytes before graph activation. Package
runtime records resolution/installation references through owner APIs.

## Failure and acceptance

Missing exact dependencies prevent publication; they cannot cause fallback to
unrelated content. Restore/rewrite changes `dataEpoch` and fences old commands,
search handles and worker leases. Revocation/erasure applies to exact history,
media, discovery and exports as well as root pages.

The first acceptance proves authenticated guarded persistence, the integrated
Space/classification/Main Version journey, rejected/stale commands, receipt retry,
text addition/deletion, and restart/restore with required objects and authority.
Later domain/source/package capabilities retain their owners without blocking
the initial launch merely through an empty directory or interface scaffold.
