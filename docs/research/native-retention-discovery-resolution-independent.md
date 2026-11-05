# Bounded retention and fair discovery: independent resolution

Research date: 2026-11-02. Repository base: `4b9af586048ac3e5f53cd3016d6fec2a1fb5c940`.

## Recommendation

**No supported positive connected design is established.** Keep the adopted global
Session-ticket queue protocol, but do not select either retention candidate or
admit the connected implementation on its metadata counts. The specific missing
primitive is a full-domain, creation-ordered, two-predicate reporting access path
with a proved inclusive maintenance/removal cost and the unchanged batch-level
40/4,000 allowance. Its coverage, exact-key representation and owner-authorized
copy removal must be part of that primitive's contract. An ordered range query,
a minimum summary, or a funding token alone does not supply it.

This is a negative result about the constructions and installed capabilities
examined here, not a universal impossibility theorem. In particular, the current
growth classifier is not a literal counter of every index probe. Neither a large
logical upper bound nor a favorable classifier result proves the complete claim.
The exact distinction and the missing inequality are derived below.

The manager can adopt this recommendation without reopening the finite autonomous
Work payer agreement. Work funding remains separate from exact original Source
frames, mutation authority and unknown foreign prices. This report adopts no
product change, starts no implementation, and authorizes no native experiment.

## Evidence and verified premises

The supplied autonomy brief and both owner decisions were read at their exact
paths under the main checkout's `.temp/goal/performance/`. They are absent from
this worktree. The main checkout was read only, except its expressly permitted
`.reference/INDEX.md`. No workflow, development, architecture or scope document
was opened. The other new resolution report was not read.

| Source                                                                                                                           | Verified use                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `autonomy/native-queue-discovery.md`                                                                                             | One connected repair; research precedes selection; stopped implementation is not restarted.                                                      |
| `decisions/native-discovery-owner-contract.md`                                                                                   | Queue-only incomplete amendment; unchanged retention and native predicates; complete writer/coverage/copy obligations.                           |
| `decisions/native-scheduler-funded-design-receiving-20261101.md`                                                                 | Global per-queue tickets adopted prospectively; neither retention candidate selected; owner prices remain conditional.                           |
| `af7b21363a024eee90122721e896c2f4662f0a0a:docs/research/native-scheduler-funded-design-primary.md`                               | Actual creation-radix schema, traversal, maintenance and queue protocol, not its recommendation alone.                                           |
| `cfba1553be32aeec7353adc2a1fe77ba72dc91a8:docs/research/native-scheduler-funded-design-independent.md`                           | Actual 64-expression-index completion-prefix construction and its unpriced remainder. Its bucket tickets are not the adopted fairness authority. |
| `aa9428eb40e82bffeb05afefbd4060043c8bed12:docs/research/kernel-bounded-work-source-gaps.md`                                      | Frozen inversion fixture, native call paths, populations and preservation matrix.                                                                |
| Current `services/kernel/src/work/{README.md,retention.ts}` and SDK patch                                                        | Actual adapter, schedule, sweep and permanent fences. The README and patch have changed since the old reports' common source pin.                |
| Current `services/kernel/test/{work/growth-retention.test.ts,support/growth.ts,support/growth-model.ts,support/growth-bound.ts}` | Actual 40/4,000 unit, measured-run scope and classifier behavior. No harness change is proposed.                                                 |

The current retention adapter exports batches of 1,000, at most 60 batches per
sweep, the ten-minute schedule, default 30 days and integer limits 7–365. It fixes
one `now` for the sweep. Both predicates are strict against the same cutoff
`C = now - days*86,400,000`; the SDK receives `C-1ms` because its filters are
inclusive. It selects creation-ascending terminal rows for `rezics-kernel` or NULL,
without input/output joins, then calls `deleteWorkflows(ids,false)`. All four
statuses remain: SUCCESS, ERROR, CANCELLED, MAX_RECOVERY_ATTEMPTS_EXCEEDED.

The current patch supplies permanent writer fences, restore-domain checks,
single-attempt selected maintenance, and selected-step execution authority. It
does **not** supply the proposed retention index, global discovery directory,
coverage publication or a complete autonomous scheduler issuer. Declarations and
the installed dependency are not evidence of deployment installation.

### Primary implementation sources

Reference paths below are relative to
`/home/edge/projects/rezics/rezics-next/.reference/`. Existing clones were reused;
PostgreSQL's sparse checkout was read with `git show` where necessary. No reference
code was installed, built or executed. The provenance index records this reuse.

