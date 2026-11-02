# Retained terminal directory

The implementation uses `identity_epoch_original` as a single flattened terminal
membership, and the existing mapping row as a constant-size native locator. It
stores no transitive path or reverse dependency vector. Group capacity remains
4096; each source, pending-source, drain and cleanup keyset page is at most 100.

`stepIdentityEpochBootstrap(pool, partition)` retains its public signature and
native export/receiving/source-ACK order. `stepIdentityEpochBootstrapWork` retains
the topology scheduler. `readIdentityMappings(pool, originals)` preserves input
order, duplicate originals, existing states and the 100-original input bound.

## Native enrollment

`stepIdentityTerminalClosure` performs these released native phases:

1. Recover the exact source export and create its enrollment/hold under its real
   owner and dirty-head lock. Pending source headers take custody from an exported
   transport page, so an unresolved prefix cannot hide a later terminal seed.
2. A terminal seeds itself. A redirected original uses only an active successor
   whose immediate edge, owner and captured head are current. A serialized ticket
   in the successor's existing mapping row prevents an unclassified mutation.
3. Bind the target locator at the source, then enroll a preparing member under
   the terminal group's lock. The entry binds the original, actual source export,
   source generation/head/owner, enrollment and group incarnation. Preparing
   members participate in closing and drain.
4. Commit a nonpositive source install; promote only that exact committed install
   at the terminal; ACK only that promotion at the source. Withdrawal takes the
   same source-row lock as install and ACK. Native phase references include the
   actual executor transaction and transaction version.
5. Finalize the directory reservation and acknowledge only the captured h. A
   later head h+1 remains dirty. Lost responses recover the same enrollment.

A cycle has no terminal seed. Missing subjects, unreadable/moved owners and
unfinished successors remain unavailable; none is interpreted as a terminal.
`advanceIdentityTerminalClosures` revisits pending native source headers by an
independent bounded keyset. Owner-incarnation changes are refused while native
closure or export custody remains; position-only advancement returns before any
dependency query in the owner trigger.

## Close, drain and mutation

`drainIdentityTerminalClosure` closes enrollment under the actual group lock,
walks its frozen generation, and records each real source withdrawal before
advancing its contiguous frontier. Its drained seal binds generation,
incarnation, claim and current dispositions. Legacy members are withdrawn at
their actual sources too; they cannot stand in for a newly installed closure.

`runIdentityTerminalCommand` preserves Core authorization and receipt replay,
uses `withSingleCommandAttempt` for each actual invocation, and releases a failed
discovery transaction before opening foreign drain commands. It keeps the
original request deadline, including Access's five-second deadline. A subsequent
source attempt reauthorizes and `bindIdentityTerminalMutation` consumes the
private exact drain under the same live source transaction as capture. The
trigger refuses an unbound write before advancing a dirty head.

An enrollment that loses the directory lock before insertion is still
nonpositive. A sealed group fences its late registration, allowing its actual
source writer to cancel that hold locally. A source with no chosen directory
can be cancelled under its local lock. Target binding checks that cancellation;
self registration rechecks its source in the same home transaction.

`recoverIdentityTerminalClosure` advances interrupted closing/drained groups,
releases source claims, and invokes bounded cleanup. Cleanup requires native
withdrawal and release dispositions, actual member deletion and an empty-range
proof. A redirected old terminal remains closed. Its claim reservation retires
only after that proof; a surviving terminal receives a new generation and
incarnation before enrollment resumes. Generic admission and publication add an
open-group check adjacent to existing hooks. Rating hooks and consumers are
unchanged; these observations grant no rating transaction authority.

Cancellation retains an outgoing-successor disposition in the existing source
locator. The original's own bootstrap home releases that exact successor ticket
before replacing its enrollment. The cancellation records its real native
producer commit, including for ordinary commands that otherwise emit no
bootstrap receipt. Incoming-ticket and cancelled-source recovery have separate
advancing keysets; an unresolved first page cannot hide later recovery work.

## Durable original and selected executor receiving

`identity-terminal-closure-original.ts` implements a separate, positive native
bootstrap owner-observation original. This is a narrowly supported operation,
not terminal authority and not funding for the retained directory driver.
`withIdentityTerminalBootstrapOriginal` verifies the actual retained bootstrap
page/native commit, current owner incarnation, phase and generation. It commits
an immutable original before lending its private callback handle. The original
binds the actual Pool, native transaction/position, absolute deadline, plan
digest and eight-axis allocation. Identical replay opens the same native record;
changed payload conflicts. Copies, escaped callbacks and expired handles fail.

