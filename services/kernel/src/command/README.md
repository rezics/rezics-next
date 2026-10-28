# Native commands

[The executor](command.ts) owns native command transactions, principal-scoped idempotency receipts and the
atomic domain/receipt/outbox envelope. [Access](../access/README.md) owns authorization; this module does not
duplicate its permission formula. [Commerce](../commerce/README.md#receipt-aware-native-refresh-admission-implementation-pending)
owns payment refresh composition. Its admission and the helper below are adopted contracts, not implemented exports.

## Existing execution and receipts

`runCommand` validates native identity, partition, key and digest, prepares separately anchored authorization
without holding the resource connection, and runs the final authorization inside each serializable attempt.
Authorization precedes own-receipt lookup and body execution. A matching receipt replays before the body;
a changed digest raises `IdempotencyConflictError`. Receipt-only authorization retains its existing meaning.
Current principal kind/id, partition, command kind and native idempotency key identify the receipt; token bytes
and attribution are not an alternate principal. Native keys and SHA-256 digests retain the executor's existing
validation rules, including the 1–255-character key and exactly 32-byte digest requirements.

Successful domain mutation emits registered events and commits through the partition fence with its receipt
and envelope. SQL retries do not authorize reuse of stale external evidence. `noEffect` asserts that the body
wrote no domain data; it cannot hide coordination writes or registered work. Authorization finalizers are not
a place to conceal domain mutation. Existing replay, receipt, authorization and `noEffect` semantics stay unchanged.

## Metadata-only own completion

The approved additive interface is:

```ts
hasOwnCommandCompletion(tx, { kind, key, digest }): Promise<boolean>
```

This helper does not exist yet. Its implementation belongs in the command core, reusing the native
[receipt reader](read-receipt.sql) and [executor rules](command.ts). It answers only whether a matching command
completion exists: `true` for matching completion, `false` for absence. Digest mismatch remains the native
idempotency conflict, not `false`. It never returns a stored response, historical domain snapshot, receipt object
or payload-derived digest. It must work when response payload has been minimized but completion metadata is
legitimately retained; payload availability is not a completion requirement.

Use it only inside a live authorized native transaction. Validate the executor's current principal, partition,
native key and digest with its existing rules. Callers cannot supply a different principal or partition.
Reject calls outside that authorized live phase, including preparation, before authorization and after commit;
a pooled client, live-but-not-authorized transaction or copied/expired context is not a receipt capability.
There is no public endpoint, module-local receipt SQL, anonymous/staff bypass, new permission or receipt oracle.

Retain the original apply authorization policy for the queried intent. Being authorized for some admission
command, or owning a receipt, is not authority for a different action/resource. The helper adds no authorization
alternative and does not move `runCommand` receipt lookup ahead of authorization. Current command context alone
must not be interpreted as permission to inspect arbitrary intents owned by that principal.

Commerce calls this helper only after normal service admission and the native order lock for the same immutable
order/Session/stable apply intent. That lock must cover the completion check and any subsequent claim. Matching
completion exits without domain mutation or provider read, using a rollback sentinel or native `noEffect` only
when this transaction wrote no domain data. An uncompleted intent may then perform a real revision claim with
the existing order-updated event, receipt and envelope. A completed A retry must not advance revision over
inflight B and then acknowledge A's old effect. The helper supplies completion metadata, not order locking,
refresh authority or cancellation-to-commit exclusion.

## Required native scope proof

Core implementation and native scope tests follow separately; this document reports no runtime pass. Require
actual executor/SQL tests for same principal/partition/kind/key matching completion and absence, changed-digest
conflict, native key/digest validation, different principal/partition isolation, authorization denial before any
lookup, original apply action/resource policy, and no response payload exposure. Verify matching completion
with minimized response payload. Reject prepare/before-authorization/after-commit and expired/copied contexts;
preserve existing replay and receipt-only semantics without an anonymous or staff bypass.

Commerce's native default-worker/HTTP fixture proof must also cover completed A retry while newer B is admitted,
checking the same locked order and unchanged revision/provider-read count, plus crash-after-commit replay.
Test barriers observe and control timing; they never replace native receipt, queue, CAS or settlement policy.

## Cost

### Metadata-only own completion lookup

- Touches: one stable completion PK under the current authorized principal and partition, native key/digest
  validation and live-context checks. No history scan, payload disclosure, domain mutation or cross-home checkout.
- Bound: constant keyed lookup work; a selective B-tree probe has logarithmic blocks as unrelated receipts grow.
  Charge metadata bytes, actual statements, retries and pool time. Authorization and a caller's order lock/claim
  retain their own costs; this helper does not establish their bounds or shared dispatcher cost.
- Growth check: require real native matching/absent/conflicting and minimized-payload lookups at three legal
  unrelated-receipt/history scales, holding the selected key and metadata size fixed. Include denied and expired
  context cases and measure examined rows, buffers, statements and bytes. These measurements are missing.
