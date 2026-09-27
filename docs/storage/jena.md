# Apache Jena storage and query binding

## Selected launch profile

One private Fuseki JVM owns the `product` TDB2 directory and its jena-text/Lucene
index. Main and workers use HTTP; a second host supplies application capacity and
recovery storage, not another live writer or a TDB2 replica. This keeps graph and
text queries together while PostgreSQL owns Content bodies and private authority.
The [assembler](../../infra/jena/fuseki-text.ttl) configures the dataset; the
[release manifest](../../scripts/dev/release-manifest.ts) pins the deployed image.

TDB2 transactions permit one writer and concurrent readers. Its MVCC snapshots
are not permanent product history. Application revisions and retained manifests
provide exact history; a `datasetId` remains stable when the HTTP route moves.
[Jena transactions](https://jena.apache.org/documentation/tdb/tdb_transactions.html).

## Application source positions

The graph owner's `{datasetId, dataEpoch, sequence}` position orders admitted
commands only within one epoch. Restore or cutover that cannot prove lineage
continuity must fence the old writer and allocate a new epoch. Routing has its
own epoch. A data read checks its fence in the same query; a separate position
request does not give a shared snapshot. Search also requires an index readiness
proof. The [command adapter](../../services/main/src/infrastructure/fuseki.ts)
and [history resolver](../implementation/graph-records.md#revision-anchor-resolver)
carry these contracts.

## Transactional command endpoint

An ordinary Fuseki update request is one transaction, but two remote requests
are not one transaction; an unmatched update can return HTTP success. Admitted
commands use the private command module, which checks guarded effects, receipt,
outbox and validation within its write transaction on the text-wrapped dataset.
The [module](../../infra/jena/command-module/src/main/java/com/rezics/jena/CommandService.java)
and [Main adapter](../../services/main/src/infrastructure/fuseki.ts) define the
wire contract. Main reconciles uncertain outcomes by receipt identity, not HTTP
status or an advanced sequence. [Remote transaction boundary](https://jena.apache.org/documentation/rdfconnection/#remote-transactions).

## Editorial protection and immutable record enforcement

The [editorial protection contract](../contracts/editorial-protection.md) and
[prospective acceptance](../testing/editorial-protection.md) state the additional
owner checks required before a protection profile is qualified. Existing Work
head checks alone do not qualify every protected target or writer.

## Exact history and index recovery

Lucene is derived state. A crash, offline load or analyzer change can make text
readiness uncertain even when graph receipts are intact. Hold text reads, rebuild
from a verified source cut, check membership and configuration, then reopen.
The [recovery procedure](../operations/recovery.md) owns the operator steps.
This binding does not establish cross-store atomicity, live graph replication or
permanent RDF/Lucene snapshot equivalence.
