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

| One dispatch / allowance | Rows | Points | Statements | Bytes | Engine |
| --- | ---: | ---: | ---: | ---: | ---: |
| New native Source guard | 17 | 15 | 2 | 32768 | 0 |
| History-only source/association recheck | 32 | 32 | 8 | 131072 | 0 |
| Complete Source proof verification, independently reserved at its own entry | 100 | 100 | 22 | 139264 | 0 |
| Existing subject Account verification, independently reserved | 64 | 64 | 15 | 65536 | 0 |
| Real receiving binding, including native mapping, roles and barrier | 160 | 80 | 6 | 131072 | 0 |
| Work current same-command lock | 4 | 2 | 4 | 8192 | 0 |
| **One complete new composed call, conservative subject maximum** | **377** | **293** | **57** | **507904** | **0** |
| Work released observation, separately dispatched by its owner | 3 | 2 | 1 | 8192 | 0 |

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

| Last admitted operation | Cumulative rows / points / statements / bytes / engine |
| --- | --- |
| History-only verification | 32/32/8/131072/0 |
| Independent Source verification | 132/132/30/270336/0 |
| Current subject Account settlement verification | 196/196/45/335872/0 |
| Receiving binding | 356/276/51/466944/0 |
| Original Source native guard | 373/291/53/499712/0 |
| Current SDK lock | 377/293/57/507904/0 |

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
No final funding is inferred from 577, 585, the earlier conditional subtotal 1198, or History's
11588. Baseline configured/hard native limits remain 577/577/173/630784/0, so an
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
