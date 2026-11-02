# Native Work exact keys: a connected construction and its remaining boundary

Research date: 2026-11-02. Base: `f084a1425deece3f5f28867dd4546a3a23d24674`.
This is source research for a manager decision. It delivers no producer, deployment,
execution permission, benchmark, or physical absence proof.

## Recommendation

**No supported positive PostgreSQL representation satisfying the entire uniform
`O(d log N + B)` contract is established by the inspected sources.** Retain that
contract, but do not adopt the provisional private heap as a complete architecture.
The remaining issue is a connected producer, not another choice between dictionary
names. Below is one precise construction, the PostgreSQL operations supporting its
navigation, and the places where completing it still requires an unsupported body.

The strongest constructive result is narrower: an immutable, unindexed, fixed-fanout
heap trie can perform exact equality and ordered-head path maintenance with a linear
number of single-TID operations, without indexing each byte. A stable radix sort of
decoded JSON member-name references can remove the earlier comparison-sort factor.
Neither result supplies an available SQL implementation of the complete compatible
extractor or a restore-independent inventory with the required maintenance price.
Combining them and calling the result a trie would conceal those missing operations.

The smallest next choice preserving the target is an explicitly supported native
extension project with two proof obligations: compatible linear extraction and
directly addressed, independently inventoried transactional storage. A narrower
extension supplying extraction alone leaves the inventory obligation open. This is
a recommendation for a deployment/design decision, not a finding that such an
extension is installed, already proved, or authorized. A SQL-only alternative
requires the missing inventory/restore body to be demonstrated before adoption.
No universal impossibility follows.

## Base and authority

The current [Work owner document](../../services/kernel/src/work/README.md) and
[WorkClient](../../services/kernel/src/work/client.ts) still describe the native
writer authority and the original joined fallback. The fallback has no delivered
exact-key projection. The current maintenance adapter has the original fixed
dispatch-string callback; it has no length-aware quote/apply protocol.

The following supplied decisions were read by exact path under the main checkout's
`.temp/goal/performance/decisions/` because that directory is absent in this worktree:

- `work-client-bounded-legacy-contract.md`;
- `work-client-private-heap-receiving-20261101.md`;
- `work-client-exact-key-primary-receiving-20261101.md`;
- `work-client-exact-key-independent-receiving-20261101.md`.

They retain uniform additive-byte accounting, accept the tie refinement and
prospective private-heap restrictions, and reject candidate H's original cast plus
root-only inventory. They do not establish installed exhaustive hooks or new prices.

The three requested reports exist locally. Their Git blob IDs at this base are
identical to their blobs at the requested references:

| Report                                                                             | Requested revision                         | Blob                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| [Primary exact-key analysis](work-client-exact-reservation-key-primary.md)         | `d7666822d6fa00edd90120d013e4beecbc8cebdc` | `0c6b439f18884d3948716e4e6945b35f7da5be15` |
| [Independent exact-key analysis](work-client-exact-reservation-key-independent.md) | `e1b230d1397418ea9c538e3c840644ca1f02972b` | `5b7b21793e5e28a5e03720b6f49073e872bbd226` |
| [Complete private-heap review](work-client-private-heap-complete-design.md)        | `0470a6f0e75bfe4472a087f7f0f692babb435c98` | `484a79dfee9234fbc6a981f416e8478a8d64e7af` |

Their indexed-byte, JSONB comparison-sort, restored-link and transaction-lock
counterexamples remain accepted premises. This report does not repeat their general
candidate survey or reinterpret their source deductions as executed failures.

One important premise **has changed**: the current Library page and seal verifier
are implemented. The older reports' unavailable/false-stub description must not be
carried forward to this base. The final accounting section identifies the current
successful bodies and the remaining limits of their price evidence.

## Primary-source provenance

Reference paths in this table are relative to
`/home/edge/projects/rezics/rezics-next/.reference/`. Both clones were reused read-only;
neither was installed, built or executed. Their reuse is recorded in `INDEX.md`.

