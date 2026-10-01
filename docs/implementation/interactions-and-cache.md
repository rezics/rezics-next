# Interaction graph and cache bootstrap

The proposed first durable like/favorite authority is Main's Jena product
dataset, with private Access authority in PostgreSQL inside Main. A small
interaction edge permits content joins without a second authoritative write
store. [TAO](https://www.usenix.org/system/files/conference/atc13/atc13-bronson.pdf)
shows a graph API can use relational persistence and caches; it does not require
REZICS to copy likes between databases. [LIquid](https://www.linkedin.com/blog/engineering/graph-systems/liquid-the-soul-of-a-new-graph-database-part-1)
supports useful graph joins, not this exact physical design.

Access's [interaction decisions](../../services/main/src/modules/access/interaction-decisions.ts)
admit or refuse interactions. They do not implement durable like/favorite state,
desired-state commands, revisions, receipts, outbox or bounded reads. Those
commands and their denied, concurrent, stale and recovery outcomes need a
separate feature delivery and acceptance. [Commands](../contracts/commands.md),
[votes/references](../contracts/votes-and-references.md) and the
[authorization bridge](authorization-bridge.md) remain the applicable contracts.

## Cache evolution

Redis is deferred beyond the first interaction delivery. It can reduce repeated
read and aggregate work after measuring hot-target counts, commit queueing,
projection lag and mixed traffic; it cannot increase TDB2's durable write rate.
A cache is a derived snapshot, never the authority for a confirmed click or
current disclosure. [Memcache leases](https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf)
and [Meta's stale-fill account](https://engineering.fb.com/2022/06/08/core-infra/cache-made-consistent/)
motivate guarded fills and recovery after eviction, but do not qualify a REZICS
Redis implementation. Adding one would require separate stale-fill, replay,
flush and privacy tests. A separate SQL/KV interaction authority needs measured
write pressure and an explicit projection freshness contract.
