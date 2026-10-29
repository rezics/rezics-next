# Partitioned concurrent identity: native feasibility and boundaries

Research evidence, 29 October 2026. This recommends a design; it changes no adopted contract or runtime.

## Finding

Disjoint changed groups can progress concurrently with PostgreSQL, native one-partition commands and existing DBOS work.
The minimum is a receipt-routed job, claims at each changed group's current control home, immutable versioned inputs,
per-home capacity and cleanup, and publication observations distinct from job identity. A single `controlPartition`,
one global pending job and `admit(tx, intent)` cannot express this protocol unchanged. No account-demand bound exists.
Keep P symbolic. Capacity exhaustion is retryable capacity refusal; `identity_epoch_busy` means an overlapping group.

Necessary clarifications concern safe pre-admission reservation effects/status and internal routing/observation signatures.
If zero effects are required for later overflow after safe preparation, the counterexample below rules out that promise.
No whole-job global lock, serialization fallback, distributed transaction or additional engine is recommended.

## Evidence boundary

Repository evidence is the current tree at `b7efa45b3ce2c01e35ba0380a91f4a89cedb938a`. Read the full
[types][types], [protocol][protocol], 980-line [native cutover cases][native], 553-line [support][support], and original
[admission][admission], [publication][publication], [HTTP][http] and [fixture][fixture] cases. The fixture checks for
runtime exports; declarations and SQL fixture membership are not installed producers or a successful bootstrap.
The supplied integrated result failed in setup at `bootstrapRelease`/`P1114`, before scenario execution; its successful
typecheck proves no native protocol behavior. No native probe, benchmark, production data or external executable ran here.

Read all eight items in each supplied [cost review][cost-review] and [Accounts review][accounts-review], plus the full
[integrated review][integrated-review]. Both prior [cutover reports][old-current] [were read][old-deep] only as evidence
about the former globally serialized design. Their sole-pending assumption is superseded. No concurrent sibling report
was read and no conclusions were coordinated. Both independent reports must be read fully and compared before a costly
protocol choice or freeze; one specification closure follows adoption, in the owning documents.

Other primary seams inspected: [filtered-list identity/cursors/budgets][filtered], Library's [owner contract][library]
and [structural access analysis][directory], Semantic creation/import/merge/move/reversal SQL and callers,
[native command executor][command], fence/receipt/partition ownership, [operational transactions][operational],
[command documentation][command-doc], Work composition/client/retention, and Accounts verification delivery.
Operational source and documentation were also inspected at `5b5c3be17ea1c7c747d09cdcdcfa0ac89ca37cfe`.

## Native authority and the smallest data model

The following names are SQL/type sketches, not delivered tables or callable exports. Each mutation remains in exactly
one active `core.partition`, with its native ownership epoch, native T and executor fence. Release its connection before
visiting another home. `currentCommand(tx)` is live authority only inside that attempt; captured receipts are evidence
of past commits, never permission for a later owner. Actual [partition fencing][partition] remains authoritative.
Birth initializes exact self/basis and singleton header in its revision-1 source command, without another checkout/Search.
Bind `writeSubject` (including bulk/import/named agents) and direct unlabeled agent creation. Convert `mergeSubjectsInCommand`,
move registration/repoint/member/link phases, verify/unverify/backlinks and `links.ts` relay retries. Final handoff needs
the deferred same-TX guard AND native barrier over all old writers/queued work; a type flag or capture alone proves neither.

| Native owner | Minimal retained data and indexed access |
| --- | --- |
| Original/source home | Exact self/current basis `(route,original) -> (control_home,group_incarnation,generation,version)`; creation and structural gate, source head/export/frontier and exact native custody locators. Read these with the existing native source point. |
| Current group control home | `group_header(home,incarnation)` PK: current sealed generation, exact count, monotone version, ownership epoch, readiness/claim; immutable membership PK `(home,generation,original)` and inverse current-original locator. |
| Receipt's stable job home | Unique native receipt binding, immutable operation/attempt/input references, state, planned homes, capacity/claim receipts, wakeup, progress and fixed completion custody. Index resumable state/key and receipt key, never scan historical JSON. |
| Each participating control home | At most P occupied work slots, including preparing/cancelling/reclaim-blocked occupants; unique live claim `(home,group_incarnation)`, and attempt state keyed `(home,job,attempt)`. Reserve output/copy space here before admission. |
| Actual effect/payload home | Native gate, expected prior/next effect scope, frontiers, transaction/component receipt and producer/consumer custody/minimization locators. Library payload remains Library-owned. |

