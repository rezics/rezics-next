# Account identity source consumer custody

`identity-source-consumer-custody.ts` owns the original Account identity source consumer
receipt. Its exported reference binds the exact receipt, accepted current job, original
native source component and digest, History barrier and erased logical field. Position
is bigint; original epoch is never replaced by the current owner epoch. This receipt is
neither permission nor a History artifact. Accounts owns the independent current erasure
root, original source minimization and all generated-copy associations and receipts.

## Native preparation

Verification resolves the actual `readAccountIdentityUndo` source and accepted job, including
after the account's terminal fence. Reversal reads its original Accounts source and calls
`lookupIdentityBinding` with that exact original input. Its prior `intent.undoJob` is never
used as the current job. Missing hints stay pending; preparation never admits or binds a new
receipt. Accepted claim key, digest, scope, sources, generation and binding transaction are
resolved from the actual native claim under its current owner. Logical requester and decider
are checked against the native source's actor and editor roles respectively; subject is the
source account. These names introduce no History role or permission.

The producer releases each home before probing job/control and the three fixed mapping,
Search and ALL Library receipts. It reconciles their exact native receipt, scope and complete
frontier through `identityEpochStore.reconcileStepReceipt`. Publication is a prerequisite,
never discharge. No point receiving record proves all receiving consumers have closed.

After releasing foreign checkouts, the original source home independently rechecks the source,
claim and current owner and commits one immutable **retained** obligation in
`semantic.identity_epoch_source_consumer_custody`. Its natural key is
`(partition_no,receipt_key,source_digest,barrier_account_id,barrier_version,barrier_at,erased_role,binding_generation)`.
`receipt_key` is the existing JSON `[kind,account,receipt]`. Native source epoch/position/
transaction, accepted job/epoch, scope and binding transaction are fixed columns, not JSON
evidence or new receiver UUIDs. No intent, reason, requester, decider or private payload is
mirrored. This is a custody receipt for the existing source, not another source registry.

The receipt is serialized through the real command executor and `erasure_source_commit`,
and enrolls all actual source roles with the existing Semantic native producer trigger and
locator plumbing. The default minimizer defers it: a retained receipt still has personal
locators and cannot acquire a retained-nonpersonal disposition or family acknowledgment.
This keeps the original source and surviving verification's undo/intent support pending.

## Remaining native consumer producer

The required missing producer type is **`IdentitySourceConsumerDischarge`**. This names a
dependency request, not a delivered interface, serialized proof or caller-supplied flag.
It must enumerate the complete bounded original admission/replay and receiving dependency
cut, including every OLD/NEW/first-apply/handoff scope, future verification undo and admitted
in-flight reversal/replay. It must serialize that cut durably against later consumers and
bind current native owner/restore and replay/undo generations. For transfer it must also
prove the genuine receiving owner's acceptance of the exact immutable technical obligation
and its continued proof needs. Its final receipt must be consumable and lockable at the
original source home without foreign I/O in the caller's command.

Existing `IdentityReceivingRecord` and `IdentityScopedObservations.finish({records})` do not
provide that exhaustive cut; the scoped observations factory is currently unavailable.
Neither participant ACKs nor published coordinator state fills the gap. Consequently the
read port currently commits useful native retention preparation but returns null, and the
verify port never accepts retained observations as terminal custody. There is intentionally
no terminal state setter, exported proof constructor or optimistic cleanup path. A future
consumer serializer must add the real durable discharge/transfer transition and its same-home
verification; a released pre-read or matching stale generation cannot substitute for it.

## Cost and evidence

Reads address the exact original source/claim, one job/control and three fixed participant
receipts, with released homes between stages. Source-home preparation and verification use
fixed indexed points and no global job, history or JSON scans. Scope and source observations
keep their existing native page budgets; no new receiving enumeration is invented. The
receipt grows with changed exact source/barrier/role keys, not group membership. Repeating a
retained preparation reuses the durable row. Missing consumer or copy coverage stays pending.

Focused native tests are authored in the existing fixture style and deferred. Local typing
validates implementation structure only; it does not establish native discharge, all-copy
closure, erasure completion or completion of the Source Goal.
