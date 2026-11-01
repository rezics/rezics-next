# Native eligible-key discovery: the shared-veto boundary

The available ordinary PostgreSQL index designs do **not** satisfy the simultaneous frozen
selection and single-row-writer bounds. This report gives concrete counterexamples for that
scope, and a reduction explaining why a general shared-gate solution is a substantially
stronger requirement. It does not prove an unconditional impossibility for every data
structure. No complete feasible native algorithm is established here. The actionable outcome
is an explicit owner choice at the end; the original complete native-discovery producer must
remain stopped until that choice or a genuinely stronger algorithm is supplied.

This is source research, not an adopted queue policy, implementation, or product landing.
The original producer, independent WorkClient producer, frozen files and tests are untouched.
Original, authored, native and growth acceptance are **UNRUN**; checks are `[]`.
No compiler, installation, generation, database/native query, executor, provider, remote
check, browser automation, capture, benchmark or publication was run. Primary-paper retrieval
was desk research only. Documentation changes require no workspace typecheck.

## Source pins and scope

Repository source inspected is pinned to `af182871aa1c7a9587a236d5cd8c6177a30d027e`.
The local `dev` ref resolved to `8a349cb74b60808a519a666b9baffa092c7b2ee9` when read;
its SDK patch and `work/sdk-retirement-fence.ts` were inspected through `git show`.
Their dispatch table and patch match the source boundary used below. This is a pin, not
a claim about subsequent movement of `dev` or installed delivery.

The following launch authorities were read completely:

- `docs/research/kernel-bounded-work-source-gaps.md` at
  `aa9428eb40e82bffeb05afefbd4060043c8bed12`, including both frozen reproducers and controls.
- The original complete native-discovery brief at the supplied read-only
  `.temp/goal/performance/native-eligible-work-discovery.md` path in the main checkout.
- Its complete `decisions/native-discovery-owner-contract.md`, including Commerce's acceptance
  of deterministic rotating fairness and the stopped-source receiving decision.
- `git show 77460ab6e1:.temp/native-discovery-source-audit.md`. This historical temporary
  artifact rejects eager per-domain veto maintenance; it supplies neither code nor a new authority.
- Architecture at `4736cfd8` and the current architecture, workflow and Performance definitions.
  Engine MVCC visibility work is excluded; visible posting traversal, bitmap construction,
  trigger loops, sorting and derived-node maintenance are not excluded.

`SDK/` below is the read-only local
`services/kernel/node_modules/@dbos-inc/dbos-sdk/dist/src/` of version `5.5.3-preview`.
The actually inspected byte pins are:

| Source                                                   | SHA-256                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| Repository SDK patch, also inspected at pinned dev       | `16f393956300e03b04794ec58058c98f6398bcac7d55fdbd68a6f8b84c359806` |
| `SDK/system_database.js`                                 | `7f8acb0c80120ad0afa59e7848bbebbfcae5d3f0754d459764b923c1b0343f2b` |
| `SDK/wfqueue.js`                                         | `9be7bd806fb41bbb73d87b848a2c8ac1cb8bc8e615c6cadd7158bffb8b0698c5` |
| `SDK/client.js`                                          | `9031a6d260650e4e39f225e366e43eac8d7646fb799ab8270d7117ad0826a971` |
| `SDK/sysdb_migrations/internal/migrations.js`            | `d187c8a19e4c3141392c73701899ca0005155febdabdfde481bf5782fe61daff` |
| `SDK/sysdb_migrations/internal/workflow_writer_fence.js` | `c386f618a5755655a57fde41c571ca30d3a61d7aa00d1871501892b82c4e6a0b` |

Local bytes establish no installation receipt, migration coverage or runtime result. The launch
has no required dependency receipts; no missing WorkClient delivery is inferred from old prose.

The Work README's named reference was inspected before designing: the read-only reference index
and `search-worker-outcome-harness/dbos-transact-ts/src/{client,system_database,dbos,dbos-executor}.ts`
at `980dc55095f445b189aecb59e7f3334345179f65` (MIT). Inspected surfaces were ordinary and
transactional enqueue, list/filter/deletion delegation and original deletion transactions.
Reference code is supporting evidence; patched installed bytes determine the native predicates.

Additional primary source: PostgreSQL at `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`
(PostgreSQL License), read from `library-shelf-maintenance/postgres` under the supplied reference
directory. `src/backend/commands/indexcmds.c:CheckPredicate/ComputeIndexAttrs` rejects mutable
index expressions/predicates and notes the rejection of subqueries. Git source blobs for
`executor/nodeBitmapAnd.c:MultiExecBitmapAnd`, `nodes/tidbitmap.c:tbm_intersect` and
`access/nbtree/nbtsearch.c:_bt_readfirstpage` were also inspected. BitmapAnd constructs child
bitmaps and intersects their entries; a top-level limit does not make that work constant.

Repository chains additionally inspected under `services/kernel/src/`:
`work/README.md`, `work/{client,queues,retention,registry,sdk-retirement-fence}.ts`, `worker.ts`,
`commerce/{work,work-contract}.ts`,
`history/{durable,agent-identity-retirement,agent-identity-inventory-work}.ts`,
`semantic/identity-{epoch-contract,source-consumer-maintenance,source-maintenance-config}.ts`
and `library/collection-source.ts`. These establish pool composition, Session keys and the
original aggregate axes. Short module paths below use this prefix; they do not establish
that any referenced dependency delivery is installed.

