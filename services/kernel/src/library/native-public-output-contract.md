# Native public output custody

This module owns retention of one exact published Collection output for a Semantic public capture. Semantic owns
the accepted canonical capture, original/terminal Subject closure, manifest, seal and receiving disposition. A raw
output page, native lock, native hold or native transfer establishes none of that canonical closure or viewer Access.
The native addition uses the existing public observation and output page algorithm. Working/private Source
observations, publication writer authorization and account Source custody are separate authorities.

Decision: composition builds the native operation from Library's metadata observation and Semantic's persisted disposition lock, installs it as the Library application, and supplies that operation set directly to Semantic capture.

## Public tuple and receiving identity

The six callable operations are exported from `collection-source-native.ts` and implemented in
`native-public-output-custody.ts`; their shared types live in the public Library contract
`contract/native-public-output.ts`. `native-public-output-contract.ts` remains a compatibility type re-export. The
contract uses the existing `NativePublicOutputIdentity`, `NativeOutputActivation`, publication/reference shape,
native receipt, listing stamp, raw key and eight-axis work types without importing Semantic or the native source adapter.

A public tuple requires an active public or unlisted dynamic Collection, its active unfenced same-home curator,
the original active unmoved partition epoch, and the actual selected COMPLETE publication. The publication check
joins the retained header, selected head, immutable publication, Collection incarnation, native source fence,
original `editorial.write_basis` and current Core partition. Expected, written and actual member counts agree,
including zero; member and Collection fences agree. Publication, header, head and write basis have the same native
transaction version. The account-attributed publication is from a previously committed transaction. Activation
transaction, decimal position and immutable activation source generation match exactly. Current source generation
is compared separately. A current-public lock takes real conflicting Collection/partition/curator/head/header/
publication/fence/basis row locks and leaves them on the caller's client until its commit or rollback.

`bindAndHoldNativePublicCollectionOutput` accepts a capture key, definition digest and exact publication selector.
It locks the original owner before native custody lookup. A new immutable binding establishes a capture-specific
receiving epoch of `1` and an effect key derived from the new hold, capture, actual executor component and publication.
Other captures never advance this receiving fence. The binding digest covers the complete tuple and observation,
capture/hold/definition, original and receiving home/epoch, and actual accepted component. Both homes are the original
Collection home. Positions serialize as canonical decimal strings and deserialize to the canonical bigint receipt
and observation types. Fresh observation positions advance with Core commands; current checks compare the
immutable identity and publication, rather than requiring the original observation position to remain current. Digests and UUIDs are selectors; matching persisted native records and their provenance supply
authority. The database compares the payload against its relational keys and actual publication, rather than trusting
JSON assertions.

The binder requires the genuine live `CommandTransaction`, `currentCommandResources(tx).pool`, Collection home,
current command time and existing deadline. It performs no checkout, nested command, operational substitution,
foreign Subject/Source read or publication activation. Its receipt is an **uncommitted locator**. Semantic must write
its matching accepted binding and register `recordIdentityEpochNativeCommit(tx, 'identity-public-output-capture')`
in this same command. Deferred native constraints require that exact actual Semantic native component, epoch,
position, transaction version and Core outbox event. A native hold cannot commit against an old component, a
different uncommitted command, a fabricated UUID or a command that never commits an event. Semantic owns the matching
accepted-record and initial enrollment-gate constraints. A second native deferred guard also resolves the exact
accepted record in this transaction; neither a component alone nor a binding alone can commit this capture.

Reusing a capture resolves its original immutable binding. Definition, publication and full activation must still
match; replay cannot reset or reinterpret it. A repeat inside the creating command can recover its uncommitted
locator by actual command transaction and native xid. Released use instead joins the original binding version to
the original Semantic native component and actual Core outbox version and current owner epoch. `read` resolves
that native binding and performs observation plus one raw output page in a single REPEATABLE READ snapshot.
`lock` and `revalidateHold` use the original caller transaction throughout. Exact current eligibility, identity and
publication are required for further use. An empty COMPLETE page is ready and exhausted. Eligibility loss returns
changed/unavailable without disposing custody.