Route ordinary jobs by the existing redirected original's command partition; account-agent jobs by the derived node's
command partition, as [current callers][agents] do. Accounts source intent remains account-home-routed. Claims follow current
groups, not the receipt anchor. Choosing the smallest *current* terminal would misroute receipt replay after a split.
An opaque operation locator retains the stable route; native ownership resolution can change the backend, not the key.

Use a nonreused group incarnation and monotone versions, not a terminal UUID alone. Every change to current membership,
count, claim/readiness or routing increments the version; ownership epoch also participates in comparisons. A retired
incarnation never becomes current again. A move fences old commands and transfers retained data/custody before readiness.
A changed original can therefore participate again after merge/repoint/split without reviving an old claim or capture.
New groups stay unready until flat and sealed; no alias walk, parent-generation traversal or old-generation reader.

Required internal boundary clarification, with public DTOs unchanged:

```ts
// Illustrative replacement shapes, not a new public wire protocol.
type RoutedJob = { controlPartition: number; jobId: string; epoch: bigint };
type GroupBasis = { controlPartition: number; incarnation: string;
  generation: string; version: bigint; ownerEpoch: number };
type ReaderObservation = { revision: bigint; pendingCount: number; ready: boolean };
// Pool orchestration prepares/custodies claims; a live one-home command only finalizes them.
// Query-only batched observation accepts existing page clients and routed native bases.
```

Replace the store-wide fixed home with routed job/receipt and group operations. Make released preparation explicit in
the admission signature; retain a home-local final admission primitive accepting a native retained preparation locator,
never caller assertions. `readJob`, `findJob`, steps, reconciliation and publication resolve the routed native owner.
Split global reader observation from group/job observation: global pending carries a count, not one job or an unbounded
job vector; an affected group still has exactly one pending job. Replace mapped `epoch`'s ambiguous global meaning with
the exact `GroupBasis`; canonical cursor revision comes from its existing page observation. A batched query-only control
reader must be exposed for page composition; repeatedly invoking `readMapping(pool, id)` cannot meet the page contract.
These changes belong to the existing Semantic/filtered-list boundaries, not a new dataProfile or permission service.

Keep native `{partition,epoch,position,transactionId}` plus component/job/step/version/scope identities unchanged.
Job epoch is an identity, not commit order. POST remains 202/Location/native poll; authorization precedes cap/busy disclosure
and is rechecked natively before replay/final admission. Hidden/unknown polls stay concealed. Accounts success DTOs/receipt
meanings remain unchanged. Ordinary Search checkpoints cannot become identity completion.

## Exact cap before effects, including cross-home races

First perform an effects-free optimistic read collection of the at most two *current* changed groups. Capture each
sealed count, incarnation, generation, version and native owner epoch. Finish all captures, then validate all captured
versions with released indexed reads. All matches imply a common cut between the last capture and first validation:
each unchanged interval covers that cut. Nonreuse/version monotonicity excludes ABA; missing/moved/unsealed/drifting
evidence returns retryable unavailable, never overflow. SERIALIZABLE transactions on separate databases alone give no
such cross-home snapshot. PostgreSQL's [isolation rules][pg-isolation] distinguish those guarantees.

Compute every RESULT group exactly at that cut, including its terminal. Distinct current groups have disjoint membership;
same incarnation is deduplicated, not added twice. Merge sums distinct counts; repoint changes counts by exact point membership;
specified unmerge restores its ONE explicit original, not a historical group. Its link undo uses the provenance ledger.
Counterexample to mixed reads: moving one member from B to A preserves total 4096; reading old B=2049 then new A=2048
would report false 4097. Validate both versions before returning overflow. Native membership/count writers must be the
complete converted writer inventory; counts cannot be trusted while old redirect/member writers bypass them.

