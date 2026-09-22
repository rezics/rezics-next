# Backup, restoration and failure recovery

## Recovery set

Capture PostgreSQL backups/WAL position, Fluree commits/index objects and nameservice
heads, required coordination state, content/media/artifacts, routing epochs, model/
analyzer/deployment manifests and protected key material. Operation receipts,
outbox progress, consumer checkpoints and erasure/revocation frontiers are required
state. Derived indexes can be rebuilt only when their source and recipe survive.

## Cross-store manifest

Each backup set records exact component positions and dependencies. Independently
taken snapshots are not assumed globally atomic. Use a bounded write barrier when
an exact coordinated point is required, or restore to an explicitly reconciled
cut with retained events and owner receipts. Record missing coverage as a failed
backup qualification rather than calling a partial copy complete.

## Restore procedure

Restore into isolation with side effects disabled. Verify content hashes and
compatible binaries/manifests; restore private identities and authority/erasure
fences; resolve graph history/payload references; reconcile operations and event
frontiers; rebuild projections; run allowed/denied and exact-reference probes;
then activate routing and delivery. Restored old data cannot resurrect erased
content, revoked credentials or duplicate external effects.

Retain a separately recoverable authority/erasure journal with a frontier at least
as new as the protected state being reopened. An older backup alone cannot prove
that no later revocation or erasure occurred. If the required journal coverage is
lost or uncertain, keep the affected protected datasets and outbound effects
offline until authoritative reconciliation establishes the safe frontier.

## Failover and objectives

Fence the previous writer before promoting another. Inspect unknown transaction
outcomes through receipts. Define RPO/RTO by owner and tested failure class; do
not claim zero loss from replication or backup schedules alone. Measure restore
time on available hardware and preserve off-host backup access if the principal
host is lost. A recoverable manual outage is an accepted initial operating model.

Drills cover principal process/host loss, corrupted/missing object, lost relay
checkpoint, expired broker retention, upgrade interruption, key loss/rotation,
historical anchor resolution and erasure before replay.
