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

| Body | Complete local bound |
| --- | --- |
| Executor attempt controls and native fence | `(0,7,0,3,3,0,14,768)` |
| Registration, counter, sole SDK enqueue/callback, inventory and deferred seal | `(0,1191,0,1221,1221,0,464,596352)` |
| Committed resolution or independent held verification, each | `(0,4,0,4,4,0,9,291328)` |
| Receiving and exact readback | `(0,1137,0,1136,1136,0,429,678016)` |
| Replay or guarded retirement probe, each | `(0,29,0,25,25,0,25,318592)` |
| Original ceiling, three complete attempts including every child reservation | `(0,7203,0,7254,7254,0,2925,7484928)` |

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

History validates the exact account-discovery effect row/workflow and effects checkpoint, then must also verify
Search's current discovery enrollment through a released owner observation and a final same-home result. No such
Search owner capability is installed in this composition. A checkpoint does not identify the current consumer
set, and a Search generation list read while holding an Account home is not authority. Therefore the actual gap is
`agent-identity-recovery-discovery-owner-unavailable` and the Recovery serializers remain pending for retention.
The account-updated recovery event is not an original verification/reversal handoff and cannot create a new SDK
obligation. This History module does not claim physical deletion, original SDK closure or whole Source completion.

The recovery writer is suppressed inside an active Semantic Source maintenance frame until its complete original
Source/History aggregate is funded. Five existing current verifier entries alone require 696320 bytes against the
unchanged 630784-byte allowance. The previous 11588/9856/2731/6843136/0 selected consumer body is not the final
aggregate. The current implementation does not alter prices, configured limits, or any unrelated owner budget.
