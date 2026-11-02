# History

## Recovered Account identity serializers

The original Account command and its later `access.agent-identity.recover` command have separate native cuts. The
original finite `core.agent_identity_inventory` still describes only its 2..3 actual serializers and its SDK
obligation stays independent. Recovery never fills a missing original cut or asserts the old SDK enqueue seam.

`declareAgentIdentityInventory` dispatches recovery declarations to a private writer that inserts one
`core.agent_identity_recovery_inventory` row under the original source key. It binds the immutable source digest,
recovery partition/epoch/position/transaction/receipt codec, request digest, current owner epoch and restore domain.
The expected receipt and single account-updated event are captured before serialization by
`captureAgentIdentityInventory`; actual serialized rows are associated by `recordCommandHistory`; the executor
seals the two-slot cut with `finalizeAgentIdentityInventory` before COMMIT. This uses the installed command
executor hooks; the private callback state is only a pre-serialization declaration. The real locator rows retain
the complete merged role set, with one 64-role bound per artifact. The primary key allows one recovery cut per
original key, and exact replay makes no additional serializer rows or recovery event.

The current read/retirement exports are `readAgentIdentityRecoveryInventoryInTransaction`,
`readAgentIdentityRecoveryArtifactInTransaction`, `readAgentIdentityRecoveryInventory`,
`verifyAgentIdentityRecoveryInventory` and `verifyAgentIdentityRecoveryArtifactReadiness`.
`verifyAgentIdentityRecoveryCopyInventory` is the Access owner adapter. These functions bind reads to the exact
source and recovery keys; released receipts are rechecked in the final same-home command. An absent recovery
snapshot is reread under that command after charging its 2/2/1/512 cost; the Source/Account writer locks remain
held through COMMIT. A retained old recovery without a sealed discriminator is pending.

The fixed recovery read costs are literal reservations at their dispatch points:

| Operation                                                         | Native work (rows / points / statements / bytes / engine requests) |
| ----------------------------------------------------------------- | -----------------------------------------------------------------: |
| Native inventory snapshot, once per exact source key              |                                          135 / 135 / 6 / 32768 / 0 |
| Artifact association probe, before returning absent or continuing |                                                2 / 2 / 1 / 512 / 0 |
| Unique association's exact cut reread                             |                                          135 / 135 / 6 / 32768 / 0 |
| Final same-home proof/owner/restore/receipt verification          |                                         275 / 275 / 18 / 49152 / 0 |
| Recovery owner readiness after cut resolution                     |                                         100 / 100 / 36 / 24576 / 0 |
| One non-durable serializer receiving receipt read                 |                                           76 / 75 / 12 / 24576 / 0 |

With live command resources, the recovery readiness reservation includes the exact
effects/`account_discovery_redrive` consumer probes; its event consumer ceiling is 32 plus the refusal sentinel.
After those reads it refuses for missing Search current-enrollment authority. The selected background Work callback
cannot reach that reservation without command resources, as documented below. The original verification/reversal
event path retains its separate 8/8/1/16384/0 full-key association,
69/69/4/24576/0 native artifact lock, and 76/75/13/131872/0 durable receiver plus existing History guard/absence
costs per actual consumer. Recovery does not invoke or inherit that original SDK receiver. These costs repeat for
every actual read and final verification; a failed prefix is not refunded. Source owner composition, when active,
reserves before dispatch against its existing frame and deadline. Missing, expired or exhausted Source funding
raises `identity-history-native-funding-unavailable`; independent History/Work execution retains its actual
selected-job lease and any native-command admission available to its caller, as described below.

`activeIdentitySourceConsumerMaintenance(pool)` observes the current async invocation's original token and deadline.
It returns `null` only when no Source frame is inherited; a foreign Pool or settled descendant remains observable
provenance, not permission. `reserveIdentityHistoryWork` gives an explicit token precedence over ambient context,
then validates the selected token against its actual Pool, the current ALS frame, the original lifetime and the
requested deadline before charging the cumulative native balance. A copied, malformed, foreign, expired, settled or
exhausted Source context refuses. It never creates a replacement frame or refunds work after a failed attempt,
rollback or repeated call. The separate Library balance is untouched.

