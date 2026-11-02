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

### Delivered owner ports and remaining native evidence

The following ports are consumed from their original modules. Types and signatures in
`identity-source-consumer-custody.ts` remain unchanged. No injectable adapter or public
proof setter is supported.

In `identity-epoch-binding.ts`:

```ts
readIdentitySourceConsumerWork(pool: Pool, reference: IdentitySourceConsumerReference,
  context: IdentitySourceConsumerContext): Promise<IdentitySourceConsumerWork | null>;
lockIdentitySourceConsumerCut(tx: CommandTransaction, reference: IdentitySourceConsumerReference,
  expected: IdentitySourceConsumerGeneration,
  reversal?: AccountIdentityReversalSettlement): Promise<IdentitySourceConsumerDisposition | null>;
verifyIdentitySourceConsumerCut(tx: CommandTransaction, reference: IdentitySourceConsumerReference,
  expected: IdentitySourceConsumerGeneration, disposition: IdentitySourceConsumerDisposition,
  reversal?: AccountIdentityReversalSettlement): Promise<boolean>;
```

`read` resolves native replay, undo and restore generations using the same live
`context.identityConsumerWork` frame. It charges that frame before its own native,
control and failed work; it performs no fresh identity admission. Its returned native
allowance is bounded directory planning data, never a second allocation or funding
from the accepted claim/job. Source separately charges its fixed local
claim/source/progress commands against this frame. `lock` and `verify` use the native
binding and terminal trigger. The current lock can transfer an immutable technical
input after exact claim/current-generation validation, and later consumers consult
the committed terminal pointer. Subject discharge now requires the actual Accounts
reversal settlement described below. Source carries its opaque proof only in the live
maintenance invocation; the terminal row stores no proof brand. `verify` revalidates
the same-source state in the caller's live original-home command without foreign I/O.
Existing `readAccountIdentityUndo` resolves the genuine technical source after
transfer, retaining the original accepted job and input.

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
The returned allowance is current planning data. Independent maintenance transfers
work through its frame-owned Library ledger's `compose`; prepaid receiving uses
the exact Accounts-owned original Library ledger directly, preserving its reservation identity.
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
readAccountIdentityReversalSettlement(pool: Pool, reference: IdentitySourceConsumerReference,
  context: IdentitySourceConsumerContext): Promise<AccountIdentityReversalSettlement | null>;
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

`readAccountIdentityReversalSettlement` is the actual Account-owned same-source
settlement reader. It uses the original funded `identityConsumerWork` frame and exact
reference; Source never reconstructs the reversal's own accepted job or accepts an
opaque proof by brand alone. The Semantic binding owner calls the released Account
`verifyAccountIdentityReversalSettlement(tx, reference, proof)` from its same-home
`verifyIdentitySourceConsumerCut` for both the pre-commit cut and later local receipt
verification. This Account proof closes only Account-native reversal dependencies;
it does not close Library scopes, Semantic's own cut, History copies, SDK custody,
or Account root/copy erasure.

The configured native frame retains its historical baseline ceiling of
577/577/173/630784/0. The former two-check composition used that allocation;
it is not sufficient for the installed staged History consumer or the now-complete
independent Source verifier. Final admission must use the complete composition and
original producer declarations described below. The frame is created once for the
real History callback, remains live across released-home work, and is not replaced,
refunded or extended by a second allocator.

The Semantic retained-directory reader, scoped fence, and Accounts technical receiver
are present and consumed through these original ports. Their native receipts remain
required; declarations or caller data do not establish them. The current Library
module exports the required page and seal APIs, but its implementation returns
unavailable/false in this checkout, so its scope branch stays pending. Null
acceptance/fence results must be effects-free; after a successful receiver write,
failed local verification rolls the whole command back.

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

## Terminal ownership and current branch status

This module owns the bounded terminal discharge/technical-transfer transition. It consumes
the actual admitted directory reader, the exact Library expected-effects page/seal API,
the native receiving-selection resolver, and the same-source binding and Accounts receiver
ports above. Each step enumerates one real directory page and at most one Library effect,
reconciles the actual receiving disposition, verifies the current scope seal, and retains
the durable scope fence before advancing. Finalization verifies the opaque directory cut
with foreign homes released, then locks the original claim and current owner at the source
home, accepts a genuine technical receiver for transfer, and commits terminal provenance.
The returned proof is locally revalidated after commit; no foreign reads occur in that
verification command.

Retained preparation is not terminal completion. No page EOF, caller count, participant
ACK or terminal metadata alone establishes an empty effect set. With the current Library
implementation unavailable, the first unresolved scope remains pending with no positive
receipt. Even when the Library body supplies a current native seal, the binding owner must
also supply genuine native reversal/consumer-settlement evidence before a subject-erasure
discharge can commit. Requester/decider transfer remains gated on actual Accounts technical
acceptance and same-source verification. Public-catalogue/public-output custody and missing
History artifact associations remain pending. Account current-root and all-copy proof are
separate requirements and are never inferred from this Source receipt.

## Current consumer composition and positive retirement preflight

This section distinguishes installed consumer plumbing from a complete native retirement
journey. The aggregate in Cost and evidence is the authorized **original-body** allocation, not funding
of the later Source/History/SDK composition. Exported interfaces and submitted source
are not evidence of installed producers or positive native execution.

### One page plan and one live frame

`readIdentityScopeConsumerWork` charges its retained registration/capture lookup and
returns the actual frame ledger's reservation identity and current remaining dimensions.
`advanceConsumers` binds that remainder once with
`withIdentitySourceConsumerLibraryRemainder`. `NativeCollectionWork.withinAllowance`
limits the same ledger's cumulative used **and held** dimensions. It creates no second
ledger, receipt or funding. The limit covers producer transfers, checkout points,
receiving work, nested and repeated verification, control statements, failed dispatches
and reserved terminal cleanup. It survives until the continuation has completed its
checkpoint or terminal Source command. A smaller plan cannot borrow the enclosing
ledger's larger remaining balance. Foreign reservation identities and ended callback
contexts refuse. Re-entering a helper never resets previously spent work.

An independent page keeps the existing `compose` transfer under that ceiling and
returns the sole producer's receipt with the same reservation identity. An incomplete
or throwing transferred child spends its whole ceiling and poisons its parent ledger.
A prepaid page instead runs under the existing original ledger's observation without
transferring its capacity to a second ledger. A sealed page must return that SAME
ledger's cumulative receipt. A nested replacement ledger has no transfer authority.
The literal policy and observation span the whole continuation, including checkpoint
and final commands; an undeclared reached statement refuses before transport.
Known subsequent SQL reserves before dispatch; failed SQL retains its charge.
The former per-statement comparison against a fixed post-page snapshot is removed.
The Source native commands keep their independent `NativeStepWork` reservations on
that same frame. Library and native dimensions are not converted or added as new funds.

`requireNativeCollectionFootprint` keeps the Source statement policy active even when
a transferred page installs its own local instrumentation. An unmatched statement is
refused before the underlying query, including inside a nested producer. This admission
policy is not another allowance. A previously funded transaction terminal remains
available for cleanup after refusal. `retainIdentityScopeConsumerFence` itself requires
the current page remainder and instruments its native queries on the same ledger.
The per-page seal check and the separate check inside the exhausted-page fence remain
independent calls on the same Source-home transaction, including sealed zero. Neither
check is replaced by a receipt or a cached verdict. Receiving selections still require
the exact original/job/effect/owner/source/scope/disposition/capture and applied native
receipt. Changed seals restart the scope; invalid directory continuations restart
native enumeration. Durable fences, checkpoints, terminal discharge/transfer and
post-commit Account verification retain their original semantics.

