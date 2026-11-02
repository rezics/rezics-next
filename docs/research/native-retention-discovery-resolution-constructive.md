# Connected native retention and fair discovery: constructive resolution

Research date: 2026-11-02. Repository base: `4b9af586048ac3e5f53cd3016d6fec2a1fb5c940`.
This is source research, not an installed design, grant, implementation restart or native result.

## Recommendation and evidence boundary

**No complete positive design is established under both unchanged retention allowances.**
Retain the adopted global Session ticket/finite-epoch queue protocol. Do not select either
retention candidate. The most useful next architecture input is a lossless, ordered,
two-cutoff reporting primitive with a jointly priced mutation/removal implementation;
its empty certificate must be derived from transactional coverage of every old writer.
An extension could provide this primitive, but neither installed SQL nor the inspected
projects supplies its required numerical guarantee. This is a precise missing construction,
not a universal impossibility result.

One material correction to a tempting rejection of the prefix candidate: PostgreSQL does
**not** immediately remove all index entries on heap DELETE. Consequently, multiplying
64 indexes by 1,000 deletions is not an established 64,000-descent deletion cost. Inserts
and non-HOT indexed updates really do maintain the indexes. The candidate still lacks a
complete 40/4,000 proof, compatible key representation, complete prices and coverage.

The recommendation is evidence for comparison with the independent resolution report.
It adopts no architecture change. In particular, a separately funded incomplete retention
step is an explicit contract alternative below, not permission inherited from queue discovery.

### Sources actually governing this analysis

The three named owner documents were absent from this worktree's ignored `.temp` tree.
They were read at these exact, read-only main-checkout paths, with no main-checkout write:

- `.temp/goal/performance/autonomy/native-queue-discovery.md`;
- `.temp/goal/performance/decisions/native-discovery-owner-contract.md`;
- `.temp/goal/performance/decisions/native-scheduler-funded-design-receiving-20261101.md`.

Also read the current [Work README](../../services/kernel/src/work/README.md),
[SDK patch](../../patches/@dbos-inc%252Fdbos-sdk@5.5.3-preview.patch),
[retention adapter](../../services/kernel/src/work/retention.ts),
[maintenance declarations](../../services/kernel/src/work/sdk-retirement-fence.ts),
[Work client](../../services/kernel/src/work/client.ts), and the actual growth accounting
code. The linked governing specification was read at
`aa9428eb40e82bffeb05afefbd4060043c8bed12:docs/research/kernel-bounded-work-source-gaps.md`.
No workflow, architecture or scope document was loaded.

Both previous reports were read from Git objects, without merging:

| Report                                                       | Exact object and relevant construction                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Primary](native-scheduler-funded-design-primary.md)         | `af7b21363a024eee90122721e896c2f4662f0a0a`; creation-radix minima, global Session tickets, counted queue kernel and coverage protocol |
| [Independent](native-scheduler-funded-design-independent.md) | `cfba1553be32aeec7353adc2a1fe77ba72dc91a8`; 64 completion-prefix expression indexes and per-bucket progress                           |

Their common repository pin was `129bf1ff7be77f5ceec93f503d77ba870bcea9d6`.
The current patch additionally contains selected-step authority and `maintainWorkflowOnce`;
the latter is a real single-attempt seam, not general retention funding. It still uses
the narrow four-delete body and its conditional descendant declaration. Neither old report's
patch hash describes the current patch. No installed-dependency hash or applied migration
is inferred from a tracked patch.

Primary implementation references, reused read-only under the main checkout's `.reference/`:

| Local clone                                       | Commit, licence and primary links                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-scheduler-funded-design/dbos-transact-ts` | `627990fc59619d3584ce88511ab546bc7483f4b9`, MIT, `LICENSE`; [system_database.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/system_database.ts), [native migrations](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/sysdb_migrations/internal/migrations.ts), [wfqueue.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/wfqueue.ts)                                                                                                                                                      |
| `library-shelf-maintenance/postgres`              | `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, PostgreSQL License, `COPYRIGHT`; [nodeModifyTable.c](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeModifyTable.c), [execIndexing.c](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/execIndexing.c), [nbtree.h](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/include/access/nbtree.h), [spgtextproc.c](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/spgist/spgtextproc.c) |

The DBOS clone is the exact release-source pin used by the reports, not the older
`980dc550...` clone. PostgreSQL sources were accessed with `git show` where its sparse
checkout omitted files. No reference code was installed, built or executed. Only provenance
lines were added to the permitted `.reference/INDEX.md`; no new clone was needed.

## Exact preservation obligations

Retention fixes one invocation time `T`, days `D` and cutoff `C=T-D*86,400,000`.
It selects the creation-ordered first 1,000 rows satisfying **both** `created_at<C`
and non-null `completed_at<C`, one of SUCCESS, ERROR, CANCELLED,
MAX_RECOVERY_ATTEMPTS_EXCEEDED, and the native own-application-or-NULL predicate.
Keep default 30, inclusive configuration range 7–365, batches 1,000, at most 60 batches,
the ten-minute schedule, `deleteWorkflows(ids,false)` semantics and permanent fences.
The adapter's cutoff-minus-one millisecond implements the SDK's inclusive predicates.
Completion order is not a permissible substitute. A tie rule may totalize creation ties.

