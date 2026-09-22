# Commands, transactions and cross-service consistency

## Command envelope

Commands carry an operation ID, idempotency key, canonical request digest,
verified principal/context, target reference, expected revision, contract version
and bounded input. The server supplies trusted identity, admission and deadlines.
Reusing a key with another digest is a conflict, not another operation.

## Local atomic boundary

The authoritative transaction commits domain changes, revision/selection anchors,
an OperationReceipt and outbox intent together. A receipt written only to another
database cannot prove the domain mutation happened atomically. Fluree-backed
commands keep their receipt/event fact in the same ledger transaction; private
PostgreSQL owners use their own local transaction.

Conditional writes constrain the exact target and expected revision. Zero matching
rows are a typed stale/precondition result, not success. Another transaction may
advance ledger `t`, so comparing an old `t` with the response is insufficient.
Resolve the command's own committed receipt. Network timeout after submission is
an unknown outcome until receipt lookup/retry reconciles it.

Receipts have a declared retention/replay horizon. After expiry, a retry cannot
silently become a new side effect: reject expired keys or retain an operation
identity tombstone appropriate to the effect. Engine/broker dedupe windows are
not the application guarantee.

## Cross-service workflows

Use explicit durable states: planned, staging, ready, activating, active,
cancelling, failed and completed as applicable. Each step records prerequisites,
owner receipts, lease/fence and compensation. Compensation is a new authorized
operation and cannot erase independent human edits or external effects.

These are domain workflow phases/states. The common API operation status and
terminal result are defined separately in [the transport blueprint](../implementation/api-and-events.md#operation-representation-and-errors).

Examples include Agent provisioning plus representation, Realm admission plus
effective membership, media upload plus publication, and package installation
plus cataloged result. Expose pending state until required owners are ready.
Do not mark a workflow complete from message enqueue alone.

## Reads and authority

| Request | Required boundary |
| --- | --- |
| Read after local write | Carry owner/ledger/branch/commit fence and wait with a deadline. |
| Exact historical read | Resolve pinned source/component and current disclosure; unavailable stays unavailable. |
| Ordinary derived query | Report generation and freshness; no false exactness. |
| Cross-owner snapshot | Seal exact dependencies and validate the specified consistency contract. |
| Protected write | Bind authorization to subject, operation, target, expected state and admitted validity. |

Access admission has a defined linearization point. Revocation prevents later
admissions; already admitted work follows an explicit finite validity contract.
Operations requiring no old-authority effects after completion use a scope fence:
stop admission, drain/cancel admitted work, then acknowledge effective revocation.
Expiry alone is not that stronger guarantee. Domain CAS still protects resource
state while authorization remains valid.

## Bounded execution and failure

Bound batch size, bytes, affected entities, traversals, lock duration and retries.
Large topology/import/rebuild operations stage pages, catch up committed deltas
and activate one validated generation. Stale workers fail at every page/activation.
Failed staging never replaces the active generation. Cancellation distinguishes
stopping future work from reversing already committed effects.

Qualification must cover competing expected-head edits, same-key retries,
lost responses, zero-match conditional writes, stale workers, grant revocation,
cross-service partial completion and restore/replay. See [invariants](system-invariants.md).