The current exact Source statement accounting remains:

| Exact SQL import or control                                                          | Native rows / points | Statements | Returned-byte ceiling |
| ------------------------------------------------------------------------------------ | -------------------: | ---------: | --------------------: |
| scoped consumer current / work                                                       |                7 / 7 |          1 | closed projection below |
| scoped consumer receipt                                                              |                3 / 3 |          1 |                  2048 |
| scoped consumer conflict / native, partition read, command no-effect fence           |                1 / 1 |          1 |                  1024 |
| command time                                                                         |                0 / 0 |          1 |                   128 |
| native commit insert                                                                 |                2 / 2 |          1 |                   128 |
| scoped consumer insert, including two FK points and seven deferred constraint inputs |              10 / 10 |          4 |                     0 |
| existing literal BEGIN modes, COMMIT, ROLLBACK and bounded timeout configuration     |                0 / 0 |          1 |                     0 |

Each byte reservation additionally includes the actual SQL and serialized parameter
bytes; a checkout separately costs one native point. Cleanup is held before BEGIN.
No engine request or MVCC-visibility accounting is introduced. These are only the
already declared Source statements, not a whitelist inferred from a paid Library body.

### Actual default entry and remaining owner transitions

The current default entry is `access/shared-history.ts`'s selected durable-work unit.
Its selection/locator transaction releases its checkout before calling
`minimizeHistoryWork` in `history/durable.ts`. For an agent-identity association,
`minimizeIdentitySDKWork` invokes `advanceAgentIdentityConsumerMaintenance` when
readiness or the SDK retirement receipt is missing. That function opens the original
Source callback, then performs the released receiving binding, original Account Source,
accepted-job lookup and `readAgentIdentityRetirementStage` reads. The stage consumes
`readIdentitySourceConsumerCustody`: retained original claim, directory page, Library
page, exact receiving reconciliation, both same-home seal checks, durable scope fence,
final directory cut and the original Source terminal command. Subject retirement needs
Account reversal settlement and discharge; requester/decider retirement needs actual
technical receiver acceptance and transfer. After commit, `verifiedTerminal` independently
revalidates the native Source and current Account state. None of these gates implies
History/root/all-copy closure.

Inside that callback the existing `retireAgentIdentitySDKWork` repeats the Source stage
check, resolves the genuine receiving binding, invokes the SDK owner, reads the durable
SDK fence and receiving binding again, repeats the Source check, then enters a receiving
command. This checkout's body does not implement the adopted durable readiness/closure
guards. In particular a released Source check or terminal Source receipt cannot authorize
readiness, SDK retirement or a later receiving write. The original History owner must
install its staged body rather than relying on this baseline ordering.

After `advanceAgentIdentityConsumerMaintenance` returns, the current Source frame has
already closed. `history/durable.ts` subsequently reads saved readiness, runs
`prepareIdentitySDKWorkRetirement`, checks retired state and cleared request/scope,
observes the SDK fence, inspects eight physical SDK tables, calls supported
`deleteWorkflows([exactWorkflowId], false)`, observes the fence again and inspects physical
absence. Its later absence/locator transaction locks the current barrier and native
association before writing `absence_verified` and minimizing the locator. Finally
`access/shared-history.ts` opens a distinct transaction for the receiving-copy proof,
selected cursor and progress, through COMMIT. Extending the SAME original callback
across those actual commands, with fresh original Source and generation-2 SDK locks at
each guarded transition, belongs to History. This consumer does not create another
frame to cover that gap. Inventory's before/after SDK, Source and receiving checks,
Account current-root, every History role and all-copy obligations remain independent.

Physical inspection retains status/input/output limits 1/1/1, operations/events/history
64/8/64, notifications/streams 0/0, the limit-plus-one refusal, 139 admitted rows and
less than 10 MiB stored data. Stored payload limits do not establish returned protocol
bytes or Source point charges. Bounded SDK retry/deletion, triggers, physical queries
and all later transaction controls need the original owner's actual cost declaration.

### Physical placement and authority still required

The installed Work exports are `readSdkWorkflowWriterState` and
`lockSdkWorkflowWriterState` in `work/sdk-retirement-fence.ts`. The former is a released
observation; the latter uses the caller's `CommandTransaction` and its actual configured
Pool through commit. Generation 1 serializes readiness only; generation 2 binds the
exact permanent closure. The SDK client must share that very Pool. Matching connection
strings, colocated tables or support for a shared-pool capability do not prove actual
configuration. This source review supplies no runtime placement evidence.

The retained original Source producer interface, reviewed separately from installed code,
is `lockIdentitySourceHistoryAuthority(tx, reference, expected)` and
`lockIdentitySourceHistoryHandoff(tx, stage, binding, writer, phase, sdk)`, backed by
`semantic.lock_identity_source_history_handoff(reference, expected)`. It resolves actual
original custody, terminal/disposition, role, claim, barrier, replay/undo/restore and
native commit addresses. History must re-resolve the returned address in its own native
guard at every readiness, closure, retirement, absence and receiving transition. Equal
JSON or a previously successful result is not durable authority. These original Source exports and the native SQL function are installed. The consumer
prices the standalone guard from that actual body; the enclosing History/SDK branches
still need their complete eight-axis declarations and actual invocation multiplicities.

The agreed supported path is Source home 0 / barrier home 0 / receiver home 0 and the
actual identical SDK Pool, with preserved permanent SDK fences/domain and original
Source custody. Moved or cross-database Source, lost custody and restore that discards
permanent fences stay pending without an original-owner bridge. Readiness, permanent
SDK technical closure, legal History cleanup, receiving recording, current Account
settlement, root and all-copy proof are distinct obligations.

The Library module in this checkout still returns `unavailable` / `false`. The paid
producer review identifies the locked `identity-native-planner-read.sql` query, the
native seal receipt read, `currentLibraryIdentityPlan` and nested
`readNativeIdentitySourceBasis` work. Its planner module/SQL and final original-owner
statement declarations are absent here. The precise missing handoff is **every actual
page/verifier/nested-current-plan SQL literal and defensible per-axis dispatch bound**,
including repeated and failed work, local-ledger interaction and receiving/fence controls.
The consumer refuses the first unmatched dispatch; it does not import the provisional
paid SQL into its whitelist. A producer's fixed local verifier ledger supplies no
additional Source funding. No creator-sales or live-copy adapter supplies this seal.

### Funding decision pending complete bodies

The fixed native default and maximum remain 577 rows / 577 points / 173 statements /
630784 bytes / 0 engine requests for the original documented body only. Directory planning
independently remains 100 / 200 / 36 / 229376 / 0, split into children
50 / 100 / 18 / 114688 / 0, with smaller configured and current remainder limits preserved.
Every current Account settlement read costs 64 / 64 / 20 / 65536 / 0; each independent
same-home verification costs 64 / 64 / 15 / 65536 / 0. The actual final History body must
supply their repetition counts rather than assuming two calls.

Known additional owner inputs, in rows / points / statements / bytes / engine units:

| Per actual dispatch                                                                        | Cost                        |
| ------------------------------------------------------------------------------------------ | --------------------------- |
| SDK released writer observation                                                            | 3 / 2 / 1 / 8192 / 0        |
| SDK current same-command lock                                                              | 4 / 2 / 4 / 8192 / 0        |
| Original Source expected-address standalone guard                                          | 17 / 15 / 2 / 32768 / 0     |
| That Source function nested inside a History guard, excluding its outer statement/triggers | 16 / 15 / 1 / 32768 / 0     |
| Reviewed complete composed subject Source handoff, including documented children           | 377 / 293 / 57 / 507904 / 0 |