If any result exceeds 4096, stop here: no job, draft, claim, slot, pending epoch, native command receipt/outbox, revision,
redirect, mapping or participant effect. Do not run an effectful no-op command merely to record the refusal. Preserve
the existing 4097/all-effects assertions, and extend future snapshots to new control tables rather than excluding them.
The current fixture snapshot enumerates old tables; it is insufficient evidence for an added reservation table.

For a safe read set, preparation commands may only claim those exact versions and retain those immutable input refs.
CAS failure means drift/busy/unavailable and cleanup, not a new overflow verdict on freshly substituted counts. Once all
claims succeed, group versions are frozen against other structural admissions; the safe cut's count proof remains valid
through final admission. Two refs plus a constant transform are retained atomically at the job home; no admission-sized
membership insert. Count validation and claim installation must serialize on the native header row, including first claim.

**Reservation decision required:** safe preparation necessarily has durable effects before cross-home final admission.
Example: claim A commits; process dies before claiming B. With released homes and no distributed transaction, either a
durable cleanup owner exists or A is orphaned. If B later grows, this attempt must cancel/retry with retained native
cleanup history; it cannot now return an all-effects-free overflow. Recommend explicit PREPARING/CANCELLING custody,
with no domain pending until the safe read-set proof, and retryable outcomes after preparation starts. This does not
exempt reservations from snapshots. If every failed preparation must leave zero durable history, the requirements conflict.
Likewise Accounts' already-committed pending/source intent precedes Semantic admission: an all-effects snapshot starting
before that Accounts command cannot also require it absent on Semantic overflow. Scope that boundary explicitly; perform
the Semantic cap preflight before new control custody, without erasing the pre-existing owner's source intent.

## Claim acquisition, capacity, cancellation and recovery

Use the existing worker/outbox for a native state machine:

```text
effects-free capture/validate/cap
  -> PREPARING (stable receipt owner, <=2 input refs, complete planned-home set)
  -> acquire slots/claims by (partition, incarnation), released after EACH command
  -> OPEN reader barrier -> ADMITTED/PENDING -> mapping + fixed Search + fixed Library
  -> validated publication -> group/source handoff -> minimized/reclaimed -> FREE
PREPARING -> CANCELLING -> cancellation custody at EVERY planned home -> FREE
```

At a group home, one command locks quota/header/attempt rows and one indexed free slot, never scans P slots. Check active
ownership/cancellation and exact input versions, then install the unique claim and retained native receipt/wakeup:
```sql
SELECT * FROM group_header WHERE home=$1 AND incarnation=$2 FOR UPDATE;
UPDATE capacity SET occupied=occupied+1 WHERE home=$1 AND occupied<$P RETURNING occupied;
UPDATE group_header SET claim=$job,version=version+1
 WHERE home=$1 AND incarnation=$2 AND generation=$g AND version=$v AND claim IS NULL RETURNING *;
```
These are sketches inside `runCommand`, with locked attempt-state UPSERT/recheck and all-or-rollback slot allocation.
Uniqueness plus `INSERT ... ON CONFLICT`/locked recheck closes first absence. Native rollback removes claims/receipt/outbox;
claim writes require a registered native wakeup/event, never branded `noEffect`. [Locks][pg-locks]/[heap rechecks][pg-heap]
are local mechanisms. Timeout or skipped locked rows is contention, not proof that P slots are actually occupied.

Use deterministic resource order and try/refuse rather than waiting with partially acquired slots. This also avoids
P=1 deadlock where two jobs hold one home each and need the other's. Only an overlapping ADMITTED pending claim returns
busy; preparing/cancelling overlap is retryable unavailable unless explicitly included in the pending-group definition.
P actual occupants without overlap is capacity refusal. Preserve the same intent/receipt. Disjoint sets share a home up
to P slots, with no shared whole-job lock. Reserve all copy capacity before effects, never halfway through execution.