`readIdentityTerminalOriginalOwner` receives the installed
`withCommandDispatchLifetime(pool, deadline, owner, body)` ABI directly, without
casts, query replacement, Pool interception or fabricated receipt authority.
Its reserve callback checks the actual frozen `COMMAND_DISPATCH_ALLOWANCE` and
commits one native child ticket plus a monotonic spent vector before Core can
check out its effect connection. It wraps exactly one actual `runCommand` in
`withSingleCommandAttempt`. The effect transaction locks and checks the actual
owner, original and exact operation/home/phase/cursor/price ticket. Retirement
ordinal advancement revokes that permission at the actual effect home. A
failed dispatch, rollback, lost COMMIT reply or lost effect reply never refunds
the ticket. Reopening a callback does not reset it.

The metadata arbiter uses a real checked-out client, a private live callback
association, a current native owner lock, fixed-width projections, one immutable
deadline and separately reserved same-client rollback. It performs only original
admission, debit and retirement metadata work. It does not reproduce Core's
executor, issue command authority or append domain events. The selected native
bootstrap allocator hook must have no personal source/basis/copy roles; indexed
absence checks precede its use. Positive roles refuse this selected profile.

`retireIdentityTerminalOriginal` spends a second one-shot ticket before its
cleanup checkout. Cleanup requires the actual source page ACK, current native
owner and empty exported payload. It verifies both exact spent tickets, deletes
their physical rows and the header, and only then releases their three reserved
copies. SDK return and an accounting counter are not retirement evidence. An
uncertain or unsuccessful cleanup remains spent and charged. `withIdentityTerminalMaintenanceOriginal` now supplies a separate native
maintenance original after that allowance is exhausted or its deadline expires.
Its proof is the actual source ACK/maintenance command, not the old callback.
`recordIdentityTerminalOriginalMaintenance` registers this proof from the real
executor callback and native commit at the source ACK boundary. It projects the
captured export, locks its exact owner/page/predecessor, requires native ACK and
empty exported payload, and records the actual producer transaction and next
position and the actual command resource deadline. Admission cannot extend that
deadline even if no header has yet committed. A still-unspent, unexpired maintenance custodian cannot be displaced.
A later actual native invocation can replace a spent or expired custodian; merely
changing a callback or deadline cannot. The selected Core profiles still refuse
this event/callback producer; the hook is not a free or supported Core dispatch.

Admission verifies both original export and maintenance native commits, the
latest page grant, exact owner incarnation, advancing home generation, immutable
header/price/deadline, nonpersonal provenance and actual reservation. It deletes
the predecessor's exact spent tickets before creating its maintenance header.
The old header's ordinal becomes 2, revoking late owner observation, while its
price and spent vector remain unchanged. A lost admission response recovers the
same immutable maintenance identity and its current spent state.

`cleanupIdentityTerminalMaintenanceOriginal` commits one child ticket before its
cleanup checkout. Its effect rechecks the current native grant and both headers
under the actual owner lock, validates the exact spent ticket, deletes ticket and
headers, records complete disposition on the exact page, then releases three
copies and uses the indexed native empty-range proof. A failed or uncertain
effect remains spent and charged. Replacement requires a different real native
producer receipt; the old grant cannot become current again after replacement
or successful cleanup. No cross-home transaction is held.

## Literal selected-operation declarations

`identity-terminal-closure-cost.ts` declares all eight axes beside the supported
bodies. Values price bounded index/heap/lock/FK/deferred-hook work, bounded binds
and projections, control SQL, failed dispatch and disjoint rollback. Fixed SQL
and protocol framing follow the delivered Core byte convention. Candidate keys
are zero for this owner/metadata-only operation; no candidate discovery occurs.
Every remaining zero is visible in the component declarations. Repetition is
fixed by the implemented one owner-read and one retirement attempt, not by a
post-dispatch `NativeStepWork` counter.

The actual imported Core quote is:

| Component | candidateKeys/nativeRows/identityMetadataRows/nativePoints/witnessKeys/statements/bytes/emptySeeks |
| --- | --- |
| Core effect | 0/2/0/1/0/7/169/1 |
| Core cleanup | 0/0/0/0/0/1/0/0 |
| Core total | 0/2/0/1/0/8/169/1 |
| Owned effect-home owner/original/ticket read | 0/9/3/3/3/1/272/3 |

The source exports component literals for `begin`, `lockTimeout`,
`statementTimeout`, `owner`, `export`, `provenanceAbsence`, `copyRoleAbsence`,
`original`, `sharedSlot`, `existingSlot`, `insertSlot`, `allocateCopies`,
`insertOriginal`, `insertTicket`, `debitOriginal`, `provenanceBinding`, `commit`,
`rollback`, `retirement`, `deleteTickets`, `deleteOriginal`, `releaseCopies` and
`ownerRead` and `emptySlot` (`0/15/10/10/0/3/120/10` for the indexed native
retirement proof). The immutable composed plan separates admission, debit, effect,
retirement debit and retirement effect. FK and the existing deferred mapping
state erasure hook are included. The admitted nonpersonal branch executes no
role callbacks or domain authorization/receipt/publication work. No successful
price is declared for absent foreign children.

