# Native commands

[The executor](command.ts) owns native command transactions, principal-scoped idempotency receipts and the
atomic domain/receipt/outbox envelope. [Access](../access/README.md) owns authorization; this module does not
duplicate its permission formula. [Commerce](../commerce/README.md#receipt-aware-native-refresh-admission-implementation-pending)
owns payment refresh composition. The metadata-only helper below is implemented in this core; Commerce refresh
admission remains an adopted contract with implementation and native schedule gaps.

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

The command core implements this helper with a narrow [digest projection](read-own-completion.sql) of the same
receipt authority/key as the native [receipt reader](read-receipt.sql), using the [executor rules](command.ts).
It answers only whether a matching command completion exists: `true` for matching completion, `false` for absence. Digest mismatch remains the native
idempotency conflict, not `false`. It never returns a stored response, historical domain snapshot, receipt object
or payload-derived digest. It must work when response payload has been minimized but completion metadata is
legitimately retained; payload availability is not a completion requirement.

Use it only inside a live authorized native transaction. Validate the executor's current principal, partition,
native key and digest with its existing rules. Callers cannot supply a different principal or partition.
Reject calls outside that authorized live phase, including preparation, before authorization and after commit;
a pooled client, live-but-not-authorized transaction or copied/expired context is not a receipt capability.
The executor holds the normalized owner in a private WeakMap keyed by the exact transaction object, installed
only after execute authorization succeeds and removed before commit/rollback and on every attempt exit. A passed deadline
also expires the capability. Neither the public command context nor copied transaction descriptors convey it.
Commands without identity or explicit completed authorization have no receipt owner capability.
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

[Native own-completion tests](../../test/command/own-completion.test.ts) use real `runCommand`, PostgreSQL,
Auth/JWKS, installed Access grants and anonymous resource eligibility. They cover same principal/partition/kind/key
completion and absence, digest conflict, native syntax validation, principal/home isolation, the original apply
policy's denial before lookup, minimized responses, and rejection of pooled/preparation/before-authorization,
expired/copied/rolled-back/committed and identity-free contexts. Actual captured SQL selects only `request_digest`
with the full receipt key; large and minimized stored responses return the same metadata bytes. Read-only helper
commands use `noEffect` without a receipt and leave the partition head, receipts, events and write basis unchanged.
Legacy account writers and principal callers share the receipt namespace, and ordinary replay retains its response
and original transaction identity. Existing native replay, receipt-only and `noEffect` suites remain required.
These core tests establish no Commerce claim, combined routing or cancellation-to-commit exclusion.

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
  context cases and measure examined rows, buffers, statements and bytes. The native own-completion growth test
  seeds 512/4,096/32,768 legal same-owner, same-partition unrelated receipts with the selected keys fixed. It captures
  actual plans, rows, buffers, statements and wire bytes for matching/absent/conflicting/minimized cases and a denied
  zero-lookup path. It requires constant rows/statements/bytes, logarithmic blocks and no receipt sequential scan.
  The separate expired-context test requires zero receipt statements. The check log records the measured samples.