Before the first remote claim, the job home owns the entire planned-home set and recovery obligation. Cancellation writes
an attempt tombstone at *every* planned home, even one with no visible claim yet; it serializes with claim creation there.
A delayed old acquire sees CANCELLED and cannot recreate a claim after cleanup. Retain this minimal fence until all
registered deliveries/retries are in native custody; elapsed lease time or a failed workflow is insufficient.
Job-home CAS chooses ADMITTED versus CANCELLING once. Final admission consumes exact claim/slot receipts; a late admitted
receipt wins over an uncertain HTTP result. Never say `not_applied` after a lost final commit; replay resolves the same job.
After ADMITTED, recovery finishes the job rather than dropping claims while partial effects survive.

Cancellation/publication/reclaim need no new slot; release only after claim/copy/minimizer custody. Indexed resumption seeks
occupied slots/jobs, not R/L/H history. With available owners, finite inputs and fair recovery, admitted jobs and cancelled
preparations finish finite bounded steps. Sustained arrivals/failures give refused requests no age bound; P bounds local resources.

## Publication, cursors and one relevant control home

For the retained global reader scalar, use a short native metadata fence, not a job lock. An idempotent OPEN before any
structural effect increments a reader revision and active count. Job home commits an immutable publish-ready manifest of
complete expected effects/mapping/both ACKs; released marker-home custody validates that native record before CLOSE.
CLOSE decrements count and increments revision. UPDATE the singleton under its native command fence, never caller booleans;
the row lock lasts through commit, so committed revisions cannot invert. Per-job OPEN/CLOSE identity uses native receipt
custody for replay. These small records are metadata/history, not group generations or another global P-sized job queue.
Explicitly document that distinction: charging all active jobs as resident group jobs at this singleton recreates a global cap.

Many jobs execute concurrently between OPEN and CLOSE. Lists prepare while count>0; no reader waits for completion.
Keep group/source gates pending until CLOSE's committed publication receipt is in their native custody; a crash in that
handoff may conservatively prepare, never expose an unpublished result. Poll completion requires that same publication
and handoff custody. CLOSE must resolve a committed OPEN once, including cancellation before domain admission.
Measure marker throughput: only short metadata commands serialize. Asynchronous derived zero is unsafe if source changes
precede its pending increment. Maximum allocated job epoch is also unsafe. [Sequences are not commit order][pg-sequences].

A cursor binds the existing global reader revision and existing canonical/filter/privacy bases. Check the page's existing
start/final observations; equal clean revision excludes an intervening OPEN/CLOSE cycle. No home vector, alias sweep,
new cryptography, private allow certificate or historical generation retention is needed. Mapping points use group basis,
not a global read: an unaffected point need not wait for an unrelated group's publication. Metadata supplies no SourceAccess.

The first source point yields the actual original's current control home and immutable group basis. That home is exactly
one lookup destination for that original, not the terminal's guessed route or every former group owner. At control, two
batched probes test pending membership/descriptor and coherent current-original/group basis. Claiming one input generation
makes all its originals pending immediately without inserting 4096 pending rows. A different group on that home is unaffected.

When a publication moves an original to a new group/control home, retain its old generation's pending/retired gate until
every affected source basis has native handoff custody. An old source basis then sees pending/unavailable, never a ready
old mapping paired with a new revision. Publish the source's new pointer only with its exact generation/version/gate.
After release, final source validation rejects any changed basis/owner. A retired control route returns unavailable;
do not chase forwarding aliases in the request. The next request reads the new native source basis. Native owner move
failure likewise returns unavailable; old captures cannot authorize the new owner. Concrete ownership-transfer and final
writer-barrier producers remain missing delivery obligations, not assumed ports.

| Mapping observation layout | Charged native SQL envelope, excluding no work by renaming it |
| --- | --- |
| Same backend | ONE RR snapshot: BEGIN, SET timeout, source-owner point, source-basis point, control-owner point, TWO control probes, COMMIT = 8. The common snapshot needs no second source visit. Missing fields must be joined into these indexed points. |
| Different backends | Initial source RR: 3 setup/close + owner + basis = 5; released control RR: 3 + owner + 2 probes = 6; final source RR: 5. Source <=10, control <=6, total <=16; pending returns after 11. |
| Filtered page | Reuse its existing batched owner/epoch observation and source candidate/basis points; add no snapshot, client or control statement. Route bases into backend batches and execute the SAME two probes, not per-ID loops. Preserve <=12/backend direct or 8+4R composed. |

