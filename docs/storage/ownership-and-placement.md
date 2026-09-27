# Data ownership and physical placement

## Authority map

Each authoritative component has one writer. Main owns semantic facts in Jena
and Content revisions in PostgreSQL; Account and Access own separate private
state. Exact cross-owner references and outboxes coordinate distinct commits,
without making those stores one transaction. Search and convenience projections
are rebuildable. The [service boundary](../architecture/services.md) explains
the ownership decision; owner schemas and [recovery coverage](../../tests/qa/unit/recovery-coverage.test.ts)
carry the current state inventory.

The initial graph is one `product` dataset in one Fuseki JVM. Splitting it before
measured writer or lifecycle pressure would add cross-dataset coordination to
ordinary changes. A second host does not provide a live TDB2 replica. Stable
UUIDs and IRIs do not encode a host or shard; a locator is neither an existence
proof nor permission authority.

## Movement procedure

To move an owner, stage the target and retained objects, stop admission, drain
the old writer, verify the final source frontier, then activate routing with a
new data epoch. Retain the old copy for a recovery window and verify exact old
revision resolution, receipts, consumer progress, authority and erasure fences
before collection. Never admit both copies as writers. This procedure requires
a maintenance window; it promises no live replication or zero downtime.

The [partition relocation test](../../tests/qa/fault-recovery/partition-relocation.test.ts)
exercises the routing fence. Storage and object provider changes need separate
qualification of their conditional writes, restore and disclosure behavior.