## Exact native problem

Let `K=(queue_name,queue_partition_key)` in the native database scope, with a non-null
partition key. `H` is stored native/index history, `N` distinct keys, `M` exact
application/version/key memberships, `D(K)` the number of those memberships at K,
`w` fixed available slots, and `L` fixed selected metadata width. Application count and
coexisting version count are independent unbounded population axes. A changed source row
and its actual children are a legitimate input axis; memberships of unrelated executions
sharing K are not automatically such children.

The source at `SDK/system_database.js:835–849,3604–3788,4531–4664` establishes:

```text
compatible(row,A,v,latest) = ENQUEUED && row.queue=q &&
    (row.application=A || row.application IS NULL) &&
    (row.version=v || (latest && row.version IS NULL))
free(K) = NOT EXISTS row(queue=q, key=K.key, status=PENDING)
eligible(K,A,v,latest) = free(K) && EXISTS compatible(row at K,...)
head(K,...) = compatible row minimizing (priority,created_at,workflow_uuid)
```

`noPending` deliberately has no application or version filter. A foreign application's
PENDING row vetoes a local or unclaimed head. Nonlatest workers match exact version only;
latest workers match current **or null**. More than one nonlatest version can remain live.
`insertWorkflowStatus` and batched `enqueueWorkflows` accept the supplied version without
a per-key version census/cap. Null/unclaimed is shared membership, not a synthetic owner.
The nameless SDK application filter matches all applications; the mounted kernel names
`rezics-kernel`. An extension claiming generic nameless support must separately account
for that union, rather than assuming the named caller is the whole SDK surface.

The active `effects` queue has worker concurrency 8 and partition concurrency 1;
`checkoutPartitionKey` preserves namespace, live/test mode and actual Session ID.
It cannot be replaced by a hash bucket. `wfqueue.js:672–693` reaches the batched native
selector with its actual available slots. Nonpartitioned `workflows` and `maintenance`
use `claimStartableWorkflows`; their residual version/application filtering also needs repair.
That path has no universal cross-version per-Session veto: do not invent one there.

The partitioned candidate walk runs outside the claim transactions. In each bounded batch:
native `partitionLockQuery` tries transaction advisory locks hashed from schema/queue/key;
locked-out keys are skipped. Under the locks, native code selects heads again and repeats
the shared veto. It then locks the **fixed** candidate IDs `FOR UPDATE SKIP LOCKED`, without
sliding a LIMIT past a locked head, and rechecks queue, non-null key, status, version and
application in the conditional update. Only `RETURNING` IDs are dispatched, with the same
owner token, executor, version, claimed application, deadline and recovery-attempt update.
`claimLockQuery` and the original NOWAIT/SKIP LOCKED modes of nonpartitioned/shared-budget
claims remain authoritative. Hash collisions may cause a busy miss; they cannot admit
two owners. A replacement index selects candidates; it never grants execution authority.

## Factorization that is valid, and where it stops

Exact null buckets avoid a false infinite application fanout. Use stored application and
version values, with tagged null keys (never an ordinary string sentinel that can collide):

```text
E index: (queue, app_tag, app_value, version_tag, version_value,
          key, priority, created_at, workflow_uuid) WHERE status=ENQUEUED
P index: (queue,key,workflow_uuid) WHERE status=PENDING AND key IS NOT NULL
membership M: PK(queue,app_bucket,version_bucket,key), head_id, stable_ticket
reverse M: (queue,key,app_bucket,version_bucket)
gate G: PK(queue,key), pending_count
```

For one named worker, merge two application buckets and one or two version buckets:
at most four exact components, without duplicating nulls into every worker domain.
Pick the minimum original tuple among compatible component heads at the selected key.
A new latest deployment only changes which version buckets its selector probes; it does
not rewrite old memberships. Component duplicate keys must be collapsed before claim.
Exact E equality probes also remove the hot incompatible-version prefix. For an ordinary
nonpartitioned queue, separate exact bucket order indexes ending in
`(priority,created_at,workflow_uuid)` can merge a constant number of top-w streams for the
named caller. Preserve its original queue ordering; rotating keys is for partitioned selection.

For partitioned discovery the remaining operation is **dynamic set intersection**:
given arbitrary posting set `S_b={K:M(b,K) exists}` and the shared dynamic set
`R={K:G(K).pending_count=0}`, find a member of `S_b intersect R`, or certify empty.
An index on either marginal set does not index the intersection. Four component probes
are constant only if each component already solves this problem.

## Concrete candidates and their actual costs

All pseudocode here describes evaluated data structures, not a second implementation.
`Q` counts examined records/cells, `P` keyed/range probes, `S` SQL statements including
nested maintenance, and `I` visible index work. Distinguish `B_out`, content returned to the
calling owner, from `B_int`, scalar content processed inside native execution. A server-side
loop can have zero B_out and growing B_int; SDK dispatch `bytes` must not be inflated by
pretending the latter crossed the client boundary. Ordinary
B-tree descent for a fixed number of entries is `O(log H)` engine work; explicit SQL tree
nodes also count as examined rows. A function containing a loop pays for its whole loop.

### Eager ready memberships