The independent History/Work entry is `history/work.ts:advanceSelectedHistoryOriginal` from
`access/shared-history-work.ts`. It admits the actual selected `core.preference_history_job` phase and scan/verify
cursors through a released native command. The command's real transaction identity, immutable account barrier,
registry generation and absolute five-second deadline are persisted before its private callback. The job lease
only schedules this work. Durable original admission, one-shot entry, immutable allocations and recorded native
progress provide its execution provenance; neither a UUID nor the lease supplies Source/Library funding.
[Access's selected original contract](../access/README.md#selected-history-original-and-private-transfer) owns the
callable signatures and disjoint allocation/control declarations.

`advanceSharedHistory` and nested `receiving.ts` readiness retain their operational transactions. Their query-only
liveness adapter does not manufacture `currentCommandResources` or an authorization principal.
`verifyAgentIdentityRecoveryArtifactReadiness` therefore retains
`agent-identity-recovery-command-resources-unavailable` before readiness SQL in that context. A caller with a real
live `CommandTransaction` independently retains its own admission and the same verifier bounds. The selected
identity SDK branch requires genuine additional Source/History and Library partitions and the installed prepaid
private caller. Their absence refuses only the affected child dispatch. It cannot enter the configured independent
`withAgentIdentityHistoryUnit` under a new reservation or fund a child from spent local controls.

In `durable.ts`, the eight-table physical inspection's complete 148/8/12/11888 bound (including its controls and
rollback slot) is reserved before checkout whenever it runs inside a Source frame. The mapping-only reservation is
also charged before `minimizeHistoryWork` checks out its first connection. `receiving.ts` command-resource calls
keep their local deadline while the reservation helper resolves the inherited original Source token and frame;
wrong-Pool and settled provenance therefore refuses before the next checkout or SQL dispatch.

## Operational Members Work

`operational-work.ts:registerPositionedOperationalHistoryWork(tx, binding, intent)` accepts the genuine live
`OperationalTransaction` from `runOperationalTransaction` with `operationalHistory: true`. Call it immediately after
Commerce's native reservation, replacing that call site's separate enqueue. The operation must be a request of
kind `library.membersPreparation`, on `partitionOf(route)`, fencing exactly `[ownerAccountId]`. The binding contains
`route`, `ownerAccountId`, `collectionId`, sorted unique new `episodes` and sorted unique `retired` locators. Each of
the 1..16 new episodes supplies `collectionId`, `episodeId`, `reservedIncarnation`, decimal-string
`reservedGeneration`, `canonicalBasis` and lowercase SHA-256 `basisDigest`. Retired locators remain bounded by 32;
canonical basis is `[1, owner, collection, admittedFilter, sort, releaseDigest]`. Commerce owns the real reservation
verification and final native episode association. Existing-basis reuse with no new intent calls neither this
producer nor enqueue.

The sole SDK enqueue uses the SAME checked-out operational client and transaction as the reservation, permanent
native counter and immutable original. It preserves the exact `workflows/library.membersPreparation` name,
`library:members-preparation:<route>:<owner>:<minimum-new-episode>` deterministic ID, sorted locator-only
`accounts/route/episodes/cleanup` input and 4096-byte payload cap. The canonical binding/intent is bounded by
196608 bytes. No positional arguments or additional payload keys are accepted. Same binding/different body
conflicts; an exact durable repeat returns its original locator and position without allocation or enqueue.
The original binds operation kind/mode/partition/accounts/absolute deadline and all actual Access identity roles,
with at most eight distinct accounts. The owner and durable-initiator bits are added independently of record-source
ownership; SDK payload accounts never replace this role union.

`OperationalWorkRegistration { partition, custodyId }` is an opaque serializable lookup key, not a receipt. Fresh
custody/transaction UUIDs identify records only. A successful opted-in original allocates a locked transactional
`core.operational_work_head` position in **operational-work/v1**. Its discriminated `OperationalWorkStamp` contains
`domain`, `partition`, actual `epoch`, family `generation` and positive `position`; bigint generation/position use
canonical decimal strings. This is not the canonical event `Stamp`, and provides no common ordering with command
events. `core.partition.position` and the event log stay untouched. There is no sequence, independent allocation
commit, event, command receipt, effect, relay or second executor.