The current sweep exits on a numeric result below 1,000. A repaired sweep needs an internal
exhaustion distinction: lock loss, uncovered data or an unfinished frontier cannot become
a successful short page. A covered inversion fixture must still immediately return its
1,000 required rows. Continuation cannot silently replace that assertion. New eligibility
behind an old creation cursor must invalidate exhaustion or start a new lap at the same cutoff.

Queue outcomes remain committed claim, prepaid incomplete/no-claim, and authoritative empty.
Use exact native application/null and latest/nonlatest version predicates, all-application
mode where supported, shared cross-application/version PENDING veto, actual Session identity,
same-Session priority/creation order, original partition locks, fixed-ID SKIP LOCKED rechecks,
conditional owner-token claim, and permanent writer guards. Partitioned paths still exclude
NULL partition keys. Native nameless scope is not the named application's NULL branch.

The accepted fairness authority is a **global per-queue Session ticket**, preserved while
ENQUEUED membership remains, including moves between compatible app/version buckets.
Do not replace it with independent bucket tickets. A nonpartitioned queue's synthetic
Session retains its original priority/creation order and does not acquire the partition veto.

## What 40 and 4,000 actually measure

These are not SQL-statement ceilings, 40/4,000 rows, new Work balances, or a budget renewed
for each internal seek. [growth-retention.test.ts](../../services/kernel/test/work/growth-retention.test.ts)
declares `indexProbes:40` for a complete ten-result short batch and `indexProbes:4000` for
a complete 1,000-result batch. The frozen inversion design retains 4,000. Each measured
operation is `runWorkflowRetentionBatch`, including its native deletion, not selection alone.

[growth.ts](../../services/kernel/test/support/growth.ts), `GrowthCheck.indexProbes`, defines
index descents per measured run into growing relations. The linked Kernel README's growth
section explains the allowance for a one-level index depth change between consecutive
scales. In [growth-model.ts](../../services/kernel/test/support/growth-model.ts),
`classifySeries`/`staircaseFit`, an allowed family is fitted with a nonnegative staircase:

```text
block_cost(scale_i) = intercept + permitted_family(scale_i) + staircase_i
staircase_0 = 0
0 <= staircase_i - staircase_(i-1) <= indexProbes
```

The actual code uses calibrated intervals/envelopes, not exact equality to a noiseless
formula. Thus 4,001 observed blocks is not itself a failure; more than 4,000 possible
logical accesses is not itself a classifier failure either. Conversely, a count of 1,128
stream seeks does not prove that the complete operation fits. The count must justify the
growth-sensitive descents of **every** reached operation and nested hook in that run.

[growth-cost.ts](../../services/kernel/test/support/growth-cost.ts) counts scan rows plus
filter/recheck rejects times loops and shared hits/reads, separating inclusive/exclusive
plan accounting. One outer function call cannot conceal nested work. Engine multiversion
visibility is excluded by the controlling clarification; live residual traversal, explicit
summary repair, index inserts, payload conversion and application cleanup remain charged.

| Unit                | Correct scope                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Queue step          | One paid fixed transition; does not inherit retention's 4,000 or another step's balance                                              |
| Retention batch     | One complete selection/deletion attempt and reached controls/hooks; 40 for the named ten-result fixture, 4,000 for the full fixture  |
| Sweep               | At most 60 batches with fixed `T,C`; sum actual batch work under its finite original invocation/deadline, not 60 free replenishments |
| Installation/repair | Separately admitted finite pages; no startup census hidden before the measured selector                                              |
| Retry/failure       | Another charged attempt under the same applicable admission/deadline; rollback is reserved before BEGIN                              |

The frozen populations remain 49,152 rows **per axis** at scales 1,4,16, with older
ineligible creation history, later eligible history, warmup at creation age 202 days and
fresh probe at 201 days. Queue populations remain 16 units times 256,1024,4096 plus the
independent version/Session grid. Ten-result, empty, all terminal statuses, strict boundary,
app/null, races, short sweep, all writers, restore and mounted Commerce controls remain.

## Reconstructing the two candidates together with their writes

### Creation radix: correct pruning, insufficient literal certificate

The primary uses an application-tagged 64-bit creation trie. Each node stores the minimum
completion in its subtree; each exact creation leaf has a completion-ordered index.
Creation-first traversal prunes subtrees whose minimum is too new and merges own/null roots.
The width is the signed BIGINT width, with sign-bit inversion; no lossy Number conversion.

Its counted one-leaf repair is one leaf-minimum read, one leaf write, then 64 repetitions
of a two-child read and parent write: **194 rows, 194 point starts, 130 nested statements**.
Two changed paths cost 388/388/260 before controls/guards/inventory. Distinct leaves in a
1,000-row deletion can require 194,000 summary-row operations and 130,000 nested statements.
The published conservative traversal is 256,258 nodes plus up to 2,000 leaf rows over two roots.

All these are design-visible operations, even when executed inside PL/pgSQL. At fixed
64-bit width and result count they are independent of unrelated history. That establishes
neither a useful literal allowance nor a physical probe certificate: the published traversal
upper bound already exceeds 4,000, before repair/native work. An upper bound exceeding the
allowance is **not a lower bound proving every execution fails**. The report supplies no
tighter joint implementation/certificate; counting selection alone cannot repair that gap.

