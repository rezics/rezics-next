# Native identity cutover and independently landable admission

Research evidence, 29 October 2026. No implementation approval or adopted contract change.

## Answer

Search, Library and the final coordinator are **not prerequisites for implementing real pending admission,
exact cap refusal, home admission or receipt custody**. They are prerequisites for publication and successful
Accounts returns. The missing dependency is complete source-writer ownership, not consumer acknowledgement.
Creation hooks alone cannot turn the preserved store into that implementation.

An independently complete, activated STORE cannot simultaneously leave the old structural implementations
running and preserve all successful publication suites without those consumers. The smallest honest sequence
lands additive native primitives first, the actual consumer producers next, and activates complete writer cutover
with final caller binding. If an earlier independently accepted STORE is required, its owner must explicitly split
primitive acceptance from activation/publication acceptance; the original successful outcomes remain mandatory.
Neither a readiness setter nor replacing expected pending/published outcomes with unavailable resolves this.

## Evidence and status

The delivered base is `bae843d0b9e438ebba76a96b4b758d537808d64c`. Read in full: the adjacent
[epoch types](../../services/kernel/src/semantic/identity-epoch-contract.ts) and
[contract](../../services/kernel/src/semantic/identity-epoch-contract.md), current Semantic Identity/Account agents,
[canonical identity](../filtered-lists.md#canonical-identity-and-personal-references), and
[private follow counts](../private-follow-counts.md). The type file supplies no runtime registration.
The root bounded-job-step owner ruling was read from its persisted dispatch: the shared limits below remain
unchanged. Their actual native declarations are `library/shelf-maintenance-ops-contract.ts` and `bulk-contract.ts`;
the shared README subsection was not delivered at this base. Declarations alone are not runtime enforcement.

Explicit `git show 49a51f6350:<path>` inspection covered the complete preserved `identity-epoch-store.ts`,
`identity-epoch-bootstrap.ts`, all four bootstrap SQLs, migration
`20261028234658_identity_epoch_store.sql`, and the new 276-line native-store test. This commit is preserved,
**unintegrated**, and is not delivered runtime. Original admission/publication/support suites were read fully;
their contents match the preserved tree. Short Semantic paths below are under `services/kernel/src/semantic/`;
other component paths are relative to `services/kernel/src/` unless qualified.

| Seam | Delivered or preserved evidence | Consequence |
| --- | --- | --- |
| `subject.ts:writeSubject` | Delivered shared revision-1 writer; no epoch call | Hook creation here, not only HTTP. |
| `identityEpochStore.initializeSubject` | Preserved checks actual creation TX/revision, inserts local self | Only manually invoked by its native test; actual creation remains uncovered. |
| `stepIdentityEpochBootstrap(pool, partition)` | Preserved indexed pages, dirty capture and released-home custody | Useful primitive; caller must supply each home. No all-home scheduler. |
| `readIdentityEpochCutover` | Preserved hardcoded five missing-writer names | Always blocked, not a delivered proof of installed writers. |
| `admit` | Preserved checks some command authority, then always throws | No pending job, cap implementation, affected index or wakeup success. |
| `admitHomeEffect` | Preserved even a matching locked fence ends in throw | Hooks do not supply successful home admission. |
| `reconcileStepReceipt` | Preserved native identity/scope checks, then always throws | No successful complete custody path. |
| `publish` | Preserved checks fixed ACK rows, then always throws | Missing ACKs and missing publication implementation are distinct defects. |
| Mapping, fixed ACK producers, coordinator | Required exports are absent at this base | Cannot claim successful publication or Accounts compatibility. |

Supplied raw result, **not rerun here**: three passes, two failures, 437 assertions; root typecheck exit zero.
Positive pending and cap cases fail at `readEpoch` unavailable before exercising admission. This establishes
neither pending admission nor overflow refusal. Twenty to twenty-one observed producer statements are observations,
not a new allowance or a physical growth proof.

Relevant prior evidence: [Search coverage](search-canonical-coverage-deep.md), especially stale physical writes;
[native cut research](public-filter-native-cut-deep.md), especially lost-dirty/ACK races and cold enumeration;
[follow-count research](follow-counts-simplest.md), especially current-source reconciliation and terminal fences;
and [verification research](agent-verification.md), especially provenance-aware reversal. Earlier proposed group
unions or identity-basis sweeps in those reports are superseded by the adopted epoch/support contracts.
The independent sibling cutover report was not read or coordinated.

## The actual writer boundary

| Owned source seam | Required change in the same STORE writer ownership boundary |
| --- | --- |
| `subject.ts:writeSubject`, `createSubject` | Initialize exact self after subject and revision 1, before native commit; one TX with existing receipt/outbox. |
| `bulk.ts:batchCommand` create/import | Its shared `writeSubject` hook covers actual claimed source-tuple creation; preserve `guardBatchAuthorization`, source fence, tuple claim and real Global/import authority. |
| `account-agents.ts:ensureAccountAgent` | Named path calls `writeSubject`; `createUnlabeledAgent` directly inserts subject/revision and needs its own same-TX hook. Keep deterministic ID and platform source authority. |
| `merges.ts:mergeSubjectsInCommand` | Stop unadmitted revision/redirect/count/event changes; perform only retained job-scoped structural effects after admission. Its callers include verification. |
| `merge-moves.ts:register`, `moveMergePage` | Own survivor member registration, original repoints, recursive members, withdrawal/addition and member frontier. Every half-effect needs retained custody and a matching home fence. |
| `account-agents.ts:verifyAccountAgent` | Bind persisted Accounts intent; include both reciprocal backlinks and merge effect, including already-verified replay. |
| `account-agents.ts:unverifyAccountAgent` | Replace direct redirect/member deletion and backlink relocation with admitted split/reversal work; replay must wait for the same published job. |
| `merge-moves.ts:reverseAccountAgentLinks` | Replace request-local exhaustion loop with durable bounded provenance pages and withdrawal/addition receipts; preserve Context/filter/source/statement identity. |
| Direct SQL and relay entry | Guard `merges-insert-redirect.sql`, `merge-moves-insert-redirect.sql`, member insert/update/delete, and account backlink verify/unverify SQL. `links.ts:applyLinkBatch` can invoke moves from old `SUBJECT_MERGED`/`LINKS_MOVING` outbox events after HTTP returns. |

The five-name list therefore understates the concrete boundary. The unlabeled creation branch, reversal helper,
cross-home backlink effects and old relay deliveries cannot be omitted just because another helper is hooked.
`register` also follows/compares older targets using UUID order; that behavior cannot choose the new survivor.
`account-agent-subject-verify.sql` and `...-unverify.sql` change route/subject under the node command today;
the replacement must use released, separately owned home commands, not bless cross-home SQL with one component.
No production physical subject-delete path was found in the inspected writer inventory; capture must nevertheless
handle native imports/migration DML and both OLD and NEW keys of supported key-changing UPDATEs.

Fresh creation retains actual `semantic/http/subjects.ts` authorization and `semantic/http/bulk.ts` import checks.
`initializeSubject` must validate the live `currentCommand`, native home and creation revision/transaction,
not mint permission from a route, null basis, supplied source or cached Global allow. Accounts' platform path is
distinct from user Global creation. No private permission store or new account lifecycle generation is needed.

## Native patterns that support the proposal

PostgreSQL holds conflicting relation/row locks through transaction end. `CREATE TRIGGER` takes
`ShareRowExclusiveLock`, conflicting with writers' `RowExclusiveLock`: installing capture waits for earlier
DML before the installer commits. This is an installation boundary, not a distributed transaction or ongoing
global lock for creation. [Official locking documentation](https://www.postgresql.org/docs/19/explicit-locking.html),
[native trigger source][P1]. Serializable isolation can abort a stale attempt; the executor must retry the whole
native command, including authorization, instead of treating an old observation as an allow.
[Official isolation documentation](https://www.postgresql.org/docs/19/transaction-iso.html).

PostgreSQL's concurrent-index implementation separates installation, waiting for old writers, build, validation,
waiting for older snapshots and final validity. One exhausted build does not establish validity. Apply this
pattern to source ownership/capture/backfill/validation, not its internal APIs or table layout.
[Native index source][P2], [official index documentation](https://www.postgresql.org/docs/19/sql-createindex.html).

DBOS checks its saved operation result before reexecuting a step and journals a new result after the body returns.
A native commit followed by a crash before that journal can execute the body again. Therefore job receipts,
frontiers and effect custody belong in native SQL; a DBOS success value is not publication proof.
[Native executor source][D1], [official step documentation](https://docs.dbos.dev/typescript/tutorials/step-tutorial).

## Proposed native representation

These are design sketches, not assertions that the candidate migration implements them. Keep the existing
native database, `runCommand`, outbox, DBOS and WorkModule; introduce no engine, library or service.

* Local source: exact `(route, original)` mapping/self-creation receipt; a structural fence row; coalescing dirty
  heads keyed by original and by `(terminal, original)`; retained page/frontier/effect/native receipt rows.
* Control: one locked epoch/pending row; immutable receipt-bound job/intent; versioned exact group catalogue;
  immutable affected-set references; unique source-page custody; fixed mapping/Search/Library ACK custody.
* Bootstrap: durable topology enumeration frontier, one custody slot per physical home, and source owner epoch,
  capture installation and final drain receipts. Coverage is derived from those records, never caller supplied.
* Indexes: subject `(route, subject_id)` and redirect `(route, subject_id, sequence DESC)`; member
  `(route, subject_id, member_id)` plus pending phase index; dirty pending indexes where `head > captured`;
  control membership `(group_version, original)` and unique current original; page/effect/ACK exact locators;
  affected-set seek `(job_id, original)` or its immutable indexed membership view.

Maintain a complete immutable membership version for every published group, including the terminal, with an
exact bigint cardinality. A job's affected index can atomically reference a fixed number of these already-retained
versions plus the intent's constant-size transform. For merge, stream the two disjoint canonical groups; for same
group, use one version; for repoint/split, include previous/new terminals and the explicit original. Retain the
prior undo job for unmerge. Deduplicate overlap through canonical group identity and indexed original uniqueness.
Do not infer unmerge scope from a representative; its saved original/undo intent determines the adopted split.

This representation avoids inserting 4096 affected rows inside one admission command. `pageChanges` seeks each
fixed input index with `original > $after`, merges/deduplicates bounded output and returns at most 100 changes.
It must also bound raw rows consumed, including lookahead. Build the next fully materialized group version in
bounded job steps before publication; do not replace this with an ever-deeper delta/history walk. The candidate's
empty `identity_epoch_change` table and mutable `observed_count` do not implement this representation.

## Bootstrap, creation and global coverage

1. Install capture on every actual identity table before enumeration. Concurrent source commands either commit
   before the DDL boundary and are enumerated, or commit with capture. Dirty UPSERT increments a per-key head in
   the source TX. UPDATE records both removed OLD and added NEW keys where keys can change; DELETE retains a
   negative. A wakeup is atomic with the durable source work. It is not the capture itself.
2. Schedule topology homes 0 through 4095 through the actual Semantic WorkModule/outbox composition, using native
   bounded steps and a durable enumeration cursor. Include empty homes. No client-selected seed list supplies
   coverage. Reuse existing WorkModule registration; `semantic/work-module.ts` currently starts only link relays.
3. In each home command, lock its source frontier, seek at most 100 raw keys in its 16-route range, and retain the
   page plus actual native commit locator. Release that home before control custody. Apply custody once, in exact
   source generation order; changed ownership or missing page rejects. Advance only with the saved page.
4. A dirty page locks the dirty key, reads current source truth, retains observed head `h`, and sets
   `captured = h` only for that observation. A writer behind the base keyset increments head. If it waits on the
   dirty lock, it increments after capture; if it commits first, capture sees it. Neither ordering loses the update.
5. Exhausting subjects is followed by member inventory and dirty/member-dirty drain. A legacy redirect's latest
   target may itself redirect: the candidate's single `coalesce(target,self)` is not terminal closure. Resolve
   retained edges in bounded indexed steps, preserving original IDs; audit membership reciprocity, cycles and
   unfinished legacy move/reversal work. Missing target/owner or inconsistent scope stays unavailable.
6. At final writer handoff, all legacy structural entry points must be replaced or drained, including commands
   between move halves and pending relay retries. Take each local structural barrier, exclude further old effects,
   drain both dirty streams and retain a final native cut. New job effects require matching local intent scope.
   Creation continues locally: revision 1 + exact self + capture/wakeup in the same TX, without touching control.
7. Reconcile every final home cut under control custody. A bounded scheduler can maintain an exact remaining-home
   count, decrementing once per unique topology slot only after validating its real cut. Readiness requires complete
   topology scheduling, all slots custodied and installed writer ownership, not the number zero in isolation.
   Final cuts need not share one instant: excluded legacy effects cannot resume, and later creations are captured.
8. Deliver later creation receipts to control in bounded native work. Until enrollment is actually custodied,
   that original remains locally self-readable but structural admission cannot count a missing control entry as 1.
   The pending creation delivery is distinguishable from an unknown legacy original by its actual creation receipt.
   This may require waiting for enrollment before merge; it never requires Search or a nested control checkout.

The capture/drain lock discipline can use native SQL of this shape; table names are proposed:

```sql
-- In the source mutation TX, including a fresh creation behind the base cursor:
INSERT INTO identity_dirty(route, original, head, captured) VALUES ($r,$o,1,0)
ON CONFLICT (route, original) DO UPDATE SET head = identity_dirty.head + 1;
-- Drain under the same row lock; partial pending index supports this seek:
SELECT route,original,head FROM identity_dirty
WHERE route BETWEEN $first AND $last AND head > captured
ORDER BY route,original LIMIT $bounded_page FOR UPDATE;
-- Persist source truth + h in the page and native receipt, then acknowledge only h.
UPDATE identity_dirty SET captured=$h WHERE route=$r AND original=$o AND head=$h;
```

The proposed final handoff must include a retained inventory and drain/conversion of pre-protocol move work.
Stopping a process or checking an empty outbox once is insufficient. A legacy worker paused between source withdrawal
and destination addition must either finish under tracked bootstrap ownership or have its remaining work converted
to retained native recovery work before the home cuts close. Undiscoverable old halves prohibit readiness.

**Why the current test cannot prove coverage:** `requireCutover(ids)` visits only homes computed from selected IDs.
Its legacy fixture creates members on the seeded root route. Put an extra redirected original in any unvisited
home, or pause a legacy `register` there before repoint. The fixture's observations are identical, but exact group
cardinality/terminal closure differs. Even visiting all currently nonempty fixture homes misses a creation with a
lower key after enumeration. Only scheduled topology coverage plus capture/drain/native writer ownership closes
these counterexamples. Empty page, `observed_count`, missing mapping, epoch 0 and a manually set bit prove none of it.
The preserved replay branch also calls an empty saved member-dirty page caught-up without rechecking subject dirties.

## Admission and custody transaction sketches

Control admission uses the existing live authorized command on the fixed control home. Preserve the command
receipt identity even if its native component now belongs to that home. `authorization.authorize` runs before
receipt replay in `command/command.ts`; an authorization prepare may release other homes before this TX starts.
An Accounts request additionally binds the actual persisted pending decision/receipt and reversal comparison in
`access/agent-verification.ts`; `basis === null` and a matching string are insufficient. The binding producer is absent.
A proposed producer records delivery of that existing decision in its Accounts native TX, naming the account,
receipt, catalogue, operation and release plus actual native commit locator. After releasing Accounts, reconcile
that retained intent into control custody before admission. This references the existing decision; it creates no
new approval status or decision receipt. Reversal must retain the actual newer-pending comparison. Ordinary user
admission still uses current Global authorization, not the internal Accounts delivery record.

```sql
-- One control runCommand; native owner fence and receipt/outbox commit remain executor-owned.
SELECT * FROM identity_control WHERE partition_no = $control FOR UPDATE;
-- Reauthorize before replay; identical receipt + immutable intent returns original job.
-- Conflicting receipt reuse errors; another pending job errors identity_epoch_busy.
SELECT version, exact_count FROM identity_group WHERE group_id IN ($old, $new) FOR UPDATE;
-- Validate complete custody/ownership and compute every resulting group's exact count.
-- If any >4096: identity_group_overflow, with NO structural writes or successful receipt.
INSERT INTO identity_job (...) VALUES (...); -- unique receipt; one pending job
INSERT INTO identity_job_inputs (...) VALUES (...); -- fixed retained membership roots
UPDATE identity_control SET pending_job = $job, pending_epoch = $epoch;
-- Return job; registered native outbox event wakes bounded work in this same transaction.
```

For disjoint merge groups use `old.count + new.count`; identical canonical group counts once. Repoint moves exactly
one original, so check both resulting cardinalities and explicit terminal membership. Split uses saved original/undo
scope and checks each result. The sum is checked before pending/job/input/outbox/revision/redirect/mapping/participant
effects. Keep a requested larger survivor. Never scan groups at request time or pass originals in a workflow vector.
The mapping producer visits every affected original in bounded steps and writes its direct latest redirect to the
chosen active terminal, or restores self for the split. Its completed group version and native redirects must agree
before publication; neither a chain nor a numerically smaller inferred representative satisfies that ACK.
Pending point lookup seeks the retained input membership by original, rather than enumerating either group or all
homes. This is metadata observation, never home-effect authorization. Unrelated points inspect their local mapping;
exact fresh self does not depend on Search/bootstrap completeness. Missing native ownership remains unavailable.

```sql
-- In each actual effect's own runCommand, never as a reusable pre-read:
SELECT * FROM identity_home_fence WHERE route = $r AND original = $o FOR UPDATE;
-- Check native home, exact job/epoch/scope and retained immutable intent.
-- A matching structural permit permits its effect; other structural intent rejects.
-- A follow effect checks the destination's retained original/epoch fence in this TX.
-- Effect + frontier/effect locator + executor transaction-ID/component callback commit together.
```

To cover old binaries/in-flight code, a proposed structural-table trigger takes the same home barrier and requires
a scoped effect record in this SQL transaction. `admitHomeEffect` creates that record only after the live command
and matching native job permit checks. Its registered callback binds the executor-minted transaction ID/component;
deferred validation requires the actual native commit record before commit. A SQL XID can join intra-transaction
rows, never replace the durable native locator. Old redirect/member/backlink code supplies no scoped record and
rejects after handoff. Creation instead needs a deferred same-TX self-initialization invariant, so old creation
code cannot commit an uncovered revision 1. These are effect/creation records, not stored user permissions.
Install capture additively; install/enforce these final guards with actual writer binding, under native DDL locks.

Install destination permits from the retained admitted job through separately released commands. Local monotonic
epoch/state comparisons prevent delayed pending installation reopening a published fence. Every structural effect
requires its matching pending permit; published fences close that job's structural permits.
This closure precedes control publication, so an old job cannot write after a new pending admission.
Serialize the first apply against a pre-existing destination/original admission row or destination lock;
locking a missing pair alone cannot exclude an insert race. Preserve real source-account locks and terminal-follower
fences. A pre-read of pending control cannot authorize a released-home follow write. No new global creation lock.

For each withdrawal/addition/pending-fence/published-fence retain a job/version/scope-specific effect locator in
its actual home transaction. A mapping step cannot acknowledge only its last page: its final native step record
must cover all earlier committed effects and the gap-free frontier, including saved halves of multi-home pages.
Reconciliation reads the exact source record and actual `(partition, owner epoch, position, transactionId)`, releases
the source, then takes idempotent control custody. Missing/moved ownership, wrong transaction at the same position,
wrong component/job/version/scope and missing prior effects reject. Position alone and caller-supplied complete
are never proof. The preserved native callback machinery is a starting point, not a completed reconciliation path.

Mapping/participants install and retain published fences through bounded home work before final ACK custody.
`publish(tx, job)` then locks control and compares the fixed actual custody records without a remote checkout,
changing pending to published exactly once. Missing Search or Library means pending; it does not make `admit` or matching
`admitHomeEffect` throw unconditionally. No fake ACK/noData/default participant may stand in for a producer.

## Required concurrent timelines

| Schedule | Native outcome required |
| --- | --- |
| Bootstrap seeks past key K; creation inserts key < K | Creation commits self + dirty head/wakeup together. Dirty drain enrolls it; local self works while Search is absent. |
| Capture h races update h+1 | Same dirty-row lock orders them; custody of h cannot clear h+1. Capture and custody are separately crash replayable. |
| Old writer holds local barrier when cutover arrives | Cutover waits; old committed effect is captured and drained. If cutover wins, old effect rejects in its actual TX. A process-local FIFO is insufficient. |
| Legacy merge register commits; worker pauses before repoint | Retained legacy work must be inventoried/drained or converted before final cut; no empty member page can certify completion. |
| Reversal pauses after restoration, before survivor cleanup | Retain exact provenance and both receipts; retry does not restore unrelated facts, and publication waits for cleanup custody. |
| Admissions A/B race | Control lock serializes them: authorized replay of A returns A; different intent gets busy; conflicting same receipt errors before effects. |
| Follow apply starts before local pending fence | Same local lock lets it commit before the fence and enter retained repair input; if fence commits first, stale apply rejects. Cover old and new destinations. |
| Owner fences/moves after page or permit read | Executor final native fence rolls back late effects, or source receipt reconciliation remains unavailable. Never interpret missing owner as empty. |
| Crash after admission, before dispatch | Durable pending/intent/input roots/wakeup survive; worker resumes job identity, no second epoch. |
| Crash after home effect, before custody or DBOS journal | Recover retained exact receipt/frontier; duplicate custody is no-op. Do not replay a stale positive from workflow arguments. |

`partition/partition.ts` exposes active/fenced/moved ownership and `command/fence.sql` atomically advances its
component with receipt/outbox. `database/pool.ts` rejects nested checkout. The inspected base has no general
partition-move executor proving transfer of these new rows. A real move must transfer source work/fences/receipts
and their custody obligation, or invalidate coverage and reestablish it; absent that implementation, block honestly.

## Landing sequence and the precise owner decision

1. **Additive source/native primitives:** implement real creation hooks, capture, topology scheduling, receipt
   retention, exact group materialization and bounded bootstrap/recovery. Old APIs retain their current binding.
   Leave `readEpoch` unavailable wherever actual writer cutover is incomplete; call this primitive delivery.
2. **Complete STORE algorithms:** implement real admission, immutable affected indexing, successful matching home
   admission and native custody. Implement mapping as its own bounded producer. Their native tests can prove actual
   pending/refusal with real writer fencing and topology proofs without running a consumer or calling publish.
   Such a native composition exercises the future handoff; it does not establish production activation by itself.
3. **Independent participants:** Search and Library depend only on Store/Step types and real native producer work.
   They implement actual versioned ACK records and all effect/fence custody. Neither imports the final coordinator.
   Preserve Search stale-write handling and Library canonical support/terminal-follower behavior, not dummy zero work.
4. **Composition and final handoff:** the coordinator consumes the fixed two adapters, resumes only job identity,
   and registers through existing WorkModule/outbox/DBOS composition. Bind all source structural callers together,
   drain/constrain old writers, finish native cutover, and activate admission. Accounts wait for PUBLISHED inside
   the existing merge/unmerge durable step; the ordinary route adopts its already-decided async 202/Location/poll
   contract. Keep successful callable DTOs and real replay semantics; do not return a provisional success.

The actual graph is `native Store primitives -> mapping/participant producers -> coordinator -> final callers`.
Source-local creation/capture belongs with Store, not behind the coordinator. Complete structural writer ownership
belongs to the same Store implementation boundary, with its production handoff in the final caller change.
This breaks an implementation/import cycle; it cannot erase the final activation dependency.

**Exact counterexample to an independently activated full STORE:** leave `mergeSubjectsInCommand` unchanged after
certifying cutover, then call `verifyAccountAgent` on a fresh account node and matching catalogue subject. It commits
a redirect/revision without pending intent/cap/fence ownership. Guarding that write instead makes the unchanged call fail. Binding it
to real admission leaves its required success pending forever if fixed ACK producers are absent. Returning the
old DTO before publication violates the adopted Accounts step contract. All three choices violate a requirement.
The original publication test invokes these actual APIs, so it cannot pass under a store-only implementation.

Smallest owner contract decision: assign creation, capture and **all listed writer implementations** to STORE;
name an additive primitive landing separately from completed cutover; place production writer handoff plus original
successful API/publication acceptance with the final composition. Preserve the original suites unchanged as final
mandatory acceptance, including overflow expectations and native growth. If STORE must itself pass those complete
suites before landing, include actual mapping, Accounts binding, fixed ACK producers and coordinator in that slice.
An earlier slice that reserved the source hooks cannot honestly claim complete cutover; its scope must be amended.

## Verification obligations, cost and remaining unknowns

Retain `test/semantic/identity-epoch-admission.test.ts`, `identity-epoch-publication.test.ts` and their support without
weakening outcomes. Additional native cases must cover every actual creation entry (including unlabeled/import),
all 4096 scheduled homes including empty/moved homes, lower-key concurrent changes, resumed saved empty pages,
OLD/NEW-key capture, legacy chained redirects/move/reversal, all-home cap4096/4097, larger survivor, overlapping
groups, authorization-before-replay, conflicting intent, first-apply fence race, exact receipt rejection and crash
custody. Pending/refusal tests require no consumer ACK; publication/Accounts success requires actual producers.
No native probe or production server was run for this report; the candidate's supplied result is the only cited run.

Keep 100 raw rows/page, 100 pages/segment, command deadline at most 5000 ms, eight cursor scalars/2048 UTF-8 bytes,
and 4096 UTF-8 bytes each for workflow args/results. Smaller is allowed; deadline bounds waiting, not arbitrary
work. Charge source/control/metadata/lookahead/retries, native callbacks, backend/engine work and retained bytes.
Preserve native 64/512/4096 axes, real owner pools and no planner pin; the old reversal's `enable_seqscan=off`
is not a recommended implementation. A 100-row source result is not proof that total physical work fits.

Append cost is real: bootstrap retains a page, its rows, native receipt, outbox and control custody; jobs retain
intent/input roots, group versions, per-page/per-home effect/frontier records and three fixed completion records.
For P bootstrap pages and R source rows, page/row retention is O(P+R); materializing affected membership per job
adds O(K) retained rows for K affected originals, plus actual link/support-degree work and crash retries.
Repeated jobs therefore grow history even with fixed K. Specify native indexed retention/minimization custody
before deleting evidence still referenced by jobs, participants, Accounts reversal or an owner move. Do not infer
bounded immutable history from bounded page size or introduce a new numeric retention allowance.

Unknown until implementation/evidence: actual legacy unfinished-work discoverability, complete owner-move handoff,
source/bootstrap scheduling liveness, participant producer details, Accounts persisted intent binding, and physical
native growth within existing limits. These are explicit delivery obligations, not reasons to bless stub admission.
The manager must read both independent reports completely and compare them before costly implementation changes.

## Primary source snapshots and licences

Existing reference clones were reused read-only; no code was installed, built, executed or copied from them.
Reference index topic: `identity-store-cutover-deep`; source licences were inspected.

* PostgreSQL: `.reference/library-shelf-maintenance/postgres`, release object
  `0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89` (`REL_19_RC1`, not the clone's 20-devel HEAD), PostgreSQL License,
  `COPYRIGHT`; inspected `src/backend/commands/trigger.c` and `indexcmds.c`. Native PostgreSQL 19 documentation
  supports the lock/isolation claims; these sources do not prove this application's capture implementation.
* DBOS Transact TypeScript: `.reference/search-worker-outcome-harness/dbos-transact-ts`,
  `980dc55095f445b189aecb59e7f3334345179f65`, MIT, `LICENSE`; inspected `src/dbos-executor.ts:914-1138`.
  Repository native evidence is AGPL-3.0-only. Recommendations describe designs in the existing stack.

[P1]: https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/commands/trigger.c#L213
[P2]: https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/commands/indexcmds.c#L1647
[D1]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/dbos-executor.ts#L961