The counter advances exactly once, monotonically across epoch/family-generation changes. Native constraints bind
its custody/transaction/workflow/digest/deadline to the immutable original and require both its actual source fences
and executor seal at the real commit boundary. An unused allocation cannot commit. Lock order is the executor's
partition/Account fences, family domain, operational head, ordered History seals, SDK restore domain and SDK writer.
The existing-original full-key lookup is immutable and allocates nothing. Original finalization and deferred native
verification run before the actual COMMIT; private transfers activate only after that COMMIT succeeds. Every exit
invalidates live handles, and failed/contention attempts invalidate transfers without refunding spent allowance.

The retained `registerOperationalHistoryWork` interface preserves legacy unpositioned behavior. This explicit
versioned entry point keeps its existing callers and frozen regressions intact. Old nullable-position records and
mappings receive only the `legacy-unpositioned` discriminator: no position is backfilled, and even a later call
through the positioned interface reuses that exact legacy record. An older SDK execution remains uncaptured,
including when a genuine new positioned registration encounters it. Neither a dedup hit nor a recreated SDK row
becomes initial positive custody.

`reserveOperationalWorkTransfer(tx, phase)` privately prepays one child for each of `resolve`, `verify`, `receive`,
`replay`, `retirement`, after registration while the authentic original is live. Tokens bind the custody locator,
actual Pool, phase and absolute original deadline. Copies, foreign locators/Pools, repeated issuance/spend,
precommit use, expired or rolled-back attempts refuse before checkout. Reusing a durable original cannot extend
that original's deadline. One cumulative original balance funds all three possible attempts without refills.

`resolveCommittedOperationalWork(pool, locator, transfer)` performs one bounded committed read, holding the actual
partition/family/head/original fences through its source-home COMMIT, then releases the client before returning
an opaque `CommittedOperationalWork` or `null`. The discriminated source contains the immutable original position,
never the current head substituted as an original. It checks current epoch/family generation and that the head
still bounds the exact original. `operationalWorkSource(pool, origin)` returns a defensive copy.
`verifyCommittedOperationalWorkOrigin(pool, origin, verifyTransfer)` independently repeats that exact same-home
held verification and returns the typed stamp. Its success establishes local operational provenance only; it grants
no Source enrollment, cut coverage, currentness, replay or destructive authority. Legacy verification refuses
`operational-work-original-log-position-unavailable` rather than fabricating provenance.

After releasing the source client, `receiveCommittedOperationalWork(pool, workClient, origin, receiveTransfer)`
(also `work/history-enqueue.ts:receiveOperationalHistoryWork`) registers the immutable partition-led
`core.operational_work_mapping`, native `history_work` and exact role inventory. Stamp columns, serialized stamp,
full original body, receiver epoch/family generation and SDK writer/restore generation are read back and bound.
The SDK's real transaction-scoped writer barrier stays held through the receiving COMMIT. Every SDK probe uses
the mapped deterministic workflow ID, never the native custody UUID. Receiving performs no second enqueue and
never inserts `core.agent_identity_work`. It returns `registered-pending-source-currentness` for captured positioned
originals, `registered-pending-position` for captured legacy originals, or `uncaptured` for older SDK executions.
Single-database SDK placement does not prove independent-home/restore closure.

The local declaration lives in `operational-work-budget.ts`. Axis order is candidate keys, native rows, identity
metadata rows, empty seeks, native points, witness keys, statements, bytes. Exact native keys use no semantic
candidate/witness or identity-metadata allowance. Each key's bound covers either a hit or an empty seek.

| Body                                                                          | Complete local bound                  |
| ----------------------------------------------------------------------------- | ------------------------------------- |
| Executor attempt controls and native fence                                    | `(0,7,0,3,3,0,14,768)`                |
| Registration, counter, sole SDK enqueue/callback, inventory and deferred seal | `(0,1191,0,1221,1221,0,464,596352)`   |
| Committed resolution or independent held verification, each                   | `(0,4,0,4,4,0,9,291328)`              |
| Receiving and exact readback                                                  | `(0,1137,0,1136,1136,0,429,678016)`   |
| Replay or guarded retirement probe, each                                      | `(0,29,0,25,25,0,25,318592)`          |
| Original ceiling, three complete attempts including every child reservation   | `(0,7203,0,7254,7254,0,2925,7484928)` |