Add `Ready(queue,bucket,ticket,key)` with that primary index; store stable tickets in M.
On an E change repair the exact old/new component head using E top-1 equality probes.
On a gate crossing 0/1, enumerate reverse M and insert/delete each Ready membership.
Select up to w Ready keys after the durable cursor, wrap once, then run the original
native locks, under-lock head/veto probes, fixed-ID locks and conditional claim.

```text
on status mutation, in the source transaction:
    apply delta to exact G(K), holding its row lock
    if zero/nonzero boundary crossed:
        for (bucket,ticket) in M WHERE (queue,key)=K ORDER BY bucket:
            insert Ready(bucket,ticket,K) if free; otherwise delete it
```

With correct coverage, read costs are `Q=O(1+w), P=O(1+w), S=O(1)` at fixed w,
returned `B_out=O(wL)`, `I=O((1+w)log H)`. A gate toggle costs
`Q=Theta(1+D(K)), P=Theta(1+D(K))`, `S=Theta(1+D(K))` for this loop,
`B_int=Theta(D(K))` internal fixed-width membership content and
`I=Theta((1+D(K))log H)` index updates. A set-based INSERT/DELETE reduces S, not Q/B/I.
On one K with V versions, one original completion or claim incurs V derived writes.
Application factorization removes hypothetical worker replication but does not remove V.
This candidate fails the writer bound; it is not an acceptable repair.

Transaction order for an updated implementation would retain native advisory lock, fixed
workflow lock and permanent writer guards, then G and exact memberships in sorted key/bucket
order, committing all changes together. Old row-trigger writers can start by locking their
source status row. Claims must not hold G and then wait for a source status row: their
source-row locking remains SKIP LOCKED. Retirement has its existing fence/status ordering;
whole-attempt deadlock/serialization refusal remains possible and paid. A trigger design
cannot assume every old multirow statement already has globally sorted workflow locks.
No additional lock-order rule turns the V writes into constant work.

### Shared gate plus postings, including signature factoring

Keep E/M/G and an ordered partial `Free(queue,key)` index maintained only when G crosses zero.
Do not store Ready. Both of these exact selectors are executable relational algorithms:

```text
posting-driven: scan M(bucket,key>cursor); point-probe G; stop after w eligible keys
free-driven:    scan Free(key>cursor); point-probe M(bucket,key); stop after w matches
merge:         seek both ordered lists; advance the smaller key until equal or exhausted
```

A single toggle has constant G/Free row changes and logarithmic engine index work.
Choose `S_b` to contain every even key and R every odd key. Empty intersection requires
Theta(N) posting/gate/membership examinations for these algorithms, including merge/galloping
on interleaved lists; append one common key for the corresponding hit. SQL joins can keep
S constant and return zero bytes, but Q/P and processed bytes grow; point-loop versions
also have growing S. `I=O(N log H)` for point probes (or linear leaf traversal after seeks).
Filtering a fixed LIMIT gives a false empty; repeated filtering without bounded proof
recreates the stopped failure. A cursor does not certify exhausted work.

Factoring identical membership signatures can help a special workload: store
`Signature(sig,key)` plus `SignatureBucket(bucket,sig)`, and free keys per signature.
A key toggle updates one signature's ready list. A bucket query must still find a signature
having a free key. Give keys distinct signatures and interleave free signatures outside the
queried bucket; the same empty/hit counterexample applies over signatures. Materializing
bucket/signature readiness on each signature toggle restores incidence fanout. No bounded
number of signatures or common worker census is provided by the source contract.

### Ordered multilevel summaries and lazy invalidation

Consider a balanced key-range tree with `Node(queue,node_id,lo,hi,left,right,free_count)`
and exact `DomainNode(bucket,node_id,member_count)` summaries. Maintain free_count on the
root-to-leaf path. Selection descends a child only if both counts are positive, searching
in rotating order. With alternate-key membership/readiness, every nontrivial range can have
both positive counts but no intersection. It visits Theta(N) nodes to prove empty;
explicit row storage costs Theta(N) rows/probes/bytes, even inside one recursive SQL statement.
Updates cost Theta(log N) derived node rows, not just engine B-tree pages. Thus even the
marginal tree writer fails a literal constant-row writer budget.

Exact `DomainNode(bucket,node_id,eligible_count)` permits logarithmic descent. However a
key gate flip changes the eligible counts on every incident domain's ancestor path:
Theta(D(K) log N) scalar updates/bytes, or D(K) separately augmented native index paths.
Packing all counts in one vector changes its size to Theta(number of domains), not O(1).
Lazy tags only work for a uniform range or uniform membership subproblem. A point shared
by arbitrary domain postings is neither. An epoch-invalid summary must be recomputed or
validated; the first empty query after many invalidations can pay the complete traversal.
Deferred repair needs a dirty frontier, and cannot be called an exact empty selector while
that frontier is incomplete. Restarts and repeated invalidation do not erase that debt.

### Bitsets, arrays, compressed postings and native bitmap plans

Schema: `Bits(bucket,chunk_no,member_bits)` and `FreeBits(queue,chunk_no,free_bits)`, with
primary keys on their named fields. A chunk contains W fixed bits. A toggle changes one
free chunk; query scans chunks in cursor order, ANDs the two values and extracts set bits.
Worst-case empty/hit on disjoint dense alternating sets costs Theta(N/W) chunk reads and
Theta(N) bits processed; there may be no output at all. With machine words of b bits,
that is Theta(N/b) word operations. W cannot grow while its row/byte work stays constant.
An array containing every eligible version/key has the same byte/update issue. TOAST does
not make reading or rewriting a long value constant design work.

