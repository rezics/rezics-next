# Native identity store: cutover, admission and landing sequence

Research date: 29 October 2026. Evidence baseline: `bae843d0b9e438ebba76a96b4b758d537808d64c`.
This report separates delivered code, the preserved candidate, proposed implementation and remaining proof.
It adopts no implementation, budget, permission or retention policy. No sibling report was read.

## Finding

The native pending-admission and cap-refusal algorithms do **not** require Search, Library or the final coordinator.
They require real creation coverage, complete legacy membership, maintained exact cardinalities, atomic native
admission, and closure of every structural writer. Receipt custody and home-effect admission also need actual
implementations. Adding the candidate's five hooks cannot remove its four unconditional implementation failures.
Missing fixed participants must prevent publication; they must not prevent implementing these store primitives.

There is a separate activation dependency. A store cannot admit real structural work while an old caller can
still commit an unreserved merge, move or reversal. Nor can Accounts return its successful DTO before publication.
The smallest safe sequence lands native primitives and producers before binding final callers. It does not
declare writer cutover complete while those callers still bypass the job. If “independently complete STORE”
means passing the existing successful Accounts/publication acceptance without the real producers, that scope
is impossible. The exact counterexample and smallest ownership decision appear below.

## Authority and inspected evidence

The complete [TypeScript boundary](../../services/kernel/src/semantic/identity-epoch-contract.ts) and
[protocol](../../services/kernel/src/semantic/identity-epoch-contract.md), current Semantic
[Identity and Account agents](../../services/kernel/src/semantic/README.md),
[canonical identity](../filtered-lists.md#canonical-identity-and-personal-references), and
[private follow counts](../private-follow-counts.md) supply the constraints, not an implemented runtime.
The actual root bounded-job-step decision was read from its recorded brief: 100 raw rows/page, 100 pages/segment,
5000 ms native deadline, eight scalar/2048-byte continuations, 4096-byte workflow arguments and results.
The shared README section named by that decision is not delivered in this baseline; the protocol's Cost section
already records these limits. Smaller limits are allowed; waiting deadlines do not bound work.

Existing [follow-count research](follow-counts-simplest.md) distinguishes durable source replacement from wakeup
delivery; its older identity-union proposal is superseded by the adopted identity contract.
The [Library terminal review](library-terminal-native-implementation-review.md) distinguishes native fences,
cleanup custody and workflow completion. This report reuses those distinctions, not their unrelated designs.

Delivered seams inspected include `semantic/{subject,bulk,account-agents,merges,merge-moves,links}.ts`, their
creation/redirect/member SQL, `command/command.ts`, `command/fence.sql`, `partition/{partition.ts,read.sql}`,
`database/pool.ts`, `access/{agent-verification,agent-verification-work}.ts`, `semantic/work-module.ts`,
`work/{registry,modules,client}.ts`, and `worker.ts`, all under `services/kernel/src/`.
`runCommand` uses SERIALIZABLE, native time, authorization before receipt lookup and transactional receipt/outbox
fencing. Its process-local command queue is not the sole durable structural-job lock. `currentCommand(tx)` is a
live binding, not transportable authority. The native fence must still succeed for any proposed local proof.

Explicit `git show 49a51f6350:<path>` inspection covered the COMPLETE preserved, unintegrated candidate:

- `services/kernel/src/semantic/identity-epoch-store.ts` and `identity-epoch-bootstrap.ts`;
- all four `identity-epoch-bootstrap-{subjects,members,dirty,member-dirty}.sql` files beside them;
- `services/kernel/db/semantic/migrations/20261028234658_identity_epoch_store.sql`;
- the new 276-line `services/kernel/test/semantic/identity-epoch-store.test.ts`;
- the original admission/publication suites and `test/semantic/support/identity-epoch.ts`.

These are branch evidence, **not delivered runtime**. The supplied final native result was three passes,
two failures, 437 assertions; positive pending/cap tests failed at `readEpoch` before admission. Root typecheck
exited zero. Those results were not rerun here and prove neither successful admission nor cap enforcement.

Candidate observations:

- `readIdentityEpochCutover` always reports blocked with five missing writers. No actual creation path calls
  `initializeSubject`; only a native test invokes it manually. Its same-transaction revision/subject checks are useful.
- `admit` never admits; Accounts also lacks the persisted-decision binding. `admitHomeEffect` checks a local gate
  but always throws. `reconcileStepReceipt` verifies some native evidence then always throws. `publish` checks
  participants then always throws. Full writer coverage alone implements none of these missing tails.
- Bootstrap retains bounded source pages, revisions and control custody. Dirty drains without an advancing
  original cursor can revisit lower keys; revision-conditional acknowledgement protects a concurrent update.
  But observations/`observed_count` are not exact published group cardinalities or installed legacy mappings.
- There is no delivered global bootstrap scheduler, mapping producer, fixed ACK producer or coordinator.
  The candidate mapping reader's local gate alone also cannot report every affected original pending immediately
  after a control-only admission; the real reader needs the retained affected index as observation evidence.
- Immutable page/row/custody/native-commit history appends indefinitely, including repeated empty generations.
  SQL statement counts of 20–21 on an observed path establish neither an allowance nor physical growth safety.

## Which writers belong to the same store integration

“Same” means a shared native invariant and complete cutover, not necessarily one large commit. A trigger that
captures changes is not the admission hook that prevents unauthorized structural work after cutover.

| Actual seam | Required store-side binding |
| --- | --- |
| `subject.ts:createSubject -> writeSubject` | Exact self mapping and local creation evidence after actual subject/revision-1 insertion, inside that source command. |
| `bulk.ts:batchCommand -> writeSubject` | Same hook on actual new imports; existing source-claim replay is not creation. `http/bulk.ts` requires batch access and constructs real Global `subject:create` authorization for each create. Preserve both; an action-name test alone proves neither. |
| `account-agents.ts:ensureAccountAgent` | Cover named `writeSubject` and the unlabeled direct `createUnlabeledAgent` subject/revision path. Do not reset an existing redirected agent to self. Preserve deterministic ID and platform authority. |
| `merges.ts:mergeSubjectsInCommand` | Move revision, release, count and redirect writes behind admitted immutable job scope and local fencing; ordinary merge and verification both reach it. |
| `account-agents.ts:verifyAccountAgent` | Bind actual persisted Accounts intent, reciprocal backlink and verification receipt; include already-verified/same-receipt success paths in final publication wait. |
| `merge-moves.ts:register`, `moveMergePage`; `links.ts` relay calls | Cover member registration, redirect repointing, link/outbound/member phases and progress updates, including old queued work. Numeric UUID preference must not override the chosen larger survivor. |
| `account-agents.ts:unverifyAccountAgent` | Cover unverify revision, redirect/member deletion, backlink restoration and replay. Its present single command can address catalogue and agent routes; new effects must visit one actual home at a time. |
| `merge-moves.ts:reverseAccountAgentLinks` | Replace synchronous exhaustion with saved bounded work and per-home receipts; retain exact verification Context/property/source/statement/filter identity. |
| Direct native SQL | Cover `create-subject.sql`, `merges-insert-redirect.sql`, `merge-moves-insert-{redirect,member}.sql`, member state updates and `account-agent-delete-{redirect,member}.sql`; capture deletes and both old/new keys of key-changing updates. |

Actual Global authority remains with the existing command authorization. The candidate's action-name check alone
does not establish every permitted creation authority. An internal creation helper must validate the real native
creation kind/binding; it must not create another permission store or call Search. No nested pool checkout or
control-home mutation belongs inside source creation. Source subject, revision 1, exact self mapping, singleton
provenance and durable local delivery/capture commit together, or all roll back. Missing mapping never implies self.

## Proposed bootstrap and cutover schedule

The following are design sketches, not candidate exports or adopted schema names. Reuse PostgreSQL, existing
native commands, outbox and `WorkModule`; no new engine, service or public readiness setter is needed.

1. Install local capture before scanning. PostgreSQL trigger installation takes `ShareRowExclusiveLock`, which
   conflicts with ordinary table writes: an already-writing transaction finishes before installation commits;
   a later write fires the installed trigger. Take the scan snapshot afterwards, and apply ordinary lock/deadline
   limits and retries. This closes the install gap; it does not certify application writer conversion.
   See [native lock rules](https://www.postgresql.org/docs/18/explicit-locking.html) and the PostgreSQL source below.
2. Capture subject births/deaths, latest-redirect changes and member insertion/deletion in their actual home.
   Keep tombstone evidence after deletion. If keys can change, dirty OLD and NEW locators; the candidate trigger
   only chooses NEW on UPDATE. Its current member phase/cursor changes do not themselves change membership.
   [AFTER triggers](https://www.postgresql.org/docs/18/sql-createtrigger.html) see completed row effects; they do
   not turn arbitrary multi-home SQL into an authorized native command or bound the number of touched rows.
3. Register a real bootstrap workflow/effect through `semanticWorkModule.register`. Save a topology cursor and
   native per-home state for **all 4096** partition numbers, not homes found in test input. Seek the native owner
   catalogue in pages, then release it before visiting each source owner. A bounded reducer records exact coverage
   of the fixed topology and ownership epochs. Missing/fenced/moved owners prevent closure; absence is not empty.
4. On each source, scan subjects by `(route,subject_id)` and members by `(route,subject_id,member_id)`, LIMIT 100.
   Read latest redirects through indexed points. Retain unresolved redirect edges; resolve their actual targets
   through bounded native work, detecting cycles/missing owners. Neither smallest UUID nor a member row is a
   terminal certificate. A subject original is counted once even if member/move evidence duplicates it.
   Install actual legacy local mapping rows through bounded native commands before declaring mapping coverage;
   a control observation is not that installation. Revalidate the captured revision so an older scan cannot
   overwrite a newer redirect or exact creation mapping. Use smaller source pages where total native work needs it.
5. Export each bounded observation with source generation, scope, native receipt and saved frontier in one
   source transaction. Release the source. Apply it idempotently in control, deduplicated by source/generation;
   replace that original's prior observed group and apply exact decrement/increment once. Retain reverse locators
   for deletions and unfinished legacy moves. Member metadata supplies outstanding work, not additional originals.
6. Drain indexed dirty rows, retaining each captured source revision. A useful local shape is:

   ```sql
   -- PROPOSED local capture and acknowledgement; native command owns this home.
   INSERT INTO dirty(route,original,revision,captured) VALUES ($r,$o,1,0)
   ON CONFLICT (route,original) DO UPDATE SET revision=dirty.revision+1;
   SELECT route,original,revision FROM dirty
   WHERE revision>captured ORDER BY route,original LIMIT 100;
   UPDATE dirty SET captured=$seen WHERE route=$r AND original=$o AND revision=$seen;
   -- PK(route,original); partial pending index(route,original) WHERE revision>captured.
   ```

   Persist the page before releasing; acknowledge only after control custody, in another local command.
   Never carry an `after` original through successive dirty drains: a new smaller key must remain discoverable.
   Member dirtiness needs the analogous full compound key. Empty/lookahead/replayed work is charged too.
7. Close the legacy writer generation with a real native local barrier, not an exhausted SELECT. Every old
   structural job/relay continuation must finish under capture or be transferred to explicit new-job custody;
   do not silently drop pending link moves. Every structural SQL path must then require the admitted-job/local
   claim invariant. Old binaries lacking it must have drained before activation. A same-home barrier row updated
   by writer and closer establishes a write conflict; SERIALIZABLE retry must start the native attempt afresh.
8. A closure record binds writer generation, native ownership epoch, completed base scans, exact captured dirty
   revisions and custody of all legacy work. Control accepts it only with its source native receipt and imported
   pages. Combine all-home closure incrementally once; no request or mapping page sweeps all homes.
   Do not close a home merely because one replayed empty page says caught-up while newer dirty work exists.

Ongoing revision-1 creation need not stop for global closure. Distinguish pre-conversion legacy originals from
births already guaranteed exact self by the installed creation invariant. Such a birth has a local singleton
certificate and durable export, not a guessed zero-count control row. Import its actual native evidence before
admitting an operation on it; if that evidence is not yet in custody, admission is unavailable, not a guessed
singleton. Unrelated fresh reads remain local and Search-independent. Creation never opens a control transaction
while holding the source. The finite legacy closure plus the enforced birth invariant covers future originals;
requiring every concurrent birth queue to be globally empty would prevent honest convergence.

The candidate's `requireCutover(ids)` helper visits only selected seeded homes. Its seed helper puts every member
on the root route. Counterexample: seed roots in home A, put another original redirecting to A in unvisited B,
or leave a legacy member/move in B. A's pages can exhaust while the true union is 4097. The helper can report
neither complete group size nor global writer coverage. A real all-home scheduler and closure evidence must run
even for empty homes; tests must include cross-home legacy originals absent from the selected fixture vector.

## Proposed admission: small control transaction, real retained work

Maintain an original-leading unique membership index and terminal/generation-leading membership pages, plus exact
group summary counts. For a sealed legacy generation, counts derive from unique original rows, including self;
for a real new singleton, from custodied creation evidence. Later published jobs maintain them transactionally
with generation changes. Do not recompute counts with `COUNT(*)`, recursively walk a group, or query all owners
inside `admit`. Unresolved legacy edges, pending changes and owner moves cannot be interpreted as smaller groups.

Retain immutable, indexed input group generations. A pending job binds a constant-size affected-index descriptor
to those existing generations plus its immutable merge/unmerge/repoint transformation and exact point exceptions.
This **proposed representation** makes the affected index atomic without copying up to 4096 rows in admission.
`pageChanges` keyset-seeks at most 100 raw entries, merges a fixed number of ordered generation streams and derives
before/after terminals from the frozen intent. Include terminals/self rows and split/repoint destinations; dedupe
overlap from membership identity, not an input vector. No chain of historic generations may accumulate read cost:
prepare the next flat indexed generation in bounded mapping work before it can become a later input.

The candidate's flat `(job_id,original)` change table alone does not provide this. If the owner requires every
flat change row physically inserted in the pending transaction, a legal 101-original merge contradicts a
100-raw-row step. Smallest clarification: allow an atomic reference to an already immutable indexed input with
deterministic intent transformation; retain the flat pages as optional bounded derived materialization.
This changes no cap, API, workflow payload allowance or publication condition.

```sql
-- PROPOSED native control command, after actual current authorization.
SELECT * FROM identity_control WHERE singleton=0 FOR UPDATE;
-- Resolve identical receipt AND immutable intent first; conflicting reuse is idempotency conflict.
-- Another pending intent -> identity_epoch_busy. No second pending epoch.
SELECT generation,exact_count,coverage FROM group_summary WHERE terminal IN ($a,$b);
-- Check actual memberships/overlap and EVERY resulting group. Missing truth -> unavailable.
-- Overflow -> THROW identity_group_overflow: rollback, no receipt/outbox/domain write.
INSERT INTO identity_job (... immutable_intent, receipt_identity, input_generations ...);
INSERT INTO affected_index_descriptor (... job, generations, transformation ...);
UPDATE identity_control SET pending_job=$job,pending_epoch=$next WHERE singleton=0;
-- Return durable wakeup event through CommandResult; normal native fence commits outbox/receipt.
```

Use the existing receipt identity/digest and native transaction result; do not mint a successful user DTO receipt
from admission. Two distinct groups merge by exact count addition; identical groups count once. Repoint removes
one original from its exact old group and adds it once to its destination; unmerge binds the prior undo job and
checks each resulting group. Validate unsupported/conflicting structural preconditions rather than guessing.
The cap is 4096 ORIGINALS per resulting group, not two endpoints or link degree. A larger chosen survivor is legal.
Source/control/authorization/receipt/metadata/retry statements all count toward work evidence.

`readMapping` must combine its exact local mapping with indexed pending scope observation: a control point/index
read may report affected pending, but supplies no effect permission. Preserve unaffected local reads; never do a
4096-home sweep. If an owner cannot be resolved with the native read capability, report unavailable. In particular,
do not solve the candidate's stale local gate by writing every affected home inside the admission transaction.
There is an explicit interpretation boundary here: a strictly home-only reader sees identical local rows just
before and after a remote control admission, so cannot immediately return pending as the original test requires.
The proposed solution needs permission for a bounded read-only control scope observation, while unaffected
mapping lookup stays indexed and does not wait for list preparation. If “local” forbids even that observation,
the owner must reconcile that precise conflict; do not silently weaken the immediate-pending test or invent
atomic cross-home gate installation. The current query-only read signature supplies no released-home router.

Accounts admission additionally needs an actual owner-produced immutable intent bound to the persisted pending
decision/reversal, account, catalogue, receipt and prior verification/undo job. `basis === null` is insufficient.
Use the real `access/agent-verification.ts` decision and existing stale-reversal check; release that owner before
control. The exact producer/binding is absent, so no successful Accounts admission is established by this sketch.
Ordinary authorized native admission can be implemented and tested without inventing that binding or consumer ACKs.

## Home effects and native custody are store work

Implement `admitHomeEffect` to return after a successful **same-effect-transaction** lock/compare, not after a
global pre-read. Create/lock the actual `(destination,original)` gate with a unique key; serialize first apply
against first gate installation too. Locking a missing row alone does not serialize two creators. Structural
effects require the exact pending job and scope installed from committed job custody; a null user basis alone
cannot install a claim. Ordinary follows require the exact local published destination/epoch and no pending gate.
The effect and its progress/evidence commit under the same active native owner fence.

```sql
-- PROPOSED one-home effect command; durable job scope was resolved and released beforehand.
INSERT INTO home_gate(destination,original,...) VALUES ($d,$o,...)
ON CONFLICT (destination,original) DO NOTHING;
SELECT * FROM home_gate WHERE destination=$d AND original=$o FOR UPDATE;
-- Compare local epoch/terminal/pending-job AND exact persisted effect scope; otherwise throw.
-- Apply the actual effect; save its scoped progress/intent in this SAME transaction.
-- Executor callback records its actual transactionId plus active owner epoch/next position.
-- The normal native fence commits both evidence and effect, or neither.
```

The insertion is only for a gate whose initial state has actual native provenance; absence is not permission
to synthesize self/published state. A failed compare rolls the insertion back as well. Ordinary no-op receipt
position reuse cannot certify an effect. Native uniqueness plus SERIALIZABLE retry handles the concurrent insert.

For each retained page, enumerate expected old-home removals, new-home additions and gate transitions before
dispatch. Each one-home command saves its idempotence key, actual effect, native transaction identity/component
and frontier together. Release it, then take control custody. Keep the expected manifest and predecessor chain
until every required effect is resolved; “no known receipt has NULL” does not prove complete enumeration.
The control ACK advances only after the complete manifest is in custody. Crash before ACK redelivers the exact
native record, not a new asserted completion. A producer's saved complete observation must cover all prior pages.

`reconcileStepReceipt` must resolve actual native step records and bind job/epoch/step/version/scope/frontier,
`transactionId` **and** `(partition,epoch,position)` to committed effects. Position-only/noEffect proof fails.
Missing, same-position/wrong-transaction, wrong-component, unfinished or conflicting records reject. Perform the
source read and release before the control command; preserve the candidate's ownership checks, not its final throw.
`publish` must actually consume mapping and both fixed versioned producer records when present, while missing
records return `identity_participants_incomplete`. No caller `complete`, default adapter or `noData` can fill them.
Published fence installation and every prior withdrawal/addition/fence require custody before publication;
pending gates cannot be released by a control pre-read. These are implementation obligations, not satisfied code.

## Concurrent schedules that the implementation must establish

| Schedule | Required ordering and durable evidence |
| --- | --- |
| Bootstrap versus creation | A birth before capture installation is in the later base scan; one after it is captured. A post-conversion birth also has same-TX exact self mapping. A lower-key birth behind the scan cursor is drained by dirty revision, never inferred from scan exhaustion. |
| Bootstrap versus legacy merge/move/reversal | Record source original redirect changes and terminal-home member changes independently; deleting a redirect/member retains a dirty tombstone. Reconcile the same original once. Keep unfinished move/reversal custody until both homes and exact verification-scoped links are resolved. |
| Writer already in flight at cutover | If it acquired the writer barrier first, closer waits and then drains its committed capture. If closer wins, the writer retries under the new admitted-job invariant. Installing a hook in new binaries does not stop an old process that can still execute bare SQL. |
| Old follow apply versus pending home gate | Apply wins the same-home lock: its committed contribution is included in retained re-key input. Installer wins: stale apply rejects inside its effect transaction. A source/control read before either event cannot authorize the later effect. |
| Admission versus competing intent | A locks control and commits pending+intent+index+wakeup; B then sees A and fails busy before structural effects. Identical authorized replay finds A; different intent with A's receipt conflicts. SERIALIZABLE aborts retry the complete native attempt. |
| Legacy structural call versus admitted job | Every callable must reserve through control before effects, including queued continuations. Local affected gates alone cannot stop a competing structural change to an unrelated group. This is why writer conversion precedes real cutover. |
| Ownership moves | Source page/capture, unfinished effect and closure carry actual owner epoch. A move fencing the native command rolls it back; a committed record survives with partition data. Resolve the new native owner and resume. Missing/moved ownership is unavailable, never a fabricated empty closure or expired job. |
| Crash after local commit, before control custody | The source generation/effect and full native receipt survive. Retry imports the same record once and only then acknowledges/releases it. No in-memory frontier can forget a removal or addition. |
| Crash after admission, before dispatch | Atomic outbox/wakeup and pending intent survive. Resume by job reference through the existing worker. No coordinator is needed to prove that the durable pending job exists; one is needed to drive final completion. |
| Crash before DBOS result journal | Re-enter the same receipt-bound native operation. Accounts waits for PUBLISHED inside its existing merge/unmerge durable step before returning success, approving or clearing pending. Native effect commit alone cannot complete that step. |

All cross-home edges above are released-home delivery with durable custody, not distributed transactions.
PostgreSQL [SERIALIZABLE semantics](https://www.postgresql.org/docs/18/transaction-iso.html) require retry handling;
locks and a snapshot do not automatically establish a fresh complete observation. The
[application-consistency guidance](https://www.postgresql.org/docs/18/applevel-consistency.html) specifically
distinguishes locking a row from updating it when serializing against concurrent changes.

## Smallest landing sequence and precise scope decision

1. **Creation/capture primitive:** real source hooks, authority binding, native evidence and dirty indexes.
   Keep existing callers and DTOs. Prove both account-agent birth paths and actual imports without Search.
2. **Bootstrap primitive:** actual all-home scheduling, indexed scans/drains, exact membership generations/counts,
   owner-bound closure/custody and retained unfinished legacy work. Observation can land before writer activation;
   it must continue to say unavailable until its real closure condition holds.
3. **Store writer primitive:** implement control admission, atomic retained affected index, real home fences,
   complete effect receipt custody and publication validation. Refactor all listed structural writers into
   job-scoped executor seams. Positive store pending/refusal tests need this whole writer invariant, not a flag
   clearing the candidate missing-writer list. No Search/Library ACK or final coordinator import belongs here.
4. **Mapping and Accounts binding primitives:** mapping imports Store, not Coordinator; it advances actual native
   redirect/member/revision/backlink/link work with bounded saved frontiers. Accounts owns the persisted-intent
   binding, not a null-basis shortcut. These exports can land before their final successful caller is rebound.
5. **Fixed producer primitives:** Search and Library each implement their real version-1 step against Store's
   affected stream and custody interface. They do not import Coordinator. Ordinary Search checkpoints are not
   identity ACKs; Library preserves stored originals and target-home support deduplication/current account fences.
6. **Composition and final caller binding:** Coordinator consumes Store, Mapping and the two real adapters through
   the existing once-only WorkModule/DBOS composition. Bind native wakeup/resumption and then actual callers:
   Accounts waits inside its same durable steps, including replay; ordinary HTTP uses the already adopted 202,
   Location and currently authorized operation poll contract. No temporary success DTO or extra polling step.
   Finish legacy writer drainage and factual all-home cutover before accepting structural jobs in that runtime.

This is a dependency DAG: Store -> Mapping/participants -> Coordinator -> final caller bindings, with source
creation/capture underneath Store. Reading arrows as “is consumed by” avoids requiring Store to import consumers.
It is code landing order, not a new feature flag, permission gate, readiness override or permission to activate
a runtime with old bypass writers. Final binding and cutover remain an integrated acceptance boundary.

Exact impossibility witness under the original isolated STORE scope: leave `mergeSubjectsInCommand` unchanged,
admit pending J, then call ordinary merge or verify for another group. The old command writes a revision/redirect
without reserving the sole job. Capturing that write afterwards cannot undo the violation. Rejecting it with a
new blanket unavailable gate does not preserve the requested successful API. Routing it through J's protocol
without actual participants cannot return the mandated published Accounts DTO. The original publication test
explicitly requires mapping plus BOTH actual participant completions; manufacturing those would weaken it.

Smallest owner decision: expand store writer ownership to the enumerated creation and structural hooks and
native custody; accept its independent native pending/cap/fencing outcomes separately from final caller binding.
Keep every original successful API/default/DBOS/growth requirement assigned to the final integrated boundary,
unchanged and mandatory. Do not call that boundary passed because a smaller store test is green. If ownership
cannot expand, assign those hooks to a preceding explicit source-writer primitive and retain the same invariant.
Clarify immutable generation references as the atomic affected index if a flat-row-only interpretation is intended.
This is an explicit scope/sequence decision for the owner, not a claim that the original isolated STORE assignment
or its unchanged combined acceptance is independently green. Without it, only the named preceding primitives land.

## Remaining native proof and physical cost

No temporary native probe was run and no production service/data was touched. This is source proof and a proposed
schedule, not native race, crash, deployment or performance evidence. Additive tests must cover all-home closure
with unselected cross-home originals, missing/moved owner, lower-key dirty replay, both birth paths/import authority,
in-flight old writer, split/repoint/reversal, larger survivor, 4096/4097 refusal with unchanged effects, authorized
replay/conflicting intent, and actual pending without fake consumers. Preserve the original acceptance suites.
Mapping needs finite actual native work and receipt custody; publication/API/DBOS tests still need real producers.
Also test first absent-gate apply versus installation, a writer targeting an unrelated group during pending,
capture commit before control import, and saved complete observations missing an earlier page effect. Assert
actual native receipt identity/component and fixed producer records, not only final state or returned booleans.

Charge source reads, local/control metadata, native fences, lookahead, discarded rows, retries and all engine work.
Keep the native 64/512/4096 axes and adopted physical-growth requirements; no planner pin or new allowance.
Retained space is not constant: bootstrap appends page rows plus page/commit/outbox/custody records; each captured
change and retry generation adds evidence. Flat membership generations add changed-group rows per job; effects
add records per touched home/page/link-support input. Immutable histories grow with completed jobs and captures,
and PostgreSQL MVCC adds physical update/dead-tuple/index costs. Vacuum does not remove live immutable history.
Specify actual retained bytes/rows and existing retention-owner obligations in implementation evidence; this
report introduces no disposal policy and cannot claim a bounded lifetime footprint from bounded step sizes.

Before costly implementation, the manager must read both independent reports completely and compare their
counterexamples, atomic-index representation and activation sequence. This report supplies evidence, not approval.

## Primary external sources and licences

Reference clones were reused as read-only data, never installed, built or run; their reuse is recorded in
`.reference/INDEX.md` in the reference directory. Recommendations concern native design, not copying source.

- PostgreSQL, `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, PostgreSQL License (`COPYRIGHT`), clone
  `.reference/library-shelf-maintenance/postgres`: [trigger.c](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/commands/trigger.c)
  `CreateTriggerFiringOn` takes `ShareRowExclusiveLock`; [tablesync.c](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/replication/logical/tablesync.c)
  documents copy, catch-up, synchronization-position custody and READY as separate states. This is a bootstrap
  pattern, not a proposal to add logical replication. Official PostgreSQL 18 documentation is linked above;
  the source snapshot is separate evidence, not a claim about the deployed PostgreSQL version.
- DBOS TypeScript, `980dc55095f445b189aecb59e7f3334345179f65`, MIT (`LICENSE`), clone
  `.reference/search-worker-outcome-harness/dbos-transact-ts`: [src/dbos-executor.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/dbos-executor.ts)
  invokes step work before `recordOperationResult`; `runInternalStep` checks stored output before invoking again.
  Together with the official [step documentation](https://docs.dbos.dev/typescript/tutorials/step-tutorial), this
  supports native idempotence/custody across the commit-to-journal gap, not a cross-database atomicity claim.

Shared pattern: capture precedes baseline copy, completion follows a durable catch-up boundary, and replay uses
native retained evidence. Applying that pattern does not supply the absent identity writers or participant ACKs.