The literal declaration includes both allocator INSERT and conflict-UPDATE trigger paths, partition FK and PK,
exact head/original deferred constraints, original/episode unique indexes, position index, stamp serialization,
repeated idempotent lookup, all eight SDK physical probes, bounded SDK projection/callback, History role/seal/FK
and family-touch bodies, receiving mapping/index/readback, current writer checks, settings, lock failures, commit
and rollback slots. Registration pays the complete fresh/repeated-path upper bound before its first SQL. The
original prepays executor controls before I/O; each private transfer subtracts its whole child before checkout.
All child queries check the same deadline after connection/lock waits, and commit refreshes the remaining timeout;
raw rollback remains available after expiry. No allowance is copied from identity/preference History or replenished.
This is the opt-in producer's price only: Commerce's reservation/association, Access, Semantic Source enrollment/
consumer accounting and Library positive SQL require their separate real bodies, prices and private composition.

`verifyOperationalWorkReplay` and the optional `{ origin, transfer }` branch of `durable.ts:minimizeHistoryWork`
recheck the actual receiving incarnation, immutable mapping/roles, account seals and SDK original/writer on the
receiving client through commit. Positioned captured originals then refuse precisely
`operational-work-source-currentness-unavailable`; uncaptured originals refuse
`operational-work-uncaptured-older-execution`. The former obsolete log-position refusal remains only for legacy
unpositioned records. No SDK read, removal or absence probe is performed under a native custody UUID. Native
custody guards continue to forbid readiness, retirement, physical absence and minimized receiving proofs until
real owning operands exist. The remaining operands are released/final held Source enrollment/currentness/cut
coverage, independent SDK/physical home inventory and restore/retirement authority, and Commerce's final episode
association/completion caller. The positive operational stamp opens none of those branches. Registration, terminal
status, local cleanup, EOF, publication and ACK are not all-copy completion. Focused native regressions in
`test/history/operational-work-position.test.ts` supplement the unchanged legacy suite; both remain UNRUN in this
delivery pending controller integration.

History validates the exact account-discovery effect row/workflow and effects checkpoint, then observes Search's
current Account enrollment in a released Source snapshot and compares it with the final same-home result. The
worker commits its selected History cursor before the released observation, then locks and rechecks that cursor
before final receiving. The supported local case requires active Account and Search homes, at least one active generation for the configured
prefix, a certified Account population for each generation, and its exact non-deleted, settled copy at the current
Account revision and recovery event position. Empty enrollment, unsupported homes, changed snapshots and genuine
unsettled copies retain their specific pending gaps; a callback, relay checkpoint, empty page or Source observation
alone is not a completion receipt. The Recovery serializers become ready only after the final locked rows match.
The account-updated recovery event is not an original verification/reversal handoff and cannot create a new SDK
obligation. This History module does not claim physical deletion, original SDK closure or whole Source completion.

The recovery writer is suppressed inside an active Semantic Source maintenance frame until its complete original
Source/History aggregate is funded. Five existing current verifier entries alone require 696320 bytes against the
unchanged 630784-byte allowance. The previous 11588/9856/2731/6843136/0 selected consumer body is not the final
aggregate. The current implementation does not alter prices, configured limits, or any unrelated owner budget.

## Private selected operational association

