# Initial host deployment

Start with one Fuseki JVM owning local TDB2 and Lucene, Main and Account on Bun,
and separately owned PostgreSQL data for Content, Account, Access and operations.
Only Main and admitted maintenance tools may reach Fuseki. The principal host
holds stateful services; a second host may run API/edge or Account over
authenticated private calls. The available 16-core/64GB and 12-core/32GB hosts
are placement constraints, not qualified production capacity. Keep encrypted
complete recovery sets and pinned release artifacts under separate custody.

Inventory durable disk, IOPS, backup bandwidth, page cache, JVM heap, Lucene
merge space, PostgreSQL WAL, object staging and other host workloads before
setting process and worker limits. One JVM owns each TDB2 directory; a second
host cannot mount the live files as a replica.

## Practical load objective

`task load` runs the named host profile. Its executable thresholds and
evidence checks live in [the load runner](../../scripts/load/practical.ts) and
[OPS05 cases](../../scripts/qa/cases/operations.ts). The recorded
[qualification](../plan/qualification.md) applies only to its exercised
fixture and host. Storage and restore capacity for 500 million entities, and
the three-billion-entity scenario, require separate measurement. Preserve
failed attempts and distinguish setup cost from measured request latency.

## Failure and upgrade model

A principal-host failure causes an outage. Fence its writers, capture or choose
a complete stopped recovery cut, restore into separate writable volumes,
verify Account, Access, Content, graph/text generations and exact samples, then
route manually. The [OPS02 drill](../../tests/qa/fault-recovery/second-host-format-upgrade.test.ts)
simulates this locally; it does not measure cross-host transfer or physical
host failure.

For a format upgrade, hold Main admission, reconcile uncertain receipts, retain
the complete recovery set and format marker, close the Access recovery fence,
then stop the one Fuseki writer and other application writers. Run only a
compatible pinned release. A failed incompatible conversion leaves the
candidate offline; restore its matching prior bytes and marker into an isolated
project, check current and exact reads plus authority, and promote manually.
The [OPS04 drill](../../tests/qa/fault-recovery/second-host-format-upgrade.test.ts)
exercises a small Access format rewrite and rollback. Production rewrite and
cross-host recovery time remain unmeasured. Follow the
[recovery runbook](recovery.md) for owner cuts and search reconstruction.

## Email rollout

Configure `ACCOUNT_SMTP_*` and `ACCOUNT_EMAIL_FROM` from
[Account's example environment](../../services/account/.env.example).
Development uses Mailpit; a remote sender needs verified identity, TLS,
bounce/complaint handling and separately held secrets. Account mail serves
security and recovery. Optional notification mail requires consent,
suppression and signed unsubscribe before rollout. Inspect uncertain delivery
counts before retrying after a lost acknowledgement.

## Commercial rollout

Only the fake payment adapter is admitted. Select a real provider, currency,
tax, collection, refund and payout policy before taking transactions.
Seller onboarding and persistent hosting need their own operating arrangements.
