# Database restore before traffic

Status: **unexercised until hosting is selected**. Performance owns this operational procedure. Hosting, backup
storage, credentials, retention and the deployment operator remain unchosen external conditions. The recommended
starting point is nightly base backups plus WAL archiving to maintainer-controlled object storage with PITR;
provider availability and cost still need selection. This document neither provisions nor certifies that system.

The policy owners are [architecture](../architecture.md), [deletion](../deletion.md#account-erasure),
[Auth admission](../../services/auth/README.md#restored-database-admission),
[Access replay](../../services/kernel/src/access/README.md#auth-obligation-discovery) and
[external copies](../../services/auth/src/external-custody-contract.md#restore-admission-and-replay).
This is the A1 operating procedure with A6's hosting limitation. Module contracts continue to own runtime behavior.

## 1. Close admission and establish the recovery boundary

1. Keep the target isolated before restoring bytes. Block public and internal serving, issuer startup, old and new
   application executors, scheduled/DBOS recovery, mail/log collectors and replica promotion. Permit only the
   recovery operator and explicitly isolated replay composition. Fence old deployments too; a load-balancer switch
   alone cannot fence their writers. Verify those gates through the selected hosting controls before proceeding.
2. Inventory each affected database and every replica, WAL archive, snapshot, dump and derived restore. Record its
   nonsecret database identity, source cluster/timeline, backup capture point, recoverable committed tail and storage
   entry/version outside the restored image. Keep credentials and private keys in their respective owners' stores.
   Preserve surviving source evidence before recovery overwrites anything; an old snapshot cannot establish it.
3. For an Auth-only restore, retain an independently current Access source and recover Auth's original committed
   progress beyond its backup. For a joint Auth/kernel restore, require **point-in-time recovery to the latest WAL**
   for both databases, including every committed erasure confirmation and Auth native continuation. Verify each
   timeline and final replay LSN against its independently retained WAL boundary. A matching pair of old snapshots,
   or merely the end of an incomplete archive, is insufficient. Missing WAL or an unproved latest boundary stops
   recovery; do not choose an earlier convenient point or treat an absent obligation as no deletion.
4. Use the selected PostgreSQL/hosting restore and WAL-replay operations while gates remain closed. There is no
   installed production backup, PITR or traffic-gate command in this repository. Obtain their exact procedures and
   independent boundary verification from the chosen operator before execution. The workspace `db migrate` and
   `db dump` commands are schema operations, not data backup/restore or WAL recovery.

## 2. Give every restored database a new incarnation

Decision: store a random operational incarnation in an operator-owned table in each restored database; it supplies
no runtime admission proof and requires no physical-owner ABI.

After physical recovery finishes, connect separately to each restored database as its recovery administrator using
`psql -X --set=ON_ERROR_STOP=1 --dbname=<operator-connection>` and run this SQL. Connection credentials come from the
selected operator's secret mechanism. Reserve `restore_operations` for that administrator; stop on a conflicting
schema/table owner or shape. Do not grant application roles write access.

```sql
BEGIN;
CREATE SCHEMA IF NOT EXISTS restore_operations;
REVOKE ALL ON SCHEMA restore_operations FROM PUBLIC;
CREATE TABLE IF NOT EXISTS restore_operations.incarnation (
  singleton boolean PRIMARY KEY CHECK (singleton),
  incarnation uuid NOT NULL
);
REVOKE ALL ON restore_operations.incarnation FROM PUBLIC;
INSERT INTO restore_operations.incarnation VALUES (true, gen_random_uuid())
ON CONFLICT (singleton) DO UPDATE SET incarnation = EXCLUDED.incarnation
RETURNING incarnation;
COMMIT;
SELECT current_database(), incarnation FROM restore_operations.incarnation WHERE singleton;
```

Save the returned UUID against that database's external recovery inventory entry. Reconnect and read it back;
require exactly one row, the expected database and a UUID different from its captured prior incarnation. Generate
independently for every restored database. A newly materialized replacement image gets another UUID; resuming replay
on the same image reads its existing UUID instead of rerunning the write. This operational table is created by the
operator, has no installed application reader and cannot replace verified Auth image identity, immutable source
obligations or native domain guards. Do not rewrite those guards to make admission pass.

The SQL uses PostgreSQL's [random UUID function](https://www.postgresql.org/docs/current/functions-uuid.html) and
ordinary SQL through [psql](https://www.postgresql.org/docs/current/app-psql.html); no restore-stamp CLI is installed.

## 3. Invalidate proofs before any issuer or verifier serves

Rotate the **Access proof-signing key**, including every trusted composition's proof/reference sealing ring.
Installed Access references use HMAC-SHA-256 through
[`KeyRing`, `seal` and `unseal`](../../services/kernel/src/tokens/seal.ts), with `referenceKeys` supplied to
[`createRegistrationProofBindings`](../../services/kernel/src/access/registration-proof.ts) and other capability
factories. Supply a fresh random key of at least 32 bytes, choose its active ID (0–255), and remove every pre-restore
proof key from every verifier's accepted ring. Selecting a new active key while retaining the old verification
keys still accepts old proofs. Recreate all affected instances and caches under the closed gate; fence old instances
and secret versions so they cannot rejoin. `KERNEL_SESSION_KEYS` configures the server's token ring, but does not
prove that separately injected `referenceKeys` were replaced. Inventory and rotate those compositions explicitly.

There is no global Access proof-key rotation CLI or production secret-distribution operation here. If any minting
or verification composition cannot be identified and replaced, stop. Do not erase `KERNEL_RECEIPT_KEYS`: those are
separate permanent receipt-lookup keys needed to recover original obligations, retained until receipts are re-keyed.
Auth's ES256 `signing: { activeKid, privateKeys }` is also separate; ordinary Auth JWKS rollover retaining old keys
does not perform Access proof invalidation. Preserve Auth's owner rules and current account fences.

In isolated verification, require a saved pre-restore Access proof to fail at every affected verifier and a newly
minted proof to verify cryptographically while still obeying current authority. This is a future operator release
gate, not a proof campaign delivered here. Missing fixtures or an unexercised verifier keeps traffic closed.

## 4. Replay post-backup erasures and close the live tail

Use the permanent Access erasure ledger through the independently recovered latest boundary. Replay **every erasure
committed after each backup point before traffic**, and revisit earlier obligations whose bytes/completion markers
the image reintroduced. Preserve original route/account/version/T, captured floor, applicability and first consent
due time. Never resurrect an account, reuse its ID, reset an obligation or restart the original 310-second delay.

Installed native operations are bounded library ports, not an operator replay command:

- Access `createAuthErasureObligationBindings(pool)` supplies partitioned cut/page/point verification; trusted
  `createAuthErasureLiveBindings(pool, receiver)` enrolls the tail against the same tombstone append fence.
- Auth `createAuthRestoreHost` exposes isolated `start` / `reconcile` / `stop`, with no HTTP handler, issuer or SDK
  recovery. Its restored-generation composition requires a real `AuthRestoreDatabaseOwner`, original obligation
  ports and live receiver. Reconciliation imports original progress and redrives native pages/checkpoints.
- Reconcile all 4,096 Source partitions, following native pending/next states and original cursors. Empty pages,
  sealed cuts or a sampled current account are insufficient. Consume live obligations between cut and arm and keep
  live fencing active through cutover. Missing original floor, Auth tail or consumer continuation stays pending.
- Redrive each applicable kernel owner, native child, shared-history copy, receiving copy and external obligation
  through its existing erasure engine; Auth replay alone cannot clean all kernel owners. Reconcile both endpoints'
  lineage and tails for restored Access live-copy domains before any positive resume.

No installed database-owner implementation verifies independent backup lineage, committed native tails and final
physical/receiving closure. No production CLI orchestrates all-owner replay or final admission. These are explicit
missing operations: retain isolation until real composition and operator verification exist. Auth's older external
contract describes required interfaces; its delivered native ports are detailed in the newer module README.
`external-owner-pending`, `receiving-closure-pending` and other pending states are stop conditions. A restored done
marker, callback, TTL or final coordinator status cannot establish external cleanup or backup expiry.

## 5. Verify, release or recover

Before release, the operator must verify all of the following against independent records:

- Each database has the expected image/lineage, latest required WAL boundary and newly read-back incarnation.
- Every old proof key and old executor is excluded; stale proofs fail and fresh proofs retain current fence checks.
- Every relevant erasure through the recovered boundary has replayed in this image, including reintroduced payload;
  original native evidence and consent timing agree. Erased accounts cannot authenticate or disclose personal data,
  late retries cannot revive them, and unrelated living accounts retain their data.
- Required native, receiving and external cleanup has completed, and live Source enrollment prevents a deletion
  racing release. Record outstanding isolated backup expiry separately; it never permits serving restored payload.
- The actual deployment gates admit only this recovered generation and keep old replicas/writers fenced.

If any condition is unknown or fails, keep all traffic and issuers closed. Today the missing production operations
and unchosen hosting prevent completing this gate; this runbook remains unexercised. After all conditions are met,
the selected operator opens admission through its documented deployment controls while maintaining live fences.

On a crash, resume the same isolated image, incarnation and durable replay checkpoints. On wrong lineage, missing
WAL, mismatched immutable evidence or failed cleanup, quarantine that image and recover again from verified inputs.
Rollback may return traffic only to an independently current deployment that already enforces every committed
erasure and the new proof-key boundary. Otherwise remain offline. Never roll back to an old snapshot/key set,
clear permanent fences or lower an epoch to regain availability. A replacement restore repeats this procedure.
