# Source, media and delivery workers

## Execution contract

Workers consume committed bounded intents and invoke the authoritative owner.
They hold scoped service identities, input snapshots, generation/lease tokens,
deadlines, cancellation and durable checkpoints. They cannot directly rewrite
another module's native facts or bypass the caller's delegated ceiling.

Source workers fetch current official contracts/data under provider rate/size/
redirect limits, preserve observations and propose mappings. Media workers verify
quarantined bytes and transform exact inputs. Delivery workers recheck recipient,
preferences and disclosure before external effects. Projection workers coalesce
affected roots and build recoverable generations.

## Scheduling and backpressure

Use JetStream pull consumers with bounded batches/bytes/ACK backlog and persisted
job state. Separate high-cost imports/builds from latency-sensitive product work
even when they share a principal host. Concurrency budgets consider CPU, RAM,
storage I/O and downstream capacity together. Retry with finite backoff and
terminal disposition; never move unbounded queues into an outbox or WAL slot.

## Recovery

ACK after the effect or durable continuation is committed. Detect expired source
frontiers and rebuild rather than silently skip. Every page/activation rejects
stale fences and current erasure/revocation. Unknown external outcomes reconcile
with provider receipts. Observe queue age, throughput, retries, dead letters and
generation lag. Test crash/restart at each durable boundary.