A hierarchy of nonempty **intersection** chunks must be updated for every incident bucket;
separate nonempty marginal hierarchies admit the same disjoint example. Compressed postings
have adversarial incompressible patterns; a worst-case guarantee cannot use expected runs,
compressibility or random success. PostgreSQL BitmapAnd builds its input TID bitmaps before
intersection; it is not a persistent join index over two different relations. GIN-like
posting storage or lossy bitmaps move traversal/rechecks into the engine without eliminating
visible growing set work. Returned bytes may be O(wL) while processed bytes remain linear.

### Native partial/expression index

`E` and `P` above are valid useful partial indexes. A proposed
`INDEX ... WHERE status='ENQUEUED' AND shared_free(queue,key)` is not a reactive join index.
Its predicate depends on other rows, violating the immutable expression requirement read in
PostgreSQL `indexcmds.c`. Lying with an IMMUTABLE wrapper neither registers dependencies nor
updates existing index entries when B completes. Copying free into every E row explicitly
requires all those row updates, potentially worse than D(K). Same-row expressions cannot
factor a cross-row veto. A custom access method would need a complete traversal/update and
custody derivation; its opaque name is not evidence of one.

### Honest dynamic intersection with a heavy/light threshold

For a fixed membership snapshot, pick threshold T, store ordered postings for domains with
at most T keys and Ready indexes for larger domains. Keep reverse lists of heavy incident
domains. A light query checks at most T gates; a heavy query reads its Ready index.
On a gate toggle, update each incident heavy Ready index. With M memberships there are at
most M/T heavy domains, so worst-case toggle work is
`Q,P,B_int=O(1+min(D(K),M/T))`, `I=O((1+min(D(K),M/T))log H)`;
a light miss is `Q,P,B_int=Theta(T)` with corresponding indexed work. Statements can be batched,
but the scalar work cannot. T near sqrt(M) offers an honest tradeoff, not the frozen bounds.
T constant makes arbitrary V domains heavy. T growing violates constant empty-query rows.
Dynamic promotion/demotion also requires rebuilding a posting/Ready set; amortized rebuilds
are not worst-case single-writer bounds. Incremental rebuild requires versioned coverage and
an explicitly incomplete query state. This is a maintainable alternative only after an
owner changes the relevant contract; it supplies no free allowance or hidden fixed V.

## What is proved, and what is conditional

For **ordinary row-local native indexes plus the concrete relational postings, shared
gates and summaries above**, the counterexamples are unconditional. An exact materialized
membership at each independently indexed domain must change at each affected membership;
a marginal selector without joint summaries has the stated disjoint-list/tree examples.
One K with V memberships alone is not a universal lower bound: a shared object can represent
that special case cheaply. The arbitrary key/domain incidence is essential.

Here is a stronger reduction, not an assertion that all dynamic structures have been ruled
out. Assume a complete proposed solution handles arbitrary incidence, charges all its work,
builds through ordinary bounded writers/backfill in near-quadratic time for a dense input,
and supports polylogarithmic total engine work per fixed-source writer and fixed-slot poll.
For an arbitrary n-by-n Boolean matrix A, create key K_j for each column, distinct non-null
version v_i for each row, and an ENQUEUED membership at (v_i,K_j) exactly when A_ij=1.
Use one named application and nonlatest workers; no null/version/latest ambiguity is needed.

For an online Boolean vector x, set K_j free iff x_j=1 by adding/cancelling one original
PENDING blocker at that key. Blockers use a foreign owner/version; at most O(n) original
row changes encode the vector. Fresh blocker IDs per round avoid assuming reopening a
permanently retired ID. To read (Ax)_i, poll one slot at version v_i. In an uncontended,
fully covered database it must distinguish an eligible hit from an empty intersection.
If it claims a head, resume that one PENDING head through native `resumeWorkflows` before
the next query; this preserves its membership and removes the temporary veto. Each bit
costs a constant number of fixed-source operations. Durable rotation does not affect the
existence bit. No workflow body or provider is needed for this mathematical reduction.

Over n vectors, this would compute online Boolean matrix/vector products in
O(n² polylog n) work after O(n² polylog n) native construction, with polynomial state.
That implication is our reduction; it is not an observed execution. Arbitrary superpolynomial
precomputed readiness tables would also need their population, membership updates and bytes
charged and cannot be built by the assumed bounded native writers/backfill at that cost.