### Completion prefixes: exact selection, conditional domain and short-batch problem

The independent candidate stores one terminal/non-null-completion projection and 64
expression B-tree indexes. At depth `j=1..64`, its key is
`(application, completion_prefix_j, created_at, workflow_id)`. Decompose unsigned strict
completion interval `[0,u(C))` into disjoint binary prefixes. At most 64 prefixes times
two app branches produce `R<=128` ordered creation streams. Merge initial heads and refill
only the winning stream. With the final unnecessary refill included, `H=R+d<=128+d` seeks
and head rows suffice, without scanning the ineligible creation prefix.

This is a real constructive selection argument. It is not a complete batch argument:

| Candidate operation              | Literal local work; all other work additional                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Select `d=1000`                  | At most 1,128 ordered head seeks/rows; at most 128 live merge heads, 1,000 selected records                           |
| Select `d=10`                    | At most 138 head seeks/rows using the same algorithm                                                                  |
| Select `d=0`                     | At most 128 head seeks, including paid empty seeks; no deletion                                                       |
| Insert a terminal projection     | One heap row, PK index insertion and 64 expression-index insertions; 65 index entry insertions, not 65 SQL statements |
| Change indexed projection fields | New heap version and up to the same 65 new index entries; old/new contribution logic and native guards additional     |
| Delete a projection by PK        | One indexed heap deletion and DELETE hooks; **not** 64 immediate B-tree deletion descents                             |
| Build on `N` old terminal rows   | At least `N` projection heap insertions and `65N` index entry insertions, paged with committed progress               |

The DELETE distinction is established by PostgreSQL `nodeModifyTable.c:1838–1848`:
ordinary index-tuple removal is deferred because older snapshots can still need entries.
`ExecInsertIndexTuples` in `execIndexing.c` does maintain indexes on insertion and relevant
updates. Do not relabel the 64 explicit index copies free, or add nonexistent DELETE
descents. Deferred engine visibility cleanup and deliberate SQL summary repair are different.

The following is an explicit, conservative **candidate composition**, not an installed price:
assume short fixed-width keys, indexed scalar native recheck per selected ID, one projection
PK deletion per selected ID, and native status deletion per selected ID. Count only the
growing status/projection relations of the status-only inversion fixture; `K` is all other
growing-relation descents, including coverage/inventory/alias/fence work actually reached.

```text
P_prefix_separate(d,R) <= R + d + d(recheck) + d(projection delete) + d(status delete) + K
                      = R + 4d + K
P_prefix_separate(1000,128) <= 4,128 + K; this certificate does not establish <=4,000.

If a NEW actual body fuses native recheck with status delete, reusing its acquired tuple:
P_prefix_fused(1000,128) <= 3,128 + K <= 4,000 only if K <= 872.
P_prefix_fused(10,128)   <=   158 + K; this does not establish the short-fixture 40.
```

Array-key B-tree positioning can reuse search state; a physical capture may cost less than
this independent-descent upper bound. A tuple/TID reuse design can also remove a separate
lookup. Neither optimization is present in the proposed connected body with a priced
proof. These inequalities reject admission on the supplied certificate, not every prefix
implementation. The short-fixture data may populate fewer streams; that does not prove a
uniform full-domain bound. Neither 138>40 nor 4,128>4,000 alone is a measured failure.

A legal adversarial prefix input has `C=-1ms`, obtained with `now=D*day-1ms`, and signed
BIGINT completions spread across the 63 disjoint prefixes below that cutoff, in each app
branch. Put only ten creation-eligible results in the union and grow unrelated terminal
rows in the indexed domains. Initializing all 126 streams is then real visible work,
independent of the ten returned IDs. A small-positive-date or one-populated-prefix shortcut
does not cover this input. A summary that avoids these starts needs its own update/delete
algorithm; importing creation-radix minima merely restores the first candidate's repair cost.

### Full-domain failure is concrete, not a licence to shrink inputs

On an ordinary 8-KiB PostgreSQL build, the B-tree item limit is approximately a third of a
page, defined by `BTMaxItemSize` in `nbtree.h:155–174` and enforced by `nbtinsert.c`.
A terminal workflow with an incompressible roughly 1,500-byte ID and 1,500-byte application
name can fit the original separate ID PK and terminal indexes; the new combined
application/prefix/creation/ID item can exceed that limit. No active-queue index is needed
for that terminal row. Short UUID fixture IDs cannot establish compatibility for it.

Replacing ID/application/version/Session strings with small aliases would fix composite
width only after supplying **exact** alias lookup, uniqueness, lifecycle, rollover,
collision resolution, restore and atomic removal. A digest without collision verification
is not equality. A monotonically allocated int8 without rollover/reuse proof adds a lifetime
limit. A numeric alias remains an identifying copy. An auxiliary prefix-row table instead
of expression indexes creates 64 explicit heap copies and changes its deletion price.