The separate immutable maintenance declarations are in
`identity-terminal-closure-maintenance-cost.ts`. Each header projection is bounded
by 1216 binding/result bytes: fixed UUIDs, int32/int64 strings, constrained phase
and operation, 32 digest bytes and two exactly eight-element int64 vectors. The
same SQL shapes apply on conflict/empty branches. Two original ticket PKs are the
maximum delete range, and the predecessor partial unique index permits one live
maintenance header. Owner, original, both native receipts, ACK, home, reservation,
source-role/basis/copy-role exclusions and every reached FK/index/lock are charged.
The native grant callback's local declaration remains separate from its missing
Core event/callback executor operand.

| Maintenance phase | candidateKeys/nativeRows/identityMetadataRows/nativePoints/witnessKeys/statements/bytes/emptySeeks |
| --- | --- |
| Native grant hook and native-commit callback bodies only | 0/37/12/13/8/4/2176/11 |
| Admission, including transfer/replacement and failure rollback | 0/75/28/28/13/18/8068/21 |
| Irreversible child debit | 0/46/17/18/11/15/5972/16 |
| Cleanup effect and separately prepaid rollback | 0/106/45/44/12/28/7300/36 |
| Complete metadata maintenance original | 0/227/90/90/36/61/21340/73 |

The old owner-read plan and digest remain unchanged. A maintenance original has
its own plan/digest, actual producer position and deadline. These declarations do
not price the earlier source command or any authorization, event or callback
executor outside the metadata arbiter. The shared store error now comes from the
dependency-free `identity-terminal-closure-errors.ts`, preserving the store's
existing exported class and eliminating cost/store/bootstrap initialization cycles.

## Same physical inventory

`reserveIdentityTerminalOriginalCopies` authenticates the real native arbiter
client and calls the same private `reserveGeneration` used by mapping and
`reserveIdentityTerminalClosure`. It creates no physical allocation ledger.
Original and ticket tables hold bounded execution metadata, not another member
directory or transitive path. Their reservation FKs and indexed references keep
generic closure cleanup from freeing their slot.

Admission reserves the entire three-copy bundle before creating its header:

| State | Actual metadata rows | Charged bundle |
| --- | --- | --- |
| Admission committed | One header | Header + two provisional one-shot tickets = 3 |
| Owner-read debit committed | Header + owner-read ticket | 3 |
| Retirement debit committed, including abandoned/uncertain effect | Header + two spent tickets | 3 |
| Transfer committed | Old revoked header + maintenance header | Same 3, including one provisional maintenance ticket |
| Maintenance debit committed or failed cleanup | Both headers + one spent ticket | Same 3 |
| Replacement by a fresh actual native producer | Old revoked header + replacement header; old maintenance rows deleted first | Same 3 |
| Native ACK/empty-range cleanup committed | No header or tickets | 0 |

All three roles use the same coalesced reservation, including at cohome
source/successor/terminal. They are distinct rows, so they are never collapsed
into one charged copy. No later ticket needs another slot. Together with all
previously charged directory/source/export/old/new copies, each slot satisfies
`closure_copies <= 4096`, and the existing allocator permits only four slots.
For this extension, `Cq = prior reserved copies + 3 * admitted originals` is at
most `4 * 4096 = 16384`; metadata admission waits/refuses before allocation if a
three-copy bundle cannot fit. Canonical rows remain in `Aq`, so this extension
uses only the existing `Aq+16384` / `Gq+4` inventory. Failed or replayed tickets
do not release the bundle. Both normal retirement and maintenance can reclaim their already
reserved bundle without acquiring a fifth slot. Transfer first removes zero to
two actual predecessor tickets (or the old maintenance ticket/header), then
creates the replacement header inside those same two provisional roles. Its
single ticket is created only after committed transfer. At no statement boundary
are there more than three actual rows in this bundle. It leaves the shared ledger
counter unchanged until native cleanup deletes all three roles. The same schedule
works when all four slots already contain 4096 charged copies. Empty bucket retirement uses
seven indexed native reference ranges and both original/ticket FK checks under
the same owner transaction. It never infers emptiness from the counter. Native
page ACK clears its allocation pointer only after deleting its exact payload;
retired page history cannot make a slot proof grow with population.