| Project, pin and licence                                                                                                                                                                                                       | Files inspected and relevant fact                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [DBOS TypeScript](https://github.com/dbos-inc/dbos-transact-ts/tree/627990fc59619d3584ce88511ab546bc7483f4b9), `627990fc59619d3584ce88511ab546bc7483f4b9`, MIT (`LICENSE`); `native-scheduler-funded-design/dbos-transact-ts/` | `src/system_database.ts:889–954,2670–2755,4645–4860` and migration definitions: retry loop, four-family deletion, exact head ordering, shared PENDING veto, fixed-ID locking and native ownership.                            |
| [PostgreSQL](https://github.com/postgres/postgres/tree/700b422af7e26cf310caf3fb76d78f4c8ca39c1f), `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, PostgreSQL License (`COPYRIGHT`); `library-shelf-maintenance/postgres/`          | `src/backend/executor/execIndexing.c:315–442`, `nodeModifyTable.c:1516–1596`, `src/include/access/{nbtree.h:155–180,amapi.h:205–305}`: actual insertion work, deletion visibility, index tuple width and extension interface. |

Official PostgreSQL documentation establishes the installed SQL boundary:
[multicolumn B-trees](https://www.postgresql.org/docs/18/indexes-multicolumn.html)
do not generally eliminate examination after an earlier range key;
[CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html) supports
expressions and partial indexes but does not make populated index construction
bounded; [SELECT](https://www.postgresql.org/docs/18/sql-select.html) describes
SKIP LOCKED's inconsistent observation;
[isolation](https://www.postgresql.org/docs/18/transaction-iso.html) explains fresh
Read Committed observations and nontransactional sequences;
[triggers](https://www.postgresql.org/docs/18/sql-createtrigger.html) provide
transactional old/new mutation hooks. These support the protocol ingredients,
not the required literal performance certificate.

## What the probe allowance actually means

There are three separate accounting quantities:

1. Native reservation `points`: charged full-key/range starts, including misses
   and mutation/constraint work, alongside rows, statements, bytes and engine
   requests. They are not PostgreSQL buffer counts.
2. Physical index descents: repeated accesses to growing index paths. One descent
   may touch multiple pages; cached shared hits still represent examined blocks.
3. Harness `indexProbes`: an allowance for index-level growth **per measured run**.
   `growth.ts:84–85` says each scale transition may add that many blocks. It passes
   the number only to the blocks classifier, not to a runtime seek counter.

For `rule:'series'`, `growth-model.ts:staircaseFit/classifySeries` first tries its
ordinary constant/logarithmic family. If needed it fits an additional staircase:

```text
observed block interval at scale i contains a + b*ln(scale_i/scale_0) + s_i
a >= 0, b >= 0, s_0 = 0
0 <= s_i - s_(i-1) <= P, where P is 40 or 4,000
```

It includes measured uncertainty and interval envelopes. Thus `P=4000` is neither
4,000 total block accesses nor an enforced `actualSeeks <= 4000` assertion. A large
constant intercept or an ordinary logarithmic fit can pass without consuming the
staircase. A source-only analysis must not invent a stricter test and call its
failure an observed regression, or exploit that permissiveness as a larger grant.
The owner still requires a literal inclusive design and unchanged physical limits.

The short test measures **one complete ten-deletion batch**, with `P=40`; the full
test and frozen inversion measure **one complete 1,000-deletion batch**, `P=4000`.
Their operation includes list selection, deletion and reached native hooks. Warmup,
fixture insertion, replenishment and admin assertions are outside capture.
This is not a fresh 4,000 allowance for selection, every nested SQL statement, each
workflow or each internal continuation. Occurrence-level list bounds must also
hold independently; deletion cannot conceal a growing selector.

For a literal certificate, let `p_j` count descents into growing relation `j`,
`h_j(H)` its index height and `K(d,c,L)` all history-independent work. A sufficient
shape is `B(H) <= K + sum_j p_j*h_j(H)`, with bounded live rows and statements at
fixed deleted count `d`, actual descendants `c` and input lengths `L`. If each
growing path can gain one level at a scale transition, the required inclusive
certificate is:

```text
p_select + p_fixed_recheck + p_native_delete + p_projection_remove
 + p_summary_repair + p_coverage_controls + p_owner_hooks <= 4,000  (d=1,000)
the same complete branch                                             <=    40  (d=10)
```

If heights can gain more than one level, use `sum p_j*delta(h_j)` instead. Shared
ordered array scans may reduce descents, but that saving needs the actual native
body and a uniform argument; it is not a free credit. This sufficient certificate
is distinct from the exact empirical classifier above. Neither is supplied by
the earlier reports for the connected design.

A sweep has up to 60 separate batches, potentially 60,000 deletions; its accounting
is the sum on its original finite invocation/deadline, including the last short or
empty observation. The batch fixture does not grant a 240,000-probe sweep budget,
60 new balances or permission for an unbounded refill loop. A separately admitted
later ordinary invocation resumes committed data, not the old funding token.

## Falsification of the available retention constructions

### Ordinary indexes and eligibility promotion

Hold `d=1000`, keys and child populations fixed. Add `H` workflows created 400 days
ago but completed yesterday, and `H` created 200 days ago and completed 90 days ago.
The former precede and fail completion; the latter form an eligible backlog. A
creation-first scan rejects `H` rows; completion-first plus top-N creation sort
consumes `H` eligible rows. Both are visible work, outside the MVCC exclusion.
Reversing completion order among eligible rows preserves this counterexample.

Because both current cutoffs equal C, eligibility can be written
`greatest(created_at,completed_at) < C` after excluding NULL completion. Indexing
that scalar solves eligibility order, **not creation order**. Promoting all newly
eligible rows to a creation queue before the paid query simply moves the `H` work
into a timer, cutoff change, installation, or restore. Updating 359 possible daily
policies does not cover arbitrary millisecond cutoffs without such promotion.
No timer or prior maintenance is free or guaranteed complete by the contract.

### Creation radix with min-completion summaries

The primary candidate has a leaf per creation timestamp and depths 0–64 per app.
Its pruning is correct only while every terminal old/new contribution is current.
At one changed leaf it reads the new minimum, writes the leaf, and performs two
child reads plus one parent write at 64 levels: **194 rows/194 points/130 nested
statements**. Distinct old/new leaves double those figures before enclosing locks,
native guards, inventory or bytes. Server-side PL/pgSQL does not collapse them.

The supplied two-app traversal bound is **256,258 nodes plus 2,000 leaf rows**;
even just its node-probe certificate exceeds 4,000. Deleting 1,000 distinct leaves
can require 194,000 maintenance row operations/130,000 nested statements in the
shown unbatched body. This is a failed admission certificate, not proof every
execution realizes the upper bound. Shared ancestors can help only if a different
batched repair algorithm proves and prices that sharing.

Adversarially distribute eligible minima under many separated creation prefixes,
with ineligible siblings and no useful shallow pruning. Maintaining min values
does not turn these explicit node visits into engine-only visibility work. If a
proposed batching method sorts all changed ancestors first, include its distinct
keys, bytes, comparisons, temporary state, lock acquisition and failure cleanup.

### Completion prefixes and 64 expression indexes

The independent candidate stores one terminal projection and one B-tree at every
completion-prefix depth 1–64, keyed `(application,prefix,created_at,workflow_id)`.
Flip the signed BIGINT sign bit; the interval below C decomposes into at most 64
disjoint prefixes. Each app/NULL branch is creation-ordered within each prefix;
merging their heads is semantically sound. Equal creation timestamps need no new
completion precedence. Explicit NULL tags and deduplication avoid duplicate rows.

For `m=popcount(unsigned(C))`, there are `q=2m <=128` streams. The actual submitted
head/refill algorithm performs at most `q+d` seeks, at most 1,128 for a full batch.
That is only selection. A conservative four native family probes per ID already
reserve `4d` **if all four families require independent growing-path starts per
ID**. Under that additional assumption, the proposed budget would be:

```text
P_full_budget  = 128 + 1,000 + 4*1,000 + P_other = 5,128 + P_other > 4,000
P_short_budget = 128 +    10 + 4*   10 + P_other =   178 + P_other >    40
```

This is a conditional composition, **not a lower bound on the frozen fixture or
all PostgreSQL executions**. The frozen fixture seeds status rows; its other
three deletion families are empty. Their negative probes cannot be assigned
growing height without growing those relations too. With one native and one
projection growing-path start per ID, the arithmetic would instead be
`128+1,000+1,000+1,000=3,128`, leaving 872 for every remaining path. That is not a
proved pass either: array scans, stream refills, constraints and triggers need
their actual trace. Native array scans, persistent stream cursors or a changed
physical layout might save starts. Counting alone does not reject the full-batch
prefix candidate; its full-domain representation, short-batch and inclusive cost
certificate remain unproved.

The short problem is not only the worst 64-bit cutoff. Choose the supported
millisecond cutoff `C=2^32-1`, with `now=C+30 days`. Its sign-flipped value has 33
set bits, hence 66 initial own/NULL probes even for ten returned rows. Populate
the queried completion prefixes in both apps with creation-ineligible rows, and
put ten eligible rows in one prefix. Empty/range-negative streams still cost
seeks; they cannot be omitted without a maintained, covered emptiness directory.
That directory's updates, coverage, invalidation and deletion would be new costs.
The 66 starts refute a one-start-per-stream certificate under 40; they do not
alone prove a failed physical classifier. That additionally requires growing
backing indexes and the measured block trace, with its ordinary-logarithmic fit.

An important correction to an easy rejection argument: **PostgreSQL DELETE does
not synchronously descend all 64 expression indexes to remove each tuple**.
`nodeModifyTable.c:ExecDelete` explicitly leaves index modifications to the engine's
tuple lifecycle. Logical visibility disappears at transaction commit; old snapshots
may still see the old version. Do not charge 64 immediate DELETE descents that the
body does not execute. Conversely, `ExecInsertIndexTuples` loops through applicable
indexes. Inserting a projection creates 64 expression entries plus its primary
entry; changing indexed completion/creation/app fields repeats applicable insertion
work. Index expression/predicate evaluation, index bytes and failed insertions are
real maintenance, not zero because there is one SQL INSERT. Ordinary engine MVCC
reclamation is on the existing exclusion boundary; explicit projection rebuilding,
summary updates and account-bearing copy retention are not.

The full input domain also defeats the submitted composite-key schema. A terminal
row may have an incompressible application string that fits native TEXT but not
one third of a B-tree page; its status is outside the native in-flight INCLUDE
index. Its workflow ID can separately fit the existing primary key. The new
`(application,prefix,creation,id)` entry need not fit. Even two individually valid
indexed strings can overflow a new composite entry. PostgreSQL's
[field limits](https://www.postgresql.org/docs/18/limits.html) do not guarantee
B-tree tuple admissibility. This falsifies that representation, not every exact
dictionary or a projection scoped to a separately justified eligibility domain.

Hashing the key changes this to an exactness/coverage problem: a digest alone
loses collision correctness; a hash bucket followed by exact comparison admits
an arbitrarily long collision scan. A chunked exact dictionary could retain the
domain, but its traversal, string equality/collation, duplicates, ownership,
allocation and erasure need a complete paid body. Neither earlier candidate has
one. Restricting old inputs is an explicit alternative, not an implementation fix.

## Connected protocol that any replacement must implement

The following concrete relation layout fixes the queue and coverage seams. It
does not assert that the absent retention access method or exact dictionary is
installed SQL. Numeric aliases require exact lossless resolution, not hashing.

```text
discovery_domain(singleton PK, layout, hooks, restore, coverage_generation,
                 phase, base_after, base_end, dirty_after, dirty_end)
queue(qid PK, revision_generation, revision, first_segment, tail_segment, tail)
segment(qid, segment PK-with-qid, next_segment)
member(qid, sid PK-with-qid, enqueued_count>0, segment, ticket)
  UNIQUE(qid,segment,ticket)
item(wid PK, qid,sid,aid,vid,priority,created_at,incorporated_revision)
  INDEX(qid,sid,aid,vid,priority,created_at,wid)
  INDEX(qid,sid,vid,priority,created_at,wid)       -- ANY_APPLICATION
pending(wid PK,qid,sid); INDEX(qid,sid,wid)      -- ALL apps and versions
retained(wid PK,aid,created_at,completed_at,incorporated_revision)
  REQUIRED ACCESS: ordered eligible reporting, not an assumed B-tree feature
contribution(wid PK,restore,incorporated_revision,state,qid,sid,aid,vid)
frontier(domain PK,qid,aid,vid,latest_generation,layout,hooks,restore,
         epoch,segment,after_ticket,end_segment,end_ticket,start_revision,
         authoritative)
dirty(segment,ticket PK,actual_identity,generation,owner_reference)
key_dictionary/key_chunks(exact tagged identity,lossless bytes,owner references)
```

Nonpartitioned head indexes omit `sid` and preserve their native priority/creation
order across eligible rows. NULL is tagged; nameless application means unrestricted,
not NULL-only. Named/latest needs at most four exact app/version heads; named older
needs two; unrestricted latest needs two all-app version heads. Duplicate branches
are removed. A shared PENDING projection has no app/version filter. Every primary,
unique and secondary index write, FK check if added, and constraint evaluation is
part of the trace. Adding FKs cannot silently add unpriced cascading work.

### Queue visit, fairness and empty certification

An admitted step takes the exact Pool/capability/deadline, prepays cleanup, begins
one native transaction and validates current domain/coverage. It locks one frontier
and visits **one** member up to its captured end. It performs the bounded compatible
head and PENDING probes, tries the original Session partition lock, then locks
only the chosen actual ID with SKIP LOCKED. It rereads heads/latest identity and
conditionally claims that fixed ID with the native owner token. Cursor advance,
claim and projection changes commit together. No sliding replacement scan follows
a busy row. A failed lock/claim is paid incomplete and marks the epoch unsuitable
for empty certification. Native version and owner predicates remain at the write.

Hold the per-queue allocator row through commit when publishing new membership.
Capture the finite tail under the same lock. Use linked finite ticket segments
and a paid rollover step, rather than a lifetime counter cap or nontransactional
sequence. Keep one Session ticket while any ENQUEUED contribution remains, including
exact/NULL app or version movement. Never decrement to zero and recreate the same
member during such a move. When count really reaches zero, later re-entry gets a
new ticket. Queue/version clocks invalidate proofs, not the current fairness lap.

Fix a continuously eligible Session and repeatedly admitted compatible domain.
At a captured tail there are finitely many preceding committed members; later
arrivals cannot extend that epoch. Each committed visit advances, restart resumes
that frontier, and bucket switching cannot move this Session's global ticket.
Thus it obtains repeated claim opportunities. Busy/incompatible visits consume
finite paid steps and are revisited in later epochs. As in the adopted protocol,
eventual lock availability must include fair acquisition or a free interval at a
visit; an adversary holding the lock at every probe is not a liveness premise.
No amount of indexing guarantees success under that exclusion.

An end-of-epoch result is incomplete until a separate sealing transaction locks
the queue, current version controls and coverage domain, uses a fresh observation,
and verifies unchanged generations/revisions, complete base and dirty coverage,
all visits authoritative, and no membership beyond the captured tail. All writers
must publish their relevant clock changes in their own transaction. Otherwise an
old completion, new PENDING owner or late compatible insertion invalidates an
earlier no-head observation. Claim, paid incomplete and proven empty remain three
distinct caller outcomes. Empty is scoped to an instant, never future arrivals.

Old row writers can lock status before their triggers obtain queue metadata.
The selector must not hold metadata and block indefinitely waiting for that status:
use fixed-ID skip/NOWAIT plus a finite original deadline. Serialize head-affecting
writers and seal controls, including old clients. Merely taking an advisory lock
in the new poller does not constrain ordinary SQL writers. Bulk multi-row lock
conflicts, deadlocks, retries and aborted prefixes remain paid; actual lock order
and fair service are still implementation obligations.

### Retention batch and sweep

Each supported covered batch must report the earliest up to 1,000 currently
eligible creations, using strict creation/completion predicates and all four
terminal states. Merge own/NULL sets without double counting. Recheck fixed IDs
and original predicates inside the actual deletion/closure composition, not on
an independent connection whose selection locks disappear before deletion.
Do not require descendants to vanish by deleting child workflows.

At fixed cutoff an old creation can become terminal or completion-eligible behind
a saved cursor. New batches must reopen an authoritative ordered root or reconcile
such changes before using a frontier. A clock mismatch is not exhaustion. A partial
selection, coverage gap, lost row or price limit cannot return a successful short
count that makes the existing `removed < 1000` sweep exit. The frozen covered
warmup/probe still requires 1,000 actual deletions. The queue amendment supplies no
permission to turn this into multiple paid no-claim retention calls.

### Complete writer and installation coverage

| Native writer family                                                   | Required atomic work                                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary, transactional, SQL, child and bulk enqueue                   | Actual status/input contributions, conflict/no-op guard, parent/fork checks; bound each 500-row chunk and the caller's total. Replace or price first-key MAX/creation seeding. |
| Claim, completion, fallback/error/dead-letter, low-level status writes | Actual old/new state, ENQUEUED count/ticket, shared PENDING gate, terminal contribution and clocks under unchanged owner predicates.                                           |
| Delay/debounce/activation, recovery, cancellation/timeout, resume      | Only actual transitions; every row of a bulk activation/recovery is paid. A zero-row native operation still reaches applicable guards.                                         |
| Priority, creation, app/version changes and rename                     | Update exact heads/retention and clocks; preserve stable Session membership. Original population-sized rename work cannot become one-row maintenance.                          |
| Rewind and fork                                                        | Account all copied/deleted child payload families and original parent/source guards; rewind removes old terminal eligibility.                                                  |
| All eight payload/status families, ordinary delete, COPY/restore       | Preserve existing ALWAYS writer guards, actual owner inventory and descendant operands; delete projections/copies in the original native transaction.                          |

Installation creates empty SDK-owned projections and indexes, then installs all
hooks under a barrier conflicting with old in-flight writes. The barrier must
cover transactions already executing old statements, not just new client versions.
DDL lock waiting has a finite paid deadline; timeout leaves coverage untrusted.
Existing positional migrations stay frozen. Building an index over old native
history, validating a populated constraint or counting all rows is not a bounded
installation step, including with CONCURRENTLY.

After the barrier, capture a finite base range and use the existing native primary
index to choose one fixed old row per admitted backfill step. Lock that actual row,
read current native state and incorporated receipt, and apply the delta once.
Never decrement a contribution the row has not yet acquired. A concurrent writer
behind the lexical cursor is covered by the hook; an earlier deleted row must not
be resurrected from a stale backfill snapshot. Skip/conflict creates a durable
repair obligation; it cannot silently advance an authoritative frontier.

Effect, incorporated revision and progress publish in the same transaction.
Generation-conditional dirty acknowledgment prevents a newer mutation from being
lost. Capture/drain finite dirty segments without letting arrivals prolong an old
segment. Publication locks the current domain, proves both frontiers exhausted and
all relevant generations current, then marks coverage complete. No final COUNT,
all-version census, orphan sweep or unstated validation pass may precede that seal.
Payload orphan inventory, where required for absence, has its own paid frontiers;
status coverage alone is insufficient. A missing writer class defeats the proof.

Restore first preserves current permanent fences, advances the supported restore
domain, invalidates layout/hook/coverage trust and reconciles actual restored rows
by the same bounded protocol before authoritative discovery. Ordinary restart
retains compatible committed progress. Layout/hook changes need explicit repair,
not a fictitious complete bit. Restored projections do not certify their own
coverage. Whole-database rollback losing permanent closures stays unsupported.

## Copy, abort, snapshot and erasure inventory

| Retained material                                            | Lifetime, abort and authorized erasure rule                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original eight SDK families and their indexes                | Existing authority/guards and actual descendant populations; abort restores old state; committed deletion changes current visibility, not old snapshot history.                                                                                                         |
| Item, terminal projection and every index entry              | One reverse actual-workflow association; update/remove with the native old/new transition. Prefix design retains 64 index copies plus its heap row.                                                                                                                     |
| Contribution, shared member and stable ticket                | Remove this workflow's reference exactly once; preserve other live contributions; remove Session identity at zero without scanning its versions/workflows.                                                                                                              |
| Exact aliases, chunks, comparison/canonicalization buffers   | Numeric identity is not anonymity. Include full bytes, collision verification and reverse ownership; remove last authorized identifying reference transactionally.                                                                                                      |
| Queue/version controls, segments and due registry            | Classify actual identity-bearing values; shared references cannot be erased with another owner's work. Paid rollover/cleanup; no global janitor census.                                                                                                                 |
| Frontiers, cutoff state, dirty tickets, retry/repair records | Do not embed unnecessary Session/ID lists. Inventory identifying bindings; conditional invalidation/removal must not fan out over arbitrary consumer versions.                                                                                                          |
| Candidate arrays, head merge state and payload conversions   | Bound invocation memory/bytes; discard on settlement/abort; never let an escaped candidate authorize later work.                                                                                                                                                        |
| Permanent writer fences and restore-domain controls          | Survive supported execution deletion and restore under existing authority; closure receipts contain no execution payload and cannot be rotated away.                                                                                                                    |
| Current `selected_step_executions`                           | The new patch retains workflow input, registration and step arguments with immutable admission state and DELETE/TRUNCATE refusal. This is additional to the old reports' eight-family inventory. No all-copy absence or permission to delete it follows from retention. |

The final row is a current-source boundary, not a request to edit that other
producer. Owners must classify its permanent versus removable data and provide
an authorized lifecycle before a connected all-copy claim includes it. The patch
cannot be assumed identical to the older research source pin.

SQL abort rolls projection/index/cursor effects back together; attempted work and
materialized bytes remain charged. Ambiguous commit requires later ordinary paid
reconciliation of durable state, never replay of a spent capability. Old snapshots
seeing pre-delete native versions and normal engine reclamation stay on the
architecture's existing MVCC boundary. Explicit shadow tables, stale dictionaries,
frontiers and permanent payload copies are design-visible retained material.
An after-commit janitor does not establish same-transaction owner-authorized
removal. Current eight-family probes do not prove absence from these new families.

## Literal cost disposition

Use the owning native vector `(rows,points,statements,bytes,engineRequests)`.
Rows count actual reads/writes, points include negative seeks and index starts,
statements include outer/nested SQL, constraints and controls, and bytes include
internal conversions, bindings, copies and results. SQL-only paths have zero
separate engine-service requests, not zero PostgreSQL work. Unknown owner children
retain their own native or Library eight-axis declarations; no conversion or zero
price is inferred. Checked sums/multiplicities must fit the original API domain.

`U` below means an unavailable inclusive price with its missing operand stated;
it is never an admitted numerical zero. The counted kernels are conditional
operands from the actual candidates, not newly issued grants.

| Path                                          | Rows / points / statements or explicit multiplicity                                                                                                          | Bytes, requests and missing inclusive work                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact compatible lookup                       | At most 4 head rows/4 range starts/4 SELECTs, twice when rechecked; 1 shared veto per observation                                                            | Actual key/result bytes plus exact dictionary body U; SQL requests 0. No all-version pre-scan.                                                                                          |
| Queue claim metadata kernel                   | Primary 23/21/26; its named same-queue projection and final recheck yield 37/40/42                                                                           | Native guards, owner/version serialization, key arena, inventory, byte copies and actual constraints U. No full claim price.                                                            |
| Queue no-head/veto visit                      | Primary 13/12/16 including controls                                                                                                                          | Same unresolved key/coverage/hook operands; failed/locked visit remains charged.                                                                                                        |
| Epoch open / segment or empty seal            | Primary 7/6/10 and 8/7/11 respectively                                                                                                                       | Extra proof/control queries, alias/restore checks and payload-free control bytes must match actual implementation; U if any omitted.                                                    |
| Radix terminal leaf change                    | 194/194/130; distinct old/new 388/388/260                                                                                                                    | Key/summary bytes, root/owner locks and inventory U; no refund on failed ancestor.                                                                                                      |
| Radix selection                               | Up to 256,258 node reads plus 2,000 leaf rows for two roots                                                                                                  | Nested seeks/statements and frontier bytes must be charged; does not supply 4,000 certificate.                                                                                          |
| Prefix selection                              | Up to 128+d range-head statements/starts and head rows for the submitted refill body                                                                         | Merge comparisons/buffers and key bytes; no maintenance or native deletion included.                                                                                                    |
| Prefix projection insert / indexed-key update | 1 heap row plus 65 applicable index insertions, 64 expressions, native/projection trigger and constraint trace                                               | Exact serialized tuple/index/WAL-related design operands U; native engine requests 0. DELETE is not 64 immediate index descents.                                                        |
| One coverage/repair row                       | Fixed native peek+lock, receipt read, actual old/new transition, progress write, controls; radix transition alone can add 399 rows/403 starts/273 statements | Barrier, exact-key, inventory and byte bodies U; base/dirty totals scale with actual covered rows, not one startup grant.                                                               |
| Installation / publication                    | Empty DDL catalogue operations, hook barrier, generation/coverage locks and frontier seal                                                                    | Complete actual DDL/constraint/catalogue trace U; no old-table build or final uncharged census.                                                                                         |
| Restore / cleanup                             | Domain rotation plus invalidation; one paid reconciliation/removal unit and committed frontier per step                                                      | Actual layout, alias, owner-copy and permanent-data lifecycle U; neither restore nor failed cleanup is free.                                                                            |
| Existing narrow one-attempt retirement        | Declared **13/7/17/41088/0**                                                                                                                                 | Conditional receipt/body; includes controls and prepaid rollback. Not ordinary retention readiness.                                                                                     |
| Existing narrow one-attempt deletion          | Declared **144/10/16/8320/0**                                                                                                                                | Requires certified 64 operations, 8 events, 64 history, zero notifications/streams. Not a universal descendant operand.                                                                 |
| General `deleteWorkflows(ids,false)`          | Per attempt: BEGIN + four outer DELETEs + COMMIT + reserved ROLLBACK = 7 controls/outer statements, plus all reached cascades and new hooks                  | `d_status+d_input+d_output+c_ops+c_events+c_history+c_notifications+c_streams` affected rows; actual read/constraint/copy costs additional. Retry multiplicity U until bounded/charged. |
| Source/History/Library removal and readiness  | Actual authorized callable, original frame/Pool/deadline and inclusive child multiplicities U                                                                | Work money grants no Source lifecycle authority. Missing Library or native operand is unavailable, not zero.                                                                            |

For the four FK families, the general delete trace includes their actual per-parent
referential-action dispatches/probes and changed child rows; the seven outer/control
statements are not its complete statement price. Four selected native table deletes
also do not remove projections, aliases or new permanent payloads by implication.

The existing installed fence's row guard uses `to_jsonb(NEW)` and `to_jsonb(OLD)`
to extract an ID. Payload-bearing tables can therefore materialize full content
even for a scalar-returning call. A byte table based only on wire results misses
that work. A legal 65th operation output defeats the narrow 64-row deletion price;
similarly streams/notifications need their actual operands. Fencing and a bounded
inventory phase or exact maintained counters can certify them, but that phase and
all old child writers need their own paid coverage. Neither can be presumed.

DBOS `withDbRetry` is `while(true)`; ordinary deletion's internal method is
decorated. One reservation around the public method cannot bound arbitrarily many
retryable attempts. Every attempt and cleanup must prepay against the same finite
invocation/deadline, with a nonretryable funding refusal, on the actual supported
delegation path. The single-attempt adapter is a useful pattern, not proof that
ordinary retention already does this. No guessed Work grant fills these cells.

### Uniform scaling and failure obligations

Hold `d,c,L`, native predicates and configured slots fixed while history H, active
Sessions N and registered/incompatible versions V grow independently. A positive
certificate must bound each selection occurrence and all inclusive paths uniformly,
not just the original friendly distribution. Prefix/radix depth is fixed by the
input type, but their explicit roots/nodes/writes still appear in the inequalities.
Queue per-visit work may stay fixed while a finite epoch needs N visits; that total
is paid over ordinary admissions. Retention cannot borrow that outcome amendment.

Every path includes BEGIN/settings/COMMIT, a rollback slot reserved before checkout,
timeouts, lock skips, lost claims, attempted unique/FK writes, hook failures and
ambiguous commits. Incremental base/dirty progress does not amortize unpaid work
into future polls. Each multi-row writer, backfill page, deletion batch and sweep
has its own full sum; only disjoint branches may use componentwise maxima.

## Smallest explicit alternatives and missing primitive

The current SQL interfaces support the component operations. They do not provide
an installed worst-case creation-ordered dominance reporter with this cost
certificate. A proposed replacement must demonstrate `report(app-or-null,
created<C,completed<C,1000)` and exact insert/update/remove over old native values,
plus the two complete batch inequalities, installation/restore coverage and erasure.
An R-tree/GiST/SP-GiST label or priority-search-tree asymptotic bound is not that
implementation. Adversarial overlap, ties, long strings and all update paths still
need a literal storage/maintenance analysis. No such source was established here.

| Explicit alternative                                                                       | Smallest changed requirement and remaining obligations                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preserve current semantics and allowances; supply a new native ordered reporting primitive | No outcome amendment. Deliver the full-domain representation, charged actual SQL/engine body, worst-case path certificate, old-writer hooks, paid build/rebuild, owner-copy lifecycle and proof at the frozen populations. This is the recommended prerequisite, not a claimed available primitive.                                             |
| Extend incomplete progress to retention                                                    | Owners must expressly change the immediate full-batch/sweep contract and define how creation-ordered selection completes before deletion, dirty revisions/races and durable cutoff continuation. A finite paid radix traversal becomes a candidate, not an automatic fit for maintenance/erasure. The current queue amendment does not do this. |
| Order retention by eligibility time                                                        | With the current common cutoff, order by `greatest(created_at,completed_at)` on non-NULL terminal rows, merging own/NULL streams. This changes original creation order; long-key, maintenance, native-delete and owner costs remain. Completion alone is insufficient for the full timestamp domain.                                            |
| Change representation domain or allowance                                                  | A documented old-input compatibility/migration policy or explicitly rederived ceilings could admit other structures. A small key cap alone does not price 64 indexes, coverage or foreign callbacks. No such change is authorized here.                                                                                                         |

If the first alternative is a PostgreSQL extension, separate deployment from SQL
availability. The [index AM interface](https://www.postgresql.org/docs/18/indexam.html)
permits custom add-on code; it does not install one. Delivery requires supported
server/version/platform packaging, extension installation authority, operator and
planner integration, WAL/recovery and crash-safe layout changes, transaction/MVCC
correctness, concurrent maintenance, bounded build/rebuild, backup/restore and
owner custody. Ordinary TypeScript/pg access and CREATE INDEX privilege do not
supply that deployment. Moving explicit logical tree work into C does not remove
its charges under the existing visibility-only exclusion.

The shared established patterns are transactional native ownership and old-writer
guards (DBOS), explicit secondary-index maintenance and visibility semantics
(PostgreSQL), and separating progress from an authoritative observation. Apply
those patterns in this repository's PostgreSQL/TypeScript/DBOS stack; recommend no
upstream file or long passage for copying and no replacement orchestrator.

## Receiving and deferred proof

Keep the original retention axes **49,152 × 1/4/16**, 1,000 warmup/probe deletions,
short ten-row and empty cases, both strict cutoff edges, all statuses/app/null,
creation ties/inversions, actual child-size variation, fences and the 60-batch
sweep. Keep queues **16 × 256/1024/4096** plus the independent V/N grid, all native
partitioned/nonpartitioned paths and mounted Commerce authority/order outcomes.
Add the 33-prefix short case, compatible bucket switching, commit-order inversion,
continuous arrivals, membership deletion/re-entry, busy/incompatible visits,
old in-flight writes across hook installation, stale backfill/delete races,
layout/restore changes, long composite keys, rollback at every mutation boundary,
retry exhaustion and every identifying-copy removal to the future connected proof.
These are research counterexamples and future acceptance obligations, not executed
tests or permission to alter frozen assertions.

Only this report is a tracked change; permitted reference provenance was updated.
No executable workspace, test, story, package or frozen file changed, so there is
no changed-workspace compiler or changed-test command to run. The original
report-existence acceptance and all implementation/native/growth/browser/root/
remote verification remain deferred under this launch's execution policy. No
passing native, compiler, installation or whole-feature result is claimed.
