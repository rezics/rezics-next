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

## Terminal consumer composition

Source owns the terminal transition and local receipt. The original public reference,
read and verify signatures remain unchanged. The delivered
`identity-epoch-prearm-custody.ts` reader enumerates the retained admitted directory;
its opaque cut is verified before the final source command and is never persisted.
Library `readLibraryScopeEffectsPage` and `verifyLibraryScopeEffectsSeal` own expected
effects and their current seal. An unavailable implementation remains pending.

### Required bounded owner exchange

The following additive exports are required in the **original modules**. They are
requirements for owner delivery, not declarations of already implemented authority.
Types below are published by `identity-source-consumer-custody.ts`. No injectable
adapter or public proof setter is supported.

In `identity-epoch-binding.ts`:

```ts
readIdentitySourceConsumerWork(pool: Pool, reference: IdentitySourceConsumerReference,
  context: IdentitySourceConsumerContext): Promise<IdentitySourceConsumerWork | null>;
lockIdentitySourceConsumerCut(tx: CommandTransaction, reference: IdentitySourceConsumerReference,
  expected: IdentitySourceConsumerGeneration): Promise<IdentitySourceConsumerDisposition | null>;
verifyIdentitySourceConsumerCut(tx: CommandTransaction, reference: IdentitySourceConsumerReference,
  expected: IdentitySourceConsumerGeneration, disposition: IdentitySourceConsumerDisposition): Promise<boolean>;
```

`read` resolves native replay, undo and restore generations using the same live
`context.identityConsumerWork` frame. It charges that frame before its own native,
control and failed work; it performs no fresh identity admission. Its returned native
allowance is bounded directory planning data, never a second allocation or funding
from the accepted claim/job. Source separately charges its fixed local
claim/source/progress commands against this frame. The local `lock` resolves the exact original accepted
claim under the same binding lock used by admission/replay/undo/restore. It returns
discharged only after genuine native reversal and every surviving consumer is settled;
it returns transferred only when the immutable technical input remains indispensable.
Every later consumer must take that lock and consult Source's committed terminal row,
then use the native technical input or reject old-source use. A generation pre-read,
fixed publication state or current pending-job absence cannot implement this hook.
`verify` revalidates these native states in the caller's live original-home command,
including current owner/restore, without foreign I/O. It cannot accept caller stamps
as native truth. Existing readAccountIdentityUndo must use the genuine technical
source after transfer, retaining the original accepted job and input.

In `identity-scoped-observations.ts`:

```ts
readIdentityScopeConsumerWork(pool: Pool, ticket: IdentityPrearmTicketData,
  context: IdentitySourceConsumerContext): Promise<IdentitySourceScopeConsumerWork | null>;
retainIdentityScopeConsumerFence(tx: CommandTransaction, ticket: IdentityPrearmTicketData,
  seal: LibraryScopeEffectSeal): Promise<IdentityNativeReceipt | null>;
```

`read` resolves the original retained registration/capture with the same live
`context.identityConsumerWork` frame and charges its probes before dispatch. It returns
the child ceiling and native SQL footprint, including all failed/native/control work.
The returned allowance is current planning data; Source transfers work through its
one frame-owned Library ledger's `compose`, preserving the parent reservation identity.
Neither retained capture funds nor a new ledger supply this work.
The footprint is accounting only; unknown SQL is refused before dispatch by the
existing NativeCollectionWork instrumenter. It cannot provide discharge authority. It must not allocate
a guessed reservation or depend on query readiness. `retain` runs on the exact
Source home after Source has independently verified the current Library seal on
that same transaction. It rechecks the native registration/capture/attempt and
exhaustive current completion, records a durable native fence with real commit
provenance, returns that exact native receipt (including on replay), and retains every proof obligation. Later scoped writers must extend
that durable obligation or reject old-source use; ordinary finish/revalidate and
a receipt read before release do not implement this guarantee. Unsupported public
catalogue and public-output sources remain separate pending branches.

