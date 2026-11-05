# Native Work exact keys: independent remaining-architecture review

## Recommendation

No supported positive representation is established for the **complete** uniform
`O(d log N + B)` contract. Keep that requirement, and do not promote the private
heap-TID sketch to an implementation contract yet. Direct heap addressing is a
real PostgreSQL mechanism that can remove a per-byte B-tree descent; it does not
supply compatible linear canonicalization, all ordered-head mutations, or an
independent restore-safe inventory. These are separate missing primitives.

The next deliverable should close those obligations in the current SQL deployment
or explicitly select additional native deployment support. If neither producer
can be supplied, changing the cost contract to pay the actual SQL algorithms is
an explicit alternative. An extension is a new deployment dependency, not an SQL
mechanism already delivered here, and its necessity has not been proved. This
report recommends retaining the target while requesting the concrete connected
producer proof described below. It does not authorize implementation or resume
the stopped producer.

This is a model-scoped negative result, not universal impossibility. Exact
long-string dictionaries have positive abstract results. What is missing is a
supported composition that also preserves PostgreSQL conversion/errors/collation,
the original native transaction, all copies, and the existing owner accounting.

## Evidence boundary and verified premises

Repository source is pinned at `f084a1425deece3f5f28867dd4546a3a23d24674`.
The three earlier reports are present locally; their named Git references were
resolved without merging or cherry-picking:

| Earlier evidence                                                                 | Git reference                              |
| -------------------------------------------------------------------------------- | ------------------------------------------ |
| [Primary exact-key report](work-client-exact-reservation-key-primary.md)         | `d7666822d6fa00edd90120d013e4beecbc8cebdc` |
| [Independent exact-key report](work-client-exact-reservation-key-independent.md) | `e1b230d1397418ea9c538e3c840644ca1f02972b` |
| [Complete private-heap review](work-client-private-heap-complete-design.md)      | `0470a6f0e75bfe4472a087f7f0f692babb435c98` |

The bounded-legacy contract, both exact-key receiving decisions, and private-heap
receiving decision were read by exact path under the main checkout's
`.temp/goal/performance/decisions/`. Their byte-index, original-cast and invalid-link
inventory counterexamples are premises of this review. The other new resolution
report was not read. This is a focused closure analysis, not another candidate
survey.

The current [Work owner document](../../services/kernel/src/work/README.md),
[client](../../services/kernel/src/work/client.ts), and
[maintenance adapter](../../services/kernel/src/work/sdk-retirement-fence.ts)
establish the actual starting seam:

- The resolver still executes the native four-way status/input join. Its current
  SQL orders by parent time only; the accepted contract additionally specifies
  parent and child actual-ID C-order ties. There is no completed exact-key
  projection to extend or treat as installed coverage.
- Exact native-ID precedence, the loose 36-character lowercase recognition
  pattern, original-ID fallback, original SDK options/errors, and borrowed-Pool
  ownership are real behavior, not optional dictionary details.
- `hasRetainedWorkCopies` probes eight native families. It does not inventory any
  private dictionary, ordered structure, scratch or restore metadata.
- `maintainSdkWorkflowOnce` admits literal dispatch strings through a callback.
  Those strings carry no changed lengths, extracted lengths, key depths, copy
  counts or restore-inventory operands.