| Project                                            | Reference path and pin                                                              | Licence                                                                                                                       | Inspected implementation                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [PostgreSQL](https://github.com/postgres/postgres) | `library-shelf-maintenance/postgres`, `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`    | [PostgreSQL License, COPYRIGHT](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/COPYRIGHT) | JSON input/build/extraction, decimal numeric I/O, text equality, TID executor, heap fetch, large-object writes and B-tree insertion |
| [Rax](https://github.com/antirez/rax)              | `work-client-exact-reservation-key/rax`, `1927550cb218ec3c3dda8b39d82d1d019bf0476d` | [BSD-2-Clause, COPYING](https://github.com/antirez/rax/blob/1927550cb218ec3c3dda8b39d82d1d019bf0476d/COPYING)                 | Exact byte walk and upward deletion/recompression in `rax.c`                                                                        |

Current official PostgreSQL documentation was consulted on 2026-11-02; its current
stable documentation resolves to version 18. Implementation claims below are pinned
to the source revision above, not an assertion about an installed server build.
The PostgreSQL and Rax licences permit study; no source files or long passages are
recommended for copying. The proposed implementation belongs in this repository's
PostgreSQL/TypeScript stack, with a server extension only after an explicit decision.

## Relation and cost operands

Preserve the exact loose legacy-ID recognition, native-status precedence, original
SDK method/options/errors, original-ID fallback and borrowed/private Pool lifetime.
The parent is `community.leave`; the child is `accounts.membership`. Both native
status and split-input halves must exist. Realm/member predicates and reservation
equality are the original `inputs::jsonb #>> ...` text predicates. There is no new
application, status, principal-kind, role, parent-link or authorization filter.

The selected pair is ordered by parent time descending, NULLS FIRST, then full
parent actual ID ascending COLLATE C, then full child actual ID ascending COLLATE C.
Within one reservation group the best pair is the independently best parent and
best child. A realm/member's answer is its best group having both components.

Use `d` for changed native source rows, and `N` for all live auxiliary storage,
including inventory, allocator, orphan and unfinished-rebuild records. Do not use
only the selected realm's population. Keep the byte operands separately visible:

- `B0`: admitted old/new source-input bytes associated with the changed records;
- `E`: bytes of compatible extracted text actually produced, including numeric expansion;
- `A`: full old/new actual-ID and ordered-key bytes requiring navigation/copying;
- `R`: any additional unchanged complementary-half bytes that must be reread;
- `Q`: visited/copied/released fixed-size trie nodes;
- `J`: independently retained inventory items changed or removed.

The intended additive byte operand must cover its explicitly admitted input,
extracted and ID bytes; writing `B` does not make `E`, `A` or `R` zero. In particular,
an implementation proving only `O(d log N+B0+E+A+R)` has not proved the original
contract if it quietly enlarged the meaning of `B0` to include encountered history.
Avoid `R` on ordinary status changes by retaining valid, inventoried extraction
metadata from input-half production; initial production/backfill still pays for it.
If that metadata is absent, report the extra operand rather than rename it.

## A concrete linear canonicalization construction

This section is an algorithmic proposal, **not an available SQL function or a
completed compatibility proof**. It makes the parsing primitive sufficiently
specific to assess; it does not reuse the rejected JSONB cast as a free step.

### Parse and order member references, not whole prefixes

1. Materialize/decode each native input once under the actual server encoding.
   Use PostgreSQL-compatible lexical rules and scalar conversion. Retain spans or
   stable buffers for decoded names/strings, scalar values and child references;
   never append a repeatedly growing whole prefix or serialize at every ancestor.
2. For each object, retain its member references in original order. Sort those
   references by decoded name **byte length**, then by bytes. First stable-radix-sort
   the bounded-width length field. Within each equal-length group, perform stable
   least-significant-byte counting passes using 256 buckets and two pointer arrays.
   No string comparison is used in these passes.
3. Equal names now occur contiguously in original order. Retain the final reference
   of each run. This reproduces last-value-wins without sorting occurrence numbers.
   Adjacent equality checks examine at most twice the total member-name bytes.
4. Traverse the resulting tree into one output buffer/segmented stream. Emit the
   exact PostgreSQL text form only for the required paths, while validating the
   entire cast's accepted domain and conversion errors. Do not recursively build
   a fresh serialized copy of every nested subtree. Arrays retain their order.

For an object whose equal-length group has `k` names of length `l`, step 2 costs
`O(k*l + 256*l + k)`. Summed over nonempty groups, the sum of their lengths is no
larger than the sum of all name lengths. Empty names add `O(k)` syntax/metadata.
Thus the sorting work is `O(K + sum(name bytes))`, with small alphabet/word-width
constants independent of the admitted string-length domain. Every name belongs to
one object; nesting does not multiply this sum. Temporary pointer storage is
`O(K)`, not a stored prefix per node. This is a direct counting argument, not an
appeal to average hash behavior or an enormous maximum JSON size.

The required order and duplicate rule come from PostgreSQL
[`jsonb_util.c:1990–2120`, `lengthCompareJsonbString`/`uniqueifyJsonbObject`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/jsonb_util.c#L1990).
The proposal replaces the pair-sort operation; calling the existing object-end
builder would invoke that comparison sort again and invalidate the derivation.
[`JsonbValueToJsonb` and `convertJsonbObject`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/jsonb_util.c#L96)
show a possible native integration seam: an already normalized `JsonbValue` object
can be serialized without going through the input builder's object-end sort.
This is an internal C seam, not a SQL facility or a stable cross-version ABI.

### The compatibility work that this does not settle

PostgreSQL's [JSON input implementation](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/jsonb.c#L240)
uses the database encoding, parser semantic callbacks, string-size checks and
numeric conversion. A replacement must retain validation of discarded duplicate
values and irrelevant subtrees wherever the original whole cast validates them.
It must preserve container/string limits, nesting failures, numeric range failures,
Unicode/surrogate/zero-character errors and their observable error information.
Skipping a subtree because its result is unused is not enough.

[`jsonb_get_element` and `JsonbValueAsText`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/jsonfuncs.c#L1533)
establish the output cases: missing/path mismatch and JSON null yield SQL NULL;
strings are de-escaped text; Booleans and numbers have server spellings; objects
and arrays use JSONB rendering. Empty text is not NULL. JSON `1` and string `"1"`
can therefore match, as can a structured value and a string equal to its rendered
text. Adding a type tag to their equality identity would change behavior.
The [JSON documentation](https://www.postgresql.org/docs/18/datatype-json.html)
also distinguishes JSONB's duplicate/encoding behavior from raw JSON text.

Decimal numeric conversion is less mysterious than the object-sort problem:
[`numeric.c:set_var_from_str`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/numeric.c#L6817)
scans decimal digits/exponent, then groups digits into the internal base;
[`get_str_from_var`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/numeric.c#L7299)
emits digits according to weight and display scale. For JSON decimal tokens these
loops support charging input digits plus output digits, not a comparison-sort
factor. JSON lexical validation must precede numeric input: calling the broader
numeric grammar alone would accept spellings JSON rejects. Exponent expansion and
display scale require `E`; numeric equality or JavaScript number conversion cannot
replace numeric text output. This loop analysis is not a complete error-equivalent
replacement parser proof.

The original native input column is TEXT. An unrelated invalid input can be legally
stored. Maintenance must not turn every INSERT into a new JSON validator. Input-first
arrival and later relevant-name changes need an explicit invalid-result/error state,
including its inventory and bounded lookup behavior. Neither catch-and-omit nor
reject-at-enqueue preserves the original contract. A new extractor also needs to
show how it reproduces the original lookup's observable conversion errors without
executing the old population scan. That body is still absent.

### Equality collation is a separate certificate

[`varlena.c:texteq`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/varlena.c#L1429)
uses byte equality for deterministic collations; nondeterministic equality calls
the collated comparator. C ordering of actual-ID ties does not set the extraction
expressions' collation. This applies to realm/member/principal predicates as well
as reservations. The [collation documentation](https://www.postgresql.org/docs/18/collation.html)
describes expression derivation and nondeterministic equality.

No database was queried in this research. The inspected source does not establish
the live extraction-expression collation. The byte construction is therefore
conditional on a deterministic expression collation certificate. For any supported
nondeterministic deployment, an exact equivalence-class key producer and its time,
space, version and error bounds remain necessary. Naming an ICU sort key does not
prove those bounds. Requiring deterministic equality would be an explicit placement
restriction, not a silent switch to C or permission to change an existing database.

## Exact navigation and ordered group heads

Assume compatible equality bytes have been produced. Use an uncompressed byte trie
with separate terminal state, fixed child arrays and fixed-width summary references.
Do not store whole prefixes or concatenate surviving suffixes during deletion.
Empty text terminates at the root. NULL produces no equality terminal. Intern IDs
identify exact terminals and can be reused only after safe release; allocation
order is never string order. No digest or collision bucket is required.

For ordered, concatenated components use an explicit prefix-free encoding: emit
`(1,b)` for each byte `b`, then `0` at the component end. It preserves byte order,
places a shorter prefix first, represents empty components, and has length `2L+1`.
Distinct terminal markers in a wider alphabet are another option; neither is a hash.
Charge the encoded bytes and component boundaries.

Maintain three connected layers:

| Layer                    | Stored ordered/equality key and payload                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact dictionary         | Extracted equality bytes → logical terminal/refcount                                                                                                      |
| Reservation group        | Parent tree by exact descending time/null encoding then full C-ordered actual ID; child tree by full C-ordered actual ID; cached minimum terminal of each |
| Realm/member eligibility | Only groups with both heads; ordered tree by parent head time, full parent ID and full child ID → group/head references                                   |

For a confirmed signed fixed-width timestamp representation, descending order uses
the complemented, sign-bit-adjusted big-endian integer; a leading tag puts NULL
first. The implementation must derive this from the installed native column type,
not from JavaScript's floating-point timestamp range. Native actual IDs remain
unchanged. Long IDs are navigated as bytes, never squeezed into an assumed-fitting
`group/time/full-ID` ordinary B-tree key.

At every trie node cache the minimum terminal reference. Recompute it from that
node's terminal and first nonempty child in byte-label order. Inspecting 256 fixed
entries and fetching the chosen child's summary is constant work per visited node;
the numeric magnitude of the terminal ID is irrelevant. Removing a minimum does
not walk all surviving candidates. A mutable global linked order with labels that
require mass relabeling is not part of this construction.

A source delta removes its old component and adds its new component, touching at
most two groups. Refresh both heads in each group: at most **four component-head
probes**, then remove/insert those groups' eligible entries. Lookup performs one
realm/member root seek and its cached eligible minimum lookup, plus original native
validation and the SDK step call. These are constant successor-selection counts,
not a claim that long-key path work or returned IDs cost zero. Native half checks
still include up to four original status/input rereads. If those use text-key B-tree
probes, their actual full-key comparison/return cost must be included; a count of
four seeks alone is not a byte-work proof.

There is another important boundary: a replacement head can belong to an unchanged
surviving source. Rebuilding its entire eligible key would charge that survivor's
ID bytes, not just the deleted source's bytes. Cached minima establish constant
head discovery; they do not establish cheap reinsertion of that head into a second
ordered tree. A complete producer must supply bounded structural sharing/order
metadata for this transition, or expose the extra operand and fail the original
bound. An external terminal comparator that repeatedly rereads long keys is not
that primitive. The layer description above therefore establishes the selection
shape and explicit path cost, not the missing changed-source-only ordering proof.

### Actual PostgreSQL access, not a pointer metaphor

Use private immutable heap rows containing inline fixed-size nodes. One indexed
logical root fetch gives a table/epoch-qualified TID. Each subsequent
`WHERE ctid = $1::tid` operation must execute as a **single** TID access. PostgreSQL's
[`TidNext`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeTidscan.c#L305)
passes the executor snapshot and exact item pointer to table tuple fetch;
[`heap_fetch`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/heap/heapam.c#L1648)
reads the specified block/line pointer and checks visibility without following HOT
chains. This establishes direct addressing at this seam, not a scan of an ID index.
An actual supported-server access plan is still required before implementation
acceptance; SQL text alone does not force a plan.

Read the path, push unindexed fixed-size scratch frames, then unwind bottom-up:
read old node, insert its replacement, delete the superseded node by its exact TID,
and delete the scratch frame. Publish the root and all associated changes atomically.
Untouched subtrees remain referenced; last-reference removal prunes only the released
path. Shared prefixes require live references, not surviving-key recompression.

The accepted provisional layout is 1584 logical bytes for 256 TIDs and three int8
fields; an additional summary field makes 1592. Conventional 8 KiB/MAXALIGN layout
fits five such nodes per page. Ownership/epoch/inventory fields add bytes and may
change that occupancy. PLAIN inline storage is essential to this local accounting;
an out-of-line child array would introduce separately indexed TOAST storage.
PostgreSQL's [TOAST description](https://www.postgresql.org/docs/18/storage-toast.html)
explains why large values cannot simply be treated as one inline tuple.

For `Q` visited positions, the simple reference body has seven row-action/SQL slots
per position: old-node read, scratch insert/read, old-node reread, replacement
insert, old-node delete and scratch delete. Five are exact-TID actions. Ordered
summary variants can reserve two additional child reads per position: nine slots,
seven TID actions. These are local envelopes inherited from the prior review,
before inventory, allocator, hooks, controls and quote work; not installed prices.

**A new batching pitfall:** replacing these reads/deletes with one arbitrary
`ctid = ANY(tid[])` call does not establish linear work. At the same source pin,
[`TidListEval:134–272`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeTidscan.c#L134)
deconstructs the list and, for more than one TID, comparison-sorts and deduplicates
it. A length-`Q` batch therefore has an additional `O(Q log Q)` sorting bound.
Use single direct accesses or prove a different native batch body; reducing the
visible statement count cannot erase the internal sort.

## Snapshots, aborts and source synchronization

The local storage operation can use ordinary PostgreSQL MVCC: insert immutable
replacement rows, mark superseded rows deleted and update a versioned root in the
same transaction. A registered old snapshot sees its old root and old nodes; a new
snapshot sees the new root and replacements. Rollback publishes neither. Ordinary
vacuum reclaims dead versions only after the visibility horizon permits it.
See [transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html)
and [routine vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html).

This requires a single protected traversal snapshot, or the actual version-changing
root lock held throughout the specified fresh-snapshot protocol. Saving a root and
following it under later READ COMMITTED snapshots is unsafe. A missing/epoch-mismatched
node is unavailable/corrupt coverage, never an exact miss. TIDs are qualified by
relation and epoch; they are not native workflow identities. Private UPDATE,
rewrite/move and independent logical restore remain forbidden while covered.
[System columns](https://www.postgresql.org/docs/18/ddl-system-columns.html)
document TID movement and the per-transaction command-ID limit. Node-by-node SQL
also needs a whole-transaction command-count/allocation derivation, not a maximum
key length hidden in a supposedly constant price.

No new lock-order theorem is asserted. Original SDK guards/fences must precede or
compose with the actual private protocol across an entire caller-owned transaction.
An AFTER hook can hold a root while a later statement requests another native row.
Per-row sorted IDs do not order those transactions. Deadlock/serialization failure
may abort the original transaction; every partial path, rollback and later retry
remains charged. A statement retry inside a partly used command is not a remedy.

Coverage requires native status/input OLD/NEW INSERT/UPDATE/DELETE hooks, either-half
arrival/deletion and retained-orphan handling, actual stored conflict winners,
name/time/ID/input changes, raw SQL/COPY, bulk/caller-owned enqueue, fork/recovery
and retention. Existing ALWAYS INSERT/UPDATE writer guards are not those DELETE or
private-copy hooks. Installation must be independently versioned after SDK migration.
Backfill reads both native halves in bounded keyset pages, reconciles live changes
under the same source version protocol and publishes only a completed coherent cut.
No cursor EOF, root Boolean or read-time repair scan establishes coverage.

## Independent inventory is the remaining storage primitive

All logically retained copies need independent owner-addressable selection, removal
and probing even when physical root links are untrusted. An ordinary root path is
useful navigation; it cannot simultaneously be the sole evidence that all copies
have been found. Invalidation stops lookup but deletes no relocated row.

Consider the most direct repair: add a logical allocation/owner record for every
private node or fixed-size chunk. If `J=Theta(Q)=Theta(B)` such records are inserted
or changed through a B-tree, the inventory costs `O(J log N)`. This reintroduces
the exact byte-index factor that direct TID traversal removed. Putting owner fields
in the unindexed nodes avoids that write cost but leaves no bounded owner selection
after invalid-link restore. A global heap scan is not a per-source removal bound.

An inventory root containing an expanding TID/ID array also fails as an unexamined
repair: repeated whole-array replacement copies old unrelated entries; large values
use TOAST; a TID-only array remains wrong after relocation. A second linked list of
physical pointers has the same restore problem. Duplicating it does not make it
logically addressed. Indexing every second-list node restores the logarithmic term.

### Why a PostgreSQL large object is not the missing priced arena

Large objects offer logical object identity and stream I/O, so they are a plausible
way to retain an owner manifest across a logical restore. However, inspect the
actual [large-object implementation](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/storage/large_object/inv_api.c#L450):
`inv_read` uses an ordered catalog scan; `inv_write` creates/updates per-page tuples
and invokes catalog index maintenance for each page. A streaming read can share a
range seek. That does not establish additive **writes** for all modified pages.

The underlying [B-tree insertion search](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/nbtree/nbtinsert.c#L282)
has a cached rightmost-leaf fast path, falling back to a root descent when its
conditions fail. Arbitrary interleaved owner objects/page updates need not be at
that right edge. Thus an `O(B/page_size * log N)` write envelope remains for this
repair; fixed page size does not make it uniform additive-byte maintenance.
The [large-object API](https://www.postgresql.org/docs/18/largeobjects.html) is an
available PostgreSQL mechanism, but supplies no documented alternative write
guarantee that closes this gap. This is a bound on this repair, not on all possible
PostgreSQL inventory designs.

### The exact positive primitive still needed

A candidate storage producer must expose all of these operations with actual
PostgreSQL implementations and bounds:

```text
locateOwner(owner, epoch)                 O(log N), fixed-width metadata
allocate/edit/release changed extents     O(changed bytes + changed metadata)
enumerateSelectedCopies(owner, selection) O(log N + selected items/bytes)
probe/remove after logical relocation    same bound, without old physical links
publish/abort/reclaim                    all changed copies and old snapshots priced
```

An extension could own page-local slots and owner extent directories, rewrite
logical references during dump/restore, and maintain snapshot-safe allocation and
WAL. It would need a concrete bounded directory/allocator and partial-extent
deletion algorithm; saying “owner extents” does not prove any of them. A private
relation per owner is also not a proof: catalog/DDL costs, retained snapshots,
selected-source removal, ownership and restore enumeration still need pricing.
No such completed primitive was found in the inspected available SQL mechanisms.

Alternatively, the owner may explicitly fund an offline full restore reconciliation
that enumerates all private tuples and rebuilds a logical inventory before any
receiving/absence claim. That is a separate whole-epoch job, with all old/new copies
charged and custody retained until completion. It cannot be presented as bounded
per-source removal before reconciliation, or assumed to satisfy the uniform job
bound without pricing its own output inventory. This is the narrow restore-contract
alternative allowed by the receiving decision, not permission to erase by invalid root.

## Complete cost and retained-copy argument

Let `P` be compatible extraction/error/collation work, `G` fixed-count group/root
operations, `V` actual native rereads/fences, `C` controls/abort work and `I` independent
inventory work. The connected inclusive body must establish:

```text
T = P(B0,E) + O(Q) direct-node work + O(d log N) root/group/terminal work
    + I(J,bytes) + V + C + paid quotation/backfill/restore work actually reached

Q = O(d + E + A) for the uncompressed, terminated-byte paths
```

For the proposed radix ordering, the member-sort component of `P` is linear in raw
name bytes. The complete error/collation-aware `P` remains unsupported. For ordinary
per-node indexed inventory, `I = O(J log N)` with `J=Theta(Q)` in adverse inputs;
for root-only inventory the required restore operation is undefined. Neither version
yields the required full bound. The display does **not** set those terms to zero or
certify the conditional trie as a positive result.

The following copy families must each be covered; normal-path reachability and
restored-copy discovery have different requirements:

| Retained family                                 | Normal mutation/removal and lifetime                              | Independent inventory obligation                                                |
| ----------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Native status/input and surviving half          | Original owner operations/fences; either-half liveness            | Existing native custody; retain orphan association                              |
| Decoded/canonical extraction and error metadata | Produce once; version on input change; release on last reference  | Actual bytes/error excerpts and owner links, including irrelevant/orphan states |
| Equality nodes, terminals, refcounts            | Copy/release only old/new paths; preserve shared live references  | Find relocated/unreachable live nodes; no zero-reference cache                  |
| Parent/child ordered nodes and head summaries   | Charge all full-ID encoded paths and replacement summaries        | Same requirement as equality nodes; references are retained relationships       |
| Eligible nodes and realm/member/group roots     | Remove old heads before publishing new eligibility                | Roots, memberships and old epochs are copies, not receipts                      |
| Source/candidate/half/orphan associations       | Atomic with native change; delete empty account state             | Select by actual owner/native identity independently of live trie               |
| Allocator/free metadata and scratch             | Abort/reuse/cleanup priced; no identity-bearing abandoned scratch | Inventory any retained identity/byte relationship and interrupted allocation    |
| Installer/progress/pending/rebuild state        | Bounded convergent pages; remove replaced epochs                  | Covers interrupted builds and restored invalid generations                      |
| Inventory's own nodes, chunks, owner records    | Create/change/delete in the same price model                      | Inventory cannot recursively exempt its own retained copies                     |

Every selected relationship must be removed in the original owner-authorized native
deletion transaction; sharing justifies retaining only what a surviving live
reference needs. An empty account synchronization row cannot become a tombstone.
Engine-managed invisible dead versions follow normal MVCC horizons; explicit live
path copies, scratch, manifests and abandoned generations are designed storage and
are charged. No native eight-family absence result proves absence of these private
families. This accounting is a complete list of obligations and exposes the missing
inventory algorithm; it is not a claim that the missing removal bodies exist.

## Prepaid operations and current foreign price status

The current [maintenance adapter](../../services/kernel/src/work/sdk-retirement-fence.ts)
still maps dispatch strings to static `NativeStepWork`. Retirement totals
`13/7/17/41088/0`, deletion `144/10/16/8320/0` and the independent same-command
SDK fence `4/2/4/8192/0` describe their existing bodies. New hooks/extraction/inventory
cannot be charged to those unchanged literals without rederivation.

A sound future protocol first prepays metadata quotation, then obtains/locks actual
source versions, lengths, extracted-length bounds, traversal/release cardinalities
and inventory operands on the original Pool/deadline. Quote parsing is paid work;
it must not materialize the input for free to discover its size. Reserve the full
inclusive apply/abort body before affected I/O, and apply only against the same
locked versions. Staleness, refusal, failure, rollback and repetition retain spent
charges. Neither a new frame nor unused foreign allowance funds this work.

At this base, distinguish **missing** foreign bodies from **unreconciled** prices:

| Callable/price                          | Source finding at this base                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library `readLibraryScopeEffectsPage`   | Successful sealed-page body now exists in [identity-scope-effects.ts](../../services/kernel/src/library/identity-scope-effects.ts). It locks a plan, checks currentness, reads native seal provenance, then reads a keyset page. No longer an unconditional unavailable stub.                                                                                                                                                                                                                  |
| Library `verifyLibraryScopeEffectsSeal` | Successful same-command plan/seal/currentness checks exist; `currentLibraryIdentityWork` requires the original live Library ledger. No longer an unconditional false stub.                                                                                                                                                                                                                                                                                                                     |
| Library leaf SQL prices                 | [identity-native-planner-work.ts](../../services/kernel/src/library/identity-native-planner-work.ts) supplies footprints for locked/unlocked plan, current, job and seal reads and controls. [identity-native-planner-statements.ts](../../services/kernel/src/library/identity-native-planner-statements.ts) prices `effectPage`, including its EOF slot. These named leaf prices are present.                                                                                                |
| Original Source Library composition     | [identity-source-consumer-custody.ts](../../services/kernel/src/semantic/identity-source-consumer-custody.ts), around lines 760–855, calls the real page through `budget.compose`, then receiving reconciliation, same-seal verification and scope fence retention. Its complete successful path, including the active-explicit-output basis branch and original receiving/fence footprint, was not rederived by this exact-key research. No complete price is certified or assumed zero here. |
| New Work successful callables           | Compatible extraction, inventory/select/remove/probe, quote/apply, exhaustive hooks, backfill and coverage publication still have no delivered connected bodies/prices. Their absence alone prevents a new whole-Source parent price.                                                                                                                                                                                                                                                          |

Accordingly, the earlier claim that the _named Library page/verifier leaf bodies_
are missing is obsolete. No missing leaf price is established for those named reads
in the inspected base. The foreign successful-callable price still **unestablished
here** is the complete Source-consumed Library/receiving/fence path, not a supposed
zero-cost refusal. The explicit-output nested basis and all repeated entries must
be included before publishing that aggregate; this report does not assert that its
owner has no additional source or evidence.

Preserve every original child allocation, actual Pool, fresh authority and original
deadline. The prior History consumer envelope `11588/9856/2731/6843136/0` is not a
Source parent and is not revalidated here. Eight handoffs' `4063232` bytes, recovery
and independent receiving paths, staging, repeated verifiers and successful Library
composition do not disappear. A new parent is the componentwise maximum of complete
actual successful/refusal/abort path sums, with nested inclusive work counted once.

## Shared patterns, remaining choice and evidence boundary

The inspected sources share a useful separation: exact bytes are navigable data;
terminal identity is separate; storage references have a lifetime; mutation carries
an explicit ancestor path. [Rax's walk and deletion](https://github.com/antirez/rax/blob/1927550cb218ec3c3dda8b39d82d1d019bf0476d/rax.c#L459)
show these patterns and also show why deletion recompression can copy surviving
suffixes. PostgreSQL adds actual snapshot visibility and transactional publication.
Its large-object implementation illustrates that logical stream identity does not
remove per-page index work; its TID executor illustrates that one SQL batch can
contain a comparison sort. Interfaces do not supply their own complexity bounds.

The manager can compare the independent reports against these explicit alternatives:

1. **Preserve the target and allow new deployment support.** Require a packaged,
   versioned PostgreSQL extension providing the compatible extractor and the complete
   independently inventoried storage producer above. Server binaries/control/SQL files,
   major-version support, WAL/recovery, restore/upgrade ownership and actual deployment
   privileges are prerequisites. [CREATE EXTENSION](https://www.postgresql.org/docs/18/sql-createextension.html)
   loads installed support; it does not upload arbitrary code. A new access method
   also has [privileged creation requirements](https://www.postgresql.org/docs/18/sql-create-access-method.html).
   This route preserves the objective but is not yet a proved positive implementation.
2. **Preserve SQL-only placement and the target.** Keep the immutable heap provisional
   until an inspectable SQL extraction/error body and additive independent inventory
   are supplied, or explicitly adopt fully funded completed offline restore
   reconciliation before copy closure. Neither root invalidation nor a per-node
   indexed manifest completes this route. This is a precise unresolved primitive,
   not a renewed generic candidate survey or a stopped-producer restart.
3. **Change the performance contract explicitly.** Accept actual cast cost `P` and
   byte-proportional indexed inventory/navigation, with a bound such as
   `O(P + (d+Q+J) log N + E+A)` and literal owner prices. This is an honest weaker
   contract, not uniform `O(d log N+B)`. It is an alternative requiring adoption;
   it is not selected by this report. A new cap, digest identity, collision scan or
   enormous finite-domain coefficient is not among the alternatives.

Established: the source access paths, radix-sort counting argument, constant group
selection shape, TID-batch sort and indexed-inventory/large-object write terms.
Conditional: the complete direct-heap path bound under the accepted immutable
placement and actual single-TID plans. Unestablished: the compatible error/collation
extractor, independent additive inventory, survivor-head ordering integration,
whole native hook/lock/quote bodies and complete successful foreign composition
price. These distinctions are the research
result; no universal lower bound against all PostgreSQL extensions is claimed.

Only this report is changed in Git. Permitted ignored reference-index metadata is
the only write outside its declared path. No product, test, story, package, frozen
file or workspace code changed, so no workspace typecheck applies. Original
acceptance/native/browser/growth execution is deferred and UNRUN under this launch
policy; no reference code or product experiment was run.