`operational-work-selected.ts` is the Accounts half of the opt-in Work selected invocation ABI described in
[Work](../work/README.md#selected-execution-producer). Its `SelectedLocator`, opaque `SelectedEpisode` and
`SelectedOutcome` types are server-only. Exported association helpers require the exact private identity attached
to a genuine live selected `OperationalTransaction`; structural identities and synthetic transactions refuse
before SQL. Native transaction construction and live maps remain exclusively in `command/operational.ts`.

`core.operational_work_selection` records a bounded once-only selected identity and immutable original/episode
binding, observed tuple, attempt/domain/deadline and conditional result. `core.operational_work_selected_continuation`
binds a newly transactionally enqueued workflow to that same original and parent selection. Both tables have native
FKs and ALWAYS immutable/no-delete/no-truncate guards. A deferred constraint checks that the continuation and
parent result commit together. Recovery reads the actual result before requiring an episode still to be live;
missing or pending results after durable spend refuse. No durable outcome is inferred from a successful callback.

Selection rereads actual positioned operational-work/v1 original/episode, current home epoch/domain/head and exact
SDK creator/input digest. The original remains immutable provenance, even when its request deadline expired; it
never funds selected work. The first native tuple acquisition locks Collection SHARE and episode UPDATE, verifies
active curated/current curator, <=24-hour live episode, exact basis/digest and reserved/current incarnation/generation,
then records that actual tuple. Source reading occurs after release. Apply/failure takes a new genuine transaction,
holds current SDK owner, rereads original and native tuple and compares all observed fields, including version,
checkpoint, stored observation, prepared generation and completion. Conditional result follows the native version
transition in that same COMMIT. Failure requires the same observed version and a reached native failure field.
Unknown native SQL is refused; foreign update prices and real Source authority remain caller-owned.

The first lock is never carried as evidence into the second transaction. A copied episode, changed tuple, moved home,
restored domain, changed incarnation/generation or new version refuses. Supported ordinary continuation requires
its exact step/version ID, genuine new SDK transactional enqueue and exact committed argument mapping. Changed-
generation repair and cleanup are unavailable until their separate complete authority/prices exist. `complete`
explicitly refuses missing final Source/physical authority. No new Source enrollment, legal erasure or all-copy ACK
is inferred from selection. Existing operational-work/v1 registration/enqueue and transfer expiry guards are unchanged.

The current installed Library Members body/schema is absent; the producer checks native table presence before
attempting that dependent read and refuses `selected-runtime-commerce-native-episode-absent`. It never imports
retained code as an installed prerequisite. Core migration/snapshot live at `db/migrations/` and `db/schema.sql`
(the repository's current core placement); no `db/core` migration tree is introduced. Native and full verification
remain deferred. New fixtures preserve expired-transfer, immutable binding, recovery, copied context, owner/restore
and no-refill refusal oracles; they do not claim an implemented Commerce caller.

## Selected original prepaid identity consumer

`withPrepaidAgentIdentityHistoryUnit` is the Accounts receiver required by the
installed `withSelectedHistoryOriginalChild`. Its exact type is
`PrepaidAgentIdentityHistoryUnit` from `access/identity-original-admission.ts`:

```ts
<T>(
  deps: HistoryOriginalDependencies & {
    env: Readonly<Record<string, string | undefined>>;
    clock: () => Date;
  },
  parent: IdentityOriginalSourceContext,
  body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>,
) => Promise<T>;
```

It runs **inside** the sole `withIdentityOriginalSourceTransfer` callback. It neither
consumes the local original again nor enters another transfer. The producer module is
resolved at the prepaid operation boundary to avoid an eager Library/HTTP/command
construction cycle. Its cached callable namespace is not funding or a cached receipt.
Producer operations validate the actual opaque grant, selected original, job, Pool,
WorkClient, registry, immutable position, native allocation, exact Library ledger and
absolute deadline.
The fixed runtime Source receiving operand is
`withPrepaidIdentitySourceConsumerMaintenance(deps, parent, body)` in
`semantic/identity-source-consumer-maintenance.ts`. A missing data export refuses as
`identity-source-prepaid-maintenance-not-installed`, before entering configured
maintenance or child I/O. The independent `withAgentIdentityHistoryUnit` retains its
existing configured admission and is never a substitute on this route.

The Source callback must deliver its real live maintenance context with the original
deadline and exact `identityOriginalLibraryWork` ledger. Accounts binds that object to
its private identity unit and maintenance callback machinery. Reentry poisons the
outer unit; copied explicit contexts, foreign Pools/clients, callback escape, expiration
and repeated entry refuse. Passing a genuine context from an earlier callback also
poisons the current prepaid unit, even if the caller catches the refusal and restores
the correct context. Callback success and failure invalidate the unit and saved
query closures. Released read facades carry no native command resources. They release
their checkout before another home is entered. Query wrappers validate authority
before and after each await; a separately prepaid ROLLBACK remains usable for cleanup.

`shared-history.ts` forwards this same context into its identity-only final receiving
branch. It locks and compares the selected phase, both partition cursors, locator,
account, registry generation/digest and accepted barrier. Final SDK/native currentness,
receiving and checkpoint writes stay in the same native command, with producer progress
recorded before COMMIT. This code does not treat a later head as original authority.
Native source association still uses the actual original command source, independently
of every retained account role. Existing native inventory, restore, permanent SDK
generation-2 fence, physical-copy and live-subject checks remain required.

### Selected native executor binding

`identityHistoryCommand` captures the actual private prepaid unit, its original grant,
context, Pool, WorkClient, registry and immutable deadline. It calls the installed
`withCommandDispatchLifetime(pool, deadline, owner, body)` around exactly one genuine
`runCommand`, under `withSingleCommandAttempt`, returning the native `noEffect` result.
Core retains construction and association of the native transaction. Accounts creates
no command transaction, raw-client interceptor or executor replacement.

The synchronous `owner.validate(): void` authenticates that same active unpoisoned unit
and parent through the real original producer operations on every Core checkpoint.
`owner.original` is exactly `parent.original`. `owner.reserve(allowance)` validates again,
requires the actual `COMMAND_DISPATCH_ALLOWANCE` identity and calls
`reserveIdentityOriginalSourceWork` **once** with `allowance.total.work`. This atomically
holds effect plus disjoint cleanup before checkout. It never charges `local.command`,
the old Source counter, or the already-spent original local allowance for that command.
Core alone dispatches the already-held same-client failure ROLLBACK, even after expiry
or revocation. Failed COMMIT, failed ROLLBACK and unused cleanup never refill the ledger.
Body SQL and SDK/Source/Library children remain additional independently priced work.

`IDENTITY_HISTORY_ACCOUNTS_DECLARATION.selectedCommand` is the actual frozen Core export,
including its component prices, rather than a handwritten replacement. In vector order
candidateKeys/nativeRows/identityMetadataRows/nativePoints/witnessKeys/statements/bytes/
emptySeeks, its effect is `0/2/0/1/0/7/169/1`, cleanup is `0/0/0/0/0/1/0/0`, and total is
`0/2/0/1/0/8/169/1`; every `engineRequests` is zero. Variable timeout strings, bindings
and bounded projected rows are included; fixed SQL/protocol framing is excluded as
defined by [Core](../command/README.md#cost-selected-native-no-effect-controls).

Each reached command pays one total, including early pending returns and failures.
The local retirement route has eight distinct command sites: initial receiver, original
source, source handoff, native retirement verification, receiver reread, readiness
recording, durable readiness reread and closure recording. Physical minimization adds
prepare, current guard and final native recording; two fence observations each repeat
their before/after receiving commands. Selected final progress or the pending scheduler
update adds one alternative command. Source-owned scheduling/repeated native inventory
may add further reached commands; these multiplicities must be composed by Source,
not inferred as a finite whole-child maximum from the local quote.

Only Core's finite `single-no-effect` profile is supported. The adapter supplies no actor,
basis, principal, receipt, authorization or custom clock. Events, callbacks, record-source
sets and agent associations remain refused before unsupported final controls. Empty
native fence results refuse before unbounded routing projections, writable waits or retry.
The ordinary independent-maintenance command branch keeps its historical control price.

### Known local declaration and composition interface

`IDENTITY_HISTORY_ACCOUNTS_DECLARATION`, exported by `agent-identity-inventory-work.ts`
and re-exported by `agent-identity-retirement.ts`, publishes per-call Accounts local
and installed SDK dispatch prices. It is a **subdeclaration**, without a whole-parent
`work` or nullable successful total. Semantic owns composition of
`IDENTITY_HISTORY_ORIGINAL_SOURCE_DECLARATION`; Library owns
`IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION`. Missing terms cannot be filled by
zero, a configured allowance or the fully spent Accounts local allocation.

All eight axes are explicit. In the local table below, `candidateKeys`,
`identityMetadataRows` and `witnessKeys` are proven zero: these bodies address Accounts
native control/serializer rows, not Library candidate enumeration, Semantic metadata
sweeps or Library witness expansion. The remaining five axes are shown below.
`engineRequests` is separately zero. Native row/point/statement/byte bounds preserve
the literal bounded local SQL; each joined indexed relation contributes its own seek.
A bounded range contributes one empty seek, not one per possible returned row. Scalar
returns, transaction/settings controls and COMMIT/ROLLBACK contribute no index seek.
Source's nested native work is excluded and remains a named missing operand.

| Local call body          | nativeRows | nativePoints | statements |  bytes | emptySeeks |
| ------------------------ | ---------: | -----------: | ---------: | -----: | ---------: |
| command (independent)    |          3 |            1 |          8 |    256 |          1 |
| snapshot                 |          1 |            0 |          4 |    128 |          0 |
| physicalInspection       |        148 |            8 |         12 |  11888 |          8 |
| mapping                  |          4 |            4 |          3 |  16384 |          4 |
| receivingBinding         |         72 |           72 |          6 |  32768 |          8 |
| readiness                |         74 |           74 |          7 |  49152 |         10 |
| sdkReceiving             |        160 |           80 |          6 | 131072 |          8 |
| nativeWorkRead           |          1 |            1 |          1 |     64 |          1 |
| nativeWrite              |          1 |            1 |          1 |      0 |          1 |
| nativePairWrite          |          2 |            2 |          2 |      0 |          2 |
| nativeAuthoritySeal      |          3 |            3 |          2 |      0 |          3 |
| nativeLocatorWrite       |          4 |            4 |          4 |      0 |          4 |
| nativeGuardProbe         |          1 |            0 |          1 |    256 |          0 |
| durableReceiving         |         76 |           75 |         13 | 131872 |         10 |
| releasedDurableReceiving |         76 |           75 |         17 | 132000 |         10 |
| receivingInsert          |         72 |           71 |          7 |      0 |          7 |
| roleScope                |         65 |           65 |          1 |   8192 |          1 |
| selectedJob              |          1 |            1 |          1 |   4096 |          1 |
| selectedBarrier          |          1 |            1 |          1 |    128 |          1 |
| selectedProgress         |          1 |            1 |          1 |      0 |          1 |
| sdkWriterObservation     |          3 |            2 |          1 |   8192 |          2 |
| sdkFenceObservation      |          1 |            1 |          1 |   8192 |          1 |
| sdkWriterLock            |          4 |            2 |          4 |   8192 |          2 |
| nativeInventory          |        202 |          202 |          5 |  65536 |          7 |
| recoveryInventory        |        135 |          135 |          6 |  32768 |         10 |
| recoveryAssociation      |          2 |            2 |          1 |    512 |          3 |
| recoveryReceiving        |        100 |          100 |         36 |  24576 |          3 |
| seal                     |         16 |           16 |          7 |     64 |          7 |
| nativeGuardLocal         |         71 |           70 |          5 |  40960 |          6 |
| nativeAbsence            |          9 |            9 |          9 |      0 |          9 |
| recordedAuthority        |          1 |            1 |          1 | 122880 |          1 |
| previousReadiness        |          1 |            1 |          1 | 106496 |          1 |
| durableReadiness         |          1 |            1 |          1 |  65536 |          1 |
| sourceMappingSnapshot    |          6 |            5 |          8 |  16640 |          5 |
| retirementSnapshot       |          7 |            6 |          8 |  33024 |          6 |
| inventoryReceivingCopy   |          4 |            4 |          3 |   1024 |          4 |
| sdkObligation            |          1 |            1 |          1 |   1024 |          1 |
| familyTouch              |         12 |           12 |          4 |      0 |          4 |
| workInvalidation         |        846 |          846 |        261 |      0 |        326 |
| workWake                 |        128 |           65 |         65 |      0 |         65 |
| locatorInvalidation      |       1678 |         1678 |        518 |      0 |        518 |
| receivingInvalidation    |        845 |          845 |        261 |      0 |        261 |

The aggregate `physicalInspection` includes its envelope; `releasedDurableReceiving`,
`sourceMappingSnapshot` and `retirementSnapshot` also include theirs. For the other
local cuts an envelope is additional: selected native commands reserve the actual
Core `selectedCommand.total` above; independent commands reserve `local.command`.
Released snapshots reserve
BEGIN/settings/COMMIT/ROLLBACK. Recovery released snapshots now include that envelope
as well. Mapping is read initially and again by each receiving binding. Retirement
has two released binding checks and the writer observation before mutation, then two
binding checks around each fence observation. Owner readiness repeats per actual
owner call. Native inventory reads allow three copies and 64 roles plus a refusal
sentinel per copy; recovery inventory allows two copies with the same role bound.
Each initial and repeated current-cut check is charged, including absent/rejected cuts.
Per-copy final receiving/seal/locator/physical checks and each SDK obligation probe are
additional terms. Physical cleanup inspects eight tables twice, with limits
`1,1,1,64,8,64,0,0`; each probe reserves its LIMIT+1 rows, bytes and one empty seek.
Family/invalidation/wakeup terms include the actual native trigger fanout, including
65 locators and the nine-family touch bound. They are added on every reached write.
No successful or failed prefix resets the ledger.

The SDK single attempt reserves ROLLBACK before checkout, then BEGIN, settings, native
writer lock, action and COMMIT. Retirement has one action; deletion has the four
literal installed deletes, with `children=false`. Its exact dispatch declaration is:

| SDK dispatch             | nativeRows | nativePoints | statements | bytes | emptySeeks |
| ------------------------ | ---------: | -----------: | ---------: | ----: | ---------: |
| rollback                 |          0 |            0 |          1 |     0 |          0 |
| begin                    |          0 |            0 |          1 |     0 |          0 |
| settings                 |          1 |            0 |          1 |   128 |          0 |
| lock                     |          4 |            2 |          4 |  8192 |          2 |
| retire                   |          8 |            5 |          9 | 32768 |          5 |
| commit                   |          0 |            0 |          1 |     0 |          0 |
| delete-workflow_input    |          1 |            1 |          1 |     0 |          1 |
| delete-workflow_output   |          1 |            1 |          1 |     0 |          1 |
| delete-operation_outputs |         64 |            1 |          1 |     0 |          1 |
| delete-workflow_status   |         73 |            5 |          5 |     0 |          5 |

These terms follow the installed SDK native writer SQL, including the writer trigger
and four status FK cascades. Payload/operation tables have independent keys. Actual
SDK dispatch objects are recognized by identity and checked against these bounds at
the operation boundary. Copied five-field values and unknown SQL have no eight-axis
declaration and refuse before dispatch. The known local reservation calls the actual
`reserveIdentityOriginalSourceWork` once; it does not also debit independent Source
maintenance. Dispatched, failed, rolled-back and ambiguous work remains spent.
Library descendants use only the authentic parent's cumulative ledger.

### Missing operands and current refusal boundary

The installed Source module does not export the agreed prepaid receiver or complete
Source declaration; the installed Library module does not export its complete original
declaration. Accordingly the actual original admission cannot supply those partitions.
The known Accounts declaration remains independently available for owner composition.
Its named missing terms are:

- `SourceHistoryNativeAllReachedCalls`: original/accepted recovery reads, Source
  staging/custody/handoff and final native verification, including nested native SQL.
- `LibraryAllReachedCalls`: successful page/current/locked-plan/seal/fence and cleanup,
  through the exact original ledger. An unavailable page is not successful free work.
- `SourceHistoryNativeGuard`: nested Source work reached by the History native guard.
- `RecoveryFinalReceiving`: disjoint local/Source composition of the two serializer
  current receiving verifiers; its legacy five-field bound does not classify eight axes.
- `RecoveryReceivingEnrollment`: genuine released Search enrollment and same-home
  current verification. Canonical-index redrive/release is insufficient.
- `SDKPhysicalWriterClosure`: independent homes and non-FK participants. SDK deletion,
  EOF, terminal workflow, ACK or local cleanup cannot discharge these obligations.

The delivered Core lifetime is now bound by the selected adapter and is not a missing
term. Missing complete partitions still refuse before affected child I/O, and missing
physical/native enrollment refuses the affected final proof. No complete Account erasure
or all-copy completion is asserted.
Focused prepaid callback/declaration and authentic selected-original regressions are
provided in the History and shared-History context tests. The new native command suite
exercises the delivered executor binding. The retained older prepaid suite includes a
historical unconditional-executor-refusal assertion that predates this supported binding;
it is preserved unchanged under the acceptance-test freeze and needs owner reconciliation.
Native acceptance remains
unrun at this source delivery boundary; typechecking does not establish native proof.