Two added SDK locks alone give 585 / 581 / 181 / 647168 / 0. The conditional original
baseline 441 / 441 / 131 / 483328 / 0 plus two reviewed composed calls and one SDK
observation gives 1198 / 1029 / 246 / 1507328 / 0. Neither subtotal funds the final body:
released observations, repeated checks, actual History native guards/recording, physical
cleanup, receiving COMMIT and complete Library statement costs must be reconciled from
the delivered owner bodies. Each failure/repetition reserves again before dispatch;
no refund or estimated multiplier repairs an absent declaration. Semantic must adopt
an explicit full fixed per-axis funding decision before any defaults or maxima change.
A conservative sum alone proves neither mathematical minimality nor positive execution.

Authored regressions cover cumulative page/receiving/repeated-check work, held cleanup,
dispatched failure charges, nested unknown-SQL refusal, reservation identity and callback
lifetime. They manufacture no native seal or receiving authority. Original native,
browser and acceptance execution remains deferred. Workspace typing can establish only
source compatibility; the absent whole-child declarations and prepaid History
receiving/frame body prevent claiming the complete positive default journey.

## Cost and evidence

Reads use released homes and fixed native source/claim/job keys. Directory pages
retain the native eight-scalar/2048-byte frontier and at most 100 RAW keys. Scope
pages share the actual Source work reservation; native and Library work units are
never converted. No caller scope list, expected-set mirror, zero from EOF, timing
shortcut or participant ACK is terminal authority. Account current root and all
History copy associations/receipts remain independently required.

The baseline default path is `advanceAgentIdentityConsumerMaintenance`, which creates
one frame through `withIdentitySourceConsumerMaintenance` and passes it into
`retireAgentIdentitySDKWork`. That function runs the complete Source check before SDK
retirement, observes the SDK fence, then runs the complete Source check again before
committing the receipt. Each check includes the History stage verifier, Source custody
verifier and same-home Account verifier, all on the same original frame. Source funding
is not a separate allocation for either check. The opaque frame is bound to that
Pool, deadline and async invocation, and ends in `finally`. Deadline-only, copied,
wrong-Pool and expired frames return pending before Source consumer I/O. Same-command
verification resolves the current frame from the live command resources and checks
the same Pool and invocation before reading.

The baseline native aggregate is fixed at rows 577, points 577, statements 173, bytes
630784 and engine requests 0. This funds the prior composition only; it does not
fund the new guarded History handoff, native SDK locking or later receiving guards.
Its baseline derivation is:

| Existing work in the one invocation                                           |    Rows |  Points | Statements |      Bytes |
| ----------------------------------------------------------------------------- | ------: | ------: | ---------: | ---------: |
| Source, binding, directory and local Source verifier                          |     249 |     249 |         81 |     286720 |
| Account reversal-settlement read                                              |      64 |      64 |         20 |      65536 |
| Account same-home verification before and after Source commit                 |     128 |     128 |         30 |     131072 |
| History Source verification before SDK retirement and after fence observation |     136 |     136 |         42 |     147456 |
| **Total**                                                                     | **577** | **577** |    **173** | **630784** |

The larger aggregate does not enlarge the Source directory children. Before splitting,
`identitySourceConsumerDirectoryPlan` clamps the current remaining allowance to the
original effective envelope: 100 rows, 200 points, 36 statements, 229376 bytes and
zero engine requests. It splits that envelope into two planned children of 50 rows,
100 points, 18 statements, 114688 bytes and zero engine requests each. A smaller
current balance is preserved before the split; the native reader independently
refuses more than 100 RAW rows. These child bounds do not reserve or convert Library
work, and lower configured aggregate limits continue to refuse unfunded work before
dispatch. Values above the configured hard maxima remain invalid.

The Account verifications and Source verification remain real, separate same-home
checks. No engine request is dispatched by this PostgreSQL path, so that proved-unused
axis remains zero. No second frame, refund, cached verdict or skipped verification is
introduced.

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

| Environment key                                                     | Default | Derivation                                                                                                                                               |
| ------------------------------------------------------------------- | ------: | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_ROWS`                    |     577 | Fixed sum of Source/binding/directory (249), Account settlement read (64), Account verification (128), and both History Source checks (136).             |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_POINTS`                  |     577 | Same fixed bounded operation count as the native row aggregate.                                                                                          |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_STATEMENTS`              |     173 | Fixed sum of Source/binding/directory (81), Account settlement read (20), Account verification (30), and both History Source checks (42).                |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_BYTES`                   |  630784 | Fixed sum of Source/binding/directory (286720), Account settlement read (65536), Account verification (131072), and both History Source checks (147456). |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_ENGINE_REQUESTS`         |       0 | This PostgreSQL path dispatches no engine request.                                                                                                       |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_CANDIDATE_KEYS`         |       1 | One effect selection in the existing one-page bound.                                                                                                     |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_IDENTITY_METADATA_ROWS` |       0 | This path does not dispatch an identity metadata sweep.                                                                                                  |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_NATIVE_ROWS`            |    8192 | Existing Collection Source one-page native row ceiling.                                                                                                  |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_NATIVE_POINTS`          |     128 | Existing Collection Source one-page native point ceiling.                                                                                                |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_WITNESS_KEYS`           |       1 | One effect selection.                                                                                                                                    |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_STATEMENTS`             |     128 | Existing Collection Source one-page statement ceiling.                                                                                                   |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_BYTES`                  | 1048576 | Existing Collection Source one-page byte ceiling.                                                                                                        |
| `KERNEL_IDENTITY_SOURCE_MAINTENANCE_LIBRARY_EMPTY_SEEKS`            |       2 | The bounded page-end and sealed-empty probes.                                                                                                            |

Overrides are canonical non-negative safe integers no higher than the named
existing ceilings; invalid values fail at frame creation. Required work dimensions
cannot be set to zero. Zero is accepted only for the proved-unused engine-request
and identity-metadata axes above.

Native tests are authored but deferred. Local typing is implementation evidence,
not native discharge, erasure or Goal completion.

## Original Source interface for the History native guard

The Source owner now exports the following implemented default composition, with no
injectable producer, proof setter, alternate ledger or foreign-table mutation:

```ts
lockIdentitySourceHistoryAuthority(tx, reference, expectedAuthority = null)
  : Promise<IdentitySourceHistoryAuthority | null>;
lockIdentitySourceHistoryHandoff(tx, stage, receivingBinding, expectedWriter,
  phase: 'readiness' | 'closure', actualSDKClient)
  : Promise<IdentitySourceHistoryHandoffResult>;
```

The first operation resolves and locks original authority through
`semantic.lock_identity_source_history_handoff(reference jsonb, expected jsonb)`.
The second re-runs the real History stage verifier (including its original Account
source, association, erasure barrier and opaque Source proof), checks the actual
receiving binding, resolves original Source authority and invokes Work's supported
`lockSdkWorkflowWriterState` on the **same command**. It uses the existing live
maintenance frame. It opens no checkout, dispatches no SDK retirement and performs
no History write. Generation 1 is technical readiness serialization; generation 2
requires the exact actual closure. Neither result establishes History readiness,
physical absence or receiving-copy closure.

`IdentitySourceHistoryAuthority` is a persistable **address**, not a certificate.
It includes the original custody key and terminal sequence, exact reference, actual
replay/undo/restore generations, disposition, original terminal native commit and
technical receiving commit, if any. Bigint fields are decimal strings. The
address is reconstructed from native columns and the actual claim receipt; extra
caller JSON is not copied into it. Barrier time uses the native timestamp text.
History's installed native guard resolves this address with `expected` on every transition;
an equal JSON value, a released successful call or a copied terminal is insufficient.
It must independently revalidate its own association, receiving identity and physical
roles, current erasure barrier, native Source/Account prerequisites and actual SDK
state. The returned `guarded` value describes locks held by the current command;
it is not itself a durable SDK-bound readiness or closure record.