In `access/agent-verification-identity.ts`:

```ts
acceptAccountIdentityTechnicalSource(tx: CommandTransaction,
  reference: IdentitySourceConsumerReference): Promise<IdentityNativeReceipt | null>;
verifyAccountIdentityTechnicalSource(tx: CommandTransaction,
  reference: IdentitySourceConsumerReference, receiving: IdentityNativeReceipt): Promise<boolean>;
```

These are same-original-home native receiving operations. Acceptance resolves the
actual original accepted immutable input and job and stores only indispensable
technical undo/replay identity, never reason/requester/decider/private payloads.
It enrolls all remaining personal locators through native all-role custody and
records real receiving commit provenance and returns the exact native receiving
receipt. Source binds that receipt in its terminal row; verify must resolve that
same receipt, not a replacement obligation. The existing Accounts source/undo read
must resolve this native obligation after original source minimization, without an
active-account requirement or current-release reconstruction. Verify resolves and
locks that actual durable receiver in the same live command, with no foreign I/O.
Source's own receipt does not implement this receiver and cannot stand in for it.

These hooks are indispensable: the delivered directory proves inventory only,
the Library seal may be invalidated by a later writer, and current Accounts undo
reads still require the original source row. Their absence must leave the exact
branch pending. Source does not edit these owner modules or copy their SQL. Null acceptance/fence
results must be effects-free; after a successful receiver write, failed local verification
rolls the whole command back.

### Source storage and transition

`identity_epoch_source_consumer_terminal` is an append-only continuation chain under
the immutable retained obligation's native key. Each append binds the previous
sequence, original claim and current owner and has same-transaction
`erasure_source_commit` provenance. It enrolls through the existing all-role native
trigger. It stores bounded directory/effect cursors, seal digests and native fence
receipts; it stores no Source payload, scope inventory, opaque directory cut or
serialized proof brand. A changed seal restarts that scope; a directory continuation rejected after a
process restart restarts native directory enumeration; a changed native
replay/undo/restore generation restarts the directory.

Each invocation reads one actual admitted directory page and at most one Library
effect selection. Every selection is resolved by `readIdentityReceivingSelection`,
bound to its real original/job/effect/source/incarnation/scope/disposition/capture,
and reconciled through the existing native receiving producer. Intermediate pages
and sealed zero both require current native seal verification on the actual Source
transaction. The directory advances only after the owning scoped operation durably
fences that scope's later writers. A final directory cut is independently verified
with all foreign homes released before the original-source command.

That command locks the exact accepted claim and current continuation, rereads the
original source, resolves the native consumer cut and, for transfer, obtains and
verifies actual Accounts technical receiving acceptance. It commits a Source-owned
discharged/transferred row with real commit provenance. The returned opaque locator
is reconstructed only after commit and same-home native verification. Verify checks
the exact original reference, current accepted claim/owner, latest committed receipt,
native replay/undo/restore fence and genuine technical receiver on the same command.
It performs no foreign reads. The public read first resolves an already committed
terminal receipt locally, so source minimization cannot force reconstruction of the
erased original input before the technical receiver can be used. Neither a retained row nor a later pending continuation
can satisfy it. A surviving requester's/decider's verification requires transfer; subject erasure
requires native discharge after reversal and consumer settlement.

New continuation records still contain native personal locators through their parent
key and are enrolled and conservatively deferred by the existing minimizer. Terminal
Source proof alone grants neither a nonpersonal family disposition nor History copy
closure. No existing erasure/copy producer is bypassed.

## Cost and evidence

Reads use released homes and fixed native source/claim/job keys. Directory pages
retain the native eight-scalar/2048-byte frontier and at most 100 RAW keys. Scope
pages share the actual Source work reservation; native and Library work units are
never converted. No caller scope list, expected-set mirror, zero from EOF, timing
shortcut or participant ACK is terminal authority. Account current root and all
History copy associations/receipts remain independently required.

