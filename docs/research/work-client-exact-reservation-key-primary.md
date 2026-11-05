# Exact legacy reservation keys: PostgreSQL representation and accounting

Research date: 2026-11-02. Repository source inspected: `1556f48ef91b0aee8719fa6321e9b35d500c7dc0`.
This is independent source research, not an implementation, installation receipt, owner decision or execution result.
All assertion, typing, acceptance, native and growth execution described below is **UNRUN**.

## Result and decision boundary

Do not implement the earlier full-reservation B-tree indexes or replace them with a digest bucket.
An exact byte trie can assign collision-free reservation intern IDs without copying complete prefixes.
However, implementing each trie transition through an ordinary PostgreSQL index has a separately chargeable
indexed seek. Its maintenance is `O(d log N + Q log N + B)`, where `Q` counts visited or reclaimed trie nodes
and can be proportional to changed text bytes. It does not establish the requested uniform
`O(d log N + B)` bound. A stored function does not eliminate those seeks.

The strongest available built-in alternative is SP-GiST `text_ops`, not an ordinary B-tree.
It accepts long values by splitting prefixes and suffixes. The inspected implementation repeatedly allocates
and copies suffixes during insertion and accumulated prefixes during search. Its source does not supply the
required linear byte-work derivation. It also supplies neither unique text interning nor the ordered
per-group candidate-head interface. These are specific gaps, not a claim that long-string indexes are impossible.

String B-trees and pointer-based radix dictionaries show viable algorithms in other storage models.
Moving their nodes into logically indexed SQL rows changes their access cost. PostgreSQL's direct heap-TID
access offers another route: immutable, copied paths can avoid that additional logarithm, but depend on a
physical-storage maintenance/restore contract that is not established here. A native index is another route.
Neither complete producer is present in the inspected stack. Exhaustive compatibility hooks are also
prospective, not facilities established by the installed SDK source files.

There are two explicit owner choices; neither is silently selected by this report:

1. Preserve the uniform bound and exact semantics. Require a separately reviewable native exact-string
   producer, including the ordered actual-ID tie keys, with literal inclusive costs and deployment authority
   or an explicitly owned immutable heap-TID placement as described below.
   The original complete implementation must consume that producer; a SQL wrapper around an unpriced
   dictionary is insufficient. This is the recommended choice if the uniform bound is mandatory.
2. Select a finite physical-domain interpretation for an ordinary SQL trie. This introduces no new text cap,
   but admits length-proportional indexed probes and must explicitly fund their actual lengths and worst-case
   maxima. It must not be described as a uniform linear-byte algorithm or admitted with the old allowances.
   Ordered actual-ID representation and full-call costs still need completion before implementation.

The unresolved contradiction is **model-scoped**: logical-ID indexed-row traversal charges `Q log N`, while
the uniform contract permits only `d log N + B`; `Q` is not bounded by `d` independently of text length.
Direct physical addresses escape that argument but require the additional placement contract below.
The available complete producers do not close the gap. This finding holds with short ordinary workflow IDs,
one changed native input, no hash collision, and no accumulated history. It does not establish a lower bound
for every possible PostgreSQL extension or every deterministic string dictionary.

Independently, the current Library handoff returns `unavailable` and its seal verifier returns `false`.
There is no successful producer body from which to derive its complete literal cost. A successful whole-Source
aggregate cannot be invented from that adapter. This report scopes that remaining dependency explicitly.

## Evidence, revisions and limits

The following supplied historical evidence was read completely through `git show`, at
`1196dc8d59bf3e91b335e473db13d719b70ed9d4`:

- `docs/research/work-client-source-accounting-reconciliation.md`, all 242 lines.
- `services/kernel/test/work/legacy-leave-accounting.test.ts`.
- `services/kernel/test/work/legacy-leave-key-domain.test.ts`.
- `services/kernel/test/work/legacy-leave-lookup.test.ts`.

Those authored tests are evidence of intended assertions, not executed outcomes. Their absence as files at the
current base does not authorize recreating or changing them in this research-only submission. No existing or
frozen test was edited. The full supplied `work-client-bounded-legacy-contract.md` decision and the older
adopted [bounded lookup research](work-client-bounded-legacy-lookup.md) were also read. No other new report on
this representation question was consulted, and no answer was coordinated with another author.

Repository files below are pinned to the repository revision at the top of this report. Main primary sources:

| Source                                                                                                                 | Revision and licence                                                             | Inspected material                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PostgreSQL source](https://github.com/postgres/postgres/tree/700b422af7e26cf310caf3fb76d78f4c8ca39c1f)                | `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`; PostgreSQL License, `COPYRIGHT`      | `src/include/access/nbtree.h`; `src/backend/access/nbtree/{nbtutils,nbtsearch}.c`; `src/backend/access/spgist/{spgtextproc,spgdoinsert,spgscan}.c`; `src/backend/utils/adt/{varlena,jsonb_util}.c`; `src/include/utils/memutils.h`; `src/backend/executor/nodeTidscan.c`; `src/backend/access/heap/heapam.c`; `src/include/storage/itemptr.h` |
| [DBOS Transact TypeScript](https://github.com/dbos-inc/dbos-transact-ts/tree/980dc55095f445b189aecb59e7f3334345179f65) | `980dc55095f445b189aecb59e7f3334345179f65`; MIT, `LICENSE`                       | `src/client.ts`, caller-owned transactional enqueue                                                                                                                                                                                                                                                                                           |
| [Rax](https://github.com/antirez/rax/tree/1927550cb218ec3c3dda8b39d82d1d019bf0476d)                                    | `1927550cb218ec3c3dda8b39d82d1d019bf0476d`; BSD-2-Clause, `COPYING`              | `README.md`; `rax.c`, especially `raxLowWalk`, `raxGenericInsert`, `raxRemove`; node layout in `rax.h`                                                                                                                                                                                                                                        |
| [The Adaptive Radix Tree](https://db.in.tum.de/~leis/papers/ART.pdf)                                                   | Leis, Kemper and Neumann, ICDE 2013, DOI `10.1109/ICDE.2013.6544812`             | Primary research paper; scholarly publication, not a software licence                                                                                                                                                                                                                                                                         |
| [The String B-Tree](https://www.inf.fu-berlin.de/lehre/SS01/biodaten-seminar/papers/String-B-tree.pdf)                 | Ferragina and Grossi, JACM 46(2), 1999, pp. 236–280, DOI `10.1145/301970.301973` | Primary research paper, especially dynamic dictionary/string-search problem; ACM publication, not a software licence                                                                                                                                                                                                                          |

Existing reference clones were reused under the permitted main-checkout `.reference/` directory:
`library-shelf-maintenance/postgres`, `search-worker-outcome-harness/dbos-transact-ts` and
`work-client-exact-reservation-key/rax`. Their reuse is recorded in `.reference/INDEX.md` with revision,
URL, licence and date. No reference project was installed, built, imported or executed. Designs below are
recommendations for this stack; no source files or substantial source passages are proposed for copying.

Read-only installed DBOS evidence came from
`node_modules/.bun/@dbos-inc+dbos-sdk@5.5.3-preview/node_modules/@dbos-inc/dbos-sdk/`:

| Artifact                                                      | SHA-256                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `dist/src/client.js`                                          | `9031a6d260650e4e39f225e366e43eac8d7646fb799ab8270d7117ad0826a971` |
| `dist/src/system_database.js`                                 | `7f8acb0c80120ad0afa59e7848bbebbfcae5d3f0754d459764b923c1b0343f2b` |
| `dist/src/sysdb_migrations/internal/migrations.js`            | `d187c8a19e4c3141392c73701899ca0005155febdabdfde481bf5782fe61daff` |
| Repository `patches/@dbos-inc%2Fdbos-sdk@5.5.3-preview.patch` | `16f393956300e03b04794ec58058c98f6398bcac7d55fdbd68a6f8b84c359806` |

These identify files inspected, not a migration run, installed new hooks, deployment receipt or satisfied producer
precondition. The launch dependency receipt list is empty. No database failure was executed.

The available PostgreSQL best-practices skill and its short-transaction guidance were read. They support short
transactions and bounded waits, but provide no exact-string complexity guarantee and relax none of this contract.
The repository's [architecture](../architecture.md), including its MVCC exclusion introduced at
`4736cfd8a3c3fb1aa86ce7d07691fd9af1ecb62f`, remains the accounting model.

## Exact relation that the representation must preserve

The authority is [the current WorkClient](../../services/kernel/src/work/client.ts), not the names or shapes
chosen by current producers. Recognition is exactly
`/^realm:leave:([0-9a-f-]{36}):([0-9a-f-]{36})$/`. This is a loose lowercase character/length pattern,
not validation of two RFC UUIDs. Nonmatching requests go straight to the original SDK method.
For a recognized request, `getWorkflow(requestedID)` takes precedence over compatibility lookup, even when
that workflow has another name or no steps. Preserve SDK options, errors and original-ID fallback.

When no exact native status exists, a matching pair consists of:

| Half   | Required stored status and extracted input text                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| Parent | `name = 'community.leave'`; `#>> '{json,0,realmId}' = realm`; `#>> '{json,0,memberAccountId}' = member`             |
| Child  | `name = 'accounts.membership'`; `#>> '{json,0,principal,id}' = realm`; `#>> '{json,0,memberAccountId}' = member`    |
| Pair   | Both statuses have their actual-ID-matched input row; extracted `#>> '{json,0,reservationId}'` values compare equal |

Extraction is PostgreSQL `inputs::jsonb #>> path`. SQL NULL, including absent/null reservation, does not match.
Empty extracted text does match itself. Number `42` and string `"42"`, boolean `true` and string `"true"`, and
structured values with equal extracted jsonb text retain their current behavior. JavaScript serialization,
string trimming, Unicode normalization and UUID casting are not substitutes for this expression.
No application, queue, role, `principal.kind`, parent linkage or authorization predicate may be added.

The accepted tie order is parent `created_at DESC`, parent actual workflow ID `ASC COLLATE C`, child actual
workflow ID `ASC COLLATE C`. Reservation interning must not become the tie order. If timestamps can be NULL,
preserve PostgreSQL's existing default `DESC NULLS FIRST`; do not silently select `NULLS LAST`.

The byte-trie analysis below is for deterministic text equality, where PostgreSQL `texteq` uses byte length and
`memcmp`. A nondeterministic collation uses `text_cmp` instead. The installer must establish the actual native
expression collation; it cannot unilaterally change the relation to `COLLATE C` for reservation equality.
The accepted explicit C collation is for the two actual-ID tie keys. No deployment collation was queried here.
See pinned `varlena.c:texteq` and [PostgreSQL collation documentation](https://www.postgresql.org/docs/18/collation.html).

Deleting either status or input must invalidate the pair in that same original transaction. Separate native
payload tables have no general source-half cascade to rely on. Native writer closure, erasure permission,
membership publication, compensation, receiving and physical absence remain their original authorities.
Internal intern numbers may identify dictionary entries; they never identify native workflows or authorize deletion.

## Why ordinary full keys and hashes are insufficient

Migration `109_workflow_payload_tables` declares native `inputs TEXT`. `insertWorkflowStatus` and SQL enqueue
store text without a reservation UUID/length restriction. A 16,384-byte high-entropy reservation is legal and
fits the separate History operation's 65,536-byte payload bound. That History bound is not a global native input cap.

Pinned `nbtree.h:BTMaxItemSize` and `nbtutils.c:_bt_check_third_page` impose a roughly one-third-page index-tuple
limit. A leaf tuple with an incompressible 16,384-byte reservation cannot fit an ordinary default-page B-tree.
The source explicitly explains why external TOAST pointers are not used there. Heap TOAST support therefore
does not solve an arbitrarily long ordered index key. This is static source proof, not an observed SQL error.
See also [TOAST](https://www.postgresql.org/docs/18/storage-toast.html).

| Proposed shortcut                            | Exact failure under this contract                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| UUID cast or length limit                    | Removes legal extracted text and introduces new native input errors                 |
| Truncated ordered key plus residual equality | Arbitrarily many retained unequal strings can share that prefix                     |
| Digest as intern/group identity              | Distinct texts are merged on collision                                              |
| Digest plus collision rejection              | Adds a forbidden new error for a legal native input                                 |
| Digest plus full-text bucket scan            | Correct equality, but no worst-case bound on bucket members or empty residual polls |
| Prefix/digest index with application repair  | Reintroduces population-dependent lookup or stale coverage                          |

PostgreSQL's [hash-index documentation](https://www.postgresql.org/docs/18/hash-index.html) describes four-byte
hash entries and overflow chains, not unique exact long-text identity. A larger cryptographic digest changes
probability, not the worst-case argument. SHA blocks in the authored fixture generate incompressible data only.

An additional width obligation applies to actual workflow IDs: fitting the native standalone primary-key
index does not prove that adding a group, timestamp and tie columns still fits another B-tree tuple.
Compression makes a universal character-count inference especially unsafe. A complete implementation must
prove the whole composite's accepted domain or provide external ordered keys for it too. The 1,024-byte check
in the bounded SDK fence port is not a reservation cap or a universal constraint on all legacy native rows.

## The ordered group layer, separated from the exact dictionary

For an exact reservation intern `r`, use group `(realmText, memberText, r)` and internal group ID `g`.
The recognized request limits reachable realm/member texts to the exact 36-character ASCII pattern; retaining
only such reachable associations is a semantic consequence of recognition, not an added reservation restriction.
An installer must still treat collation semantics correctly. The following widths are logical key payloads,
excluding PostgreSQL tuple headers/alignment:

| Relation/index      | Key payload                                                          | Other required state                                                                    |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Group identity      | two reachable 36-byte texts plus 8-byte reservation intern: 80 bytes | 8-byte `g`, source/candidate reference counts                                           |
| Source by actual ID | exact native ID, variable                                            | status/input presence and revisions, minimized extracted locators, input length, intern |
| Parent candidates   | `g` 8 + created-at 8 + ordered actual-ID external key                | original actual ID and authoritative source-half reference                              |
| Child candidates    | `g` 8 + ordered actual-ID external key                               | original actual ID and authoritative source-half reference                              |
| Eligible groups     | realm/member 72 + best-parent time 8 + ordered parent/child keys     | `g`, both original actual IDs and source revisions                                      |

The variable entries are obligations, not an assertion that their complete payload fits a B-tree.
If suitable exact ordered keys exist, the group algorithm is simple:

```text
reconcile_one_native_change(old, stored_new):
    derive the old/new complete candidate; invalidate on either missing source half
    lock the distinct old/new groups in ascending stable group-ID order
    remove old candidate; insert new candidate, using actual stored conflict outcome
    for each of at most two groups:
        select its best parent and best child with indexed ordered LIMIT 1 probes
        replace/delete its single eligible record
    delete a group when it has no source/candidate references
```

There are at most **two group-successor selections**, one per old/new group. Each selection can contain two
independent ordered point/range-head probes, so its accounting is two probes, not one free join. No enumeration
of parent-by-child combinations is needed. Repeated equal reservations do not increase the number of selections.
The global eligible index answers both hit and miss through the realm/member prefix and agreed order, with
one head seek. A selected pair is verified through its four exact native status/input keys in the same snapshot;
inconsistency refuses coverage rather than polling more groups. The original SDK then receives the actual child ID.

This layer avoids the old unmatched-parent scan. It does not solve the long-string dictionary or variable
actual-ID ordering below it. Placing an opaque function in either index column would hide precisely the work
that must be priced. No candidate layer shown here is claimed installed or ready to cut over.

## Serious candidate A: an exact SQL byte trie

This candidate gives a constructive exact-identity algorithm and exposes its complete length-dependent work.
It is useful for the finite-domain owner choice; it is rejected as proof of the uniform bound.

Use the exact extracted text's server-encoding bytes and an out-of-alphabet terminator 256. Byte labels 0–255
plus that terminator distinguish a string from every extension, including empty text. SQL NULL has no path.
For deterministic equality, terminal nodes are equal if and only if the extracted texts are equal.
No hash participates. Invalid encoding/NUL handling follows PostgreSQL text, not a new trie input validator.

```text
control(singleton smallint PK, version bigint, highwater bigint, coverage bigint)
node(id bigint PK, parent bigint, symbol smallint, child_count smallint, refs bigint)
    UNIQUE(parent, symbol)                 -- fixed 10-byte key payload
    -- root ID 0 is permanent; other PK key payloads are 8 bytes
free_interval(lo bigint PK, hi bigint UNIQUE)
    -- disjoint, nonadjacent ranges of unallocated internal node numbers
```

Node scalar payload is 28 bytes; interval payload is 16 bytes. `child_count` is at most 257. `refs` counts
source-input associations, not only eligible pairs. The source locator holds a terminal ID and length, not
another complete prefix string. A node ID is internal storage capacity, not a digest or an accepted native ID.
As with any fixed-address storage implementation, integer/address capacity and resource exhaustion must be
specified; overflowing an allocator must never merge entries. No smaller reservation-length cap is inferred.

The deliberately coarse synchronization is one real `UPDATE control SET version=version+1` per original
native mutation transaction, held until its original commit. It changes a tuple version, rather than merely
taking a snapshot-invisible advisory lock. At READ COMMITTED, dependent statements follow that lock using
fresh command snapshots. At REPEATABLE READ, a conflicting old snapshot must abort rather than publish stale
derived state. A design using only an advisory lock plus stale reads is incorrect.

Lock order for a cooperating writer is existing native writer fences in their established order, control,
actual-ID source state, dictionary transitions, affected groups in stable order, candidates, eligible records.
An AFTER hook may already hold a native row lock. A row trigger cannot retroactively impose a transaction-wide
order on arbitrary old multirow writers. Such writers can deadlock; PostgreSQL must abort the whole original
transaction, with all projection changes rolled back. Do not swallow the error, commit only the native half,
or add a hidden retry. Eliminating those deadlocks requires an SDK admission hook before source DML, itself a
new producer obligation. Bounded lock waits use the original deadline, never renewed time.

```text
intern(text):                              -- control already locked
    p = root
    for symbol in bytes(text) followed by 256:
        n = point_get node WHERE parent=p AND symbol=symbol
        if absent:
            id = allocate_slot()
            INSERT node(id,p,symbol,0,0)
            UPDATE node[p] child_count += 1
            n = id
        p = n
    UPDATE node[p] refs += 1
    return p

release(terminal):
    UPDATE node[terminal] refs -= 1 RETURNING parent, child_count, refs
    while current != root AND refs == 0 AND child_count == 0:
        DELETE node[current] RETURNING parent
        free_slot(current)
        UPDATE node[parent] child_count -= 1 RETURNING parent, child_count, refs
        current = parent
```

Read each input buffer once and address symbols by offset; do not materialize `substring(input,1,i)` at each
depth. A full-prefix-key implementation has quadratic retained/copy bytes. Parent links and exact counts
avoid enumerating children on deletion. There is no Patricia recompression into a surviving long key.
If the last reference disappears, cleanup walks only the just-released path and stops at the first live node.
That path is charged to the **old** changed input, including DELETE, not to a fictional zero-length new input.

Slot reuse need not retain an unbounded stack of historical IDs. Allocation takes the first free interval by
an ordered head seek, removes its first slot, and replaces its remainder; absent an interval, increment
transactional `highwater`. Freeing a slot seeks the intervals whose `hi=id-1` and `lo=id+1`, removes at most
those two, and inserts their union with the slot. If the union ends at `highwater`, reduce `highwater` to
`union.lo-1` instead. Since intervals were nonadjacent, no further coalescing cascade is possible.
There are at most live allocated slots plus one free intervals; an entirely empty dictionary has none.
Updates roll back with the caller. Repeated delete/reinsert cannot grow retained allocator metadata.

Every source input holds its intern reference even if its status has not yet arrived. If either native half
is absent, it contributes no candidate. Deleting status removes candidates immediately but may retain the
still-authoritative orphan input association; deleting input removes that association and releases its intern.
Deleting both leaves no account-linked synchronization tombstone. An actual-ID lock/state record is removed
when both halves are absent, after candidates and references have been removed. Reuse re-reads native state.
This is exact source-half liveness, not the incorrect rule “keep a candidate until both halves disappear.”

Multiwriter equal insertion is serialized at control: the second writer sees the same terminal or aborts on
its incompatible snapshot. Different strings cannot share a terminal. Rollback exposes neither allocated
nodes nor a partial eligible record. A crash before commit rolls back all source and projection changes;
a crash after commit leaves both. SQL transaction atomicity supplies this behavior, not the trie alone.
See [trigger transaction behavior](https://www.postgresql.org/docs/18/trigger-definition.html).

### Literal local work and the failed uniform bound

Let `L` be the actual extracted reservation byte length, `q=L+1` include its terminator, `a<=q` newly created
nodes, and `z<=q` reclaimed nodes. Let `h(N)` be an ordinary fixed-width index descent bound at current size.
Count successful logical rows plus one charged row slot for a miss. Counts below describe the pseudocode,
not a measured plan or existing SDK price. Each DML statement addresses at most one row.

| Primitive                                           | Rows | Points | Statements |                         Typed scalar payload bound |
| --------------------------------------------------- | ---: | -----: | ---------: | -------------------------------------------------: |
| Control version update                              |    1 |      1 |          1 | 26 bytes of fields, at most twice for input/output |
| Read one transition                                 |    1 |      1 |          1 |            10-byte key plus at most 28-byte result |
| Insert node or update its count/reference           |    1 |      1 |          1 |          at most 28-byte input plus 28-byte result |
| Allocate slot, including interval split and control |    4 |      4 |          4 |    each addressed record at most 28 bytes each way |
| Free slot, including two neighbours and coalescing  |    6 |      6 |          6 |                         same fixed scalar envelope |
| Release terminal and return its state               |    1 |      1 |          1 |                         same fixed scalar envelope |
| Reclaim node plus decrement/read parent             |    2 |      2 |          2 |    same fixed scalar envelope, excluding slot free |

Allocation's four slots are interval head read, interval delete, remainder insert, control update.
Freeing's six are two neighbour reads, two deletes, one interval insert and one control update; alternatives
that do less still reserve all six. These prices include unsuccessful point lookups and do not assume an
interval exists. Node uniqueness-index and PK maintenance is additional engine index work, not extra SQL rows.

Thus an intern call, including its own control admission, reserves on each of the three count axes at most
`2 + q + 6a`: one control, `q` transitions, `a*(4 allocation + 1 insert + 1 parent update)`, one terminal reference.
A release reserves at most `2 + 8z`: control, terminal decrement, then `z*(1 delete + 6 free + 1 parent update)`.
An update can intern new before releasing old, avoiding needless deletion/recreation when equal; its safe sum
is `4 + q_new + 6a_new + 8z_old`. Shared control admission can subtract one only when the final body proves it.
Native source reads, source locator writes, group work and caller transaction controls are not in those sums.

For these fixed scalar records, a conservative **typed-value** byte formula is `56 * R`, where `R` is the row
slot sum above: every primitive's complete argument or result record is at most 28 bytes in each direction.
Add the retained input/extracted buffers by their actual lengths, the native/source locator bytes, and fixed
SQL/protocol framing if the eventual accounting contract counts it. This is not permission to install `56R`
as an SDK literal without the actual body and serialization. No unbounded text is returned in a node record.
The input path can be streamed on insert and followed upward on release; it need not retain `q` prefix buffers.
Final dictionary storage is `28 * live_nodes + 16 * free_intervals`, plus ordinary tuple/index overhead and
the source terminal references. It is linear in live text prefixes, not historic prefix copies.

Engine-visible work is bounded by a constant number of fixed-width B-tree searches/updates per row slot,
each costing `h(N)` plus bounded tuple/page work. Therefore the dictionary's literal derivation is
`O((q+a+z) h(N) + L_old + L_new)`; its rows, points and statements grow with `q+a+z`.
High entropy makes `a` close to `q`; a long common prefix makes `q` large even with `a=0` and no unrelated rows.
Deleting the last reference makes `z` large. Repeated equal inserts still traverse `q` transitions.
No digest-shaped adversary changes correctness, but it also cannot remove those charges.

Here `N` counts logical indexed records. Rows, point probes, SQL statements, returned/retained value bytes,
and index traversal/copy work are distinct measures. Ordinary index splits, WAL and fixed tuple changes are
engine work attached to the charged operations; repeated explicitly designed branch searches and suffix copies
are not covered by the architecture's exclusion. Only invisible MVCC visibility/version skipping and engine
vacuum maintenance are excluded. An `engineRequests` allowance of zero does not mean zero PostgreSQL work.

For `d` changes, write `B=sum(old/new changed native input bytes)` and retain the actual extracted lengths
separately as `E`. Even assuming extraction and buffer processing linear in `B+E`, the bound is
`O(d log N + E log N + B)`, not the requested uniform `O(d log N + B)`.
Making `intern` one SQL call changes client statement count only; the function's internal rows, points,
statements and copies remain in its enclosing dispatch. Batch lookup cannot know untraversed node IDs for free.

### Physical finite bounds do not disappear

PostgreSQL's varlena representation and [limits](https://www.postgresql.org/docs/18/limits.html) give finite
field/allocation limits, conventionally described as 1 GB; TOAST documents the `2^30-1` representation limit
including header bits. The accepted domain already has these engine limits. No new reservation cap is needed
to establish a finite `q_max` for every successfully produced PostgreSQL text datum.

Consequently, in a model fixing that entire physical domain as a constant, `q log N <= q_max log N` is a finite
bound. That statement is mathematically true. It neither proves a uniform linear-byte bound nor authorizes
charging one row for a billion-transition operation. A finite-domain implementation must retain the literal
`q`, `a`, `z`, bytes and group costs above, then derive fixed dispatch maxima from their admitted domain.
It must also obey safe-integer checks, the original deadline and every smaller remaining allowance. Failure to
fund or finish is refusal/rollback, not permission to cap, silently drop a legal match or renew the frame.

`E` cannot simply be set equal to native JSON text length. JSON escaping, canonical object output and numeric
formatting affect extracted length. The current `jsonb_util.c:uniqueifyJsonbObject` sorts object pairs with
`qsort_arg`; repeated equal-length key comparisons examine key bytes. A uniform byte-work proof must include
native JSON conversion/extraction, rather than call the cast constant or hide it as MVCC work. A native producer
could use a proven byte-linear canonicalization scheme, but must reproduce PostgreSQL's actual extracted text.
The SQL trie argument already fails for a simple string value, independently of this additional obligation.

## Serious candidate B: stock SP-GiST text indexing

An external-key table could be `dictionary(slot bigint PRIMARY KEY, value text, refs bigint)` with a
nonunique SP-GiST index on `value text_ops`. The SP-GiST key is segmented text, with `int2` labels and text
prefixes/suffixes; it is not a fixed-size digest. Core code handles page concurrency and logging.
The built-in [operator table](https://www.postgresql.org/docs/18/spgist.html) includes text equality but no
text ordering operator for an `ORDER BY ... LIMIT 1` candidate index. Long-value support does not mean
unique enforcement or a complete group-successor mechanism.

An interning wrapper would still need serialization around equality-search/insert, reference updates, exact
deletion by slot, source-half hooks and cleanup. A unique hash index is not a replacement for that wrapper.
Keeping the dictionary row unique by protocol can limit _equal live values_ to one; it does not prove a bound
on all index branches visited, insertion copies, or unrelated unequal values. Putting long `INCLUDE` values
in a leaf is also not a solution: `spgdoinsert.c` checks that the remaining leaf tuple fits on a page.

Pinned source details establish the byte-work gap:

- `spg_text_config` sets `longValuesOK=true`. `SPGIST_MAX_PREFIX_LENGTH` is
  `max(BLCKSZ - 258*16 - 100,32)`, or 3,964 at an 8,192-byte page.
- `spg_text_picksplit` limits the common prefix and constructs suffix datums. `spg_text_choose` constructs
  `restDatum` using `formTextDatum`, which allocates and `memcpy`s the remaining suffix at each matched node.
- `spg_text_inner_consistent` reconstructs accumulated text and compares it against scan keys. The scan core
  can copy reconstructed values into child search state. Prefix reconstruction is real design-visible work.
- `checkAllTheSame` in `spgdoinsert.c` can distribute indistinguishable node labels across multiple children;
  scan consistency must return all such children or none. Interning equal live values is not itself a proof
  that every adversarial insertion/deletion history avoids this state. No constant branch bound is claimed.

For a path consuming chunks of at most `c` bytes, remaining-suffix copies have the explicit sum
`S = sum(max(L-i*c,0))`. With a long single/common-prefix path, `S` grows as `Theta(L^2/c)` over the length
parameter. Accumulated-prefix reconstruction has the analogous sum in the other direction. This is an
algorithmic source analysis, not a benchmark, database error, or claim that every index shape pays that sum.
It rules out declaring stock suffixing a demonstrated `O(L)` byte algorithm merely because each byte is stored
once in the final tree. The physical-domain constant argument remains possible, with its actual copies charged.

Using stock SP-GiST is feasible PostgreSQL DDL, subject to privileges and tested server version. Using it as
the requested complete bounded dictionary is **unproved**. An opclass rewrite would be a new native producer:
it must eliminate repeated copies, prove branch/leaf bounds, and specify equality, uniqueness, slot lifetime,
delete/reinsert and vacuum behavior. This report does not assign that hypothetical producer a zero cost.

## Serious candidate C: native radix or external string index

ART adapts node fanout while consuming key bytes; Rax compresses unary paths and uses pointers to child nodes.
Their shared useful pattern is exact bytes plus a distinct end-of-key condition, not digest equality.
Fixed-alphabet branch search can be bounded independently of the number of keys when node access is direct.
The pointer model is the material difference from `SELECT node WHERE id=...`.

Rax's `raxLowWalk` reads compressed bytes and node label arrays; `raxGenericInsert` splits prefixes.
`raxRemove` walks the parent stack, frees dead nodes, then can scan and copy a surviving unary chain to
recompress it. That last copy can involve surviving key bytes, so “delete only costs removed bytes” cannot be
assumed from a radix-tree name. Rax supplies no PostgreSQL WAL, MVCC, rollback, source-half triggers or
cross-process lock protocol. Embedding the unchanged in-memory structure in a function is not persistence.

The String B-tree paper gives a positive external-memory string-dictionary route. Its Problem 1, pp. 239–240
and section 2.1, inserts/deletes an `m`-character string in `O(m/b + log_b k)` worst-case disk accesses,
where `b` is the block capacity and `k` the number of strings. Prefix search costs
`O((pattern_length + output_count)/b + log_b k)`. Index space is `Theta(k/b)` blocks, in addition to string
storage. Prefix information and Patricia structures prevent repeatedly rescanning whole strings at each level.
These are the relevant dictionary bounds, not the different suffix/substring update bound in Problem 2.
They do not describe PostgreSQL's existing B-tree tuple format or an available SQL extension. They refute a
universal impossibility claim; they do not install a storage engine here.

A serious native producer would need all of the following as inspectable code and literal prices:

| Mechanism          | Required details before adoption                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key storage        | Exact server-encoding bytes, terminal marker, segmented immutable byte arena; bounded-width page/slot references, no full key in an ordinary B-tree tuple       |
| Traversal          | Actual page/node access algorithm; branch lookup cost; no per-byte SQL index descent; every byte comparison/copy counted, including long common prefixes        |
| Equality/interning | Atomic unique terminal insertion, refcounts, equal and unequal concurrent writers, no collision errors; no native ID alias                                      |
| Ordered keys       | Exact C-order actual workflow IDs and time/null ordering; stable candidate successor interface, not an unrelated surrogate-number order                         |
| Locking            | Native fence order, index-page/slot order, root splits, old snapshots, lock wait/deadline; whole original transaction abort on conflict                         |
| Persistence        | WAL for every mutation, recovery/redo, abort/undo or equivalent visibility, crash-safe allocation and publication                                               |
| Lifetime           | Source references and index references; bounded deletion and reclamation; no survivor-length recompression or whole historic-prefix sweep charged to one delete |
| Reuse/restore      | Slot generation/ABA protection, safe reclamation with old snapshots, independent coverage epoch, atomic refusal after restore until current rebuild is complete |
| Inventory          | All arenas, pages, nodes, prefixes, candidates, locators, eligible state and progress copies associated with native/account custody                             |
| Accounting         | Internal rows/points/statements, page work and byte-copy formulas; no opaque extension call treated as one free point                                           |

A fixed-width external-key B-tree opclass alone is not enough. If its comparator follows an external slot
through an ordinary SQL index and re-compares long strings at each tree level, it adds those accesses and
`L log N` comparison bytes. If referenced bytes change, old B-tree ordering becomes invalid. Keeping them
immutable leaves lifetime and vacuum dependencies to solve. Marking the comparator immutable does not solve
any of these facts. A native index with prefix-aware comparisons is a substantially different producer.

Privilege/deployment requirements are real: ordinary tables, triggers and indexes need ownership/DDL rights
in the SDK database. A C implementation needs server-side binary/control/SQL files installed for each server
and compatible major version. [CREATE EXTENSION](https://www.postgresql.org/docs/18/sql-createextension.html)
does not upload missing code; superuser is normally required unless a qualifying trusted extension is available.
[CREATE OPERATOR CLASS](https://www.postgresql.org/docs/18/sql-createopclass.html) and
[CREATE ACCESS METHOD](https://www.postgresql.org/docs/18/sql-create-access-method.html) require superuser.
A managed service's permitted-extension list and deployment/recovery support must be established, not assumed.
No permission, packaged extension or successful producer receipt for this design was supplied or inferred.

## Serious candidate D: immutable heap-TID paths

Do not infer that every SQL row access requires a B-tree lookup. Pinned `nodeTidscan.c:TidNext` fetches a
specified tuple version through the table access method. `heapam.c:heap_fetch` reads the block named in its
item pointer and addresses the item offset directly; `itemptr.h` specifies the six-byte block/offset pointer.
This is a relevant native PostgreSQL mechanism, not a cryptographic or alias identity.

A conditional design uses a private unindexed heap of **immutable** trie nodes, an indexed singleton root,
and `SELECT ... WHERE ctid=$1::tid` for each transition. A fixed 256-element non-null `tid[]` child array uses
1,536 element bytes plus the 24-byte one-dimensional array header on the inspected layout. An invalid TID
marks no child. Terminal intern/refcount and optional subtree-minimum payload are three eight-byte scalars:
1,584 logical node bytes before heap overhead. Use PLAIN storage and the supported default page size so a
node stays inline. Empty text is represented by a terminal at the root; there is no byte terminator node.
The terminal's logical intern ID remains distinct from its changing physical node address.

```text
take the original transaction's version-changing root lock
read the changed key path through single-TID fetches
push (old_node_tid, predecessor_frame_tid, byte_position) onto an unindexed scratch heap
unwind scratch frames; fetch each old node and copy its fixed child array
insert replacement immutable nodes bottom-up, using RETURNING ctid for parent downlinks
delete superseded path nodes and scratch frames by their exact TIDs
publish the new root pointer in the same original transaction
```

The scratch heap avoids an allocation proportional to `1,584 * key_length` in one backend memory object.
No child node is updated in place: UPDATE would change its TID and invalidate parents. For one current tree,
the superseded path nodes are not shared by the new root; untouched subtrees are shared and remain live.
Their deletion/reclamation therefore does not require recursively visiting unrelated surviving subtrees.
A terminal reference change copies its path; last-reference removal drops empty nodes while unwinding.
Reuse of a terminal intern needs the bounded logical allocator once per changed terminal, not per byte.

For `q=L+1` visited root/byte positions, one simple path operation has at most seven row/point/statement
slots per position: old-node read, scratch insert, scratch read, old-node reread, replacement insert,
old-node delete and scratch delete. The root and terminal allocator add a constant number of indexed points.
Typed node arguments/results are bounded by `2*1584+12=3180` bytes per charged node slot; scratch records are
smaller. This yields `O(q)` direct heap accesses and fixed-size copies plus `O(log N)` root/terminal index
work, under this physical model. Old/new changes charge both actual paths. It does **not** establish the
complete representation cost: ordered candidate/eligible trees, JSON conversion, source hooks and full native
writer paths still require their own literal bodies. Command-ID and backend-allocation limits also need
derivation for the entire original transaction, not a per-function proof on a small fixture.

The mechanism is promising because it identifies where a SQL-only uniform bound might be obtained. It is
not safe under ordinary unrestricted table maintenance. PostgreSQL's
[system-column documentation](https://www.postgresql.org/docs/18/ddl-system-columns.html) explicitly warns
that UPDATE and VACUUM FULL change `ctid`; a logical primary key cannot be replaced by it. Here only private
storage links would use it, while native authority and terminal identities remain logical. That distinction
does not make the physical links stable through a rewrite or a logical restore.

Required placement decisions are precise:

- Never UPDATE node content, partition-move it, CLUSTER it, VACUUM FULL it, apply a rewriting ALTER, or logically
  restore its heap independently while its root claims coverage. Invalidate first and rebuild from native data.
  Restrict node DML to the owner protocol; autovacuum/plain VACUUM can reclaim dead versions without this rewrite.
- Read every multi-statement path in one protected snapshot or while holding the writer root lock. A released
  READ COMMITTED root followed by later snapshots can see old path nodes disappear. Old-snapshot readers need
  MVCC-visible old nodes; reclamation/reuse relies on PostgreSQL's normal snapshot horizon, not an application timer.
- Establish a TID-scan access path for exact TID reads/deletes, fixed inline tuple shape and same-table pointer
  interpretation. A logical-ID fallback through a B-tree reintroduces the extra logarithm. No plan was executed.
- An offline physical restore must preserve the related heaps/root together or invalidate/rebuild. A logical
  dump/restore cannot preserve physical addresses by copying numeric TID values. No existing SDK restore hook
  supplies this guarantee for a new compatibility heap.

Those are ownership/placement obligations, not a new reservation length cap. They require no C extension
merely to express the storage operations, but they are a new storage producer and operational contract.
The current contract supplies neither this private-heap maintenance agreement nor a complete ordered-key
producer using it. It would be incorrect to assert either impossibility of SQL-only storage or readiness of
this candidate. If the owner authorizes that placement, complete this candidate before selecting a C extension;
if ordinary rewrite/restore behavior must remain unrestricted, reject raw persistent TID links.

## Exhaustive native integration, backfill and restore

The source proves why an application-only callback misses writes. Native `insertWorkflowStatus` inserts status
and input separately; its status conflict path can return stored original fields, while input uses `DO NOTHING`.
Bulk enqueue inserts statuses and inputs separately. SQL enqueue functions, caller-owned `enqueueInTransaction`,
fork/copy and other native writers also exist. A projection must derive **stored rows**, not attempted input,
timestamp or workflow name. A status-only arrival, input-only arrival, no-op replay and actual update differ.

Existing writer-guard triggers cover native INSERT/UPDATE and preserve permanent closed-workflow fences.
They do not supply compatibility DELETE hooks. `maintainWorkflowOnce` deletes input, output, operations and
status separately in one actual transaction. The new hook must invalidate at the first source-half DELETE,
including direct native SQL and orphan rows, rather than wait for status or rely on a nonexistent payload FK.

```text
on native status/input INSERT, UPDATE or DELETE, same original transaction:
    preserve native writer guards and acquire versioned compatibility synchronization
    read the actual stored status/input halves by exact native ID
    compare their stored revisions with source-state; apply exact old/new delta
    reconcile at most the distinct old/new reservation groups
    update source-state or delete it when both halves are absent
    commit or roll back only with the original native transaction
```

AFTER hooks can see the final conflict outcome; BEFORE guards keep their current authority and error behavior.
TRUNCATE, restore/COPY modes that disable triggers, schema migration and privileged bulk replacement must
invalidate coverage before any lookup is admitted. No bypass may leave a flag claiming completeness.
An invalid JSON cast needs an explicit coverage/error treatment matching the original query's observable
domain; rejecting previously accepted native TEXT at enqueue is not an authorized shortcut. In particular,
a hook that eagerly casts every unrelated native input can introduce errors the old filtered relation avoided.
Neither “catch and omit” nor fallback to the old growing resolver establishes completed bounded coverage.

Install Work's separately versioned schema after SDK migrations; do not take a shared upstream migration
number or edit installed `node_modules`. Persist a definition/version/restore epoch. Backfill uses bounded
native actual-ID keyset pages from **both** status and input tables, including orphan input halves, not OFFSET
or a growing anti-join. Each item takes the same synchronization and re-reads current stored halves; the page
is not authority to overwrite a newer live hook. Publish complete coverage only after both finite scans and
all concurrent deltas are reconciled under that version. A restart resumes the committed cursor; a crash
before cursor commit repeats idempotent work with a newly charged owner invocation.

Repair is an explicitly owned bounded write operation using the same current-row delta, never read-time
successor polling. A schema/coverage mismatch refuses admission. Initial backfill necessarily visits retained
input once; this is total job work `O(total inputs)`, not a constant installer transaction or a lookup cost.
GC uses local references and the released old path, not a later scan of all prefixes or account associations.

Copy custody must explicitly inventory the native status and input, minimized source-state and orphan input
associations, parent/child candidates, group records, eligible records, account-to-native locators, dictionary
bytes/nodes and backfill progress. Each account association must be reachable from its authoritative locator
through bounded keys. Deletion removes its source references and candidate/eligible copies in the original
native deletion transaction. Shared dictionary prefixes survive only while another live source reference needs
them; their last release reclaims the path. Progress retains cursors/version metadata, not another payload
archive. Free interval records contain storage numbers only and disappear with an empty allocation range.
This inventory is a producer requirement, not permission to infer physical absence from projection emptiness.

Native `advanceWorkflowWriterRestoreGeneration` rotates its own writer-domain singleton, after preserving
permanent closure fences. It does not rebuild this projection. Restore must additionally invalidate the Work
coverage epoch before clients use it, rebuild against restored native halves, then publish its own complete
epoch. Neither dictionary slots nor a previously complete coverage flag survive as native lifecycle receipts.
Offline restoration that bypasses these steps is an unavailable placement, not a safe default.

## Pre-I/O reservation and complete original Source composition

Use vector order `(rows, points, statements, bytes, engineRequests)`. The original live Source frame is bound
to the actual Pool and original deadline by
`semantic/identity-source-consumer-maintenance.ts`. Reservation is componentwise, before affected I/O;
failed statements, rollback and repeated calls stay charged. There are no refunds or replacement frames.
`engineRequests=0` is preserved; logical SQL index work is not an external engine request.

The current [SDK adapter](../../services/kernel/src/work/sdk-retirement-fence.ts) supplies these _old_, literal
dispatch prices, inclusive of their current nested native body:

| Dispatch                 | Current vector    | New representation obligation                                                 |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------- |
| rollback                 | `(0,0,1,0,0)`     | Reserve before BEGIN/connect; retain on every failure                         |
| begin                    | `(0,0,1,0,0)`     | Same original transaction                                                     |
| settings                 | `(1,0,1,128,0)`   | Original remaining deadline and bounded lock wait                             |
| lock                     | `(4,2,4,8192,0)`  | Add only actual new nested synchronization; preserve native fence authority   |
| retire                   | `(8,5,9,32768,0)` | Reprice any new status UPDATE hook reached inside this body                   |
| commit                   | `(0,0,1,0,0)`     | Include deferred hook work here if it is actually deferred                    |
| delete-workflow_input    | `(1,1,1,0,0)`     | Include old source-state, candidate/group invalidation, intern release and GC |
| delete-workflow_output   | `(1,1,1,0,0)`     | No reservation projection source; retain any actual other nested hooks        |
| delete-operation_outputs | `(64,1,1,0,0)`    | Preserve existing 64-row bound and native work                                |
| delete-workflow_status   | `(73,5,5,0,0)`    | Includes existing four FK cascades; add exact new status-half work once       |

`SDK_TRANSACTION_FENCE_COST` is currently `(4,2,4,8192,0)` (its exported last field is named `engineWork`).
It must change if the real same-transaction native fence body grows. It cannot substitute for Source authority.
The current bounded callback receives only a dispatch string, so a dynamic length-dependent charge is not
already available through it. Either a complete fixed admitted maximum must be proved for that dispatch, or
a supported preflight/plan seam must expose funded size metadata before the affected I/O. Reading metadata to
price the operation is itself a separately prepaid operation. History's earlier inspection may establish its
own admitted payload bound while native writers are closed; it does not bound every external writer or repair.

For any chosen representation let `Delta_k` be the inclusive proved new body under dispatch `k` and
`D_k = old_k + Delta_k` only where the old/new bodies really compose without duplicate charging.
For the SQL trie, the local intern/release formulas above contribute explicitly; source reads, group probes,
candidate writes, coverage checks, allocator and byte extraction must all appear. No numeric `Delta_k` is
given here because neither an accepted uniform representation nor that complete hook body exists.
Installing guessed literals would contradict the requirement to derive them before selecting maxima.

Other native entry points have independent actual owners and must prepay the same work:

| Entry                                                              | Required reservation placement                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary/bulk/SQL/transactional enqueue, status/input update, fork | Existing owner before original native DML; include both halves, replay/conflict outcomes and all reached hooks                                               |
| Direct/native retention DELETE                                     | Before each affected original dispatch; DELETE of either source half is enough                                                                               |
| WorkClient lookup                                                  | Before exact-native precedence read, coverage/eligible seek, four authoritative half reads and original bounded step request, under its real caller contract |
| Installer/backfill                                                 | Actual installer/job owner: control/rollback, bounded page read, every current-half reread and delta, progress and publication                               |
| Repair/restore                                                     | Actual restore/repair owner before invalidation and bounded rebuild; no cost borrowed from a historical Source invocation                                    |

The complete Source parent must use fresh-verifier whole-call composition, as selected by the supplied owner
decision. Relevant current literals establish a ledger, not the final total:

| Component                                         | Current vector/source                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Independent Source verification, **each entry**   | `(100,100,22,139264,0)`, `identity-source-consumer-custody.ts`                               |
| Source custody read admission                     | `(32,32,29,32768,0)`, same file; nested verification still separately reached                |
| Directory whole allocation / each effective child | `(100,200,36,229376,0)` / `(50,100,18,114688,0)`; both child reservations precede their I/O  |
| Source history recheck                            | `(32,32,8,131072,0)`                                                                         |
| Source receiving-binding read                     | `(160,80,6,131072,0)`                                                                        |
| Source history guard                              | `(17,15,2,32768,0)`                                                                          |
| History command controls                          | `(3,1,8,256,0)`, `history/agent-identity-inventory-work.ts`; includes failure/rollback slots |
| Released SDK state observation                    | `(3,2,1,8192,0)`, `history/agent-identity-sdk-fence.ts`                                      |
| Native same-command fence                         | `(4,2,4,8192,0)`; separately reserved where reached                                          |
| History guard / absence check                     | `(92,87,11,40960,0)` / `(9,9,9,0,0)` in the History SDK-fence body                           |
| History work invalidation / wake                  | `(846,846,261,0,0)` / `(128,65,65,0,0)`                                                      |
| Locator invalidation / receiving invalidation     | `(1678,1678,518,0,0)` / `(845,845,261,0,0)`                                                  |

The last two rows are derived from the current bounded family limits in
`history/agent-identity-inventory-work.ts`, not estimated headroom. They remain charged where called even if
a particular run changes fewer rows. Account settlement and any other separately reserved nested producer
are additional entries; an inclusive dispatch must not charge a nested item twice.

For each finite admitted control-flow trace `p`, the only valid derivation is
`T(p) = sum(existing reservations actually reached on p) + sum(inclusive new dispatch deltas reached on p)`.
The native parent is the componentwise maximum `M_i=max_p T(p)_i`, after enumerating all complete paths from
entry through final receiving commit, including refusal/rollback paths. A maximum is taken per axis, not by
selecting one visually largest path. Each smaller configured/remaining allowance still refuses normally.

At minimum, the retained-terminal successful trace must expand these bodies and repeated sites:

1. `history/agent-identity-retirement.ts:advanceInFrame`: receiving observation, original Account-source read,
   accepted-source lookup, `readAgentIdentityRetirementStage`, Source custody read and retained-terminal verifier.
2. `retireAgentIdentitySDKWork`: initial stage verification and controls, receiving observation, released SDK
   observation, readiness recording with a fresh handoff, saved readiness reread, native retirement dispatches,
   released fence observation and closure recording with another fresh handoff.
3. `durable.ts:prepareIdentitySDKWorkRetirement`: controls, `lockRecordedAgentIdentityHistory`, seal/barrier,
   bounded role reads and owner readiness; that readiness can re-enter the recorded-history handoff.
4. `minimizeIdentitySDKWork`: pre-delete command/handoff, SDK fence observations around deletion, both physical
   inspections, writer observation, all native delete dispatches and their projection deltas.
5. Final cleanup/locator recording: another recorded-history handoff, seal, absence, history/locator updates,
   invalidation/wake and their controls. Then `receiving.ts:recordIdentityReceivingProof` re-enters the
   recorded-history handoff, absence/scope checks, receiving write and receiving invalidation before commit.

Every handoff calls current Source verification again through
`lockIdentitySourceHistoryHandoff` / `verifyAgentIdentityRetirementStage`. No result from an earlier command
is reusable authority. Both physical inspections use the eight literal native table bounds in `durable.ts`:
`1,1,1,64,8,64,0,0`, each charged with its extra miss slot, keyed seek and metadata bytes; payload stays in PG.
These inspections do not make the dictionary's internal bytes or rows free.

The historical five-verifier lower bound is `(500,500,110,696320,0)`, already larger in bytes than the old
native parent `(577,577,173,630784,0)`. The selected owner decision permits a fully body-derived replacement
parent; the old ceiling is not a present contradiction. Five entries are not the complete trace above.
Neither that lower bound nor the displayed ledger authorizes a new guessed parent literal.

`library/identity-scope-effects.ts:readLibraryScopeEffectsPage` is explicitly provisional and returns
`{status:'unavailable', work: zero}`; `verifyLibraryScopeEffectsSeal` returns false. Zero describes that refusal
adapter, not a successful Library operation. Its independent allowance in config cannot pay native work.
Without its successful body and receipt, the successful complete-path sum is **unavailable**. The original
implementation must preserve that exact refusal and dependency until integration supplies it. This research
does not implement Library, alter child prices, or claim whole-Source completion.

## Adversarial acceptance specification — all UNRUN

The original authored tests remain unchanged evidence. The following is additional acceptance pseudocode for
the eventual complete implementation, not a fixture-only resolver, executed test, or new test file in this task.
Use the normal isolated migrated GrowthDatabase, the actual WorkClient and actual pinned native hook paths.
Do not call a copied projection-maintenance function from a fixture or flip coverage flags manually.

```text
for scale in [64, 512, 4096]:
    open normal migrated database; construct actual WorkClient with borrowed pool
    use native insertWorkflowStatus / caller-owned enqueueInTransaction and native SQL enqueue
    retain 12 native step rows; request unchanged {limit:10, offset:0}
    assert exact requested workflow status wins over every compatibility candidate
    assert original-ID miss/options/errors and owned/borrowed close-once behavior

    create old eligible parent+child; add scale newer parents without eligible children
    assert lookup equals direct child steps and remains bounded on hit and complete miss
    create scale same-reservation parents/children; verify all accepted tie levels
    repeat using cross-application / ban-removal children permitted by original predicates

    use 16384-byte high-entropy reservation and long shared-prefix distinct reservations
    use empty, missing, null, 42 vs "42", true vs "true", equivalent objects and arrays
    assert distinctions/equalities through actual WorkClient, never through a digest fixture key
    force every deliberately reduced test hash into one bucket if any hash accelerator exists
    assert collision handling never merges, rejects or scans an unbounded residual bucket

    delete winning parent, winning child, last child, parent input only, child input only
    assert the native original transaction sees its exact hooks and rollback restores everything
    exercise status-first/input-first/orphans, no-op conflict replay, actual updates and native fork
    race equal/different long texts, group moves, old REPEATABLE READ snapshots and multirow writers
    assert whole-transaction abort or exact committed source/projection state, never partial authority

    delete/reinsert the same long values repeatedly; inspect live nodes, free intervals and copies
    assert no retained account tombstones, historical prefix buffers or unbounded GC cascade
    interrupt bounded backfill, mutate both halves while resuming, then complete ordinary cutover
    invalidate through supported restore/disabled-hook paths; assert unavailable until true rebuild
    assert lookup performs no read-time repair, pair expansion or residual empty polling

    trace actual nested hook/index work, not just top-level query count
    charge rows, points, statements, retained/returned bytes and design-visible traversal/copies
    compare changed input lengths independently of unrelated preexisting history and shared prefixes
    assert at most two group-successor selections, each with both real head probes counted
```

Accounting acceptance additionally invokes the actual original Source frame and maintenance adapter:
repeat every fresh verification in the complete admitted path; assert its unchanged literal deduction on
every entry; assert each SDK dispatch reserves before original I/O on the same Pool/deadline; inject one-axis
shortfalls before each new hook; preserve charged failures/rollback and all smaller allowances. Assert the
componentwise complete-path parent, not merely admission of five verifications. An unavailable Library remains
unavailable. A newly available Library requires its real producer/cost receipt and full original composition.

## Recommendation for the manager

Keep the exact relation, accepted ties, two-group update shape, source-half atomicity and fresh Source
authority. Reject full-text composite B-trees, digest identity and residual buckets. Do not dispatch a claim
of completed bounded implementation based solely on a trie name, SP-GiST availability or finite field sizes.

Resolve the model choice stated at the start. Under the recommended uniform model, first decide whether the
private immutable heap-TID placement is supported; otherwise require a packaged native exact-string index.
Require the exact-string/ordered-key producer with the traversal, storage, locking, crash, GC and deployment
obligations listed above, then derive all dispatches and complete original path maxima from its actual body. Under the
finite-domain SQL choice, explicitly adopt and fund the literal length-proportional seeks; do not rename them
linear byte work. Neither choice authorizes an execution/retry, a new input cap or a lifecycle exception.

This report is the research deliverable. It changes no product, test, allocation, producer authority or frozen
file. The only write outside its declared report path is permitted `.reference/INDEX.md` source-reuse metadata.
No workspace code changed, so no workspace typing applies. The canonical nonempty-file acceptance command,
all original assertions and all native/growth verification remain **UNRUN** under the current execution policy.