### Native serialization and supported physical placement

The function uses the original accepted binding's immutable terminal pointer, not a
latest-receipt scan. It joins the original enrolled custody and terminal, exact live
claim/claim commit, original admission and undo native commits, both original
`erasure_source_commit` records, current partition, both native roles and both
physical erasure locators. The existing terminal-binding trigger must be installed
and enabled. The forward migration also fixes the existing terminal matcher to
select discharged for a subject and transferred for other roles; its previous
transferred-only predicate made genuine subject verification impossible. The Source
caller still invokes actual Account settlement verification before this matcher.
No historical migration, Account verifier or native provenance condition is removed.
Original transaction `xmin` provenance is required. All joined native
owner rows are locked through commit; the binding is locked for update. There is no
new trigger dispatch, write, receipt registry or coordinator. Missing evidence returns
null. The existing Source role rules remain: subject discharge and non-subject
requester/decider transfer with the actual technical receiver.
Account reversal settlement and technical-custody verification remain separate real
owner checks performed by the existing verifier.

Only genuine Source home **0**, erasure-barrier home **0**, receiving home **0**, and
the actual SDK client's identical configured Pool are supported. Work establishes
that pool identity in its existing worker composition. A separate client Pool,
matching database URL, colocated tables or another partition in the same database
does not establish this relationship. Source outside home 0 and moved/cross-database
Source stay pending. No cross-home transaction or durable atomic bridge is assumed.

Within this placement, the original Source binding lock serializes against undo and
terminal-pointer changes; retained/terminal immutable rows and enrollment cannot be
replaced through ordinary writes. The partition lock serializes with epoch changes;
source, owner, admission, undo and terminal restore epochs must all match its current
active, unmoved epoch. A changed replay, undo or restore generation cannot match the
stored address. Work's actual same-command domain/fence locks serialize against its
writer transition and supported restore-domain rotation. A later consumer must repeat
both native checks: Source authority contains no SDK observation and cannot keep a
released SDK lock alive.

The SDK's supported offline restore preserves permanent current fences and rotates
its native restore domain before work resumes. A rollback that discards those fences
is unsupported by that owner. This Source function likewise does not establish safety
for replacement of current Source custody/partition fences by an old backup. Missing
Source restore discipline, a missing original role/locator, discarded native custody
or independently restored homes must remain pending. No UUID or copied receipt
repairs that absence. These relationships are source-level locking arguments; native
concurrency/restore verification remains deferred.

### Exact bounded Source dispatches

Every entry reserves before dispatch from the existing live frame. Reservations are
never refunded after a miss, stale check, pool refusal, SQL error or failed SDK lock.
Malformed/home-incompatible inputs refuse before dispatch. Insufficient funding leaves
that operation undispatched; earlier reservations remain spent. Retries and repeated
checks charge again. SQL/serialization failures propagate for whole-command rollback.
There is no cached positive verdict, second frame, local ledger or engine request.

| One dispatch / allowance                                                    |    Rows |  Points | Statements |      Bytes | Engine |
| --------------------------------------------------------------------------- | ------: | ------: | ---------: | ---------: | -----: |
| New native Source guard                                                     |      17 |      15 |          2 |      32768 |      0 |
| History-only source/association recheck                                     |      32 |      32 |          8 |     131072 |      0 |
| Complete Source proof verification, independently reserved at its own entry |     100 |     100 |         22 |     139264 |      0 |
| Existing subject Account verification, independently reserved               |      64 |      64 |         15 |      65536 |      0 |
| Real receiving binding, including native mapping, roles and barrier         |     160 |      80 |          6 |     131072 |      0 |
| Work current same-command lock                                              |       4 |       2 |          4 |       8192 |      0 |
| **One complete new composed call, conservative subject maximum**            | **377** | **293** |     **57** | **507904** |  **0** |
| Work released observation, separately dispatched by its owner               |       3 |       2 |          1 |       8192 |      0 |

The native guard's fifteen keyed inputs include the installed trigger catalogue row;
its seventeen rows include the native and outer result. Two statements cover the
outer SELECT and joined native SELECT. PL/pgSQL comparisons and RETURN contain no
SQL and a read fires no row trigger. Reference and expected-address inputs are capped
at 2048 and 4096 bytes before dispatch and checked again natively. The row locks do
not enqueue work or dispatch nested owner writers. When called directly by a
native History guard, the Source function's nested body is 16/15/1/32768/0; the
standalone 17/15/2 allowance additionally counts its outer SELECT/result. History
must separately charge its own outer statement and native trigger work.

The History-only part of the recheck covers the barrier, Account row, original intent/partition,
optional technical-source fallback (technical source/partition/History domain),
accepted binding validation and its native joins, at most two physical technical roles,
and original History source/partition/domain association, including its input CTE.
That part allows eight statements for both original and fallback branches, with 32
bounded input/result rows and points. The existing Source verifier additionally reads
custody (7 input/result rows), accepted claim with its parameter CTE (7), continuation
including its subquery (5), current consumer claim with its CTE and nested native
trigger lookup (12), original Account source including technical fallback (20),
terminal match including its outer SELECT, nested hook and native joined SELECT (8),
and technical receiver/accepted binding/physical roles (15). Those are at most 74 rows
and 16 statements. The nested Source allowance rounds 74 rows to 96 rows/96 points/16 statements,
with sixteen Source projections of at most 8192 bytes (131072). Account identity
admission captures only its at-most-two closed endpoint records, not group membership.
`IDENTITY_SOURCE_CONSUMER_VERIFY_COST` combines that allowance with the prior
4/4/6/8192 reservation: **100/100/22/139264/0**, reserved at the entry to
`verifyIdentitySourceConsumerCustody` before any SQL, including a rejected opaque
proof. This is essential for initial History verification and Source post-commit
reconstruction, which do not enter the H wrapper. The H wrapper now reserves only
32/32/8/131072 for its History-owned work. Their combined charge is unchanged;
subject Account verification still reserves 64/64/15/65536 separately in its owner.
No previously spent charge is refunded or reallocated at runtime.
The receiving allowance covers three mapping/current-partition/domain statements,
one mapping/history-work join, the native locator read capped at 65 rows (including
its refusal sentinel), and one barrier statement. Counting 72 keyed input rows plus
71 returned rows gives 143 rows; 160 rows and 80 points conservatively cover them,
with six statements and bounded original association/role projections. Native JSON
contains only the owner's bounded reference, generations and locators, not payload.

### Installed History consumer and positive preflight

The original consumer is installed. Its exact call is
`lockAgentIdentityHistoryHandoff(tx, actualClient, stage, binding, writer, phase)`,
which invokes the unchanged Source export above. Its structural port accepts the
Source result, including the address's decimal bigint fields; the additional
Source `phase` field requires no adapter. The native function has exactly the
`(reference jsonb, expected jsonb)` signature used by
`core.check_agent_identity_history`. No second producer or Source operation is needed.

A supported positive handoff requires all of the following actual owner state:

1. The original native Account receipt, exact source tuple/digest and enrolled roles,
   accepted live claim/job, original admission/undo commits, current replay/undo/restore
   generations, and native retained/terminal Source enrollment must match. A subject
   needs actual discharged custody and a current Account reversal-settlement proof;
   a requester/decider needs transferred custody and the actual technical receiver.
   The terminal is produced only after the exhaustive original directory cut and
   durable scoped consumer fences, including the real Library seal where required.