Source funds this work once through `withIdentitySourceConsumerMaintenance` at the
actual History default-maintenance invocation. The opaque frame is bound to that
Pool, deadline and async invocation, and ends in `finally`. Deadline-only, copied,
wrong-Pool and expired frames return pending before Source consumer I/O. Same-command
verification resolves the current frame from the live command resources and checks
the same Pool and invocation before reading.

The independent native defaults are rows 249, points 249, statements 81, bytes
286720 and engine requests 0. The row/point allowance is two existing 100-row child
ceilings (one directory read and one current-cut verification), plus 32 fixed Source
control touches, thirteen binding-owner read points and four same-command verification touches. Each directory child still
refuses above 100. The statement allowance reserves 18 for each directory child (the existing equal
read/verify planning split), 29 fixed Source control statements including the bounded
command-executor failure/cleanup path, ten for the binding owner's two released
read snapshots, and six same-command verification statements.
The byte allowance is 32 KiB for fixed Source controls, 8 KiB for same-command
verification, 16 KiB for the binding owner's fixed projections, and two 112 KiB native child reservations. No engine request is dispatched
by this PostgreSQL path, so only that proved-unused axis defaults to zero.

Library dimensions stay in their existing units and are never converted into
NativeStepWork. Defaults are candidateKeys 1 for the existing one-effect page,
identityMetadataRows 0 because this path dispatches no identity metadata sweep,
nativeRows 8192, nativePoints 128, witnessKeys 1, statements 128 and bytes 1048576
from the existing Collection Source one-page ceilings, and emptySeeks 2 for the page
end and sealed-empty case. The Source frame creates one `NativeCollectionWork`; child
planning allowances cap its existing `compose` transfer and SQL footprints. Unknown
footprints refuse before dispatch. A dispatched reservation is never refunded from
result row counts.

The exact optional overrides and defaults are:

| Environment key                                                     | Default | Derivation                                                                                                                                                     |
| ------------------------------------------------------------------- | ------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_ROWS`                    |     249 | Two 100-row native directory child ceilings, 32 fixed Source control touches, thirteen binding-owner points and four same-command verification touches.                                       |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_POINTS`                  |     249 | The same bounded point footprint as the native row allowance.                                                                                                  |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_STATEMENTS`              |      81 | Two eighteen-statement directory children, 29 fixed Source control/failure/cleanup statements, ten binding-owner snapshot statements and six same-command verification statements. |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_BYTES`                   |  286720 | 32 KiB Source controls, 8 KiB same-command verification, 16 KiB binding-owner reads and two 112 KiB native directory children.                                                             |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_ENGINE_REQUESTS`         |       0 | This PostgreSQL path dispatches no engine request.                                                                                                             |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_CANDIDATE_KEYS`         |       1 | One effect selection in the existing one-page bound.                                                                                                           |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_IDENTITY_METADATA_ROWS` |       0 | This path does not dispatch an identity metadata sweep.                                                                                                        |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_NATIVE_ROWS`            |    8192 | Existing Collection Source one-page native row ceiling.                                                                                                        |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_NATIVE_POINTS`          |     128 | Existing Collection Source one-page native point ceiling.                                                                                                      |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_WITNESS_KEYS`           |       1 | One effect selection.                                                                                                                                          |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_STATEMENTS`             |     128 | Existing Collection Source one-page statement ceiling.                                                                                                         |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_BYTES`                  | 1048576 | Existing Collection Source one-page byte ceiling.                                                                                                              |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_EMPTY_SEEKS`            |       2 | The bounded page-end and sealed-empty probes.                                                                                                                  |

Overrides are canonical non-negative safe integers no higher than the named
existing ceilings; invalid values fail at frame creation. Required work dimensions
cannot be set to zero. Zero is accepted only for the proved-unused engine-request
and identity-metadata axes above.

Native tests are authored but deferred. Local typing is implementation evidence,
not native discharge, erasure or Goal completion.
