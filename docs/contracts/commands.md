# Commands, transactions and cross-service consistency

## Command envelope

Commands carry an operation ID, idempotency key, canonical request digest,
verified principal/context, target reference, expected revision, contract version
and bounded input. The server supplies trusted identity, admission and deadlines.
Reusing a key with another digest is a conflict, not another operation.

## Local atomic boundary

The authoritative transaction commits domain changes, revision/selection anchor
metadata, an OperationReceipt and outbox batch together. TDB2-backed commands use
one guarded SPARQL Update request through Fuseki's jena-text dataset wrapper;
private PostgreSQL owners use their own local transaction. A receipt written only
to another database cannot prove that the domain mutation occurred atomically.
Immutable object payloads/manifests are verified and retained before activation;
their upload is separate from the RDF transaction.

The guard constrains the exact target, expected component head, create-only or
uniqueness predicates, admitted data/routing epoch and every mutable local
validation dependency, including selected model/shape heads. A remote preflight
read or SHACL report does not lock those facts. Separate HTTP read, validation and
update requests are never treated as one server transaction. If the read set
cannot be guarded within budget, stage an immutable generation or reject that
write profile until its invariant can be enforced.

A matching guard writes one application source position
`{datasetId, dataEpoch, sequence}` with the receipt/outbox. The transaction reads
and increments sequence internally; callers do not use the dataset counter as a
global expected head for unrelated resources. TDB2's one-writer execution is an
engine boundary, not a reason to hold it during network I/O or external validation.

An unmatched update may return HTTP success. Resolve the command's own receipt
after success or timeout: matching digest returns the saved outcome/result;
a different digest conflicts. With no receipt and guards still valid, the result
is pending/unknown and may retry identically. When finalizing a stale, rejected,
no-op or cancelled outcome, write that terminal receipt in a transaction guarded
by receipt absence and any observed state used for the decision. It races with
the original update on the same receipt identity; the winner fixes the outcome.
Read it again before replying. A larger dataset sequence is not proof of success.
The [Jena protocol](../storage/jena.md#guarded-http-command-protocol) gives the
concrete update and reconciliation rules.

Receipts have a declared retention/replay horizon. After expiry, retries cannot
silently become new side effects: reject expired keys or retain an appropriate
operation identity tombstone. A new restored data epoch does not reset idempotency.
An old-lineage request with a preserved receipt can resolve that outcome; a
missing receipt after rollback requires recovery reconciliation, not fresh
admission of the same logical effect. Broker dedupe windows and old backups are
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
| Read after local write | Carry owner/dataset/dataEpoch/sequence fence; verify it with the data read and a deadline. |
| Exact historical read | Resolve immutable component manifest/payload and current disclosure; unavailable stays unavailable. |
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
Large topology/import/rebuild operations stage pages, reconcile intervening head
changes and activate one validated generation. Stale workers fail at every page/activation.
Failed staging never replaces the active generation. Cancellation distinguishes
stopping future work from reversing already committed effects.

Qualification must cover competing expected-head edits, same-key retries,
lost responses, zero-match conditional writes, stale workers, grant revocation,
cross-service partial completion and restore/replay. See [invariants](system-invariants.md).