The [native RR helper][read] really costs BEGIN/SET/COMMIT; do not retain the old three-snapshot layout on one backend.
Batch multiple partition keys inside the same backend statement, validating every native owner. A page can span several
control homes: ONE means one per original, not one invented universal home for the whole page. Use the already charged
backend composition and observations; additional standalone mapping helpers would break the envelope. Two probes together
return <=100 raw basis/descriptor/owner/lookahead records, so reduce candidate capacity to their measured shared budget.
Original AND terminal privacy and FOREIGN physical-query safety remain separately enforced and charged in existing
SourceAccess/query budgets. Do not turn the metadata owner probe into an allow, conceal its cost, or claim an undelivered
page producer already meets these bounds. No real counterexample requires >8 mapping statements on the same backend.

## Per-partition retention and physical work

For partition q, let Gq be current sealed groups and Aq current original memberships. Reserve at most P resident work
slots before admission; each slot funds at most two retained full inputs and two full outputs/copies. Thus full generations
<=Gq+4P and membership rows <=Aq+4P*4096. Cross-home jobs reserve at every home carrying a charged full copy; a job-home
reference is not a duplicate payload. Make physical custody attribution explicit when generations move between homes.
P must cover preparing, bootstrap/unsealed, exported, abandoned and partially deleted copies as well as admitted jobs.

Do not allocate a fifth copy for export, bootstrap or retries. Stream <=100-row custody pages within the reserved copy
envelope; if a retained export page duplicates membership, its rows spend that same membership allowance. Bootstrap's
source snapshot, building generation and retained export fragments must be charged before allocation; do not treat
unsealed or legacy export payload as free. Release source payload only after exact control custody, then exact-head ACK;
h+1 remains dirty after acknowledging h. A source page, control custody and source ACK are three released transactions.
All 4096 owner slots, including empty/missing/moved ones, require at least ceil(4096/100) enumeration pages before other
metadata; this fixed topology bootstrap is not a cursor/read-time head vector. Uncovered legacy closure stays unavailable.

Reference acquisition locks the generation against retirement/deletion. Before another admission spends a partition slot,
reclaim/minimize that partition's retired payload with an indexed frontier. Full input refs become minimized operation/
undo/provenance scope only after actual native consumers accept custody; R obligations, L effects and H receipt/outbox
history remain separate indexed history, not hidden full-group copies. Undo does not retain an old generation indefinitely.
Cursor custody is scalar restart evidence, not a reader reference to historical membership. Owner moves reserve destination
space before export and keep source capacity charged until receiving custody; no double-unaccounted full copy.

Reclaim locks a header, checks its indexed live refs, seeks/deletes a bounded membership range, and atomically commits
frontier/receipt/wakeup. Only zero refs plus a locked indexed empty range permits header minimization. Partial deletion is
still a full-generation occupant until complete. Cancellation and failed publication resume those exact identities; no
allocation-on-retry, unbounded cascade or subtraction of an unreclaimed copy from admission accounting.

Only [kernel bounded job steps][steps] sets maxima: 100 raw rows/page including lookahead, 100 pages/segment, <=5000ms
command deadline, <=8 scalars/2048 JSON bytes per frontier, <=4096 UTF-8 bytes each for workflow arguments/results.
Metadata, retries, duplicate inputs, native effects, receipt/outbox/FK/index work and empty seeks all count. Every
`floor((limit-c)/k)` needs proven c_MAX+k_MAX<=limit; otherwise use an in-unit keyset phase before consuming one unit.
An original may have unbounded supported scopes/Contexts: it cannot be assigned a guessed constant k such as 14.
Use `(phase,original,scope,unique-native-key,...)` within the eight-scalar limit to continue inside it, and bound work by
actual remaining raw allowance. Metadata-only progress cannot repeatedly revisit the same too-large unit forever.