2. The actual immutable History source association, receiving identity, role union,
   request digest, partition/domain generation and current erasure barrier must agree.
   Original source, barrier and receiver are all home 0, and the SDK client uses the
   actual same configured Pool. Matching URLs or table placement do not suffice.
3. Readiness uses actual SDK generation 1 with null closure fields under the current
   restore-domain/fence locks. History persists the returned Source address and
   binding/writer on its original association; its ALWAYS guards resolve the native
   Source function and SDK check again while setting its separate real work readiness.
   Locks last through that command's COMMIT. Technical generation 1 alone is not readiness.
4. Only committed readiness permits the one released bounded SDK retirement attempt.
   The next Source command re-enters the same producer with exact actual generation 2,
   closure UUID/time and the original readiness restore domain. History persists
   closure only under its native guard. Permanent SDK fences survive execution deletion.
5. Preparation, retirement, physical selection, absence and locator minimization each
   re-enter current Source/SDK authority. Two independent eight-table inspections and
   exact bounded SDK deletion remain necessary. Later receiving checks the actual
   selected job/cursor/barrier, re-enters Source/SDK twice, and writes the native proof
   and cursor in one receiving COMMIT. The native receiving guard repeats Source/SDK,
   original association/roles, physical absence and minimized-locator checks.

The original History migration
[`20261101083500_agent_identity_history_closure.sql`](../../db/migrations/20261101083500_agent_identity_history_closure.sql)
persists authority on the original `agent_identity_work` association, rather than
creating a new ledger. It installs `core.check_agent_identity_history` and the native
readiness/closure/work/locator/receiving guards. The production call sites are
`agent-identity-sdk-fence.ts`, `agent-identity-retirement.ts`, `durable.ts`, `receiving.ts`
and `access/shared-history.ts`. A later native call with `expected` must reconstruct
exactly the stored Source address. Changed Source generations or supported SDK restore
rotation cannot revive a previous stage. Unsupported replacement of current Source
custody or permanent SDK fences by an old backup remains closed; no cross-home
atomicity is asserted. Source authority, genuine History readiness and physical
absence are separate facts throughout the sequence.

### Literal dispatch identities and failure prefixes

The Source native outer statement is exactly:

```sql
SELECT semantic.lock_identity_source_history_handoff($1::jsonb,$2::jsonb) AS authority;
```

Its only nested statement is the fixed fifteen-input joined SELECT in the Source
forward migration. It reads no foreign History/SDK table and fires no row trigger.
The Source verification dispatch identities are the tracked
`identity-source-consumer-custody-select.sql`, `-claim.sql`, `-progress.sql`,
`identity-epoch-binding-consumer.sql` and `-consumer-terminal.sql`. The consumer
claim calls the native installed-hook lookup; the terminal SELECT calls
`semantic.identity_source_consumer_terminal_matches`, which repeats that lookup
and its fixed dynamic joined SELECT. Current Account source verification uses
`access.account ... FOR SHARE`, `agent-verification-identity-read.sql`, and the
original bounded technical-source/binding/physical-role fallback when needed.
No Source verification writes or triggers are hidden in the read charge.

History-only H work is `lockHistoryBarrier`, the original current Account source
read, and `agent-identity-retirement-source.sql` (source/partition/domain with its
parameter CTE). Receiving uses `resolveAgentIdentitySDKWork`'s three statements,
the original `agent_identity_work/history_work` join, locator `LIMIT 65 FOR SHARE`,
and the current barrier. SDK dispatch is exactly Work's outer
`SELECT * FROM dbos.check_workflow_writer_state($1,$2,$3,$4,$5)`, its domain SHARE
and permanent-fence UPDATE locks, and native return SELECT. Their bodies and
literal identities remain in their original owners; unknown SQL is never admitted
by text similarity, structural footprint or a copied foreign statement.

Each H reserves History 32/32/8/131072 before its first read. If Source verification
is reached, its own entry reserves 100/100/22/139264. A missing consumer handle
stops before that entry; a copied handle spends it and returns false without SQL.
The subsequent conservative subject prefixes are:

| Last admitted operation                         | Cumulative rows / points / statements / bytes / engine |
| ----------------------------------------------- | ------------------------------------------------------ |
| History-only verification                       | 32/32/8/131072/0                                       |
| Independent Source verification                 | 132/132/30/270336/0                                    |
| Current subject Account settlement verification | 196/196/45/335872/0                                    |
| Receiving binding                               | 356/276/51/466944/0                                    |
| Original Source native guard                    | 373/291/53/499712/0                                    |
| Current SDK lock                                | 377/293/57/507904/0                                    |

These are admitted-prefix maxima, not guaranteed work on every early failure.
An insufficient next reservation dispatches none of that operation and leaves the
previous prefix spent. SQL/serialization/deadlock errors propagate for whole-command
rollback; there is no statement retry, refund or cached verdict. The History unit
uses its existing one-attempt command wrapper and prepays control/rollback work.
A later ordinary scheduling admission starts a new frame and reads committed native
state; it does not retry an ambiguous retirement inside the earlier frame.

### Full consumer counts and final-frame handoff