One important base change prevents repeating a stale conclusion: current
[Library scope effects](../../services/kernel/src/library/identity-scope-effects.ts)
has successful page and seal-verification bodies. It is no longer the earlier
unconditional unavailable/false adapter. Its exact SQL footprint is exported from
[Library's module](../../services/kernel/src/library/module.ts) and declared in
[identity-native-planner-work.ts](../../services/kernel/src/library/identity-native-planner-work.ts).
The remaining normal-receiving composition gap is identified below.

No database, runtime collation, query plan, installed extension or native coverage
was inspected by execution. Reference code was only read, never installed, built
or run. No product, native, growth, browser or workspace compiler check was run;
this change contains no code workspace. The report is research evidence, not
installation, physical absence or whole-feature completion.

## Primary sources and licences

Paths in this table are relative to the main checkout's `.reference/`. Existing
clones were reused, with reuse recorded in its `INDEX.md` on 2026-11-02. Commit
identities were checked using Git; sparse PostgreSQL files were read from Git
objects rather than assuming their presence in the working tree.

| Project and local path                                                      | Inspected revision                         | Licence and primary source                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL, `library-shelf-maintenance/postgres`                            | `700b422af7e26cf310caf3fb76d78f4c8ca39c1f` | [PostgreSQL License, `COPYRIGHT`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/COPYRIGHT) |
| Rax, `work-client-exact-reservation-key/rax`                                | `1927550cb218ec3c3dda8b39d82d1d019bf0476d` | [BSD-2-Clause, `COPYING`](https://github.com/antirez/rax/blob/1927550cb218ec3c3dda8b39d82d1d019bf0476d/COPYING)                 |
| DBOS Transact TypeScript, `native-scheduler-funded-design/dbos-transact-ts` | `627990fc59619d3584ce88511ab546bc7483f4b9` | [MIT, `LICENSE`](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/LICENSE)            |

Additional primary evidence is PostgreSQL's current documentation, resolving to
version 18 during this review, and Ferragina and Grossi's original String B-tree
paper, JACM 46(2), 1999, pp. 236–280. The
[authors' institutional record](https://arpi.unipi.it/handle/11568/189198)
identifies DOI `10.1145/301970.301973`; the
[original paper](https://www.inf.fu-berlin.de/lehre/SS01/biodaten-seminar/papers/String-B-tree.pdf)
carries ACM copyright and limited personal/classroom copying permission, not an
open-source implementation licence. Its parsed text was available; subsequent
PDF page fetches timed out. No paper passages or project implementation are
proposed for copying.

## What a complete positive claim must mean

Let `d` count changed native source rows, including status and input separately.
Let `N` include all live dictionary, candidate, ordered, owner-inventory,
allocator and progress state, not just eligible pairs or one account's history.
Changes to either half can remove a candidate immediately; an input orphan can
still own retained bytes and an intern reference.

Keep native input bytes, compatible extracted-output bytes and actual-ID encoded
bytes separate in a quote. Call them `B_native`, `E` and `A`. Numeric output can
expand relative to input, and a binary-safe ordering encoding has a real size.
For the negative arguments below, even grant the favorable allowance
`B* = B_native + E + A` for old and new **changed** values. This is not a change
to the owner's definition of `B`; failure even with that allowance is stronger.
Do not add all encountered survivor/history bytes to `B` after the fact.

The intended uniform constants may depend on fixed page layout and byte alphabet;
they may not conceal the maximum possible PostgreSQL string length, collision
population, history length, or retained application-version population. Separate
logical rows/points/statements, design-visible index navigation and compared/copied
bytes. A one-row function call is not a one-unit implementation of its internals.

Semantic obligations remain exact:

- Use `inputs::jsonb #>> path` results, including NULL/missing versus empty text,
  numeric/string and Boolean/string equality, duplicate-member handling,
  structured rendering, encoding and numeric errors. Do not compare JSON values
  instead of their extracted text.
- Preserve the expression's actual equality collation. A deterministic byte
  dictionary is conditional on deterministic equality, not necessarily on a C
  database locale. Explicit C order for actual IDs does not change reservation,
  realm or member equality.
- Preserve parent time DESC with PostgreSQL NULLS FIRST, parent actual ID ASC
  COLLATE C, then child actual ID ASC COLLATE C. Intern allocation order cannot
  replace actual-ID order. A standalone native primary-key fit is not a proof
  that a new composite B-tree key fits.
- Keep every original candidate predicate. Other-application retained children,
  unmatched parents, either-half arrivals/deletions and stored conflict winners
  cannot be excluded to simplify the projection.

PostgreSQL's [`texteq`, `src/backend/utils/adt/varlena.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/varlena.c)
uses byte comparison for deterministic equality and `text_cmp` otherwise.
[Collation documentation](https://www.postgresql.org/docs/18/collation.html)
explains that nondeterministic collations can equate different byte sequences.
No such deployment was established here. A future producer must support the
actual equivalence relation or explicitly obtain a narrower deployment contract;
it cannot silently normalize, force C equality or publish false coverage.

## Cost audit: where a plausible additive bound loses its terms

The following is a disjoint obligation ledger, not a production price:

| Work                             | Necessary bound for the retained target                                                                      | Failure that must be excluded                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Compatible conversion/extraction | Linear in admitted changed input/output bytes                                                                | Comparison sorting common-prefix member names; repeated full-value conversion                      |
| Exact equality navigation        | Linear byte work plus a constant number of indexed entry operations per changed source                       | B-tree point probe per byte/chunk; digest-bucket residual scan                                     |
| Actual-ID and group order        | A bounded number of logarithmic structural operations, without rescanning/copying unrelated survivor strings | Long key comparator at each tree level; rebuilding a head key from an unchanged winner             |
| Owner inventory                  | Indexed entry work per changed owner/source, linear direct copy work                                         | Independently indexed inventory row per byte-node                                                  |
| Publication/abort                | Same original transaction, bounded reached work on every attempt                                             | Detached repair/commit, retry inside a partly spent transaction, free losing speculative insertion |
| Release/reuse                    | Old changed path plus bounded scalar metadata                                                                | Survivor recompression, scanning all allocated/free/history entries                                |
| Restore/reconciliation           | Explicit independent maintenance admission and complete inventory before bounded use                         | Treating invalid coverage as deletion or a broken link as absence                                  |

For example, let `q` be explicitly visited byte/chunk nodes. A representation can
have `q = O(B*)`, fixed group-seek count and `O(B*)` final stored bytes, yet still
perform `q` separately indexed node or inventory mutations. Its actual work then
contains `Theta(q log N)`. Likewise, comparison/copying of `L` shared bytes at
each of `log N` levels contributes `Theta(L log N)` without increasing the row
count. Neither term is ordinary invisible engine MVCC work.

There is no new rescue in full-key B-trees, fixed digests or stock text SP-GiST;
the earlier reports already reject those claims. The source still makes the
SP-GiST gap concrete: [`spgtextproc.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/spgist/spgtextproc.c)
sets `longValuesOK`, but `formTextDatum` allocates/copies suffixes and
`spg_text_inner_consistent` allocates/copies accumulated prefixes. Along a path
consuming at most `c` bytes per step, suffix work can contain
`sum_i max(L-i*c,0)`, not merely `L`. A long-value SQL index is available; an
additive complete producer does not follow from that availability.

### Collision and prefix adversaries

A fixed digest is an accelerator only. With `k` distinct admitted strings in one
digest class, exact residual equality can examine `k` candidates and their common
prefixes. Rejecting the collision changes successful results. A random salt,
cryptographic assumption, expected chain length or practical collision rarity
does not give the required adversarial worst-case bound. A digest plus an exact
fallback must price the fallback's complete dictionary, order, copies and cleanup.

An exact radix path with a separate terminal has no collision bucket. It can
distinguish empty text, a prefix and every extension without a lossy key. Its
remaining cost depends on how transitions are addressed, copied and inventoried.
Fixed-width direct references and a fixed alphabet can make each step constant;
putting the same references behind an ordinary indexed SQL lookup cannot.

Rax is useful implementation evidence for that distinction, not a persistence
solution. In [`rax.c:raxRemove`](https://github.com/antirez/rax/blob/1927550cb218ec3c3dda8b39d82d1d019bf0476d/rax.c),
deletion can scan a surviving unary chain and allocate/copy a compressed
replacement. Removing a short prefix key can therefore copy a long retained
extension. Avoiding this needs an actual no-recompression or segmented-reference
algorithm; the word "radix" does not prove it. Rax's pointers and ancestor stack
also supply no PostgreSQL WAL, snapshot, transaction or restore protocol.

### Canonicalization remains an independent rejection

For candidate H using the original cast, the accepted counterexample remains
decisive. [`jsonb_util.c:uniqueifyJsonbObject`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/jsonb_util.c)
calls `qsort_arg`; equal-length member names reach `memcmp` through
`lengthCompareJsonbString`. With `m` distinct equal-length names sharing `p`
bytes, an adversarial permutation requires comparison-sort work that rereads
those prefixes. Taking `p` at least the distinguishing suffix width yields
`Omega(B* log m)` byte work for one changed input, before dictionary navigation.
This is a source/model argument, not a measured native result.

The cast parses the whole native input, so making only the final reservation
string simple does not prove conversion cheap. Caching moves the first conversion
to another paid invocation; it does not remove it. PostgreSQL's
[JSON documentation](https://www.postgresql.org/docs/18/datatype-json.html)
also records duplicate-key and numeric-domain behavior that a replacement must
preserve. A linear radix-based member sorter is a plausible ingredient, but a
compatible parser/renderer/error body and its bound have not been supplied.
Compatibility requires the same results and errors, not the same sorting
implementation; this is why the counterexample does not prove impossibility.

Irrelevant invalid native TEXT is another boundary. Eager validation in every
input trigger can reject an otherwise legal native write. Deferring validation
until a relevant status exists must still handle input-first arrival and later
name changes. A validity/error cache is itself retained state with costs and
custody. Its lookup behavior must preserve the original observable error
semantics; a covered miss cannot conceal a relevant conversion failure. No fixed
planner-dependent error order among unrelated rows is established here.

### Ordered heads: selection and installing the selection are different

For each changed source, old/new membership touches at most two reservation
groups. Each group refresh still needs both parent and child head selections:
at most four component seeks, followed by eligible-state maintenance. Lookup
needs its global eligible seek and up to four original native-half rereads.
This is a constant **number** of seeks, not proof that their keys and mutations
cost constant bytes or logarithmic work.

There is a further closure obligation beyond cached trie minima. Suppose a
group's winning short parent disappears and exposes an already retained parent
with an `L`-byte actual ID. A cached minimum can return its logical terminal
without traversing the suffix. Inserting that winner into a separate eligible
trie by reconstructing the complete parent key still reads/copies `L` unrelated
bytes. Walking that unchanged survivor's whole path to alter an eligibility flag
has the same problem. The triggering deletion need not contain those bytes.
The earlier ordered-node slot bound only prices paths actually supplied to it;
it does not establish this head-to-global-update bound.

A positive producer must show an already positioned candidate handle and bounded
ancestor/structural update, or another proof that avoids survivor-length work.
Duplicating every candidate in another structure can be legitimate, but those
copies must be prepaid, inventoried and reclaimed. Assigning a fixed numeric
rank is insufficient if maintaining rank order later relabels many survivors.
This is a missing body, not proof that every ordered structure has this defect.

One useful invariant reduces unnecessary duplication: at one covered snapshot,
an actual parent belongs to one extracted realm/member/reservation group.
Different eligible groups therefore cannot tie on that same parent actual ID.
The child-ID tie is resolved inside its group; replacing only that child need
not change the global parent rank. This is an inference from exact source
identity and single extraction, not an adopted schema change. It does not solve
replacement of the parent head or authorize dropping child C-order selection.

## Private storage, old snapshots and every retained copy

The private heap idea has a valid local advantage.
[`nodeTidscan.c:TidNext`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeTidscan.c)
passes a specified TID and executor snapshot to
`table_tuple_fetch_row_version`. This can avoid a logical-ID index descent.
The conditional 1584/1592-byte fixed-node model therefore remains useful local
evidence. It is not a portable logical-address or inventory guarantee.

Asymptotic local traversal is also not a successful whole-transaction capacity
proof. PostgreSQL documents a limit of `2^32` modifying SQL commands per
transaction through its command identifiers. A multi-command-per-byte SQL body
must cover old/new paths and bulk callers within actual command/allocation/slot
limits; it cannot infer that capacity from a single source TEXT datum fitting.
No implicit smaller key cap or enormous admitted maximum closes this obligation.

PostgreSQL documents that [`ctid` identifies a row version and can change](https://www.postgresql.org/docs/18/ddl-system-columns.html).
For immutable private nodes, permitted ordinary MVCC reclamation can retain old
versions while a registered old snapshot needs them. A saved root read in one
READ COMMITTED statement followed by traversal under later snapshots is not such
protection. The whole traversal needs one protected snapshot or an adequately
proved lock/version protocol. A newer root, old node and recycled slot must
never be combined into a successful lookup or physical-absence claim.

The same distinction applies to original native authority. An old consistent
projection may be a valid historical read; it cannot certify a current writer
fence or Source discharge. PostgreSQL's
[isolation rules](https://www.postgresql.org/docs/18/transaction-iso.html)
require whole-transaction handling of repeatable-read/serializable conflicts.
A writer must not swallow that refusal, traverse using stale assumptions or
retry only a projection statement. Root publication, native mutation, terminal
counts, allocation and inventory roll back together. Failed work remains spent.

| Retained class                                                            | Independent custody/removal obligation                                                         |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Equality and actual-ID bytes, implicit prefixes, node links and summaries | Locate all live copies; preserve shared live attribution; delete released changed paths        |
| Group parent/child structures and eligible ordering                       | Include losing candidates, head payloads and any prepositioned duplicate ordering entries      |
| Roots, terminals, refcounts and logical-to-physical metadata              | Version/table/domain identity; checked reuse only after all live references are removed        |
| Source-half and orphan associations                                       | Either surviving native half remains attributable even when no candidate exists                |
| Scratch and transient publication state                                   | Remove on success; abort atomically; inventory any intentionally committed intermediate state  |
| Free intervals, allocation and pending work                               | Bounded reusable metadata, no immortal per-deleted-account or per-historical-allocation record |
| Backfill, restore reconciliation and coverage state                       | Actual funded owner and completion/non-revival boundary, not cursor EOF or a Boolean           |
| Inventory and its own links/indices                                       | Independently select/remove/probe these too, after removing the copies they identify           |

### Restore-safe inventory need not be a B-tree per byte, but must exist

Invalidating coverage is necessary for relocation; it does not locate relocated
bytes. A restored node at `(48,1)` is not removed by probing its obsolete `(12,3)`
link. An epoch check can reject an incorrect target but cannot enumerate the
missing node. Native eight-family absence says nothing about it.

Adding `inventory(owner,node_id)` with a B-tree entry for every byte-node repairs
discoverability only by introducing `Theta(B* log N)` indexed maintenance. A
second indexed copy of that inventory repeats the problem. Root-level inventory
alone avoids that factor only if its direct traversal remains authoritative for
every retained copy, including after permitted restore. "Independent" means
independent of the invalid links, not necessarily a duplicate of every node.

Two narrowly defined designs could close this part, conditionally:

1. A native segmented arena with bounded-width logical page/slot references,
   direct allocation/access, and owner/source-addressable segment inventory.
   A constant number of indexed owner/source entries may point to linearly
   maintained direct chains. Segment allocation, sharing attribution, empty-space
   reuse and inventory removal must all be proved; no per-node B-tree is hidden.
2. The accepted private-heap restrictions plus an independently funded **complete
   restore reconciliation before admitting bounded erasure or coverage**. Every
   tuple must carry enough independently readable identity/association data for
   reconstruction. All private copies, including scratch, abandoned progress
   and inventory, must be included. New mutations/deletions cannot escape the
   reconstruction cut. Broken root chains alone are insufficient input.

The second is a global maintenance operation priced to the restore owner, not
an account-erasure scan or an amortized free lookup repair. It may rebuild or
discard/reconstruct a rebuildable projection only under its actual owner and
non-revival protocol. It cannot discard permanent native writer fences or claim
Source closure. These are design obligations, not delivered facilities.

Shared prefixes complicate attribution but do not force listing every owner on
every byte-node: source-to-terminal ownership plus a proved shared-node lifetime
can be sufficient while links are valid. Its independent restore reconstruction
must recover that relationship. An old application root retained outside engine
MVCC is another live copy with its own reclamation cost; it cannot be renamed
an invisible dead tuple. Every explicit GC queue, reconciliation log and retained
version is counted in `N` and in copy custody.

## Native integration and successful-callable prices

The inspected DBOS source supplies real transaction boundaries, not optional
application callbacks. [`src/client.ts:enqueueInTransaction`](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/client.ts)
uses the caller-owned native transaction.
[`src/system_database.ts:insertWorkflowStatus`](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/system_database.ts)
and [`src/sysdb_migrations/internal/migrations.ts`](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/sysdb_migrations/internal/migrations.ts)
show separate status/input writes, input conflict retention, a split-input raw
SQL enqueue path and no input-to-status foreign key in migration 109. Projection
hooks must classify stored winners and both-half liveness inside those original
transactions. This reference does not substitute for the repository SDK patch.

All original paths remain required: either-half INSERT/UPDATE/DELETE, no-op and
speculative conflict outcomes, relevant-name/time/ID changes, raw/bulk/caller-owned
enqueue, old writers, fork/recovery/replay and retention. Existing permanent
writer/domain guards keep their authority. An AFTER trigger cannot impose a
transaction-wide lock order on earlier statements or later native rows. The
native-A/root/native-B versus native-B/root cycle remains possible. Safe whole
transaction abort may preserve correctness; a success bound or deadlock-free
claim needs its actual protocol and original deadline, not a per-row diagram.

Pre-I/O quote/apply is still absent for the proposed keys. It must fund its own
metadata reads first, lock/read actual lengths, versions and copy cardinalities,
reserve inclusive operands, then apply under those exact current operands in
the original Pool and frame. Reached quote, failed/stale apply, rollback and
repeat work all pay. Autonomous native writers/backfill/restore require their
own owners; Source funding cannot be manufactured for them.

Existing Work literals remain narrow: retirement `13/7/17/41088/0`, deletion
`144/10/16/8320/0`, and same-command writer check `4/2/4/8192/0` in their existing
axis conventions. They exclude the new extraction, dictionary, ordering,
inventory, allocator and cleanup hooks. Their availability is not a price for
the proposed producer. Internal page/byte work, server results and JavaScript
returned bytes must not be interchanged when deriving new literals.

The precise foreign-price status at this base is:

- **Library local successful bodies are now present.** The exported
  `libraryIdentityFootprint` declares locked-plan, current-capture/current-job,
  seal and effect-page work with all eight Library axes, SQL/binds/result bytes,
  miss/EOF slots and transaction controls. The owner describes these in
  [Library's owner document](../../services/kernel/src/library/README.md), in its
  native identity planner cost section.
- **Normal Source receiving has not adopted all those bodies.**
  [identity-scoped-observations.ts:scopeConsumerFootprint](../../services/kernel/src/semantic/identity-scoped-observations.ts)
  recognizes its own exact statements and returns `undefined` otherwise. It does
  not delegate to the exported Library footprint. The real consumer calls
  `verifyLibraryScopeEffectsSeal` inside that instrumentation, including again
  from `retainIdentityScopeConsumerFence`. Its locked-plan/seal/current-plan SQL
  therefore still needs exact owner recognition/composition. This is a source
  finding, not an executed failure or permission to relax unknown-SQL refusal.
- **The complete successful original parent price is still not established.**
  It must include those reached Library/receiving bodies, new Work bodies,
  repeated fresh Source/History authority, independent receiving/recovery,
  controls and rollback through final commit. The earlier History consumer
  envelope `11588/9856/2731/6843136/0` and five-verifier subtotal of 696320 bytes
  are not a parent. Existing verifier, directory, smaller remaining and Library
  child allowances stay binding. Derive a componentwise maximum over complete
  finite paths, counting nested work once; do not invent a successful zero.

This report does not audit or repair those foreign producers. It identifies
the exact remaining successful-callable composition, correcting the inherited
claim that Library's successful page/verifier implementation itself is absent.

## Shared patterns and smallest explicit alternatives

The primary sources share useful ingredients: exact bytes and terminal state;
prefix-aware navigation instead of repeated whole-key comparison; direct
protected storage references; explicit ancestor state; atomic publication; and
reuse tied to actual lifetime. They do not share a ready-made Work producer.
PostgreSQL supplies transactional machinery, Rax demonstrates string algorithms
and their copying hazards, and DBOS exposes the native transactions that must
participate. Combining their names does not combine their proofs.

The String B-tree paper's Problem 1 gives insertion/deletion of an `m`-character
string in `O(m/b + log_b k)` disk accesses, using pointers to external strings
and prefix-aware page routing. It also states CPU work proportional to `b` times
the disk-access bound; this is not a theorem that every SQL point costs one
operation. For fixed page capacity, it provides an abstract additive direction.
Its algorithm does not implement PostgreSQL MVCC, owner inventory, collation or
compatible extraction. It refutes a universal string-index impossibility claim;
it does not establish an available extension.

| Explicit choice                                 | What changes                                                                                                                                   | What still must be proved                                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retain target and SQL-only deployment           | No contract change; keep immutable heaps provisional while supplying the missing connected algorithm                                           | Compatible linear extraction, head updates without survivor-byte work, direct independent inventory and whole-transaction capacity; no such complete SQL body is established here |
| Retain target; add a native producer deployment | Package/support a prefix-aware exact string/ordered directory and directly addressed storage/inventory, plus compatible linear extraction      | WAL/recovery, old snapshots, uniqueness, head-handle updates, all copies, restore, full native transaction integration and inclusive prices                                       |
| Retain SQL-only deployment; change the bound    | Admit actual conversion cost plus byte-node indexed work, e.g. `P_PG + O((d+q) log N)`, with separate survivor/restore costs unless eliminated | Exact semantics, actual full-ID representation, prepaid literals, original owner composition and every original child allowance; this is an explicit contract relaxation          |
| Narrow a deployment precondition only           | Require demonstrated deterministic equality and controlled private-heap maintenance with completed restore reconstruction                      | This closes specific collation/relocation obligations only; canonicalization and ordered/inventory costs remain, so it is not a positive answer alone                             |

PostgreSQL permits new index types through
[add-on access-method code](https://www.postgresql.org/docs/18/indexam.html).
[`CREATE ACCESS METHOD`](https://www.postgresql.org/docs/18/sql-create-access-method.html)
requires a registered handler and superuser authority. A C extension or custom
storage manager therefore requires explicit server packaging, privileges,
supported-version/upgrade/recovery policy and operational ownership. Wrapping
an in-memory trie in a function or supplying only an external-key comparator
does not meet those obligations. Existing SQL tables, triggers, SP-GiST and TID
scans are available mechanisms; the required complete native producer is not.

A new input cap, digest identity, residual collision scan, enormous finite-domain
coefficient or renewed owner frame is not an alternative under the retained
contract. Changing when conversion errors occur or requiring successful native
writes to validate previously arbitrary TEXT would also be a product-contract
change, not a storage optimization.

The smallest next deliverable is one connected producer design closing compatible
linear extraction, constant-count ordered head changes without survivor-byte
work, and independent copy discovery/reclamation, with complete original-call
quote/apply bodies. Adversarial proof must cover forced digest collisions if a
digest is retained, equal/unequal long prefixes, short-key deletion exposing a
long winner, old snapshots across publication/reuse, abort/conflict winners,
either-half/orphan transitions, and relocated unreachable restored copies.
These are future producer proof obligations, not product tests executed by this
research. No architecture is adopted by this report; the manager compares the
independent results before changing the owning contract.