PostgreSQL's [SP-GiST text implementation](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/spgist/spgtextproc.c)
supports long values by suffixing (`longValuesOK=true`); this is useful evidence for lossless
key routing. It does not supply this multi-attribute queue/retention structure or a constant
cost independent of key bytes. Native field ceilings are conditional engine limits, not an
approved 1-KiB cap or a Work byte allocation. Charge actual key chunks and comparisons.

## The connected schema and algorithms a positive answer would have to realize

The following schema is a concrete interface decomposition, **not executable delivered DDL**.
`Key` denotes a lossless owner-bound handle whose implementation/price remains missing.
It cannot be implemented by silently substituting bounded text, collision-assumed hashes
or an overflowing lifetime sequence. Payload stays in native tables.

```text
domain(singleton PK, restore, layout, hook, coverage_generation, state,
       base_upper_key, after_key, dirty_generation)
key_binding(kind, segment, local, exact_value, references; PK(kind,segment,local))
queue(q:Key PK, revision_generation, revision, first_segment, tail_segment, tail_ticket)
segment(q:Key, segment, next; PK(q,segment))
member(q:Key, s:Key, count, segment, ticket; PK(q,s), UNIQUE(q,segment,ticket))
item(w:Key PK, q:Key, s:Key, a:Key, v:Key, priority:int4, created:int8, revision)
  HEAD INDEX(q,s,a,v,priority,created,w)
  ALL_APPLICATION_HEAD INDEX(q,s,v,priority,created,w)
pending(w:Key PK, q:Key, s:Key); VETO INDEX(q,s,w) -- no a/v filter
contribution(w:Key PK, incorporated_revision, q,s,a,v,state,created,completed)
retention(w:Key PK, a:Key, created:int8, completed:int8, revision)
  ORDERED_TWO_CUTOFF_ACCESS(a, created<C, completed<C, creation_order, limit)
frontier(domain_key PK, restore,layout,hook,coverage_generation, q,a,v,
         epoch, segment,after_ticket,end_segment,end_ticket,
         start_queue_revision,start_version_revision,authoritative)
dirty(w:Key PK, generation, original_owner)
sweep(sweep_id PK, original_T,C,D,batches,coverage_generation,revision,exhausted)
```

The missing retention access method is exactly the ordered two-cutoff operation shown;
a normal composite B-tree does not implement it with the required certificate. The missing
key resolver must have a reverse owner inventory. Counts and revision counters need checked
overflow/segment generation handling; no silent wrap, reference-count overflow or name cap.
Do not add cascading FKs to large owner inventories without charging their checks/deletes.

### Queue operation and fairness argument retained from adoption

1. Admit one finite Work capability bound to exact configured Pool, invocation and immutable
   deadline, before due-queue/registry work. Prepay controls and rollback. Choose one indexed
   due queue/control opportunity; do not enumerate keys, versions or registered queues first.
2. Under the queue allocator lock, allocate new membership tickets and link finite segments.
   Hold through the native writer's COMMIT. Epoch start takes the same lock and captures its
   finite end segment/ticket. A PostgreSQL sequence high-water is not commit order.
3. Lock one domain frontier; visit one directory entry before the captured end. Probe exact
   latest-version own/null rows, up to four compatible heads, and the global PENDING gate.
   Incompatible/busy entries consume this paid visit; they do not initiate another scan.
4. Try the actual Session advisory lock, lock only the chosen native ID with SKIP LOCKED,
   recheck native version/head/gate/owner predicates under the covered writer serialization,
   and conditionally assign the original native owner token. Update contributions and frontier
   in that **same native transaction**. Head change, losing claim or lock loss is incomplete.
5. Segment movement and epoch closing are separately priced transitions. Empty seals under
   queue/version serialization only if full coverage is current, the captured domain was
   checked, there was no unresolved skip/claim loss, no relevant revision changed and no
   unseen post-tail membership exists. Otherwise return incomplete and keep ordinary due work.

Fix a repeatedly serviced compatible domain and a continuously eligible Session. Its global
ticket remains present across compatible bucket switches. Each captured tail has finitely
many predecessors; arrivals append outside that epoch. Committed visits advance monotonically
and survive restart. Thus the Session receives recurring native claim opportunities after
finitely many committed visits, without any all-key/version fanout. Epoch invalidation for
empty sealing must not reset ordinary fair progress on each unrelated mutation.

This opportunity proof requires fair service of paid frontier/control/native lock attempts
and eventual lock availability to those attempts. Arbitrary instantaneous unlocks entirely
between every scheduled attempt cannot imply a successful claim for any polling design.
Permanent lock exclusion is not the promised outcome. Restore/layout repair needs fair
admission too; repeatedly restarting a complete rebuild on unrelated ordinary writes would
invalidate the argument. No wall-clock latency bound is inferred.

An old writer can lock native status before entering a new row trigger. A selector must not
hold metadata and wait indefinitely for that status: use fixed-ID SKIP LOCKED/NOWAIT and the
original finite deadlines. Metadata control locks must serialize all relevant committed head,
PENDING and version changes. A trigger on only new TypeScript enqueue cannot supply this.
All ordinary native limits/rate/concurrency branches, delayed activation, recovery and due
control need fixed paid bodies too; the adopted partition protocol is not their price.

### Retention operation required without changing its contract