## Receiving disposition and atomic transitions

Transfer and release take only the exact capture/hold/binding selector and expected native disposition receipt.
Composition supplies `resolvePublicIdentityOutputCaptureDisposition` from Semantic's actual producer implementation
to the native adapter. This required capability resolves persisted Semantic state on the original command; there is
no caller evidence payload, boolean completion proof, account identity cast or substitute canonical ledger.

The native receiving operand type `LockedPublicOutputDisposition` describes the persisted record needed from that
lock: the full original binding and accepted receipt, exact disposition component, staged/committed provenance,
and either the sealed manifest/seal plus successor/transfer component, or the cancellation epoch/component. The
fixed purposes are `identity-public-output-applied` and `identity-public-output-cancelled`. Semantic must independently
resolve its immutable same-home record and all genuine enrolled receiver/writer closure. Its staged branch must
bind the actual current executor component and its deferred native transition constraints; its committed branch
must verify the original committed component. Returning a typed object alone is not implementation of this lock.
Missing closure remains unavailable with its owner dependency; an empty observed reader list or successful scan
cannot establish disposal.

Before native transfer, Semantic inserts its immutable `identity_public_output_stage` keyed by the original
capture. It binds predecessor, binding digest, original receiving epoch, fixed purpose, real current component,
native xid and either the selected distinct successor plus exact manifest/seal, or exact next cancellation epoch.
No process cache selects the successor. Native insertion and Semantic stage/disposition/transition each have
deferred guards requiring the other side in the same transaction. The canonical locked union returns `binding`,
`disposition`, `work`, `provenance`, and kind-specific top-level fields; the applied `transfer` and cancelled
`cancellation` equal that disposition. Committed replay resolves the original selection, including successor.

A persisted Semantic enrollment gate begins atomically with accepted binding. Its monotone enrollment count
increments only for a newly inserted consumer. An immutable native fence closes the gate at original epoch + 1
before cancellation closure dispatch. A known original gate with count zero proves that this capture admitted
no such receivers; an empty consumer query alone does not. A positive count requires genuine Search receiver/
writer closure, which is not supplied by this module. A missing older gate is also refusing, never backfilled zero.
Already admitted Subject inverses need genuine platform-native erasure-aware removal for cancellation; an empty
future page or elapsed deadline cannot substitute for it.

Native code independently compares every selector and the complete binding. First transition requires a staged
record whose partition, epoch, position and transaction are exactly the live command's next actual Core component.
Requiring that first receipt to be already committed would make same-command atomicity impossible. Applied transfer
inserts the immutable transition, installs a native successor retaining the same publication and binding, consumes
the predecessor, and closes its enrollment fence in this same transaction. All existing receiving/copy obligations
remain attached to the unchanged binding; no obligation is discarded, summarized as zero or moved to another ledger.
The successor is a separate durable retention key. Native deferred checks require the same real disposition/native
component/outbox version, the successor created in that transaction, and predecessor consumption plus receiving
fencing. Cancelled release similarly advances the native receiving epoch and consumes only the predecessor after
the Semantic owner has resolved genuine closure. Page/seal/use of the old receiving epoch then refuses.

Committed replay resolves the Semantic record again, compares the immutable native transition payload and validates
its original native component/Core outbox version independently. It does not rewrite a disposition, allocate another
successor or reopen the receiving fence. Predecessor cancellation cannot consume a successor: successor rows are
immutable and their consumption is closed pending a separately implemented genuine terminal disposition. A seal or
capture completion alone never releases a hold. If an owner/restore fence, actual staged validator, genuine foreign
closure or successor evidence is missing or mismatched, custody remains retained.

## Retention and bounded storage