The primary paper [Henzinger et al., arXiv:1511.06773v1, Conjecture 1.1 and §5.1](https://arxiv.org/html/1511.06773v1#S5.SS1)
formulates OMv hardness and its multiphase set-intersection connection. Under that conjecture,
the implication above rules out the assumed simultaneous performance, including clever
factorizations. This is **conditional evidence**, not an unconditional PostgreSQL impossibility
theorem and not a source of adopted product constraints. The scoped relational counterexamples
are proven independently. Whether a materially different custom structure defeats this boundary
without violating the accounting assumptions is not established; claiming that it does would
require a concrete algorithm and proof, not another implementation attempt.

## Literal reservations at the original ports

The actual paid path is
`history/durable.ts:minimizeIdentitySDKWork -> maintainSdkWorkflowOnce ->
DBOSClient.maintainWorkflowOnce -> SystemDatabase.maintainWorkflowOnce`.
It uses the original configured Pool object, current writer/restore tuple and caller deadline.
`worker.ts` supplies that same Pool to Work/DBOS. The callback goes through
`reserveIdentityHistoryWork -> currentIdentitySourceConsumerMaintenance(pool,...) ->
reserveIdentitySourceConsumerNativeWork`, checking the active AsyncLocalStorage frame,
pool identity, remaining balance and live wall deadline **before I/O**. A copied URL,
unrelated preflight or released receipt is insufficient.

These are the unchanged `SDK_MAINTENANCE_DISPATCH` bounds, not new estimates:

| Dispatch                                           |    Rows | Points | Statements | Returned content bytes | Engine requests |
| -------------------------------------------------- | ------: | -----: | ---------: | ---------------------: | --------------: |
| rollback, prepaid before checkout                  |       0 |      0 |          1 |                      0 |               0 |
| begin                                              |       0 |      0 |          1 |                      0 |               0 |
| settings                                           |       1 |      0 |          1 |                    128 |               0 |
| lock current native tuple/domain                   |       4 |      2 |          4 |                   8192 |               0 |
| retire                                             |       8 |      5 |          9 |                  32768 |               0 |
| delete-workflow_input                              |       1 |      1 |          1 |                      0 |               0 |
| delete-workflow_output                             |       1 |      1 |          1 |                      0 |               0 |
| delete-operation_outputs                           |      64 |      1 |          1 |                      0 |               0 |
| delete-workflow_status, including four FK cascades |      73 |      5 |          5 |                      0 |               0 |
| commit                                             |       0 |      0 |          1 |                      0 |               0 |
| Complete retire attempt, including rollback slot   |  **13** |  **7** |     **17** |              **41088** |           **0** |
| Complete delete attempt, including rollback slot   | **144** | **10** |     **16** |               **8320** |           **0** |

Status deletion is status1 + events8 + history64 =73; notifications/streams must be absent
in this particular bounded identity custody. Input1 + output1 + operations64 +73 =139
actual owned execution rows. Physical inspection in `history/durable.ts` separately bounds
the eight row kinds, 64 KiB payloads, 4 KiB metadata and total below 10 MiB. General retention
deletion still costs actual `d+c`; these selected-identity constants cannot be applied to
every old workflow. Retirement revokes owner_xid but preserves PENDING status; it does not
open the shared gate. A lawful later deletion of the sole PENDING owner can open it.

For a literal eager-body counterexample, use scalar `bucket_id bigint,ticket bigint` in M
and `Ready PK(bucket_id,ticket,key)`, plus reverse M `(key,bucket_id)` and G's key PK.
On an existing K, the added trigger executes exactly this body on a veto boundary:

```text
UPDATE G SET pending_count=pending_count+delta WHERE key=K RETURNING pending_count INTO local_count;
FOR local_row IN SELECT bucket_id,ticket FROM M WHERE key=K ORDER BY bucket_id:
    INSERT Ready VALUES(...) or DELETE Ready WHERE full_primary_key;
```

The G update examines one row/probe; M examines V rows in one range probe; Ready modifies
V rows through V probes. Even before safety checks/head repairs, the added dispatch vector
is at least `(rows=1+2V, points=2+V, statements=2+V, bytes=0, engineRequests=0)`.
This body is wholly server-side: its B_out is zero. It additionally processes at least
`8+16V` bytes of logical bigint content internally, plus key, tuple and index content.
Moving the loop into owner JavaScript would instead return V memberships and require a
growing wire-byte reservation derived from the actual serialization/column-width bounds.
This is a literal **lower bound**, sufficient to refute every finite replacement row/probe
dispatch constant; it is not a complete safe upper bound for an unbuilt trigger. Visible
index work includes V Ready modifications and one reverse range scan, with
O((1+V)log H) B-tree work. Set-based SQL can lower S, not the growing rows/internal bytes.

Thus for this evaluated loop the delete-attempt lower bound becomes
`(145+2V,12+V,18+V,8320,0)` plus the growing internal/index work, and cannot fit a constant
dispatch replacement. For shared
postings, the corresponding unbounded variable is the number X of inspected nonmatching
keys; for chunk bitsets it is N/W; for explicit joint trees it is D(K)log N. All must be
charged, including failed/rolled-back dispatches. O(log H) ordinary index maintenance on
one source row is not permission to update V independently stored logical rows.

For any actual feasible replacement the complete enclosing equation would be componentwise
`original Source verification + directory/consumer work + History custody/probes/commands +
original SDK attempt + added discovery maintenance + final verification`.
There is no subtraction after rollback, no renewal inside the callback and no hidden retry.
Every subsequent original attempt reserves the entire dispatched path again. `maintainWorkflowOnce`
reserves rollback before BEGIN, uses one READ COMMITTED attempt, and rolls back on later refusal;
an ambiguous COMMIT propagates for later ordinary observation. Existing old APIs retain their
retry rules, whose repeated work cannot be treated as one paid attempt.

All original axes must remain visible: native `rows,points,statements,bytes,engineRequests`,
and Library `candidateKeys,identityMetadataRows,nativeRows,nativePoints,witnessKeys,
statements,bytes,emptySeeks`. A discovery-only change grants zero additional Library work;
it does not erase the existing consumer allocation. Current native defaults/hard maxima are
577/577/173/630784/0; Library maxima are 1/0/8192/128/1/128/1048576/2 in the corresponding
order just listed. The independent two-child directory envelope is capped at 100 rows,
200 points, 36 statements, 229376 bytes and zero engine requests, each child half of that
or the remaining native balance. These are finite existing allocations, explicitly not a
proof that guarded History composition fits. No replacement allocation is adopted here.
Engine request zero means no separately dispatched engine request; PostgreSQL buffer/index
work must still be proved/measured logarithmic. `SDK_TRANSACTION_FENCE_COST.engineWork=0`
does not authorize ignoring index work or inventing an aggregate refund.

## Writer, migration, custody and restore obligations

No candidate is complete merely because its SELECT looks bounded. This is the required
native hook inventory for the eventual original delivery; no hooks are claimed installed:

| Native source path                                                                                                                       | Required derived effect in the same transaction                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initWorkflowStatus/insertWorkflowStatus`, ordinary/portable and caller-transaction enqueue, batched `enqueueWorkflows`, schedules/forks | Maintain exact old/new queue/key/application/version membership, original created/priority order and PENDING gate; preserve deduplication, reuse and input compatibility. An ON CONFLICT no-op must not double-count. |
| Both native claim methods                                                                                                                | ENQUEUED removal, PENDING addition, version assignment, unclaimed application adoption and head replacement; retain original conditional update/token/locks.                                                          |
| `recordWorkflowOutput/Error`, one-statement outcome CTE and transactional fallback; `updateWorkflowStatus`                               | Owner-qualified PENDING departure, completion/retention entry and compatible head changes. A failed owner predicate changes nothing.                                                                                  |
| `cancelWorkflows`, `cancelTimedOutWorkflows`, `deadLetterWorkflows`                                                                      | Old queue/key veto departure even when NEW.queue_name becomes null; terminal status/completion metadata. Children=true remains actual native change-size work.                                                        |
| `reenqueueWorkflowsForRecovery`, `resumeWorkflows`, `rewindWorkflow`                                                                     | Remove prior PENDING gate, clear/reassign state and original queue/key; restore ENQUEUED ordering, clear completion/retention membership, preserve owner fencing and real rewind history operations.                  |
| Delayed/debounced and suspended work, `transitionDelayedWorkflows`, suspend wake/re-enqueue, `setWorkflowDelay/Priority`                 | DELAYED/SUSPENDED are not ready. Maintain activation and priority/input/application changes without prematurely admitting them; wakeReceivers' due-time update alone does not make a ready membership.                |
| `renameApplication` including in-flight transaction and terminal batches; version/application assignment on insert/claim                 | Move exact component buckets and retention ownership atomically with each original native batch. Do not replicate into the applications of every worker.                                                              |
| Original four-table delete body, both generic and paid single-attempt ports                                                              | Remove own derived copies, replace any affected heads, update old-key gate and retention metadata; preserve permanent native fences/domain and deleteChildren=false semantics.                                        |
| INSERT/UPDATE/COPY restore into live schema, input restoration and older executors' original SQL                                         | Native ALWAYS hooks, not only new JavaScript wrappers; cover unchanged old SQL and refuse incompatible layouts before trusting coverage.                                                                              |

`workflow_input/output`, operations, events/history, notifications and streams retain the
existing eight-family ALWAYS writer guards even if they do not affect queue eligibility.
Parent/fork source guards, owner checks on old sendFromStep, explicit resume/rewind/fork
guard calls and permanent closed-fence rejection cannot be removed. A DELETE hook is newly
necessary for discovery; existing writer guards only cover INSERT/UPDATE. Triggering extra
work in an old writer does not automatically supply its pre-I/O reservation: the eventual
delivery must identify the actual owner dispatch that pays, especially the paid delete port.

Any eventual additive migration must append to the SDK positional migration list without
rewriting old bodies/positions, retain existing indexes until replacement coverage is valid,
and separate `layout/hook_version`, restore domain, scan frontier and completed coverage.
Install native old-writer hooks before taking a backfill frontier. A sound bounded coverage
protocol must specify these operations, rather than a startup census:

```text
one transaction/page, bounded p original workflow IDs from the primary-key frontier:
    lock page source rows; reread their current state
    replace contributions by original workflow ID, idempotently (not additive replay)
    record exact page progress in the same COMMIT
mutations below/above frontier:
    maintain current contributions under the same source-row/gate serialization
    OR write one exact dirty identity for a bounded, paid repair step
repair:
    lock dirty identity + current source, replace contribution; acknowledge only that revision
coverage:
    publish only after scan complete AND serialized dirty frontier drained for this hook/layout/domain
```

This protocol bounds **input pages**, not derived fanout: a page of one blocker can still
require V ready memberships. No feasibility is claimed for that repair under the frozen
writer bound. Nor can incomplete coverage silently fall back to the old expanding selector
and claim bounded selection. The owner must specify a supported coverage transition/admission
state; fixture-only coverage switches and scanning all keys before first poll are forbidden.
Old migrated queued/delayed/terminal/null/unclaimed rows and mutations crossing the frontier
must remain represented. Source row locking prevents a stale backfill snapshot from replacing
a newer head. Dirty entries require bounded per-step repair, revision-aware acknowledgment,
and paid retries; endlessly deferring the exact shared veto is not completed coverage.

Copies of Session keys, IDs, versions, owners, posting chunks, counts, tree separators and
cursor/frontier/dirty records are all part of the copy inventory when they retain identity.
The future schema needs reverse original-ID ownership for per-workflow contributions and
precise shared-key references for aggregate nodes. Owner-authorized deletion must remove its
contributions and obsolete identity-bearing metadata in the original native transaction,
recomputing from still-owned data only. Shared nodes belonging to other executions cannot
be blindly cascaded away. A permanent payload-bearing scheduler tombstone is forbidden.
The existing eight-table absence probes do not prove absence of a ninth derived family;
extend inventory/probes and their original reservations, without granting new cleanup authority.
Reverse inventory enumeration itself must have a legitimate bounded/change-size derivation.

Restore must preserve current permanent fences and ALWAYS guards, advance the existing
native writer restore generation before readmitting restored work, and invalidate discovery
coverage/cursors from the old restore domain. Rebuild only from current allowed source rows
through bounded pages. A closed ID cannot return through COPY/deduplication or restoration of
an old index. Rolling back the whole database and discarding current closures remains
unsupported; no new discovery generation reconstructs lost fences or grants Source authority.

## Fair progress and retention stay in the contract

If an owner later authorizes an exact Ready design, fairness can use a stable insertion
ticket and durable per-domain `(epoch_end,after_ticket,key)` cursor, not lexicographic
rotation alone. At each lap capture a finite maximum ticket. New memberships receive later
tickets; they cannot continually insert ahead of a continuously present member in that lap.
Seek after the cursor through the finite epoch, then wrap/open the next lap with constant
indexed end probes. Merge component streams and suppress at most the four copies of a key.
Persist advancement with the native attempt, including a bounded skipped/busy attempt;
rollback does not advance it. Restart resumes the same lap/domain/restore generation.
A continuously eligible, eventually lock-available member cannot be overtaken forever by
arrivals. Permanent adversarial lock exclusion cannot promise a successful native claim;
the original busy-miss behavior remains. Lost claims do not cause unbounded refill in one
poll. This fairness mechanism solves neither intersection discovery nor veto fanout.

Retention remains in the same eventual complete implementation. Preserve creation-ordered
eligible outcomes, one original fixed now/cutoff for the whole sweep, own/unclaimed ownership,
SUCCESS/ERROR/CANCELLED/MAX_RECOVERY_ATTEMPTS_EXCEEDED, non-null completion, strict creation
AND completion cutoff and the configured 7–365 days/default30. Continue native
`deleteWorkflows(ids,false)` with actual children/copy costs and permanent writer fences.
The frozen creation/completion inversion is independent of shared queue gates; a completion
index or creation index alone does not solve it. No retention replacement is implemented
or proved here. Any continuation must be durable and commit-monotone across restart/version
changes, distinguish incomplete discovery from exhausted eligible work, and prevent the
existing `removed<1000` sweep exit from stranding later eligible rows. Queue decisions below
do not change its O(1+d) selection, O((1+d)log H) indexed work or O(d+c) deletion obligations.

## Frozen acceptance handoff — every execution UNRUN

This report contains acceptance **pseudocode**, not runnable tests or copied selector SQL.
Materializing missing native suites remains with the original complete producer after the
design dependency is resolved. Existing tests and the supplied immutable retention inversion
regression must remain unchanged. Source-only research does not execute the file-size
acceptance command, root checks or native/compiler commands.

Use the report's exact SystemDatabase constructor with the shared instrumented GrowthDatabase
pool, actual WorkflowQueue records from WORK_QUEUES, real checkoutPartitionKey and one free
slot. Use no DBOS launch, executor, free-running poller or provider callback. Seed outside
capture in batches at most 1000; fixed-width IDs/payloads and fresh claims/probes per capture.
Capture each selection occurrence plus native claim, and inclusive operation/maintenance totals.

```text
for scale in [256,1024,4096]:
  K = 16*scale
  independently grow:
    K ready Session keys; K busy keys with ENQUEUED follower + foreign PENDING owner
    one key with K incompatible-version rows, with/without one compatible head
    one key's compatible backlog; unrelated SUCCESS history
  for native effects partitioned and workflows nonpartitioned hot-history paths:
    repeat own/unclaimed/foreign app, latest(current OR null), nonlatest(exact)
    claim via actual findAndMarkStartable* (native, one available slot)
    assert exact hit/order or genuine empty; timeout is failure
    assert examined rows O(1+w), indexed work O((1+w)log H), fixed statements at fixed w
    include empty, all busy, incompatible miss, hit; no growing discarded prefix

independent grid: V in [256,1024,4096], N in [256,1024,4096], not V=N only:
  one fixed K has V compatible version memberships, all blocked by one original B
  grow N other keys independently, with interleaved domain/free-set membership
  measure ONLY one original native completion/cancel/recovery/claim of B
  count source row size fixed; include nested derived rows/points/bytes/index maintenance
  then poll each relevant nonlatest version; repeat shared-veto close and open
  separately vary application memberships; include foreign B and null/unclaimed buckets
  construct disjoint even/odd membership/free sets, then one late common-key hit
  repeat after restart and with changing incidence, not identical signatures only
```

Do not require that a busy row executes. Use `recordWorkflowOutput` with the actual native
owner token for the completion toggle, cancel/resume/recovery through original native APIs,
and both successful and lost-owner transitions. The claim itself must pay the shared close
toggle. Exact metadata-width controls distinguish bytes growing with V from larger inputs.

At the actual paid delete path, establish **genuine** original owner readiness/custody and
writer closure, then invoke `maintainSdkWorkflowOnce(...,'delete',deadline,reserve)` through
the existing Source callback. Assert every reservation precedes its instrumented pool I/O,
same Pool/frame/deadline, correct literal baseline plus all derived work, rollback charges,
later fresh reservation and all aggregate axes. No detached test ledger or fabricated ready
flag may certify deletion authority. Include a sole still-PENDING execution only if those
original owner conditions are genuinely attainable; otherwise keep it a native technical
deletion control and measure the paid dispatch on a legitimately ready execution separately.
Do not manufacture a product lifecycle permission to demonstrate the conditional counterexample.

Also preserve all original controls:

| Axis                       | Required original population/outcome                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retention inversion        | 49,152 rows **per axis** at 1/4/16: created400/completed1, created200/completed90; warmup1000 at created202; fresh probe1000 at created201. Keep original 4000 full-batch index-probe allowance and immutable regression.                                                                                              |
| Retention empty/short/full | d=0/10/1000; independent old/recent ineligible histories, later eligible backlog and shuffled completion order; creation ties without a new ordering authority. Measure selection independently and inclusive deletion O(d+c), all eight native families, descendants/unselected rows/fences preserved.                |
| Races and repeated polls   | Two workers, same Session, fixed candidate recheck, SKIP LOCKED/NOWAIT behavior, advisory contention/collisions, owner token loss, rollback/retry, cancel/recover/reuse/delay/restore. Lost claims and repeated all-busy misses remain bounded; no refill scan.                                                        |
| Fairness                   | Repeated actual native polls across arrivals/restart; continuously eligible keys progress while same-Session priority/creation order and mutual exclusion remain exact. No cross-Session global priority/randomness assertion.                                                                                         |
| Migration                  | Supported old migrated native fixture, null/unclaimed/queued/delayed/terminal rows, interruption/restart, concurrent mutation on both sides of frontier, dirty repair and incompatible hook/layout/domain refusal; no fixture-only trust flag. Repeat hit/miss and ownership bounds afterward.                         |
| Commerce and callers       | Mounted real Session refresh and generic Work/maintenance callers, distinct and repeated Sessions, deterministic IDs, replay/input compatibility, exactly-once native outcomes and ordinary authorization; scheduler costs separate from original domain/provider work. No provider call in scheduler-only acceptance. |
| Custody/accounting         | All added copies inventoried and erased with original owner authority/transaction; permanent closures and restore semantics; failed/rollback work paid, original delete dispatch and every aggregate axis, no renewed allowance.                                                                                       |

The future complete kernel acceptance command remains `bun run --cwd services/kernel check`
under its separately authorized supported placement. None of its original populations,
bounds, assertions or retention continuation semantics has been relaxed by this report.

## One actionable outcome and required owner choice

**Outcome: unavailable within the evaluated ordinary native index model.** Exact eager
domain readiness has a literal unbounded single-source mutation cost; shared-gate marginal
indexes, ordered summaries and honest intersection alternatives have the explicit growing
miss/traversal costs above. The broader polylogarithmic dynamic solution would cross the
stated conditional OMv boundary. This is enough to reject these repairs without claiming
an unconditional universal impossibility or launching another implementation.

The owners must explicitly select one of these boundaries before continuing the original
complete producer; none is selected or silently implemented here:

1. **Keep every frozen requirement.** Continue holding that producer; accept only a concrete
   stronger native structure with full writer/query/byte/inventory/reservation proof and a
   response to the reduction's assumptions. Another shared-bit-after-LIMIT proposal does not qualify.
2. **Authorize bounded incomplete queue discovery.** Keep exact membership/gate predicates
   and native claim authority, but explicitly allow a durable rotating intersection frontier
   to return an incomplete, paid step with no claim, distinct from proven empty. Specify
   progress under arrivals/restart and revise the original per-poll hit/miss acceptance openly.
   Work per step can be capped; total search may follow postings. This changes the current
   prohibition on growing-empty/deferred discovery and needs Work/Commerce acceptance. It
   does not resolve or relax the independent frozen retention inversion/short-batch contract.
3. **Authorize bounded incidence at native admission, or pay explicit incidence work.** A
   real enforced bound on exact application/version memberships per Session permits eager
   Ready maintenance; existing arbitrary-version data needs a migration/admission decision.
   Alternatively recognize D(K) as changed derived work and fund its atomic/resumable protocol
   at the original ports. The latter changes the fixed writer/architecture boundary and may
   require semantic staging of the native transition. Neither a finite allowance bump nor a
   version cap by itself can be smuggled into the present contract.

Recommendation: choose option 2 if preserving arbitrary coexisting native versions is the
product priority; it exposes the unavoidable work of the available maintainable design rather
than inventing membership limits or unfunded trigger work. If the frozen successful-poll
bound is nonnegotiable, retain option 1 until owners explicitly accept option 3 or supply the
stronger algorithm. This recommendation is an owner decision request, not an adopted contract.
The original complete delivery still owns retention, all writers, migration, custody and
original acceptance together. WorkClient remains independent and untouched.