Admit a complete batch branch, establish current coverage, compute exact `C`, obtain the
creation-ordered eligible prefix from the missing access method, and recheck fixed native
IDs inside the actual deletion owner's transaction. Selection locking on a different
connection does not guard native deletion. Remove native and derived copies together and
persist sweep progress on COMMIT; abort publishes neither progress nor absence. Preserve
descendants=false and all permanent closures. Owner-required retirement/readiness remains
owner authority, not a consequence of Work money or terminal status.

For fewer than 1,000 successful deletions, require a fresh covered exhaustion observation
at the original cutoff with matching revision, no skipped candidate and no unresolved
frontier. Changed eligibility behind the cursor forces a revisit, not permanent exclusion.
At 60 batches persist remaining work for ordinary future admission. Finite failure can be
unavailable; it cannot be a successful short-page answer to the frozen hit fixture.

## Complete hook and coverage obligations

The following is the necessary conditional proof, including installation. It is not a claim
that the current patch installs these hooks. The actual SDK patch supplies permanent fence
guards on eight native families; it supplies no discovery coverage receipt for new tables.

| Native writer surface                                              | Required transactional contribution and boundedness                                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary, child, caller-transaction, SQL and bulk enqueue          | Reconcile current incorporated state, exact keys, monotone Session creation seed and membership; a 500-row SQL chunk is not a bounded whole enqueue |
| Status/priority/application/version/queue/Session changes          | Apply old/new delta once, retain ticket for same Session, touch at most two queue controls, update exact heads/PENDING/retention                    |
| Claim, completion, fallback error, cancellation, timeout, recovery | Preserve native owner/token guards; ENQUEUED/PENDING/terminal changes publish atomically with projections                                           |
| Delay/debounce/activation, suspension/resume, rewind/fork          | Maintain only actual native transitions; page due activation; charge copied/deleted native descendants and parent/child fences                      |
| Input/output/operation/event/history/notification/stream           | Preserve native guards and original owner copy inventory; unchanged queue eligibility does not exempt payload bytes or owner work                   |
| Version registry and application rename                            | Version generation under shared serialization; no V-domain fanout; original bulk rename/activation cannot become a fixed-row step by relabelling    |
| DELETE, COPY/restore, layout replacement, TRUNCATE where admitted  | Atomic contribution removal or explicit invalidation; ALWAYS guards; no bypass can publish authoritative coverage                                   |

Let `M(w)` be the contribution incorporated for a native row. After a successful writer,
`M(w)` equals its current native eligibility scalar state at that COMMIT, or both are absent.
Reconciliation subtracts only incorporated contributions; an old unbackfilled row has no
count to decrement. An aborted writer changes neither side. Counters cannot be repaired by
an unbounded recount on mismatch; refuse or enqueue one generation-bound repair identity.

Installation must realize this sequence:

1. Append an SDK migration; create new **empty** projections and indexes. Do not edit old
   positional migrations. Index creation on a populated native table is a population build,
   even with CONCURRENTLY; it is not bounded startup work.
2. In a finite admitted DDL/barrier attempt, serialize hook installation against old native
   writers on every relevant relation, including SQL enqueue, COPY and all payload writers.
   A writer that could have committed unhooked must finish before the installation cut, or
   be captured by reconciliation. Timeout aborts installation; no hook-name flag proves a cut.
3. Capture a finite base upper key under that installed barrier. Page the existing native PK
   one fixed row per paid step, lock/re-read its **current** state, reconcile `M(w)`, and commit
   effect plus frontier together. New writes behind the cursor are already hooked. No OFFSET.
4. A row lock failure leaves progress incomplete; it must not skip without durable repair.
   A repair ticket is acknowledged only if its generation is still current. Dirtying during
   processing survives acknowledgment; abort and ambiguous commit retain no reusable money.
5. Publish complete coverage only while installed hook/layout/restore generations still match,
   the finite base is exhausted and no old unincorporated or dirty obligation remains. Use
   maintained transactional controls for this seal, not an unbounded final anti-join/COUNT.
6. Restore preserves permanent fences and their guards, advances the existing native restore
   domain, invalidates discovery coverage, and repeats paged reconciliation before absence.
   A restore discarding current permanent closures is unsupported, not repairable by an epoch.

Conditional induction: the barrier partitions old unhooked writes from hooked writes; base
reconciliation covers every surviving pre-cut row; every later write maintains `M`; current
dirty acknowledgment cannot lose an intervening change; publication is serialized with
those transitions. Therefore completed coverage can support absence. Omit any premise and
the proof fails. For example, an old enqueue commits a key smaller than the already advanced
frontier after the unhooked scan; an empty directory is then false although every page was
committed. A never-finished frontier similarly proves only a prefix, not absence.

PostgreSQL's [CREATE INDEX documentation](https://www.postgresql.org/docs/current/sql-createindex.html)
describes additional scans/waits and possible invalid indexes during concurrent builds.
This supports the empty-table-plus-paid-backfill approach; CONCURRENTLY is not a resumable
application coverage protocol. Failed/invalid DDL cleanup and its locks/catalog work need
operational admission; unsuccessful installation must not leave `coverage=complete`.

## Copy, snapshot, abort and erasure inventory