Native cost: keyed normal `runCommand` has T=5 control statements and A=3 plus authorization/body/callback SQL, before
any contention/wait retries, as [the native cost declaration][kernel] records. Charge that K for EACH home command, plus
all real body work; operational transactions have their different actual fences/enqueue costs, not a fabricated command K.
Admission is O(number of changed groups/homes) indexed points plus K per command, not O(4096) membership writes.
Job work follows affected originals plus actual structural scopes and native link/effect degree; reclaim follows retired
payload. Fixed-neighborhood reads are O(log(Aq+Gq+P+R+L+H)) index height, not constant blocks as history grows.
Measure B from actual `pg_relation_size` deltas for membership AND every index at each scale; bound payload bytes by
(Aq+4P*4096)*B plus headers and separately measured R/L/H. Returned/affected row counts do not prove examined rows,
heap/index/catalogue blocks, engine calls or retained bytes. Preserve 1/8/64 history axes, 64/512/4096 groups, 100/101 raw
boundaries, actual pools/cold-warm captures and growth checks; no planner pin or invented ready/ACK/performance result.

## Fixed participants and structural Library custody

Keep exactly mapping, Search and ONE existing Library participant with its native version-1 receipt ABI. Library covers
all canonical candidate/support directories, working/ready generations, members, entries, labels, sessions, copies,
output drivers, concurrent first-apply registrations, follows/support/totals and every prior OLD/NEW effect/fence.
No additional erasure participant or ownership transfer is implied by expanding that participant's coverage.

Use candidate `(owner,canonical)` and structural support `(owner,canonical,scope,original)`, inverse `(original,owner,scope)`
and owner/original access. Scope holds accepted driver/profile/lifecycle dimensions with existence counts and seek
extrema/locators, dirty/coverage state; it is not a per-fact revision/TX mirror. A million sessions with the same
original/profile/lifecycle produce one structural scope row. Native session/copy/label facts and their ordered indexes
retain body/identity authority. Do not require old `canonical_source_fact` writes as proof of the new directory.

Rekey a structural scope once, maintain candidate first/last support and indexed extrema, and retain finite old/new scope
manifests. A changed top needs an indexed next-native-fact seek, not copying every session or sorting history. Distinct
scopes can still be large; continue inside one original and charge every visited scope. Readiness requires all accepted
driver ranges, not merely follow ACKs or returned positives. NOT populations, excluded/order dependencies and preparation
remain covered. Current original AND terminal admission, source-account terminal fence and FOREIGN physical-target safety
are independent of canonical support counts or a readable representative.

First apply registers durable native source work and cleanup custody before it can escape directory enumeration. Installing
an absent target gate serializes via native uniqueness/lock with old-epoch apply: earlier apply enters dirty/coverage input;
later stale apply rolls back and retains retry responsibility. EOF closes under the same writer frontier plus registered
deliveries, not an empty page alone. OLD withdrawal, NEW addition and both gates each retain exact prior-scope effects,
native TX/component receipts and released custody before ACK. Partial rekey or abandoned workflow cannot clear a gate.
The actual structural-directory writer integration and complete fixed ACK producers are not delivered by the type file.

## Accounts delivery, operational transactions and terminal custody

Access owns a source intent keyed `(account-home route,account,direction,receipt)`, canonical UTF-8 JSON key
`[direction,accountId,receiptId]`. Verification inserts it atomically in `recordPendingAgentVerification`, using the persisted
decision receipt; reversal in `commitReversal`, using that command's receipt. Add role-first indexed lookup for account,
requested-by and decided-by to exact request/intent/native-effect locators. Retain the existing Global request/decision
and account-home pending/reversal identities; do not move their ownership into Semantic or Core.

After the effects-free cap proof, native control takes custody of this source intent before final admission. Retry busy,
capacity, routing drift and unavailable owner with the SAME intent/receipt and bounded backoff. They are not denied review
and must not enter the current `AccountAgentVerificationError` failure/clear branch. Verify cannot approve/write its
success page/finish/clear pending until publication; reversal cannot clear its pending receipt before the same boundary.