The owning [Access cost table](../access/README.md#cost-complete-selected-identity-unit)
and [Work dispatch table](../work/README.md#bounded-selected-identity-maintenance)
own the installed foreign body and its literal dispatches. Its fresh path invokes
H eight times: readiness, closure, two preparation checks, bound physical selection,
absence and two later receiving checks. Six of these enter through
`lockRecordedAgentIdentityHistory` (L); each L adds its original capped-state read
and outer native guard SELECT. Thirteen G native guards repeat the original Source
and current SDK functions, independently of H. Their 92/87/11/40960/0 reservation
conservatively includes the standalone Source17/15/2/32768 and SDK4/2/4/8192.
Those native calls do not enter the TS Source verifier and must not be charged as
another H. Each current subject Account verification inside H remains paid once.

Eight H sum to **3016/2344/456/4063232/0**, including eight current subject Account
checks (512/512/120/524288/0). Together with thirteen G they cause twenty-one
current SDK checks, plus three independently charged released observations O.
The five R receiving calls include four bracketing the two SDK receipt reads and
one initial later receiving call. Two inspections, three work invalidations W,
two wakeups K, one locator invalidation T, one receiving invalidation P and two
seals remain in History's stated envelope. Its published expansion counts fourteen
separate C controls; accepted-original lookup already includes its three command
controls. Initial rows that include C must not be charged that control twice.

History's **11588/9856/2731/6843136/0** is a consumer dispatch envelope, not a final
Source allocation. It excludes independently reserved Source staging and current
Source verification, additional independent receiving/inventory calls, and the sole
Library producer's original declaration. The moved reservation leaves H's envelope
unchanged but makes each independently reached Source verifier explicitly spend
100/100/22/139264/0, plus subject Account 64/64/15/65536 when that stage is reached
(**164/164/37/204800/0** for a complete subject check). This applies to initial
History verification, terminal reconstruction and Source post-commit verification;
none may borrow the eight H calls' allowance.

Source staging separately reserves its fixed admission/progress/cleanup prefix
32/32/29/32768 before checkout. The original binding work reader additionally
reserves 9/9/5/8192, then 4/4/5/8192 before its two released snapshots; a missing
first result spends only the first reservation. A discharged terminal reconstruction
reads actual Account settlement at 64/64/20/65536 and invokes the independently
funded current Source verifier above. Newly finished Source custody likewise
re-enters that verifier after native COMMIT. Directory actual dispatches and scoped
Library work retain their existing reservations; a planning allowance is not a
reservation. The old four-point/six-statement directory holdback is only a planning
floor, not sufficient funding for the current full verifier.

Every extra released receiving read spends 76/75/17/132000 + G + A; its same-command
verifier spends 76/75/13/131872 + G + A, with caller controls paid separately.
Mapping inventory snapshots spend 6/5/8/16640; complete saved SDK/work/mapping
snapshots spend 7/6/8/33024. These are separate calls, never cached certificates.
An admitted delayed reschedule adds C + 1/1/1/0. A refused or rolled-back prefix
retains all reservations and the same cumulative remainder/deadline.

The existing final-frame composition owner must reconcile those actual call counts,
initial Source work, repeated Account checks, and the sole Library producer's final
literal page/verifier/locked-plan/seal/current-plan SQL and failure/repeat/rollback/
fence declaration before adopting fixed aggregate defaults, recognition and ceilings.
No final funding is inferred from 577, 585, the earlier conditional subtotal 1198, or History's 11588. Baseline configured/hard native limits remain 577/577/173/630784/0, so an
insufficient balance refuses. Directory parent 100/200/36/229376 and effective
children 50/100/18/114688, Library child caps and the native 100-row page ceiling are
unchanged. No extra local ledger creates Source funding.

### Verification and remaining admission requirements

The existing acceptance named in
[`identity-source-consumer-custody.test.ts`](../../test/semantic/identity-source-consumer-custody.test.ts)
is preserved. The added direct-verifier regression covers repeated full reservations,
all four funded-axis refusals before SQL, and rejection of copied handles without
creating authority. The original real-default case covers stale source/job/role/
barrier, wrong association/writer phase, missing native custody and funding refusal.
The integrated original History positive journey in
[`agent-verification-reversal.test.ts`](../../test/access/agent-verification-reversal.test.ts)
uses the actual selected unit, observes committed generation1 readiness before SDK
retirement, then requires exact generation2, physical absence, minimized locators,
native receiving proof and cursor progress. It also rejects changed source, receiver,
Source sequence, restore UUID and closure, and tests permanent enqueue refusal.
Those existing owner tests are not modified or replaced here.

All authored regressions remain UNRUN at this source boundary. Only changed-Kernel
typing is permitted. Native concurrency/restore, positive default journey, original
acceptance/browser campaigns and Goal closure require later integrated verification.
Remaining runtime admission conditions are real Source/Library consumer cuts and
Account settlement, supported preserved physical custody, final Source-frame SQL
recognition/funding, and independent History receiving/physical checks. The History
consumer's former absence is no longer a blocker or a missing implementation claim.
This Source interface is implemented and consumed; installed code is not native proof.

Implementation sources reviewed: integrated Access/Work READMEs; original History
retirement, fence, inventory, durable and receiving bodies and its forward closure
migration; retained original Source SQL/implementation and prior attempt evidence;
and `search-worker-outcome-harness/dbos-transact-ts/src/client.ts` in the indexed
reference directory for actual shared-Pool construction and deletion APIs. No foreign
History/SDK/Library body or upstream reference code is copied or changed by this owner.

## Original-funded consumer receiving

This section controls consumer accounting and admission. The native Source locks and
History handoff described above retain their own authority and physical obligations.

The selected History route cannot use the independent configured Source admission.
The production receiving entry is:

```ts
withPrepaidIdentitySourceConsumerMaintenance<T>(
  deps: HistoryOriginalDependencies,
  parent: IdentityOriginalSourceContext,
  body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>,
): Promise<T>
```

Accounts calls it through its own prepaid History adapter **inside** the existing
`withIdentityOriginalSourceTransfer` callback. Source does not consume the original,
enter that transfer again, acquire a replacement job, or settle Account movement.
The installed producer owns immutable additive local/Source/Library/transfer partitions,
the pre-dispatch durable debit and eventual settlement. The local allocation is already
fully spent and cannot pay for either child.

`identityOriginalLibraryWork`, `currentIdentityOriginalTransfer` and
`identityOriginalRemainder` authenticate the private live grant, exact Pool/WorkClient/
registry, job, original identity, position object, native partition object, SAME Library
object and unchanged absolute five-second deadline. A private grant is one-shot within
Source, including callback failure. Copies of its opaque token, changed positions or
allocations, wrong dependencies, expired/ended/foreign async ancestry and nested receiving
refuse before IO. Copying context fields does not invent another private grant or capacity.

Each prepaid native reservation requires an explicit eight-axis declaration and calls
`reserveIdentityOriginalSourceWork` before IO. A five-axis legacy envelope is insufficient.
`IDENTITY_SOURCE_HISTORY_GUARD_DECLARATION` prices the installed standalone native guard:
0 candidates, 17 native rows, 0 identity metadata rows, 15 native points, 0 witnesses,
2 statements, 1 empty seek. Bytes include the exact SQL plus a worst-case JSON-escaped
2048-byte reference and 4096-byte expected address (six bytes per input byte, seven
array/string punctuation bytes) plus the existing 32768-byte result bound. Actual calls
charge their smaller actual serialized input size. No foreign History/SDK body inherits
these zeros or this price.

The producer's guarded Library object intentionally exposes no `withinAllowance` or
`close` method. `withNativeCollectionWorkAllowance` resolves an authentic receipt to its
existing private target solely to add the cumulative plan. All callbacks still receive
the exact producer object and its live checks. `bindNativeCollectionWorkLifetime` adds
Source callback lifetime to that target without replacing or closing it. Original
counters remain owned by Accounts. A Source end closes dispatch, not the counter snapshot;
independent non-History frames continue to close their own ledger. Receipt snapshots
precede child settlement; later counter changes cannot change a returned receipt.

Nested plans/instrumentation retain all ancestors. Escaped callbacks, held/query handles,
unreleased checkout/query methods and plans cannot dispatch after their Source or
ancestor callback ends. A manually held query retains its exact literal policy, admits
only one SQL dispatch covered by its full held vector, and cannot acquire a checkout. A failed plan
poisons the ledger. No helper refills work or extends the original deadline. The legacy
job-only receiving entry refuses because it has no delivered private child context.

`requireNativeCollectionFootprint` retains the Source parent's literal policy through
a producer's nested instrumentation. A permissive child cannot hide unknown SQL.
The current-dev dual COMMIT/ROLLBACK reservations and transaction-wrapper observation
remain: failed COMMIT retains its separately held ROLLBACK. Only undispatched controls
are cancelled. Failed/rejected/rolled-back transferred children retain their entire
prepaid partition, and dispatched SQL is charged before transport. Successful receipts
are snapshotted and validated before settlement; mutation cannot change the held
partition, reservation identity or receipt counters. Pool and Core transaction identity
are unchanged. This accounting is not currentness, discharge or physical proof.

A manually metered custody query suppresses observation only when the active observer
belongs to that same ledger. A local custody cap cannot hide dispatch from an enclosing
Source ledger; that enclosing observer still charges its literal footprint. This also
applies when the local cap has more spare work than the original planned remainder.

### Literal Source-side eight-axis costs

The exported `scopeConsumerFootprint` recognizes exact imported SQL or an exact literal,
not a query name, comment, prefix or arbitrary producer declaration. For the following
local SQL, candidateKeys=0 (no candidate enumeration), identityMetadataRows=0 (no
Semantic basis sweep), and witnessKeys=0 (no listing-witness expansion). Native rows
and points count admitted indexed work, including joins and constraints; they never
use returned rowCount or engine MVCC work. Engine requests are separately zero and
nonzero engine reservations are refused. Each read reserves one emptySeek, including
an expected successful zero; controls and the native commit INSERT reserve zero.
Bytes are exactly the SQL UTF-8 bytes plus serialized parameter bytes plus the stated
bounded result envelope. Repeated invocations repeat the whole declaration.

| Exact SQL                                                      | nativeRows | nativePoints | statements | Result bytes | emptySeeks |
| -------------------------------------------------------------- | ---------: | -----------: | ---------: | -----------: | ---------: |
| scoped consumer work/current                                   |          7 |            7 |          1 | closed projection below |          1 |
| scoped consumer receipt                                        |          3 |            3 |          1 |         2048 |          1 |
| scoped conflict/native, partition read, no-effect fence        |          1 |            1 |          1 |         1024 |          1 |
| command time                                                   |          0 |            0 |          1 |          128 |          0 |
| native commit INSERT/partition SELECT                          |          2 |            2 |          1 |          128 |          0 |
| consumer fence INSERT, two FK probes, deferred seven-key fence |         10 |           10 |          4 |            0 |          1 |
| receiving selection/native commit                              |          2 |            2 |          1 |          128 |          1 |
| receiving lookup, including effect commit and exact step       |          7 |            7 |          1 |         8192 |          1 |
| receiving plan/current commit/partition                        |          3 |            3 |          1 |         6144 |          1 |
| exact receiving gate or expected-effect receipt                |          1 |            1 |          1 |          128 |          1 |
| exact receiving custody/native commit                          |          2 |            2 |          1 |          128 |          1 |
| BEGIN, settings, COMMIT, ROLLBACK                              |          0 |            0 |          1 |            0 |          0 |

For receiving lookup, binding is limited to 4096 bytes, the actual writer constructs
plan/source-hold as fixed native receipt locators, and the effect frontier is limited
to 2048 bytes. It is not a reservation for arbitrary source payloads. The successful
new Source fence path, excluding its independent Library verifier and enclosing
command, reaches current + receipt + conflict + native SELECT + native INSERT +
native SELECT + fence INSERT: 25 rows, 25 points, 10 statements, 11392 result bytes,
6 emptySeeks, plus each literal's actual SQL/parameter bytes; its other three axes
are explicitly zero as classified above. Replay reaches current + receipt: 10 rows,
10 points, 2 statements, 8192 result bytes, 2 emptySeeks, plus SQL/parameters.

The released planning command reserves checkout (one nativePoint), BEGIN, timeout,
consumer-work and both terminal alternatives: 7 rows, 8 points, at most 5 dispatched
statements including failed COMMIT followed by ROLLBACK, one emptySeek, the closed work/current result
projection plus the five actual SQL/parameter bounds. This is a local term, not a page or
parent price. Nested native Source hold/release, role/outbox expansion, whole History
and real Library planner/verifier statements require their complete owner declarations;
unknown or incompletely bounded literals stay undefined before dispatch. In particular
the installed positive Library page/verifier does not supply this consumer with a
compatible complete literal declaration. `identity-native-planner-read` remains
refused; Source cannot adopt its permissive normalized-SQL classifier.

### Disjoint whole-parent composition and remaining operands

`composeIdentitySourceOriginalCosts` is arithmetic for adoption, never an
admission or funding parameter. It requires all eight explicit axes for every part,
rejects legacy five-vector substitution/overflow, and returns total=null with named
missing terms. A `total:null` disposition is never a successful installed declaration.
`composeIdentitySourceReachedCosts` additionally requires each named subdeclaration's
positive bounded invocation count and separate zero engine-request declaration. It
checks overflow before returning a complete eight-axis sum; missing children return
only `state:missing` with exact term names.

`readIdentitySourceOriginalCostDisposition()` publishes the callable local footprint
and guard declarations, the installed Accounts local/transfer-control operands,
the disjoint whole-parent missing disposition, and the missing reached terms: Source preparation/checkpoint/
terminal erasure-role, commit, event and binding child work; current binding and Account
receiver/reversal; native directory population/preparePlan; History staging, repeated
H/G/A, inventory, receiving, outbox and role mutations; prepaid History/SDK and the
same-work Library entry plus its complete declarations. Consequently Source exports no successful
`IDENTITY_HISTORY_ORIGINAL_SOURCE_DECLARATION`. Accounts admits no usable Source child
from this absence; independent receiving/accounting remains installed.

The whole parent before first discovery/control IO is exactly:

    AccountsLocalControl + SourceHistoryNativeAllReachedCalls
      + LibraryAllReachedCalls + AdditionalOriginalTransferControl

The retained Accounts declaration has these explicit local terms, in the order
candidateKeys/nativeRows/identityMetadataRows/nativePoints/witnessKeys/statements/
bytes/emptySeeks:

| Original local term              | Eight-axis declaration                |
| -------------------------------- | ------------------------------------- |
| selection                        | 0 / 10 / 0 / 8 / 0 / 15 / 10816 / 5   |
| validation                       | 0 / 7 / 0 / 5 / 0 / 12 / 6656 / 4     |
| settlement                       | 0 / 6 / 0 / 4 / 0 / 11 / 2304 / 1     |
| selected local alternatives      | 0 / 63 / 0 / 56 / 0 / 41 / 17152 / 10 |
| complete prepaid local allowance | 0 / 86 / 0 / 73 / 0 / 79 / 36928 / 20 |

These are body-derived local declarations, not spare funds. All eight native child
axes remain mandatory; native five-axis envelopes cannot implicitly supply the missing
classification. The existing History envelope 11588/9856/2731/6843136/0 is a separate
conditional native term and excludes initial staging/current verification and the
additional inventory/receiving call sites. Each actual H=377/293/57/507904/0, G=92/87/
11/40960/0, A=9/9/9/0/0, Source verify=100/100/22/139264/0 and Account verify=64/64/
15/65536/0 repeats at its real caller; included children are not added twice.
The two command/root prefixes, original-source/accepted/stage reads, released point
and inventory, receiving probes, copy lookup, current cut, up to three current copies,
SDK obligation, q<=2/c<=64 outbox expansions, recovery transitions and role mutations
remain the actual owner's independent reached terms. Their local controls do not
fund Source or Library. No single cached receiving probe replaces them.

Accounts' additive allocation/control/private grant and fixed child integration are
installed. A complete numeric parent remains unavailable: the actual History module
has no `withPrepaidAgentIdentityHistoryUnit` export; History/SDK reached bodies do not
publish compatible eight-axis child declarations and repetition counts; Library has no
the `readLibraryScopeEffectsPageWithWork` entry or
`IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION`. Its positive native page and
current/seal/planner bodies are present; those bodies alone do not establish
compatible eight-axis bounds for this selected original. Search recovery enrollment and the
physical owner's receiving/writer closure remain independent foreign prerequisites.
Source cannot classify invented foreign SQL, promote null to a grant, or count an absent
declaration as successful zero child work. The exact local formulas above are the available
composition, not an assertion of complete-parent sufficiency.

All existing native and Library defaults/ceilings remain unchanged, including the
100-row/200-point/36-statement/229376-byte directory envelope and its smaller split
children and configured limits. Old 577/577/173/630784 is not the whole parent. Same-home
Library verification remains mandatory on every page AND inside the exhausted-page
fence, even for zero effects. A changed seal restarts the checkpoint, never reuses
an earlier checked prefix. Final Source discharge/transfer, Account reversal receiver,
History generation-1 readiness versus generation-2 closure, same configured Pool/held
locks through receiving COMMIT, SDK permanent non-revival, root and all physical
copies remain independent requirements.

Accounting transport regressions are authored in the existing custody test file;
they are not native proof or manufactured Library evidence. Original native, unit,
growth, browser, default-retirement and full acceptance remain unrun under the current
execution boundary. Kernel typing is reported separately from these obligations.


### Selected original: one irreversible custody advancement

The authentic receiver and whole-parent admission remain separate. Inside the
installed Accounts transfer, `claimIdentitySourceCustodyAdvancement` consumes one
private in-memory step bound to the genuine original, immutable job/position,
Account barrier, configured Pool, exact Library object and original deadline.
Accounts has already durably committed `child_entered` on its spent original
before that grant exists. This closes process restart and new-callback replay;
the Source claim closes sequential/concurrent public attempts inside the callback.
No Source durable ledger, caller UUID, environment option or refreshed deadline is
introduced. An unavailable answer, failure or rollback never cancels the claim.
The ordinary independent maintenance entry retains its configured behavior.

`IDENTITY_SOURCE_ORIGINAL_SCHEDULE` exposes the executable closed operation names.
One directory item and one effect page use limit one. The Library maxima, in the
owner's field order, are:

| discovery | plannerSteps | effectPages | currentVerifications | exhaustedPageRechecks | finalFences |
| --- | --- | --- | --- | --- | --- |
| 0 | 0 | 1 | 1 | 1 | 0 |

`claimIdentitySourceLibraryCall` and `claimIdentitySourceScheduledCall` spend the
operation slot before awaiting. Zero entries cannot dispatch. The exhausted-page
recheck is the existing second verifier inside the Source fence, including empty
pages; it is never a third Library final-fence call. There is no inline plan repair,
discovery or ordinary Library finishScope on this selected route. A pending plan
stays pending. Exhausted receiving uses the installed single-source-fence profile
with both current checks in the same genuine transaction; a released currentness
read cannot stand in for that fence.
`identitySourceConsumerScheduleReceipt` returns an immutable counter snapshot,
which supplies neither admission nor a claim.

The prepaid page adapter resolves only the installed
`readLibraryScopeEffectsPageWithWork(pool, input, work)` entry, passes the exact
Accounts-owned `identityOriginalLibraryWork` object, and requires its installed
whole-child declaration. It rejects limit changes, replaced ledger identity,
changed deadline and noncumulative receipts. It never calls the ordinary entry
that constructs its own ledger. Missing entry/declaration is a named pre-IO gap.
The strict ancestor literal policy remains mandatory; a permissive normalized-SQL
producer callback cannot hide foreign or unknown SQL. This snapshot has positive
native Library execution but lacks that same-work entry and whole-child quote.

### Local literal components and genuine Core dispatch

`IDENTITY_SOURCE_LOCAL_SQL` and `IDENTITY_SOURCE_LOCAL_READ_DECLARATIONS` publish
closed literal bodies, exact maximum operands and full projected-result bounds.
`identitySourceCustodyFootprint` recognizes byte-for-byte literals with validated
positional arguments. It rejects comments, extra operands and the ordinary
unbounded published-job SQL. The selected accepted-claim query compares the exact
closed receipt in PostgreSQL and projects no arbitrary intent or source array.
Selected claim and publication literals explicitly bound scope_digest to 128 bytes
before projection. No truncation, schema change or foreign producer edit occurs.

Every local read declares candidateKeys=identityMetadataRows=witnessKeys=0 because
these bodies perform fixed native key joins, with no candidate enumeration, basis
metadata sweep or witness expansion. engineRequests is separately zero. The other
axes are:

| Local read | nativeRows | nativePoints | statements | emptySeeks | bytes |
| --- | --- | --- | --- | --- | --- |
| retained custody | 6 | 6 | 1 | 1 | UTF8(literal) + bounded 13 binds + five-scalar result |
| latest progress | 3 | 3 | 1 | 1 | UTF8(literal) + bounded two binds + scalar result + 2048-byte cursor JSON |
| selected accepted binding | 5 | 5 | 1 | 1 | UTF8(literal) + bounded six binds + generation/digest/home/transaction result |
| selected published state | 4 | 4 | 1 | 1 | UTF8(literal) + bounded three binds + bounded digest result |

The scoped work/current result bound is the UTF8 JSON projection of two
19-digit bigint strings, a 256-byte generation, a null seal placeholder, plus
5*256 bytes of generation escaping and 4096 bytes of actual native seal. This
replaces the historical rounded 6144-byte result estimate.

The actual SQL includes locks, while reads fire no write/FK triggers. The key paths
are respectively custody/current-binding/claim/claim-commit/source-commit/partition;
latest custody sequence/source-commit/partition; accepted binding/claim/claim-commit/
admission/partition; and job/admission/partition/control. Bounds include failed
indexed seeks. UTF8 binds use the actual immutable serialized values at dispatch;
declarations include maximum text escaping. The original Source history authority
function separately publishes its fifteen indexed inputs, two statements, outer
result and closed native JSON construction, including bounded receipt/timestamp/
bigints. Its prepaid bytes use that actual projection instead of the old 32768
independent envelope. Repeated authority/handoff entries have closed schedule slots.

`IDENTITY_SOURCE_LOCAL_MUTATION_COMPONENTS` publishes only the disjoint INSERT
body work and names every FK/default/trigger child still requiring composition.
The two custody FKs and three terminal FKs are exact schema keys, not fabricated
zero-byte successful subdeclarations. Default erasure sequence, deferred erasure
capture, terminal binding fence, native source association, role/outbox and event
work stay separate reached terms. `IDENTITY_SOURCE_LOCAL_CALLS` names the local
read/mutation repetitions and foreign children of each real Source operation;
none is a successful whole command by itself.

`withIdentitySourceNoEffectCommand` supplies the genuine private grant to Core's
installed `withCommandDispatchLifetime`, with synchronous authentication and the
unchanged Pool/deadline. Core atomically reserves effect plus disjoint cleanup
from the SAME Source native partition before checkout. In the eight-axis field
order, the delivered total is:

    0 / 2 / 0 / 1 / 0 / 8 / 169 / 1 ; engineRequests=0

This includes the held ROLLBACK after failed COMMIT and is not added to the old
historical command aggregate. Source body SQL reserves its own complete literal
price before IO. Library bodies use the original Library object; the Core controls
are outside that Library observer. Scope admission similarly charges the exact
consumer-work literal on Source and returns the unchanged Library remainder.

Compatible retained discovery, accepted binding, bounded publication, progress
and currentness commands use this real adapter. Exhausted receiving instead binds
the actual single-source-fence profile to the same private original and immutable
barrier account, reserving its complete effect plus cleanup from Source. Its native
body SQL is charged separately on Source; both Library checks use the exact Library
ledger, and SEMANTIC_ERASURE_PROGRESS is preserved. Preparation, checkpoint and
finalization include other events/callbacks. Their wider-profile gaps refuse
before unsupported dispatch, preserve the event semantics and yield pending without
claiming closure. Intermediate compatible currentness can run without publishing a
fence or advancing a checkpoint. Positive receiving-selection hold/reconcile also
requires the actual native hold/role/control child declarations before dispatch.

`readIdentitySourceOriginalCostDisposition` now reports immutable local reads,
mutation components, closed callsites/schedule, actual Core controls, actual
installed History local/SDK components when present, and actual callable/declaration
presence independently. Whole composition still requires every reached History
caller's enforced multiplicities, bindings, original Account reader/technical and
reversal children, native directory and receiving/native-hold declarations, Library
same-work literal composition and wider Core executor profiles. The installed
History private callback/command adapter and Library selected declaration resolve
those specific operands; they do not fill the other missing whole Source terms. No successful whole Source
declaration is exported and Accounts' fully spent local allowance is not reused.

The additional fixture cases cover genuine one-original/two-attempt/overlap/reentry,
unavailable/failure and real Core rollback, exact counter/ledger/deadline behavior,
zero/one-effect verifier guard arithmetic, strict literal rejection and disjoint
component/profile disposition. Guard arithmetic deliberately does not manufacture a
native seal. All focused and native tests remain UNRUN. The required single Kernel
compiler invocation is separate and cannot establish native journey completion.