This is a reservation argument for the new bounded metadata operation. The full
directory protocol's export/receiving/old+new/workflow/cleanup cohome proof and
all producer composition remain incomplete; the metadata argument does not
establish those obligations.

## Unsupported profiles and remaining source obligations

The installed Core adapter supports `single-no-effect` and a separate exact
`single-source-fence` account erasure event profile. The latter requires one
specific account erasure event and also rejects callbacks; it is incompatible
with this directory's native producer. Neither supplies a general closure
mutation/event/native callback or principal authorization/receipt profile. Directory
native phases register both Semantic erasure and native-commit callbacks and
emit bootstrap/progress events. They require an executor mutation/event/native
callback profile that is not exported by `command/dispatch-lifetime.ts`.
Principal source commands additionally require Core's authorization, receipt,
basis and source-association profile. These operations cannot use the no-effect
quote. `IdentityTerminalCompositionError` carries the exact owner/callable/
profile/producer operand, rather than a zero vector or invented successful
parent. Known bootstrap native phases and all source dispatches refuse
before their unsupported body/checkout, including receipt-free platform source
commands. The retained driver source and its
ordering remain present for receiving a supported profile.

The following owned work is still incomplete: literal inclusive compositions
for all directory SQL bodies and initial-discovery/drain/second-source/claim
release phases; authentic original admission/private transfer for all subject,
bulk, merge, account birth, mapping member, workflow and Access delivery
producers; and the complete combined physical schedule. The supported owner-read original
cannot fund those independent operations.

The source driver's release phase covers partial acquisition as well as the
second source attempt. A later group failure does not skip releases for earlier
completed drains. Each completed group receives its one bounded release-page
attempt while the original deadline remains live. Release failures are collected
across homes and preserve the source/acquisition error as the cause. Unfinished
pages and failed homes retain their native claims for the existing recovery
driver; an exception does not release their physical reservations.

## Source and verification disposition

New production callables are `withIdentityTerminalBootstrapOriginal`,
`readIdentityTerminalOriginalOwner`, `retireIdentityTerminalOriginal`,
`withIdentityTerminalArbiter`, `identityTerminalArbiter`,
`reserveIdentityTerminalOriginalCopies`, `addIdentityTerminalCosts` and
`requireIdentityTerminalExecutor`. Maintenance adds
`recordIdentityTerminalOriginalMaintenance`,
`withIdentityTerminalMaintenanceOriginal` and
`cleanupIdentityTerminalMaintenanceOriginal`, with its own literal plan and
component exports. Existing bootstrap signatures, ordered
mapping states, page100, group4096 and four-slot allocation remain unchanged.
The source command wrapper now uses typed overloads and Core's actual default
deadline; an inherited Access five-second deadline is retained.

The forward migration `20261102000300_identity_terminal_closure_fresh.sql` adds
immutable original/ticket metadata, monotonic spent state, reservation indexes
and owner-incarnation custody protection. The forward migration
`20261102000400_identity_terminal_closure_fresh.sql` adds fixed native maintenance
receipts, predecessor custody and the distinct maintenance ticket operation;
there is no new physical ledger or member directory. Position-only owner advancement still
returns before dependency IO. The Semantic snapshot includes the same changes.
Historical migrations, Core executor, rating hooks, protected Library projection
and frozen acceptance are unchanged. No file outside the declared paths was
changed.

Authored native obligations cover durable admission before handle lending,
actual Core allowance debit, lost admission/debit replies, failed effect
rollback, copied/escaped handles, immutable deadline replay, owner refusal,
native ACK retirement, retained failed cleanup and SQL refill refusal. Existing
chain/race/shared-suffix/growth acceptance is preserved byte-for-byte. All
native/unit/growth/full acceptance remains UNRUN. New connected cases additionally
cover old ordinals 0/1/2, unchanged predecessor price/spent, lost native-grant and
admission/debit/cleanup commit replies, expired admission, failed effect rollback,
fresh-native replacement, refusal to evict an unspent custodian, exact actual
owner-query revocation, and four full cohome slots.

## Reference sources

The selected directory protocol follows the pending-fill invalidation ordering
in the [UBC MSI model](https://www.cs.ubc.ca/~ajh/courses/cpsc513/2005/assign_msicache/protocol.html).
PostgreSQL's retained `src/backend/utils/time/snapmgr.c` explains snapshot
lifetime; released snapshots do not become cross-home mutation authority.
The retained DBOS `src/dbos-executor.ts`, `runInternalStep`, executes its callback
before checkpointing its result, motivating native receipt recovery after a lost
response. The retained implementation branch had no terminal-closure module;
its bootstrap/read/mapping/caller/schema paths and earlier tests were reference
material, not installed closure authority.