Refactor the SAME [existing workflow][verification-work] into bounded native ensure/probe steps separated by workflow-level
`DBOS.sleep`; no new queue or detached workflow, and no durable step held across the whole publication age. A probe reads
indexed native state, releases connections and returns pending. Sleep inside a DBOS step is ordinary process sleep in the
inspected SDK, not durable workflow sleep. [DBOS native sleep][dbos-sleep] and [step executor][dbos-step] establish this and
the commit-before-journal crash gap: retry the native receipt after recovery, never infer completion from DBOS step success.

Actual [Core operational TX][operational] exposes `enqueueIntent` only: bounded accounts, native T, request authorization
or work-step mode, sorted account terminal fences, partition fence and `enqueueInTransaction` on the same connection.
It exposes no event, command receipt, outbox, write basis, position increment, Core intent table or relay. The actual
[work client][work-client] supplies deterministic workflow identity and existing queue registration. DBOS operational
intent/status/history is shared-history-owned; consumer-derived rows are consumer-owned. Access owns its source intent,
not DBOS storage or every operational producer. No invented Core API fills a missing delivery/minimization port.

Terminal account fences act immediately, independently of identity completion. An admitted reversal finishes only
mechanically authorized cleanup; delayed verification cannot resurrect terminal backlinks/supports. Native authorization
still precedes replay. Revoked suspended bearer is 401 `invalid_credentials` with Bearer `invalid_token`; Auth sign-in is
403 `account_suspended`, with kernel 403 defense where applicable. The original two HTTP suspension assertions disagree
with the supplied native Accounts contract; record that future owning-contract closure, do not edit frozen tests here.

Every account role indexes exact source/control/effect/receipt/workflow/shared locators, including requester, operator,
reviewed account, source author and acting human. Semantic inventories its identity obligations and Library locators;
Library minimizes its own payload; Access minimizes its request/intent; shared owners acknowledge their actual receipt,
outbox/editorial/DBOS copies. Retain necessary de-identified job/scope/native-custody/undo skeletons under owner policy,
not personal linkage disguised as a digest. Late items reopen indexed cleanup responsibility. Failed registered workflow,
fork, dispatch or missing callable/locator/minimizer is not noData or permission to clear. Existing retention of terminal
DBOS workflows is not proof of all-role erasure. No namespace escape or new participant hides an unowned physical copy.

## Required schedules and recommendation

| Schedule | Native outcome/proof obligation |
| --- | --- |
| A+B versus B+C | Same current B claim serializes. Loser remains the same retryable intent, cancels every planned home, and cannot publish partial effects or mark review denied. |
| A+B versus C+D | Separate claims/slots; both map and run participants concurrently. A short reader-marker update may queue, but neither job waits for the other's complete workflow. |
| Crash after first claim / delayed acquire | Job already owns cleanup; cancellation tombstones all planned homes. Delayed claim loses locked attempt check; no orphan or lease expiry. |
| Crash at admission response / DBOS journal | Native receipt resolves PREPARING, admitted or published exactly; lost response cannot create a second job or false `not_applied`. |
| Crash at OPEN/CLOSE / home publication | Idempotent marker receipt, native count and exact job state reconcile; incomplete local handoff remains pending. No premature clean epoch. |
| Group or partition ownership changes | Version/incarnation/owner fence invalidates old plan; old source route is pending/unavailable. Transfer retained responsibility before new readiness, not trust old captures. |
| Lower job epoch commits later | Its CLOSE increments the actual committed reader revision after the earlier CLOSE. A max allocated epoch/UUID/time would miss this publication and is forbidden. |
| Crash during reclaim/export/ACK | Saved native frontier/receipt resumes; partial payload still charged, h+1 not lost, no slot freed before receiving custody. |
| Account terminal during verification/reversal | Current terminal lock prevents new personal effects; same receipt retains pending cleanup, with actual shared/Library minimizer custody before clear. |