| Retained object                                                | Copies/ownership and removal rule                                                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native eight families                                          | Status, input, output, operations, events, event history, destination notifications, streams; original fixed-ID deletion and four FK families, actual descendants priced                   |
| Permanent fences/domain                                        | Actual ID, closure receipt and restore control survive deletion; expressly permanent, never cascade, rotate away or pretend erased                                                         |
| Current selected-step rows                                     | Current patch also retains original ID, registered name/queue/creator/serialization/input and attempt/admission state; not covered by the older eight-family absence helper                |
| Key bindings/chunks/collision records/reverse inventory        | Exact identity/owner copies even with numeric handles; refcount changes and final removal in authorized native transaction, retaining shared contributions of others                       |
| Contribution, head and pending projections                     | One row per relevant workflow plus every declared secondary index; remove in original native removal transaction                                                                           |
| Member and segment/ticket linkage                              | Session association remains while any ENQUEUED contribution remains; same-Session updates retain ticket; remove final identifying association atomically                                   |
| Retention projection and summaries                             | One heap projection plus 64 index copies for the prefix candidate, or all summary nodes for radix; remove/recompute with native removal, not after-commit janitor                          |
| Dirty tickets and base frontier/upper key                      | Original workflow/key/owner references are retained copies; conditional acknowledgment/removal and covered progress must join owner inventory                                              |
| Queue frontier, domain/app/version aliases, sweep              | Domain locators are identifying while they resolve to an owner; scalar ticket/cutoff without such a binding need not copy payload, but cannot be declared anonymous merely because numeric |
| Cached heads, merge records, selected IDs, payload conversions | Invocation-local retained/materialized bytes; no durable serialized head pages without explicit new inventory; release/revoke on exit, count abort paths                                   |

All indexes are copies too; the table lists each index family rather than treating a covering
index as storage-free. No new payload copy is necessary for discovery. Existing selected-step
input copies and the fence trigger's `to_jsonb(NEW/OLD)` materialization still count where
their actual paths are reached. A new direct scalar guard could avoid conversion but is a
different SDK body, requiring derivation and integration; this report does not implement it.

Uncommitted changes are invisible to other transactions and roll back together. Old snapshots
can still observe pre-delete native/projection/index versions; they cannot supply current
absence or reopen a permanently closed writer. Current checks must use the supported native
locks and original owner receiving/restore authority; stale repeatable-read locking can fail
serialization. Logical current-copy removal on COMMIT does not assert immediate disk wiping
of all old MVCC versions. Excluded engine visibility work does not exempt explicit alias,
payload, dirty-ticket or frontier copies from current transactional inventory/removal.

`hasRetainedWorkCopies` currently checks eight tables. It does not establish absence of new
discovery objects or the newly retained selected-step family. The Work README expressly leaves
selected cleanup authority/physical acknowledgment unfinished. Extend original owner inventory,
guards and same-transaction removal before claiming all-copy absence. Shared Session/alias
metadata cannot be erased by deleting another owner's contribution, and permanent writer
identities remain the explicit exception. Funding alone cannot mint these owner callables.

## Inclusive cost ledger and the actual admission inequality

Native vectors are `(rows,points,statements,bytes,engineRequests)` as exported by
[identity-epoch-contract.ts](../../services/kernel/src/semantic/identity-epoch-contract.ts).
Points include unsuccessful seeks; rows include design-visible reads/writes; statements include
nested SQL, constraints/triggers and controls, including failure/rollback. Native budget points,
physical index descents into growing relations, and index entry copies are separate quantities.
PostgreSQL-only local bodies have zero search-engine requests; unknown foreign bodies do not.
Source's separate Library eight-axis ledger is never converted into these five axes.

Established current **conditional declarations**, not autonomous scheduler allocations:

| Body                                         | rows / points / statements / bytes / engineRequests | Scope                                                                                     |
| -------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Current writer transaction fence             | 4 / 2 / 4 / 8,192 / 0                               | Outer SELECT, domain lock, exact fence lock, native return; genuine same Pool/transaction |
| Maintenance BEGIN                            | 0 / 0 / 1 / 0 / 0                                   | One dispatch                                                                              |
| Maintenance settings                         | 1 / 0 / 1 / 128 / 0                                 | Original finite deadline, 200ms lock timeout                                              |
| Maintenance ROLLBACK                         | 0 / 0 / 1 / 0 / 0                                   | Reserved before checkout/BEGIN; charged on failure                                        |
| Maintenance COMMIT                           | 0 / 0 / 1 / 0 / 0                                   | Ambiguous outcome is not a reusable reservation                                           |
| Native retirement dispatch                   | 8 / 5 / 9 / 32,768 / 0                              | Includes owner-token UPDATE and its fence row guard; no authority inferred                |
| Complete single-attempt retirement           | 13 / 7 / 17 / 41,088 / 0                            | Controls + current fence + retirement                                                     |
| Narrow delete dispatches                     | (1/1/1)+(1/1/1)+(64/1/1)+(73/5/5), bytes 0          | Input, output, operations, status plus four FK statements                                 |
| Complete narrow single-attempt delete        | 144 / 10 / 16 / 8,320 / 0                           | Requires certified 64 operations, 8 events, 64 history, zero notifications/streams        |
| Existing eight-family inspection declaration | 148 / 8 / 12 / 11,888 / 0                           | Owner-received conditional operand; not an inventory for added tables                     |

