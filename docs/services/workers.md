# Source, media and delivery workers

The installed Main relay polls committed, bounded owner outbox batches and
retains a private handoff. [Event and job contracts](../contracts/events-and-jobs.md)
describe the source position and the remaining consumer obligations. General
source, media and external delivery workers are prospective; their complete
lease, capacity and recovery contracts still need owner code and fault tests.

## Worker intent

Workers consume committed intents with scoped service identity, exact input
snapshots, data/routing/authority/erasure fences, leases, deadlines and durable
checkpoints. They submit commands to the authoritative owner. They do not write
Main RDF directly, open live TDB2/Lucene files or exceed delegated ceilings.

Source workers limit provider rates, sizes and redirects, preserve observations
and propose mappings. Media workers verify quarantined bytes before transforming
exact inputs. Delivery workers recheck recipients, preferences and disclosure
before external effects. Product projection coalesces affected roots and submits
owner commands. Fuseki's wrapper maintains the ordinary jena-text index.

Content projection consumes exact PostgreSQL revisions and semantic events with
separate checkpoints. It fetches bounded batches and extracts text outside graph
transactions, then materializes derived units with guarded commands. A stale
worker cannot activate superseded or erased content. Publication and search
readiness remain separate; [search binding](../contracts/search.md#postgresql-body-projection)
owns staging and reconstruction.

## Activation and recovery

The first scheduler can be a bounded poller inside an owner process. Add a
broker or independent worker fleet only when fan-out or isolation needs it.
Bound undelivered work and expose its oldest age. Separate expensive imports
from latency-sensitive work and budget CPU, memory, disk and downstream load.
Large Lucene reconstruction is stopped-Fuseki maintenance.

Advance progress only after the effect or durable continuation commits. Detect
expired frontiers and reconcile or rebuild. Every page and activation rechecks
the current generation and fences. Resolve uncertain external outcomes from
provider receipts before replay. Observe queue age, throughput, retries,
terminal items and projection lag; test restart at each implemented durable
boundary. An index's existence does not prove its generation is valid.