Recommend the routed multi-home preparation protocol, local P slots and immutable group bases, with the short ordered
reader marker if retaining the global cursor scalar. First close the reservation/outcome and routing/type decisions above;
do not silently reinterpret overflow snapshots or retain sole-pending code as a successful interim protocol. Future native
acceptance must preserve existing 4097/all-effects cases and add these concurrent/crash schedules against actual producers,
plus shared-page budgets, all driver/first-apply custody, per-partition copy accounting and all-role terminal cleanup.
This report is the research deliverable, not an implemented or measured feasibility claim; missing native ports stay explicit.

## External primary sources, reuse and licences

Reused read-only clones under `/home/edge/projects/rezics/rezics-next/.reference/`; reuse is indexed there. Nothing was
installed, built, executed or copied from them. PostgreSQL source snapshot is release object `0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89`
in `library-shelf-maintenance/postgres`, PostgreSQL License (`COPYRIGHT`), distinct from that clone's development HEAD.
Read `src/backend/utils/time/snapmgr.c`, `src/backend/access/heap/heapam.c` and `src/backend/commands/trigger.c`:
transaction snapshots, tuple-lock rechecks and capture-installation locks are separate native mechanisms. DBOS Transact
TypeScript snapshot `980dc55095f445b189aecb59e7f3334345179f65` in `search-worker-outcome-harness/dbos-transact-ts`, MIT
(`LICENSE`), supplies `src/dbos-executor.ts` and `src/dbos.ts`. These sources share the patterns of native atomic local
state, explicit durable recovery and completion after custody; neither supplies cross-home atomicity. Repository source
is AGPL-3.0-only. Recommend the designs in this repository's existing stack, not source passages or new infrastructure.

[types]: ../../services/kernel/src/semantic/identity-epoch-contract.ts
[protocol]: ../../services/kernel/src/semantic/identity-epoch-contract.md
[native]: ../../services/kernel/test/semantic/identity-epoch-cutover.test.ts
[support]: ../../services/kernel/test/semantic/support/identity-epoch-cutover.ts
[admission]: ../../services/kernel/test/semantic/identity-epoch-admission.test.ts
[publication]: ../../services/kernel/test/semantic/identity-epoch-publication.test.ts
[http]: ../../services/kernel/test/semantic/identity-operations-http.test.ts
[fixture]: ../../services/kernel/test/semantic/support/identity-epoch.ts
[cost-review]: /home/edge/projects/rezics/rezics-next/.temp/goal/performance/identity-cutover-cost-review.md
[accounts-review]: /home/edge/projects/rezics/rezics-next/.temp/goal/accounts/identity-cutover-accounts-review.md
[integrated-review]: /home/edge/projects/rezics/rezics-next/.temp/goal/semantic/identity-cutover-integrated-full-review.md
[old-current]: identity-store-cutover-current.md
[old-deep]: identity-store-cutover-deep.md
[filtered]: ../filtered-lists.md
[library]: ../../services/kernel/src/library/README.md
[directory]: library-owner-index-observation-deep.md#minimal-physical-access-derivation
[command]: ../../services/kernel/src/command/command.ts
[operational]: ../../services/kernel/src/command/operational.ts
[command-doc]: ../../services/kernel/src/command/README.md
[partition]: ../../services/kernel/src/partition/partition.ts
[agents]: ../../services/kernel/src/semantic/account-agents.ts
[read]: ../../services/kernel/src/semantic/read.ts
[steps]: ../../services/kernel/README.md#bounded-job-steps
[kernel]: ../../services/kernel/README.md#cost
[verification-work]: ../../services/kernel/src/access/agent-verification-work.ts
[work-client]: ../../services/kernel/src/work/client.ts
[pg-isolation]: https://www.postgresql.org/docs/19/transaction-iso.html
[pg-locks]: https://www.postgresql.org/docs/19/explicit-locking.html
[pg-sequences]: https://www.postgresql.org/docs/19/functions-sequence.html
[pg-heap]: https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/access/heap/heapam.c#L2825
[dbos-step]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/dbos-executor.ts#L961
[dbos-sleep]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/dbos.ts#L1240