The additive Library migration creates one immutable binding, one receiving fence, at most one predecessor and one
successor, and one immutable predecessor transition per capture. It performs no Semantic capture scan. Binding,
receiving, hold and transition lookups use full primary/unique keys. Successor verification has its own unique
`(partition_no, successor_hold_id)` index. Unconsumed holds have a partial B-tree index beginning with
`(route, collection_id, output_generation)` and continuing with incarnation and the full activation tuple. Thus a
member/header/publication guard or Collection hard-delete/restore-reuse guard seeks a live prefix with `LIMIT 1`;
it never walks disposed history or counts current readers. Hold insertion checks all retained tuple columns against
the immutable binding.

Database guards protect actual member INSERT/UPDATE/DELETE as well as header/publication mutation or deletion.
A parent foreign key would not protect deleting children. Guards lock the original Collection before checking
retention and also share-lock its Core partition. Every genuine admission advances that Core row at commit; an
older repeatable-read mutator therefore serializes or fails instead of missing a newly committed hold. UPDATE
checks both old and new anchors. Collection hard deletion, key/incarnation/curator reuse, and deleted-to-active
restore refuse while any original or successor obligation is unresolved. Ordinary tombstoning, visibility loss,
source-generation changes and switching the selected head can preserve the held rows. They invalidate current
use without releasing custody. No activation writer, existing reader, account cleanup or account custody body is
changed. The immutable binding has no permanent publication foreign key: after genuine cancelled disposition the
native guard permits physical retirement under its owner's other requirements. The binding's original executor
provenance remains independently verifiable.

The original owner lock retains the curator row even when its lifecycle is no longer eligible. Fresh binding,
released pages and current revalidation separately require active/unfenced lifecycle. A genuine terminal disposition
can therefore settle retained obligations after eligibility loss; it still requires the original incarnation and
active unmoved partition epoch, persisted Semantic closure and the exact native transition provenance.

## Literal SQL and eight-axis composition

`native-public-output-work.ts` registers only the actual imported literal SQL, the public observer's existing
header/head/partition/reference literals, exact xid/partition-size points and read transaction control. Unknown
SQL has no footprint and refuses before dispatch. SQL text and parameter bytes are added to every bound below.
These are declared native plan-node bounds, not returned-row counts or engine visibility/vacuum work.

| Literal/operation                                                                 | nativeRows | nativePoints |          result/internal bytes |                  statements |
| --------------------------------------------------------------------------------- | ---------: | -----------: | -----------------------------: | --------------------------: |
| public header                                                                     |          4 |            1 |                           2048 |                           1 |
| selected publication read or lock                                                 |         48 |            7 |                           1024 |                           1 |
| owner/lifecycle                                                                   |     16 / 4 |        3 / 1 |                       512 / 64 |                           1 |
| partition size / bounded partition                                                |          4 |            1 | 128 / admitted partition bytes |                           1 |
| builtin reference / native xid                                                    |      4 / 1 |        1 / 0 |                             64 |                           1 |
| binding read or lock                                                              |         16 |            3 |                           6144 |                           1 |
| effect lookup / binding xmin                                                      |          4 |            1 |                             64 |                           1 |
| committed component and outbox                                                    |         16 |            3 |                             64 |                           1 |
| retained publication                                                              |         24 |            5 |                             64 |                           1 |
| bind, including deferred native and canonical accepted validation                 |        160 |           32 |                          32768 |                           3 |
| initial receiving row                                                             |         12 |            3 |                            128 |                           1 |
| hold, including immediate binding guard and deferred successor checks             |         96 |           20 |                           4096 | 2 predecessor / 4 successor |
| transition read                                                                   |          4 |            1 |                           9216 |                           1 |
| transition insert and both deferred validators                                    |        144 |           29 |                          16384 |                           3 |
| predecessor consume / receiving fence, each including its own deferred validation |         96 |           22 |                           4096 |                      2 each |
| raw output page of limit L                                                        |       4L+4 |            1 |                           256L |                           1 |
| BEGIN / separately reserved COMMIT / ROLLBACK                                     |          0 |            0 |                              0 |                      1 each |