The narrow status operand is status 1 + events 8 + history 64; its five statement/point
slots include all four native FK cascades, including empty probes. No DELETE invokes the
existing INSERT/UPDATE fence trigger. A new DELETE hook would add its whole actual body.
The controls add once per owning transaction, not once per nested function. Failed work
retains charges. Repeated attempts consume the same finite balance/deadline and must be
able to refuse outside `dbRetry`'s retry policy.

General retention has actual child cardinalities `c_input,c_output,c_op,c_event,c_history,
c_notification,c_stream` and actual serialized/materialized bytes `B_native`. Native deletion
changes `d + sum(c_*)` rows; its four outer DELETE statements and all reached FK trigger
dispatches/probes remain additional accounting. The original code performs no descendant
workflow traversal when children=false. A single legal 65th operation defeats the narrow
64-operation operand. This is not a conflict with the contract: general deletion is allowed
to cost its actual descendants; it needs genuine certified operands before finite admission.

For the adopted queue, the previous primary's explicitly counted kernel remains useful:

| Metadata body                                                            | rows / starts / statements | Excluded remainder, never zero                                                         |
| ------------------------------------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------- |
| Named/latest one-candidate claim kernel                                  | 23 / 21 / 26               | Writer guard, projection delta, owner/version serialization, aliases, inventory, bytes |
| Same-queue E→P projection plus explicit final head/veto recheck included | 37 / 40 / 42               | Same remaining guards/authority/bytes; not a complete native vector                    |
| Epoch start                                                              | 7 / 6 / 10                 | Exact key resolution, overflow branch, owner/coverage guards and bytes                 |
| Segment move or empty seal                                               | 8 / 7 / 11                 | Actual proof locks/currentness/cleanup and bytes                                       |
| No-head/PENDING-veto visit                                               | 13 / 12 / 16               | Same missing bodies, actual rollback/conflict paths                                    |

These are named pseudocode compositions, not grants or installed full prices. For example,
both two-version probes and four-head probes run initially and again on final recheck;
putting them inside a conditional UPDATE cannot count them a third time for free. No
numeric price is established for the all-application/rate/global-capacity branches.

Complete lifecycle disposition, including every unpriced boundary:

| Operation             | Index/metadata work established                                                                                                           | Body/bytes/requests still unavailable for a full quote                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact key lookup      | Existing native PK supports current fixed-ID reads; proposed long-key routing must charge chunks/collisions                               | Alias resolver, allocator rollover, inverse owner association, all guards and materialized bytes                                                          |
| Retention selection   | Radix 256,258 nodes + 2,000 leaf rows; prefix at most 128+d seeks; each exact nested query charged                                        | Compatible keys, actual ordered-access body, native recheck/serialization, merge/control bytes                                                            |
| Writer maintenance    | Radix 194/194/130 per path; prefix 65 index insertions per new projection, one heap row                                                   | All old/new queue contribution branches, native fence/payload conversions, constraints, owner inventories, byte widths and index split work               |
| Installation/backfill | Prefix has 1 table + 64 secondary indexes + PK at minimum; `N` successful contributions cost at least `N` heap and `65N` index insertions | DDL/barrier/timeout cleanup, complete source/alias/copy hooks, frontier locks/bytes, publication; no population work hidden in launch                     |
| Repair/restore        | One fixed current row plus its reconciliation and one conditional acknowledgment/frontier update per page; total follows restored rows    | Restore owner admission, closure preservation, exact rollback/DDL failure/retry branches, alias/layout cleanup                                            |
| Authoritative empty   | Queue close kernel above; retention must inspect all exact covered streams/access path and current seal                                   | Complete hook/layout/version/restore proof locks, no unresolved skip or dirty obligation, no guessed zero-byte controls                                   |
| Deletion and cleanup  | Four native DELETE statements, actual children, projection/alias/member/dirty removal and summary repair if used                          | Full owner authority/inventory, certified cardinalities/bytes, selected-step removal where authorized, every nested constraint/trigger and failed cleanup |

For the independent expression indexes the logical key-content copy lower bound per terminal
row is `64*(UTF8(application)+UTF8(id)+8) + 288` bytes: creation contributes 8 per index,
and `sum(ceil(j/8),j=1..64)=288` prefix bytes. Add null tags, datum/bit headers, alignment,
heap TIDs/pages, the PK and projection row; this is not an on-disk upper bound. It exhibits
real repeated key bytes, not repeated payload. Query transport/merge records add actual
ID bytes per emitted head. With long-key aliases the formula changes and every alias copy
and resolution byte must be charged instead. The existing guard can additionally materialize
whole NEW/OLD rows through `to_jsonb`; scalar-return bytes do not bound that body.

Let `P_g` be the complete justified independent-descents allowance for growing relations,
`B_i` the observed block cost, and `V_path` the native five-axis sum for a complete finite
path. A supported positive answer must establish all of the following, not just Big-O:

```text
P_g(full batch) = P_select + P_fixed_native + P_native_delete + P_derived_remove
               + P_fences + P_inventory + P_coverage_controls + P_failure <= 4,000
P_g(ten-result named short fixture) <= 40
B_i fits the unchanged permitted logarithmic family plus its bounded staircase.
Rows and statements stay constant at fixed selected/changed rows, widths and configuration.
V_admit >= componentwise max over supported complete paths(sum V_reached_edges).
```

Only growing-relation descents belong in `P_g`: an empty ungrown input table still costs
a native point/statement, but does not gain index levels in the status-only fixture. Shared
root reuse needs an actual body proof. Native children and foreign owner costs stay separate
operands, then join the inclusive invocation. An unknown operand makes the complete price
**unavailable**, not zero, infinite by theorem, or permission to invent headroom.

Uniform scaling holds for the prefix selector's candidate count at fixed 64-bit width and
input widths because every stream has exact app/prefix equality before the creation range;
growth adds no visible residual candidates. It does not remove 65-entry insertion work,
prove short-batch descent constants or repair full-domain tuple overflow. Ordinary
creation-first B-tree traversal rejects `49,152*scale` old/recent-completion rows, and a
completion-first plan consumes a growing eligible backlog to sort creation. Both have
visible history work independent of returned count. Changing plans or warming one prefix
does not establish a uniform bound. GiST/SP-GiST access alone also supplies no literal
ordered BIGINT two-cutoff reporting guarantee; a bounding box/minimum can be a false lead
without a qualifying row. Exact integer ordering cannot be replaced by lossy float distance.

## Smallest explicit alternatives and deployment distinction

| Alternative                                                   | Exact change and unresolved obligation                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preserve contract; add a specialized PostgreSQL access method | Supply lossless integer ordered two-cutoff top-k reporting, compatible exact key handles, atomic update/remove, and a page/split/rebalance certificate for the **whole** 40/4,000 batch. Ordered reporting, not just unordered three-sided reporting, is required. No engine mechanism may conceal charged design-visible summaries. |
| Explicit retention amendment to bounded incomplete progress   | Permit paid partial selection/maturation/repair with durable fixed-cutoff progress, separate incomplete/empty outcomes and revised full-batch fixture/sweep assertions. Define creation-order stability under intervening mutations. This changes retention's current successful-batch promise and needs owner adoption.             |
| Explicit allowance amendment for a SQL construction           | Keep creation/completion/order semantics, deliver exact long-key and coverage bodies, then adopt derived complete per-batch/short-batch allowances. Neither 1,128 nor 64-index write count is that complete price. No increase is adopted here.                                                                                      |

Relaxing creation ordering to completion ordering or imposing new text/version/child caps
would change additional retained semantics; neither is a smaller compatible implementation
nor a recommendation here. A pre-matured eligible cache alone is not an alternative: when
the cutoff advances across an arbitrarily large eligibility frontier, its unpaid maturation
must either run before the promised batch or leave coverage unfinished. A missing hook or
unfinished maturation frontier cannot certify empty. Queue permission does not resolve it.

PostgreSQL [index access-method interfaces](https://www.postgresql.org/docs/current/indexam.html)
and [SP-GiST extensibility](https://www.postgresql.org/docs/current/spgist.html) allow custom
implementations, but an interface is not the missing algorithm or its bound. An extension
requires compatible server binaries/ABI, server installation permission on the actual host,
WAL/crash recovery, replica/backup/restore support, operator-class/planner integration,
instrumentable nested/index work and operational upgrade/rollback. Those are deployment
requirements. The repository's supported same-PostgreSQL-Pool `core`/`dbos` placement and
SDK migration mechanism establish none of those server-extension permissions. Sharded SDK
homes or a cross-home bridge are not installed capabilities of the current guarded port.

The inspected implementations share useful patterns: DBOS's real native transaction and
owner-token conditional claims, PostgreSQL's transactional indexes and snapshot-aware
deletion, and explicit separation between logical progress and current visibility. They
also show why per-call row limits and SQL wrappers cannot stand in for coverage or physical
prices. Reuse those patterns in TypeScript/pg/the SDK patch, not source files or long passages.
The official [multicolumn-index documentation](https://www.postgresql.org/docs/current/indexes-multicolumn.html)
explains why later inequalities can leave index traversal; [SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)
does not provide an authoritative empty snapshot. Neither changes the counterexamples.

The finite autonomous Work payer remains agreed. Original Source-called maintenance keeps
its actual original Source frame, Pool, deadline, callbacks and full native/Library aggregate;
it cannot fall back to Work. Full owner removal/authority and successful Library/native
descendant prices remain required inputs, rather than grounds to reopen that agreement.
No grant, foreign mutation authority, production structure or original-task restart follows
from this research. The manager can adopt the missing-primitive requirement or one explicit
contract alternative only after comparing the independent report.

## Delivery and verification boundary

Delivered only this report and permitted ignored reference-index provenance additions.
No implementation, frozen acceptance, package, installed dependency or owner document changed.
No branch was merged or cherry-picked. No workspace's typed sources changed, so workspace
typing is inapplicable. Original report acceptance, native/browser/growth campaigns, SDK
installation and full owner lifecycle verification remain deferred under the launch policy.
The counterexamples and tables are source derivations, not executed native measurements.
