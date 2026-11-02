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

`operational-work.ts:registerOperationalHistoryWork(tx, binding, intent)` accepts the genuine live
`OperationalTransaction` from `runOperationalTransaction` with `operationalHistory: true`. The source must be a
request of kind `library.membersPreparation`, on `partitionOf(route)`, fencing exactly `[ownerAccountId]`. The
binding contains `route`, `ownerAccountId`, `collectionId`, sorted unique `episodes` and sorted unique `retired`
locators. Each of the 1..16 new episodes supplies its exact `collectionId`, `episodeId`, `reservedIncarnation`,
decimal-string `reservedGeneration`, `canonicalBasis` and lowercase SHA-256 `basisDigest`. Retired locators are
bounded by 32. Canonical basis remains `[1, owner, collection, admittedFilter, sort, releaseDigest]`. Commerce
owns native reservation verification and episode association; this producer neither admits a filter nor replaces
that owner. Existing-basis reuse with `intent: null` does not call registration or enqueue.

Registration owns the one existing `enqueueIntent` call on that same underlying source client. Callers must remove
their separate enqueue when opting in. The exact `workflows/library.membersPreparation` name, deterministic
`library:members-preparation:<route>:<owner>:<minimum-new-episode>` ID, sorted locator-only
`accounts/route/episodes/cleanup` input and 4096-byte payload cap are unchanged. No positional arguments or
additional payload keys are admitted. The full canonical binding is bounded by 196608 bytes. Same binding with a
different body conflicts; repetition of the exact original returns its existing native locator without enqueue.
The immutable source association retains the original operation kind/mode/partition/accounts/deadline and the
complete actual Access identity role union, independently of the payload's single owner account. At most eight
distinct identity accounts are admitted; role bits are preserved without projection. The owner and
durable-initiator role bits are added to the native owner association. The record-source binding is stored
separately in the immutable original and episode tables; it is not an inferred account role.

The returned `OperationalWorkRegistration { partition, custodyId }` is only an opaque durable lookup key. It is
serializable but is not committed authority. The custody UUID namespace selects a dispatch branch; neither it nor
the separate transaction UUID proves original authority or funding. The executor seals the association just before
its native COMMIT, then activates private transfers only after COMMIT succeeds. Every exit invalidates the live
transaction; rollback/contention invalidate their transfers without refund. Existing non-opted-in operational
and command/identity History paths keep their existing behavior.

`reserveOperationalWorkTransfer(tx, phase)` reserves a private one-shot child for `resolve`, `receive`, `replay` or
`retirement` after registration while the authentic original is live. Each token binds that exact native custody
locator. Copies, foreign Pools or locators, repeated phase issuance, expired deadlines,
failed attempts and precommit use refuse before checkout. `resolveCommittedOperationalWork(pool, locator, transfer)`
performs one bounded committed durable read and releases the source client before returning an opaque
`CommittedOperationalWork` or `null`. Here **committed means the registration association was observed after native
commit, not that an original log position or custody receipt exists**. `operationalWorkSource(pool, origin)` exposes
a defensive copy for owner integration during that released resolution's lifetime.

`receiveCommittedOperationalWork(pool, workClient, origin, receiveTransfer)` (also exported as
`work/history-enqueue.ts:receiveOperationalHistoryWork`) writes the independent partition-led
`core.operational_work_mapping` and receiving `history_work`/role inventory. It reads back the exact immutable
mapping and original SDK status/input, and holds the SDK's actual restore-domain/writer barrier through the
receiving COMMIT. Native custody is translated to the unchanged deterministic SDK ID on every SDK read. It never
enqueues again or inserts `core.agent_identity_work`. It returns `registered-pending-position` or `uncaptured`;
an already existing SDK execution or orphan physical copy can never become initial positive custody. SDK creator,
serialized input digest and writer/restore generation bind the original physical execution. SDK recreation,
receiving incarnation change and source restore invalidate their respective branches. Physical single-database
placement is not independent-home or restore-completion evidence.

The eight-axis local declaration is in `operational-work-budget.ts`, in the order candidate keys, native rows,
identity metadata rows, empty seeks, native points, witness keys, statements, bytes:

| Body | Complete local bound |
| --- | --- |
| Executor attempt controls and native fence | `(0,7,0,3,3,0,14,768)` |
| Registration, same-client SDK/callback, inventory and final seal | `(0,1177,0,1177,1177,0,453,588032)` |
| Committed resolution | `(0,4,0,3,3,0,7,290816)` |
| Receiving and exact readback | `(0,1137,0,1133,1133,0,428,676864)` |
| Replay or guarded retirement probe, each | `(0,29,0,25,25,0,24,317952)` |
| Original ceiling, three complete attempts including failed child reservations | `(0,7149,0,7098,7098,0,2850,6577152)` |

These bounds include literal SQL controls/settings/commit/rollback, trigger/FK/role bodies, all eight SDK physical
existence probes, SDK projection/callback reads, bounded serialization, receiving writer checks and repeated probes.
The executor prepays attempt controls before its first I/O; registration prepays its body before its first read;
private child reservations subtract their complete body before checkout. One actual Pool, absolute deadline and
cumulative balance cover all attempts; spent allowances do not refill. This is only the opt-in producer's local
declaration. Receiving and resolution check that same deadline before each SQL dispatch, including after checkout
or a previous lock wait; raw-client rollback remains available after expiry. This is only the opt-in producer's local
declaration. Commerce's reservation/association, Access preparation and final Source/Library/physical-owner bodies
require their own actual prices and private original composition. This local declaration grants none of those
allowances and does not consume the selected preference-History or identity-only allocation.

The installed native operational fence only locks the current partition. `events/read-log.sql` enumerates every
partition position and `events/log.ts` rejects a missing envelope as a gap. Incrementing that position for an
eventless operational registration would break the log, while this producer is not authorized to create an event or
change command semantics. Consequently the exact missing final operand is the authentic **original operational
commit `(epoch, position)`**. The association records its real partition epoch but keeps `source_position = NULL`
and `operational-work-original-log-position-unavailable`; current position, time, xmin, later Source heads and SDK
IDs are never substituted. A deferred database constraint prevents an unsealed association from committing.

`verifyOperationalWorkReplay` checks the real mapped receiving inventory/writer and then refuses positive replay
for that missing position (or `operational-work-uncaptured-older-execution`). `durable.ts:minimizeHistoryWork` accepts
an optional final `{ origin, transfer }` operand and dispatches the native namespace to the same fenced branch;
missing private funding refuses before I/O. No SDK deletion is attempted under a custody UUID. Native immutable
mapping/role guards also prevent generic History from declaring readiness, physical absence, retirement or a
minimized receiving proof. After a genuine original position becomes available, final Source currentness,
independent physical-home inventory/restore authority and Commerce's completion association remain separate owner
operands. Registration, terminal workflow status, local cleanup, EOF, source publication and ACK prove none of
those. Focused native rollback/contention/idempotency/conflict/expiry/uncaptured/recreation regressions are authored
in `test/history/operational-work.test.ts`; native acceptance remains deferred to the controller.

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