The migration's binding deferred SELECT has thirteen exact-key relations and twelve joins. Each transition deferred
SELECT has eight exact-key relations and seven joins; it runs separately for transition insertion, predecessor consumption and receiving closure. The
additional bind guard has two exact-key relations (accepted/binding), adding 16 rows, two points and one
statement. The additional transition guard has three (stage/disposition/transition), adding 24 rows, three points
and one statement. These are charged on top of their original 144/30/2 and 120/26/2 native declarations. The
hold BEFORE INSERT binding lookup is one primary-key SELECT; successor deferral adds a PERFORM and the indexed
transition/hold SELECT. Immutable-row guards and JavaScript executor-ID comparison perform no relation query.
These nested statements, their index/FK work and bounded JSON comparison bytes are included in the corresponding
write bounds above, reserved before the write dispatch even if a later deferred constraint fails.

The guard's literal SQL is separately registered as `nativePublicOutputRetentionSQL`: original Collection lock,
Core partition share-lock, Collection live-prefix EXISTS and output-generation live-prefix EXISTS. Each costs
`nativeRows=4`, `nativePoints=1`, `statements=1`, at most 64 result bytes plus SQL/parameters, and at most one empty
seek. INSERT/DELETE checks one anchor; UPDATE checks both. Harmless Collection changes stop after the two locks
per anchor; protected changes add the appropriate live-prefix lookup. A member counter change also runs the header
guard. Writers must compose these additional literal costs in their original frame; this declaration creates no
funding and does not certify an existing aggregate writer allowance.

For all operations, `candidateKeys=L` only for the output page and otherwise zero. `identityMetadataRows=0` and
`witnessKeys=0`: this slice performs no Subject identity resolution or canonical witness acquisition. Native identity
and provenance row work is included in `nativeRows`/`nativePoints`. `emptySeeks` reserves the statement bound for each native operation (zero for transaction controls), including
its nested validators. A single top-level seek can refund its unused empty seek; nested or failed seeks keep
their complete admitted bound. Candidate settlement cannot refund dispatched native row work. All eight dimensions are supplied before dispatch. Repeated locks, provenance checks, failed SQL,
and each separate deferred validation are charged separately. The existing instrumentation reserves one checkout
point and separate COMMIT and ROLLBACK controls before beginning a read snapshot. A successful COMMIT cancels
the unused rollback reservation; a failed COMMIT keeps it for the actual ROLLBACK, charging both dispatched
controls. A failed BEGIN cancels both unused controls and discards its connection. Caller-owned
commands retain their existing checkout/Core fence/commit/rollback accounting: these helpers open none of those.
Only the exact registered `COMMIT` and `ROLLBACK` literals can consume those reservations; a control prefix
cannot admit appended or otherwise unknown SQL.

Nested Semantic validation transfers the remaining original reservation through `NativeCollectionWork.compose`
and accounts its returned work or settled failure receipt. A child with no valid failure receipt consumes the
transferred remainder and poisons the frame. Queries reserved by the native owner suppress only duplicate
observation of that already reserved query; they retain the same Pool/client/home/T and all native charging.
Only a dispatched reservation can forward that one query; reuse before dispatch, after settlement or for a second
query refuses. An already-live Core transaction is observed even when it predates pool instrumentation. Its bound
client forwards without a second debit, and callbacks resume the active frame before any subsequent work.
The enclosing frame cannot dispatch while transferred work is held or create a second allowance. Semantic literal plans in `identity-public-output-work.ts` account staged/committed validation, callbacks and
closure attempts from this same finite frame. There is no aggregate sufficiency allowance: every repeated child
first reserves its own complete literal vector. No declaration here certifies an external receiver closure.
