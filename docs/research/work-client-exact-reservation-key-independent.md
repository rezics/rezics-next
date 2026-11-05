# Exact legacy reservation keys: representation and cost boundary

## Result and decision requested

The ordinary PostgreSQL composite B-tree representation is invalid for the
accepted reservation domain. Exact interning fixes key width, but **interning is
itself charged work**. This report supplies a concrete collision-free relational
radix dictionary, its deletion/reuse algorithm and literal operation ledger. Its
honest uniform bound is `O(d log N + B log N)`, where `B` is changed source bytes.
It therefore does **not** establish the requested uniform additive-byte bound.
PostgreSQL's built-in text SP-GiST is a serious long-key alternative, but its
inspected implementation does not establish that bound either: it reconstructs
and compares accumulated prefixes repeatedly. Neither conclusion is a universal
impossibility result for exact dictionaries.

There is one precise model decision before this can become an implementation
contract:

1. **Recommended: retain the uniform additive-byte requirement.** Require a new,
   explicitly owned PostgreSQL-native exact dictionary producer with direct
   navigation, transactional reclamation and a complete literal ledger. Keep the
   original complete WorkClient implementation on hold until that producer's
   design and deployment authority exist. An in-memory radix library or an opaque
   SQL function is not this producer.
2. Alternatively, explicitly accept the **fixed PostgreSQL-domain model** for
   the relational dictionary below. Its depth has a finite bound derived from
   PostgreSQL's existing field limit, without imposing a new input cap. Publish
   that depth coefficient and all resulting native costs. This is a model
   disposition, not permission inferred by this report to treat every byte as a
   free constant. It still requires complete native hooks and caller accounting.

The distinction matters: hiding millions of possible indexed point operations
inside the coefficient of `d log N` proves little about useful admission costs.
The contract explicitly asks for actual-byte accounting, so this report does not
silently choose option 2. Neither option permits a reservation UUID restriction,
a digest identity, a collision rejection error, a scan fallback or reduced child
prices. This is the contract's model-scoped unresolved outcome, with a concrete
costed candidate to make the decision reviewable. It is not a claim that the
stopped implementation, a replacement producer or an extension has been executed
or authorized.

The scope of that unresolved result is deliberately narrow: the model uses
ordinary relational node/edge rows reached through PostgreSQL B-tree points,
and its asymptotic coefficients cannot depend on an unspecified maximum admitted
string length. In that model a length-q path costs q indexed points, each priced
against the global population. The additive requirement and a claim that this
particular representation meets it are incompatible. This does not rule out a
different SQL algorithm, a different built-in opclass with a proved bound, or a
new native producer. None is certified by the inspected source here.

The independent Library producer remains unavailable in the inspected source.
Its literal cost and the absent exhaustive native maintenance body prevent a
truthful fixed numeric maximum for the complete successful Source invocation.
Section “Whole-call accounting” specifies this dependency rather than assigning
it zero or selecting guessed headroom.

## Evidence, placement and limits

Research date: 2026-11-02. Repository source pin:
`1556f48ef91b0aee8719fa6321e9b35d500c7dc0`. This report is independent research;
no other newly authored answer to this question was read and no author was
consulted. The supplied bounded-legacy owner decision was read completely by its
exact path. It remains an external launch input, not an adopted repository
architecture decision created here.

That input is
`/home/edge/projects/rezics/rezics-next/.temp/goal/performance/decisions/work-client-bounded-legacy-contract.md`,
SHA-256 `3f4bfc31d156d965fbaa32dc3fbf69af5dd1a1a3d47ba930e8ab3375d8655727`.

The complete 242-line accounting reconciliation and all three authored tests were
read using `git show` at `1196dc8d59bf3e91b335e473db13d719b70ed9d4`:

- `docs/research/work-client-source-accounting-reconciliation.md`;
- `services/kernel/test/work/legacy-leave-accounting.test.ts`;
- `services/kernel/test/work/legacy-leave-key-domain.test.ts`;
- `services/kernel/test/work/legacy-leave-lookup.test.ts`.

These are historical source evidence. Their presence at that revision does not
mean they are installed in this checkout or executed. **Every behavioral,
accounting, typing, native and growth assertion discussed here is UNRUN.** The
historical compiler invocation is not permission or proof for this attempt.
There was no database failure, query, benchmark, compiler, dependency installation,
generator, native executor, provider invocation, browser or remote check here.
Only read-only source inspection and primary-source web research were performed.
The current minimal execution policy defers the report existence command too;
there is no changed code workspace requiring typing.

Inspected local interfaces, all at the repository pin above:

| Source                                                                 | Relevant authority or body                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `services/kernel/src/work/client.ts`                                   | Full resolver, SDK enqueue adapter, pool ownership and close-once behavior                  |
| `services/kernel/src/work/sdk-retirement-fence.ts`                     | Every current dispatch price and supported bounded maintenance callback                     |
| `patches/@dbos-inc%2Fdbos-sdk@5.5.3-preview.patch`                     | Native writer guards, original maintenance/delete body, restore domain and same-Pool checks |
| `services/kernel/src/work/README.md`                                   | Inclusive nested dispatch accounting and physical copy inventory                            |
| `services/kernel/src/history/agent-identity-inventory-work.ts`         | Pre-I/O reservation, command controls and invalidation prices                               |
| `services/kernel/src/history/agent-identity-retirement.ts`             | Original frame lifetime, staging and fresh verification call chain                          |
| `services/kernel/src/history/agent-identity-sdk-fence.ts`              | Readiness/closure, current native locks and recorded-handoff revalidation                   |
| `services/kernel/src/history/durable.ts`                               | Physical inspection, 65,536-byte payload scope and original deletion/receiving sequence     |
| `services/kernel/src/semantic/identity-source-consumer-custody.ts`     | Independent verifier, directory composition and Library receiving calls                     |
| `services/kernel/src/semantic/identity-source-consumer-maintenance.ts` | Live frame, actual Pool/deadline, safe-integer admission and no refunds                     |
| `services/kernel/src/semantic/identity-source-maintenance-config.ts`   | Present defaults, hard maxima and smaller caller allocations                                |
| `services/kernel/src/library/identity-scope-effects.ts`                | Provisional unavailable Library adapter, not a completed native producer                    |

Read-only installed DBOS 5.5.3-preview artifacts were inspected by exact path
under `services/kernel/node_modules/@dbos-inc/dbos-sdk/`. SHA-256 pins:

| Artifact                                           | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `dist/src/client.js`                               | `9031a6d260650e4e39f225e366e43eac8d7646fb799ab8270d7117ad0826a971` |
| `dist/src/system_database.js`                      | `7f8acb0c80120ad0afa59e7848bbebbfcae5d3f0754d459764b923c1b0343f2b` |
| `dist/src/sysdb_migrations/internal/migrations.js` | `d187c8a19e4c3141392c73701899ca0005155febdabdfde481bf5782fe61daff` |
| Repository SDK patch                               | `16f393956300e03b04794ec58058c98f6398bcac7d55fdbd68a6f8b84c359806` |

Source-readable installed files are not an installation receipt. The launch has
no dependency receipts; none is inferred from these files or another session's
lifecycle state. Migration `109_workflow_payload_tables` declares independent
`workflow_input(workflow_uuid TEXT PRIMARY KEY, inputs TEXT, ...)` storage.
`insertWorkflowStatus` writes status then input in separate statements, with
conflict/reuse behavior; input has no status foreign key. `enqueueInTransaction`
delegates to the caller's real transaction. `deleteWorkflowsInternal` explicitly
deletes input, output, operations and status. The bounded port uses the same
four-table body with children disabled, one READ COMMITTED attempt, pre-funded
rollback and unchanged permanent writer/restore authority. These facts establish
which transactions must maintain a projection, not that such hooks exist.

The reused upstream reference `search-worker-outcome-harness/dbos-transact-ts`
was read at `980dc55095f445b189aecb59e7f3334345179f65`, MIT (`LICENSE`),
specifically [`src/client.ts`](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/client.ts)
for caller-owned transactional enqueue. Its revision is evidence, not a substitute
for the pinned installed artifact or the downstream patch.

## Exact semantic target

Recognize exactly the existing regular expression
`^realm:leave:([0-9a-f-]{36}):([0-9a-f-]{36})$`; it is not an additional UUID
parser. Preserve the first exact native `getWorkflow(workflowId)` precedence.
An existing native legacy ID always follows the original SDK path. Unrecognized
IDs follow it too. A compatibility miss invokes the SDK with the original ID;
it does not manufacture absence. Pass the original options object and preserve
SDK errors, deadlines, original IDs, supplied-Pool ownership and close-once.

A candidate requires both native source halves. Parent name is exactly
`community.leave`, child name exactly `accounts.membership`. Both compare the
extracted member with the recognized member. Parent realm is extracted at
`{json,0,realmId}`, child realm at `{json,0,principal,id}`. Reservation is the
result of `inputs::jsonb #>> '{json,0,reservationId}'` on each side. Use the
same PostgreSQL extraction, not JavaScript serialization, JSON identity or a UUID
cast. The comparison excludes SQL NULL; an empty extracted string is legal.
Numbers versus strings and booleans versus strings can have equal extracted
text. Structured JSON must use PostgreSQL's current JSONB text rendering.
Malformed native text cannot be made a successfully covered candidate by silently
swallowing the cast error. A parse/coverage failure must refuse activation rather
than claim bounded complete coverage or invent an empty result.

The launch requires exact text equality. A byte dictionary represents that for
the deterministic text-equality domain. Before cutover, the installer must record
and verify the source expression's actual equality/collation semantics. A database
using nondeterministic collation equality cannot silently be changed to byte
identity; it needs a separate disposition. This is a deployment precondition,
not an assertion that the current database has such a collation. `COLLATE C` is
explicitly required for both **actual workflow ID tie orders**.

Rank eligible pairs by parent `created_at DESC`, parent actual ID `ASC COLLATE C`,
then child actual ID `ASC COLLATE C`. Do not add a status, application, parent-link,
role, principal-kind, authorization or deterministic-ID predicate. In particular,
a retained matching membership from another application can remain eligible.
Use PostgreSQL's existing null ordering if nullable parent times are admitted;
do not substitute JavaScript timestamp ordering.

## Primary sources and candidate comparison

All reference paths below are relative to the main checkout's `.reference/`.
They were treated as untrusted data, never installed, built or run.

### PostgreSQL limits, external storage and hash indexes

Reuse `library-shelf-maintenance/postgres` at
`700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, PostgreSQL License (`COPYRIGHT`).
[`src/include/access/nbtree.h`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/include/access/nbtree.h)
defines `BTMaxItemSize`;
[`src/backend/access/nbtree/nbtutils.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/nbtree/nbtutils.c)
checks the roughly one-third-page tuple bound and explains why ordinary out-of-line
storage is not used there. TOAST does not turn an arbitrary TEXT B-tree key into
a small ordered pointer. A 16,384-byte high-entropy reservation with short actual
IDs is already a counterexample to the literal full composite key. This is a
static representation counterexample, **not an observed PostgreSQL error**.

PostgreSQL documents a finite field limit, approximately 1 GB. The inspected
`src/include/utils/memutils.h` sets `MaxAllocSize = 0x3fffffff`; varlena headers
and JSON representations consume part of that budget. A conservative bound for
any successfully extracted text value is `H = 0x3fffffff` bytes. This is an upper
bound, not an assertion every length below it parses or allocates successfully.
History's 65,536-byte limit is a particular consumer's scope, not the native TEXT
reservation domain. [PostgreSQL field and storage limits](https://www.postgresql.org/docs/18/limits.html).

[`src/backend/access/hash/hashsearch.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/hash/hashsearch.c)
selects a hash bucket and follows overflow storage. Native hash indexes use
32-bit hashes; exact equality needs heap checking. A SHA plus full-text residual
checking has the same architectural issue: an adversarial collision bucket can
contain arbitrarily many retained candidate groups in the scalable model. A
unique digest with collision rejection changes accepted input behavior.
[PostgreSQL index types](https://www.postgresql.org/docs/18/indexes-types.html).

A prefix index has the analogous long-common-prefix bucket. A TOAST/large-object
ID, sequence ID or `ctid` does not solve finding the exact intern ID. Comparing
external strings inside an ordinary B-tree comparator can reread long prefixes
on each comparison. `ctid` is also a physical tuple location, not a stable
transactional string identity across updates and table rewrites. These are not
free alternatives to a dictionary.

### Built-in text SP-GiST

The same PostgreSQL pin's
[`src/backend/access/spgist/spgtextproc.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/spgist/spgtextproc.c)
is a compressed radix trie with byte labels, explicit end-of-string handling,
`longValuesOK = true` and exact leaf tests (`recheck = false`). It is genuine
evidence that oversized B-tree keys do not imply PostgreSQL cannot index long
strings. Prefixes are bounded by page size and suffixes shorten on descent.
[SP-GiST's long-value interface](https://www.postgresql.org/docs/18/spgist.html).

However, `spg_text_inner_consistent` allocates a reconstructed prefix at each
level, copies the previously reconstructed bytes and compares from its beginning
against the query for each viable label. `spg_text_choose` forms remaining-suffix
datums. For depth `h` and length `L`, accumulated prefix/suffix byte copies can
be `O(Lh)`, not `O(L)`. Strings branching at successive positions of a common
prefix produce `h` proportional to `L`. No invocation or benchmark is needed to
see the repeated copies in the source; no measured quadratic claim is made.

`src/backend/access/spgist/spgutils.c` advertises neither uniqueness nor ordered
B-tree output. `src/backend/access/spgist/spgdoinsert.c:checkAllTheSame` can
create multiple same-label subtrees, including a forced split when the incoming
item does not fit. It would be incorrect to infer one traversed branch solely
from dictionary logical uniqueness. Interner uniqueness needs a separate
transactional protocol. An ordinary `SELECT ... LIMIT 1` is not that protocol.
A viable SP-GiST proposal must price exact tests, reconstruction, same-label
traversal, insertion, vacuum and repeated delete/reinsert behavior. This source
inspection supplies no such additive worst-case proof.

### String dictionary literature and established radix source

Bentley and Sedgewick's 1997 paper gives an explicit separation of string digits
from population comparisons, including the `log n + k` search result for a
balanced ternary tree and discussion of dynamic weight-balanced variants. This
is primary evidence that an additive string-dictionary target is meaningful.
It is a RAM/data-structure result; making each pointer hop a SQL B-tree lookup
introduces another logarithmic factor. It does not supply PostgreSQL MVCC,
locking or reclamation. [Author-hosted paper, sections 3–4](https://sedgewick.io/wp-content/themes/sedgewick/papers/1997StringsSODA.pdf)
(copyright retained by its authors/publisher; no source-copy licence assumed).

The 2013 ART publication establishes adaptive radix indexing as an established
design family. Its publication record was read, not used as proof of PostgreSQL
transactional costs. [TUM primary publication record](https://portal.fis.tum.de/de/publications/the-adaptive-radix-tree-artful-indexing-for-main-memory-databases/).

A new shallow reference, `work-client-exact-reservation-key/rax`, is pinned at
`1927550cb218ec3c3dda8b39d82d1d019bf0476d`, BSD-2-Clause (`COPYING`), and recorded
in `.reference/INDEX.md`. [`README.md`](https://github.com/antirez/rax/blob/1927550cb218ec3c3dda8b39d82d1d019bf0476d/README.md)
and [`rax.c`](https://github.com/antirez/rax/blob/1927550cb218ec3c3dda8b39d82d1d019bf0476d/rax.c)
show explicit edge-byte navigation, compressed paths, a parent stack and
`raxRemove` walking upward to free empty nodes and recompress paths. This supports
using explicit navigation and charging reclamation. It is an in-memory C library,
not a PostgreSQL durable index or an MVCC/rollback producer. No files or long
passages are proposed for copying.

The common pattern is **exact navigable digits plus a separate terminal/value
identity**. Compression reduces space, but does not erase traversal, comparison,
path ownership or cleanup. A Patricia tree with SQL node IDs still pays for its
SQL point fetches; storing each full prefix can copy quadratic bytes. An external
suffix referencing somebody else's native input also cannot survive deletion of
that input without copying/repointing, which must be bounded and charged.

### New native access mechanism

An owned native producer could use page-local digit arrays/direct downlinks,
compare each input digit once, store bounded independent suffix chunks and
reclaim only the modified path. The intern ID would identify an exact terminal;
ordered candidate indexes would contain small IDs, not digests. This is a design
direction, not a completed producer or a proof that adapting stock SP-GiST is a
small patch. Changing only its equality callback leaves insertion copies and
same-label routing to prove.

A new AM/opclass needs server-compatible compiled code, versioned SQL/control
files, WAL/crash recovery, MVCC/snapshot rules, vacuum/reindex/backup/restore
support, upgrades and an owner for page-format compatibility. PostgreSQL requires
superuser authority to create an AM or operator class, and privileged installation
of untrusted C functions. Application schema DDL privilege alone is insufficient.
Managed hosting must explicitly support that artifact. No such extension,
deployment grant or dependency receipt is supplied here.
[CREATE ACCESS METHOD](https://www.postgresql.org/docs/17/sql-create-access-method.html),
[CREATE OPERATOR CLASS](https://www.postgresql.org/docs/18/sql-createopclass.html),
[CREATE FUNCTION](https://www.postgresql.org/docs/18/sql-createfunction.html).

## Concrete relational dictionary and its exact boundary

This section makes option 2 concrete and quantifies why it is not silently
substitutable for option 1. It uses ordinary PostgreSQL tables, bounded B-tree
keys and PL/pgSQL. It is **a costed reference model, not product implementation**.
The ledger applies even to the subdomain with short actual workflow IDs and
fixed valid realm/member strings; therefore the uniform-cost gap does not depend
on an unrelated extreme workflow-ID fixture.

### Dictionary schema and key sizes

Split reservation bytes in the database encoding into consecutive chunks of at
most `K = 128` bytes. All nonfinal chunks have exactly K bytes. An explicit
terminal flag distinguishes a string ending at a node from longer descendants.
Empty text terminates at the root. Do not pad, normalize, hash or truncate. Use
the original extraction before converting to bytes; store bytes as `bytea`, so
chunks need not individually end on a character boundary.

Conceptual schema (all integers below are fixed-width):

```text
control(singleton bool PK, generation int8, covered bool, allocator_high int8)
node(id int8 PK, parent int8, label bytea <=128,
     pass_count int8, terminal_count int8)
UNIQUE node(parent, label)             -- non-root nodes only
free_range(lo int8 PK, hi int8)        -- disjoint maximally coalesced ranges
source(actual_id text PK, status_version int8, input_version int8,
       status_present bool, input_present bool, candidate metadata)
candidate(actual_id text PK, realm36 text, member36 text,
          reservation_node int8, side int2, parent_time int8)
group_state(realm36 text, member36 text, reservation_node int8,
            parent_actual_id text, child_actual_id text, parent_time int8)
eligible(realm36 text, member36 text, reservation_node int8,
         parent_time int8, parent_actual_id text, child_actual_id text)
```

Dictionary edge keys have at most 136 content bytes (`parent + label`), plus
varlena/index overhead; node/free keys are 8 bytes, and group identity is at most
80 content bytes (`36 + 36 + 8`). These fit default PostgreSQL pages without
relying on compression. Root/control are fixed global non-account rows. Internal
IDs are locators only; native actual IDs remain the returned authority.

For the **short-ID cost submodel only**, candidate successor indexes are:

```text
parent(realm, member, reservation_node, parent_time DESC,
       actual_id COLLATE C ASC)
child(realm, member, reservation_node, actual_id COLLATE C ASC)
eligible(realm, member, parent_time DESC,
         parent_actual_id COLLATE C ASC, child_actual_id COLLATE C ASC,
         reservation_node)
```

With actual IDs at most 1,024 bytes, their largest content key is 2,136 bytes
(two IDs, realm/member, time, node); tuple overhead still fits an ordinary 8 KiB
B-tree page. The 1,024 figure already belongs to the bounded native writer-state
port, **not** the full legacy resolver domain. This is not a recommendation to
apply it to legacy IDs. A complete general implementation must also represent
actual-ID order without assuming a new cap. Even an ID fitting the original
single-column native index does not prove it fits every new composite index.
An ID trie/ordered external-key producer must price tie selection and copying
replacement winner IDs too. That is another reason this baseline is explicitly
model-scoped, rather than a complete compatible product design.

### Transaction protocol and pseudocode

The serialized reference model acquires one control lock before any native
owner/status/fence row locks. Then it keeps existing native lock order, locks
source actual IDs in C order, and processes old/new group identities in sorted
order. Dictionary navigation is root-to-leaf; GC is leaf-to-root under that
same control lock. Native permission and permanent fences are still checked.
Source mirror versions are generated under this serialization, not supplied by
callers or inferred from timestamps. Every stored candidate is reconstructible.

```text
on_original_native_mutation(tx, OLD, NEW, source_half):
    require exhaustive participating owner hook and prepaid original work
    hold admission/control lock before existing native row-lock sequence
    change the original half in tx, preserving native fences and errors
    update only that half's source metadata from OLD/NEW
    read the other half's synchronized source metadata, not an old unlocked scan
    old_candidate = source.previous_candidate
    new_candidate = classify_both_halves_with_original_predicates()
    if candidate identity unchanged: update changed rank fields only
    otherwise:
        intern_and_retain(new reservation) if new_candidate exists
        remove old candidate if present; insert new candidate if present
        refresh each DISTINCT old/new group, at most two groups
        release old reservation if no longer referenced
    delete empty per-actual-ID synchronization state when both halves disappear
    commit native and derived changes together; rollback rolls back both
```

Each group refresh performs one fixed selection operation containing one parent
ordered seek and one child ordered seek, each `LIMIT 1` with its full group equality
prefix. It replaces/deletes at most one eligible row. This is at most two group
refresh selections (four component seeks), never parent-by-child enumeration.
A WorkClient seek reads the first eligible row for the realm/member equality
prefix. Its miss is one empty seek; it does not poll unmatched parents.

```text
intern_and_retain(bytes):
    n = root
    for chunk in canonical_fixed_chunks(bytes):
        e = indexed edge(n, chunk)         # one logical point
        if absent: allocate slot; insert edge/node with pass_count=1
        else: increment that node's pass_count
        n = edge.id
    increment terminal_count(n)
    return n.id

release(terminal):
    decrement terminal_count(terminal)
    n = terminal
    while n != root:
        r = point-read n                   # obtain parent and pass_count
        if r.pass_count > 1: decrement pass_count
        else: delete r; release_slot(r.id) # no recursive FK cascade
        n = r.parent
```

`pass_count` counts retained candidate references whose path includes that node,
including descendants, not only distinct terminal strings. Repeated equal values
therefore share one path but maintain references correctly. Release must continue
through shared ancestors to decrement their counts; stopping at the first shared
node leaks counts. It never visits siblings or their strings. A terminal may
also have descendants. References are removed before releasing a terminal ID.

An allocator must not leave a row per historical allocation. Under the control
lock, take the least free interval and advance its lower endpoint, or increase
the high-water mark when none exists. Release probes predecessor and successor
intervals, coalesces adjacent intervals, and shrinks the high-water mark if the
merged interval reaches it. At most two neighbors and one high-water record are
changed. Free intervals number at most live slots plus one; when no non-root
nodes remain, both high-water and intervals return to empty. No account/value
bytes are kept there. This supports delete/reinsert without an ever-growing
sequence ledger or repeated gap search. Ordinary storage exhaustion is not a new
reservation-validation rule. Slot reuse is atomic with source/group reference
removal; old PostgreSQL snapshots retain their consistent old row versions.

This global admission order is a **producer requirement**, not something an
AFTER ROW trigger can assume. The existing bounded SDK takes native status/domain
locks before the delete dispatch. A caller can already hold native locks before
an ordinary writer statement. Adding a control lock after those locks while
another writer takes control first creates lock inversion. Statement triggers
alone do not solve prior `SELECT ... FOR UPDATE` ownership. An implementation
must integrate the common admission order into every supported native writer,
including old-writer paths, or supply a separately proved distributed protocol.
Existing permanent fences must not be replaced or disabled. That integration is
absent here; no global-lock retrofit is declared concurrency-safe by this report.

At READ COMMITTED, a waiting owner must read synchronized state in a fresh
command snapshot after obtaining admission. Under repeatable/serializable
snapshots it must preserve PostgreSQL conflict/serialization refusal, not use a
stale mirror as current authority. SQL locking without refreshing a prior
statement's snapshot is insufficient. No new hidden retry is permitted in the
single-attempt maintenance path. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html).

Crashes before commit expose neither half-complete candidates nor half-complete
GC. Committed source and projection recover through ordinary PostgreSQL WAL.
Ambiguous commit propagates and later ordinary admission observes native state;
there is no synthetic receipt, refund or immediate retry. An old reader may see
a complete old snapshot, but no new transaction may combine old projection with
new source authority to issue lifecycle permission.

### Literal dictionary operation ledger

Define `q(L) = ceil(L/128)`, `q(0)=0`. Count a logical row read and a later write
as two row operations. Count an empty exact/range seek as one point and statement,
but zero returned rows. SQL statements inside a function count; an outer SELECT
is counted separately. All ledgers below are conservative literal maxima for the
specified pseudocode, not estimates based on elapsed time. `engineRequests=0`
means no separately dispatched engine operation, not free PostgreSQL index work.

A slot allocation/release reserves `A=(7 rows, 7 points, 7 statements)`:
control read/write (2), up to two neighboring range seeks (2), up to two range
deletes/updates (2), and one resulting range insert/update (1). Branches that do
less work still reserve the full maximum. In an implementation, allocation's
control read can include the already-held lock but must not be charged twice.
These deliberately inclusive limits permit no range scan or cascading trim.

| Primitive, excluding native I/O    |   Rows | Points | Statements | Server result retained by caller |
| ---------------------------------- | -----: | -----: | ---------: | -------------------------------: |
| Dictionary equality lookup         |  `q+1` |  `q+1` |      `q+1` |    8-byte terminal ID or absence |
| Retain existing/new reservation    | `9q+2` | `9q+2` |     `9q+2` |               8-byte terminal ID |
| Release reservation                | `9q+2` | `9q+2` |     `9q+2` |              no reservation text |
| Dictionary outer function dispatch |      1 |      0 |          1 |   at most 16 bytes of IDs/counts |

For retain: per chunk reserve one edge read, one node insert/update, and A for
possible allocation, totaling 9. Finish with terminal read and update, totaling 2. For release: per chunk reserve node read, node update/delete and A for slot
release, again 9; terminal read/update adds 2. Parent IDs obtained in those reads
avoid rediscovering paths. Equality reads each edge and terminal exactly once.
Allocation probes are bounded regardless of interval population or allocation
history. Additional constraint/FK probes must either be absent from this schema
or explicitly added by the implementation; no hidden relational cascades are
included in these constants.

For the source/group layer in the short-ID submodel, the following conditional
ledger has `F=(20 rows, 20 points, 20 statements)` per changed actual ID: source mirror
read/write (2), complementary half metadata read (1), old candidate read (1),
old candidate delete/new insert (2), at most two group-state locks/upserts (2),
two refresh selections with two component successor seeks each (4), up to two
old eligible deletes and two inserts (4), two group-state updates/deletes (2),
source candidate-pointer update (1), and source empty-state removal (1). All are
explicit fixed keys. This model has only the declared PK/UNIQUE indexes: their
index maintenance belongs in the design-visible logarithmic work below. It has
no extra FK, RLS or trigger SQL beyond the listed operations. A physical schema
adding any such body must add its literal cost rather than use this F unchanged.

F is conditional on having already derived, live complementary-half metadata.
It is not a complete price for first-half insertion, recovery or backfill. If
source mirrors store only IDs of native halves, reading/parsing the opposite
input adds that input's bytes; it cannot be called free. If they retain parsed
metadata or intern references before a complete candidate exists, those are
additional copies/references whose creation, deletion and source-half liveness
must be charged. They are not included in this candidate-only F. In particular,
a status reinsert over a retained native input may require reading input bytes
that were not changed by that status write. The final producer must either prove
an admissible live metadata protocol, or explicitly price this reread under its
chosen model. Do not silently redefine B to include all encountered history.

Thus the **candidate model's** per-mutation upper reservation is
`M(Lold,Lnew)=F + (9q(Lold)+2) + (9q(Lnew)+2) + outer`, componentwise for
rows/points/statements, omitting an absent old or new candidate. This prices a
membership/group move before selecting fixed parent maxima. For a removal use
`D(L)=F + (9q(L)+2) + outer`; an absent-candidate second half still reserves F
unless a smaller separately proved dispatch distinguishes it before I/O. Identity
or name changes are remove+insert, not a supposedly free status update.

For 16,384-byte old and new reservations, each `q=128`, so the declared M bound
is 2,329 rows, 2,328 points and 2,329 statements when `outer=(1,0,1)`; D is
1,175 rows, 1,174 points and 1,175 statements. These are source-derived
reservations for this deliberately simple model, not measured SQL counts or
proposed production constants. Equal-value/no-op paths can be separately priced
only after their complete bodies exist.

The existing SDK byte axis counts returned content, not table/WAL storage. A
server-only dictionary function can return only terminal IDs/counts. If reservation
bytes are fetched into JavaScript, retain/release/repair must instead reserve
those returned bytes **before that fetch**. For the short-ID model, the fixed
source/group operations return at most 20 rows, each bounded by two 1,024-byte
IDs, two 36-byte strings, four int8 fields and small flags: reserve 2,160 bytes
per row, hence 43,200 bytes, plus 16 bytes for the dictionary return. This is a
conservative return bound for the model, not the full unrestricted-ID domain.

Store each 128-byte label once per dictionary node. Excluding physical tuple and
index overhead, node metadata is at most 48 bytes; its PK and edge index add at
most `8 + 8 + 128 = 144` content bytes per node, for at most `320q` stored content
bytes per distinct path. Read/write label work per visited chunk is bounded by
128, so navigation and mutation copy `O(L+q)` bytes, not all historical prefixes.
Free-range operations use only 16-byte ranges. Source/candidate/group/eligible
copies add O(number of live candidates/groups) bounded-key metadata in this
submodel; they must be enumerated in account custody too. Native input remains a
separate authoritative copy. Dead tuples/WAL are physical copies maintained by
PostgreSQL, not erased merely because the logical row disappears.

A function must use an offset into one materialized input byte buffer and form
each chunk once. Repeated `substring`/conversion of a toasted full input on every
iteration can introduce `O(Lq)` bytes and invalidates even this baseline ledger.
Likewise, PL/pgSQL array append of a growing whole path can be quadratic. Release
uses stored parent links, not a growing copied path. These are implementation
obligations, not optimizations assumed without evidence.

### Population and byte proof

Let d count actual native source-row changes, including both halves separately.
Let B sum the lengths of the old and new changed input values, including bytes
available to the extraction step. Let N include **all** live dictionary, free-range, source,
candidate and group rows, rather than just the selected realm's history.

With ordinary indexed SQL, each chunk hop/allocator/GC point is `O(log N)`
index work. Under adversarial entropy or prefixes, `sum q = O(B/128+d)`, and
maintenance is therefore:

```text
logical rows/points/statements: O(d + sum q)
dictionary label/buffer bytes:  O(B + d), after extraction
design-visible index work:      O((d + sum q) log N)
                              = O(d log N + B log N)
```

Full input extraction has a separate cost P(input). Calling `inputs::jsonb`
does not prove P is linear: at the same PostgreSQL pin,
[`src/backend/utils/adt/jsonb_util.c:uniqueifyJsonbObject`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/jsonb_util.c)
sorts object pairs with a string comparator and keeps the last duplicate key.
Structured reservation rendering must preserve this behavior. The source-level
comparison sort must be accounted for; this report supplies no linear-time
replacement extractor or proof that every accepted JSON shape makes that cast
linear. Consequently the full conditional baseline is the displayed dictionary
cost **plus** P and any complementary-half reread/metadata work above. Even an
additive native dictionary alone would not certify complete maintenance without
that extraction/copy derivation. This is another explicit obligation for the
chosen producer, not a reason to narrow structured JSON compatibility.

Patricia compression can reduce q on particular data. It cannot replace this
worst-case proof with `O(d log N+B)` merely by naming the structure. Equal values
still traverse their common path to intern; release still touches ancestors.
Collision-shaped data has no special failure or scan in this trie. Unrelated
live data affects each point's index height, not the number of chunks; that is
exactly the multiplicative term the uniform additive model forbids.

In the **literal fixed-domain model**, every successfully extracted reservation
has `L <= H`, so `q <= Q = ceil(H/128) = 8,388,608`. The candidate model's M maximum
is consequently 150,994,969 rows, 150,994,968 points, 150,994,969 statements,
before native/source controls and constraints outside this model. These maxima
are finite safe integers. Thus one can explicitly write an `O(d Q log N+B)`
bound and call Q a fixed engine-domain coefficient. No new length cap is needed.
It is not the uniform statement with constants independent of the admitted
length domain, nor an acceptable unpriced constant. No existing child budget is
increased or claimed sufficient by these calculations. A smaller configured or
remaining allowance continues to refuse before I/O.

This is the precise model boundary to resolve, not a proof that all possible
PostgreSQL-native string dictionaries fail. Database page splits, visibility
chains, vacuum and concurrent uncommitted versions remain ordinary engine work
excluded from product metering by `docs/architecture.md`. Repeated explicit
point probes, casts, copies, residual tests and function SQL are design-visible
work and cannot be moved into that exception.

## Backfill, repair, restore and copy custody

For any selected representation the complete producer must implement these
operations; none exists merely because its schema has been described:

- **Install:** independently version a Work-owned migration after the SDK split
  input migration; verify schema/parse/equality assumptions, trigger coverage,
  writer protocol and algorithm version. Do not occupy an upstream migration
  number or edit installed dependencies. Coverage starts false.
- **Live mutations:** every INSERT/UPDATE/DELETE of either status or input,
  including raw SQL, COPY/restore, reuse/conflict paths, sweeps and old writers,
  participates in the same atomic source/candidate update. A status-only or
  input-only row has no eligible candidate. Deleting either half removes the
  candidate before the original transaction commits; surviving native orphan
  bytes retain their existing owner and custody rules.
- **Backfill:** enumerate each native table by its actual indexed primary key,
  with a fixed batch (one row is sufficient). Lock/version the exact actual ID
  through the supported owner hook; reread both halves, then call ordinary
  synchronization. Advance one bounded progress record in the same transaction.
  Scan both tables so input-first/orphan cases are not lost. Reserve at most one
  source item, its actual input bytes, M, two counterpart probes and progress
  read/write per step, plus native controls. Never enumerate parent×child pairs.
- **Convergence:** hooks must be active before enumeration. Delete/insert/move
  racing the cursor is version-serialized with the exact source ID. A partially
  rebuilt epoch is never used by WorkClient. Activation needs a genuine exhaustive
  coverage barrier tied to the native writer/restore generation and committed
  cursors, not elapsed time or an index's presence. Old-snapshot replay must fail
  or revalidate under the current supported native protocol.
- **Repair:** first invalidate the affected coverage generation atomically; then
  rebuild with the same bounded source enumeration and M/D ledger. No read-time
  scan, growing empty poll or synthetic “covered” flag. Missing source hooks or
  invalid parse cannot be repaired by treating a query miss as complete.
- **Restore:** preserve permanent native fences, advance the existing SDK restore
  domain through its supported offline interface, invalidate locator coverage
  and rebuild before cutover. A restored derived snapshot cannot make a retired
  native writer live. Replacing epochs must also dispose of the old epoch's rows
  through bounded owner-accounted deletion; keeping every epoch leaks copies.
- **Erasure/GC:** source mirrors, chunks, parent links, terminal references,
  candidates, group winners, eligible rows, account associations and progress
  records are additional physical relationships. Account locators must cover
  each family, including orphans and interrupted rebuild state. Remove derived
  source relationships in the original authorized deletion transaction. Remove
  empty account-specific synchronization rows; anonymous allocator/control state
  contains no account identity. No projection row is a lifecycle/absence receipt.

A global dictionary shares chunks among accounts. Removing one reference does
not authorize deleting another live account's shared chunks. Conversely, keeping
a zero-reference path because it might be useful later leaks deleted bytes.
The pass-count and coalescing allocator algorithms above reclaim exactly that
path; no GC walk over other values is permitted. There are no deferred native
half-liveness fixes after COMMIT. Multiwriter crashes and rollback must exercise
both reference counts and source/group publication, not just final lookup output.

A complete native producer must also publish its transaction-lock placement for
backfill and restore. “Use a trigger” or “run this function” is not an exhaustive
SDK/writer/deletion interface, and does not solve old-writer lock order or funding.

## Whole-call accounting and unavailable producer boundary

Use vectors `(rows,points,statements,returned bytes,engineRequests)`. Current
source-literal SDK prices, before any dictionary or group producer, are:

| Dispatch                                           | Present price     |
| -------------------------------------------------- | ----------------- |
| rollback, prepaid before BEGIN                     | `(0,0,1,0,0)`     |
| begin                                              | `(0,0,1,0,0)`     |
| settings                                           | `(1,0,1,128,0)`   |
| lock                                               | `(4,2,4,8192,0)`  |
| retire                                             | `(8,5,9,32768,0)` |
| delete-workflow_input                              | `(1,1,1,0,0)`     |
| delete-workflow_output                             | `(1,1,1,0,0)`     |
| delete-operation_outputs                           | `(64,1,1,0,0)`    |
| delete-workflow_status, including four FK cascades | `(73,5,5,0,0)`    |
| commit                                             | `(0,0,1,0,0)`     |

Their complete present sums are retirement `(13,7,17,41088,0)` and deletion
`(144,10,16,8320,0)`. `SDK_TRANSACTION_FENCE_COST` is `(4,2,4,8192,0)` per
independent fence dispatch. Nested work is charged once inclusively; do not add
the same original fence twice because its function is called from a priced
wrapper. If a new installer adds work to that fence, its literal must be
rederived, not treated as covered by the old price.

For the relational model, every relevant native writer dispatch must add M or D
for each actual source mutation in that dispatch, including both halves and
conflict/no-op outcomes. A status retirement owner-token UPDATE can still enter
the hook; its proved unchanged-key path must be priced. A delete-input dispatch
adds D for its live candidate; delete-status must still price empty synchronized
state, rank changes and cleanup, even after input was deleted first. Raw/native
retention writers and backfill outside this Source invocation need their actual
owner's existing accounting. They cannot borrow a future Source frame.

A new `maintainSdkWorkflowOnce` callback must reserve the complete inclusive
literal **before the original affected I/O**. Dynamic byte information needs a
funded preceding point read or a sound pre-I/O maximum based on already admitted
metadata. Discovering the cost after a trigger runs is retrospective funding.
The existing callback takes a dispatch string, not an arbitrary input-length
quote; a producer must either publish fixed maxima by dispatch, or add a
supported length-aware quotation protocol in the original live frame. The report
chooses neither a replacement frame nor an unpriced probe. Rollback remains
prepaid before BEGIN; refusal, thrown SQL, rollback and ambiguous commit retain
all prior charges. Deadlines and actual Pool identity are unchanged.

The original full Source aggregate is **not five verifier entries**. For a
complete admitted path p, the required composition is:

```text
S(p) = Source staging/admission(p)
     + directory read and independent verification(p)
     + every fresh Source verifier entry(p) * V
     + original Account/source/accepted-job reads and command controls(p)
     + History readiness, handoffs and recording guards(p)
     + native writer observations and fence dispatches(p)
     + original native retirement/deletion controls and inclusive bodies(p)
     + every reached projection M/D/lookup/coverage/GC dispatch(p)
     + both physical inspections and final absence/receiving commit(p)
     + all reached pre-funded failure/rollback slots(p)

parent[axis] = max over complete finite admitted p of S(p)[axis]
```

Library has a **separate** complete path sum in its own dimensions; it is not
convertible into spare native bytes. Reused authority, refunds, renewal, a
replacement frame and discounted child prices do not appear in this equation.
Maximize complete paths componentwise after enumerating their bodies, including
failure branches; do not combine guessed maximum call counts with unidentified
operations. Smaller caller allowances remain binding even after a new parent
maximum is adopted.

Source evidence fixing several summands:

| Operation or scope                                                                                    | Literal source price / obligation                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Every independent Source verifier V                                                                   | `(100,100,22,139264,0)`                                                               |
| Directory pre-split envelope                                                                          | `(100,200,36,229376,0)`                                                               |
| Directory effective child                                                                             | `(50,100,18,114688,0)`; reserve read and independent verify before either dispatch    |
| History command control                                                                               | `(3,1,8,256,0)`, including failure slot                                               |
| `advanceInFrame` receiving read                                                                       | `(72,72,6,32768,0)` plus its command control                                          |
| Original Account source read                                                                          | `(70,68,25,73984,0)`                                                                  |
| Original accepted lookup                                                                              | `(86,80,59,205920,0)` including its finite retries/snapshots                          |
| Retirement-stage source handoff                                                                       | `(73,71,26,82176,0)` before consumer reconstruction/staging                           |
| Retirement-stage verification wrapper                                                                 | `(71,71,19,82048,0)` plus command control and fresh V                                 |
| Receiving-binding wrapper                                                                             | `(160,80,6,131072,0)` plus command control on each entry                              |
| Recorded handoff outer reads                                                                          | `(1,1,1,106496,0)` during readiness; `(1,1,1,122880,0)` during later recorded closure |
| History guard                                                                                         | `(92,87,11,40960,0)` plus separately priced outer operation                           |
| History absence guard                                                                                 | `(9,9,9,0,0)`                                                                         |
| Repeated receiving/fence observations, physical inspections, sealing, invalidation/wake, final writes | Required additional summands in their actual reached bodies, never zero               |

At least five fresh V entries precede SDK deletion on the retained-terminal
path: initial reconstruction, retirement verification, readiness handoff,
closure handoff and preparation of recorded cleanup. Five alone cost
`(500,500,110,696320,0)`, exceeding the historical 630,784-byte parent by 65,536.
The supplied owner decision now authorizes a **fully body-derived** parent
maximum, so that historical comparison is not a current unchanged-ceiling
blocker. It is not the new maximum either. Further fresh checks occur immediately
before deletion and in final receiving; `lockRecordedAgentIdentityHistory` calls
current Source/native handoff again. Physical inspection and final commit stay
inside `withAgentIdentityHistoryUnit`'s same original Source frame.

The inspected `library/identity-scope-effects.ts:readLibraryScopeEffectsPage`
returns `status:'unavailable'` with zero reported use; its seal verifier returns
false. Those are unavailable adapter semantics, **not a zero-cost successful
Library producer**. Its successful-page, verification and receiving-footprint
literal is unavailable. A complete successful-path aggregate cannot be derived
by maximizing only the currently reachable refusal path. There is also no
source-delivered exhaustive dictionary hook/installer body to price, and no
chosen new native dictionary producer. Consequently this report deliberately
publishes **no numeric replacement parent default/hard maximum**. Doing so would
invent missing successful bodies. This is a precise remaining dependency, not
permission to raise V, directory or Library child allowances.

## Adversarial acceptance pseudocode — all UNRUN

Retain the three authored legacy-leave tests verbatim. These are additional
scenarios for the original complete implementation and native owner hooks; no
test source, frozen file or product code is edited by this research task.

```text
for population in [64, 512, 4096]:
    use normal isolated migrated GrowthDatabase and createWorkClient
    seed through actual status/input native writes, never copied projection SQL
    retain 12 native operation_outputs; request limit=10, offset=0
    record actual native writer/deletion and WorkClient work, including triggers

    assert exact legacy native-ID precedence and original options/error behavior
    insert older eligible group behind population unmatched newer parents
    assert actual child steps; then complete miss uses one eligible empty seek
    seed repeated same reservation and tied parent times with reverse insert order
    assert parent actual C order, then child actual C order
    allow matching child from another application and unrelated parent linkage
    assert number/string, boolean/string, object-key and array extraction behavior
    include empty text, SQL NULL and missing-path distinctions
    insert 16,384-byte high-entropy reservation and very long common prefixes
    assert exact match and one-byte distinction without digest or prefix identity

    delete only parent input; assert no compatibility hit before COMMIT returns
    reinsert original input using native hook; assert native actual child restored
    delete only child status, last child, winning parent and winning child
    assert fixed successor selection; never enumerate parent-child products
    rollback each insert/move/delete after hook; assert original state and refs
    delete and reinsert same bytes repeatedly; assert bounded live nodes/free ranges
    assert deleting final reference leaves no zero-ref path/account tombstone

    race status-first/input-first writers and old/native raw writers
    race two equal interns, two distinct shared-prefix interns, delete vs reinsert
    race opposite old/new group moves and interrupted backfill cursor advancement
    hold old snapshot across races; assert original native conflict/rollback rules
    simulate crash/ambiguous commit only in later authorized native harness
    assert complete committed source/projection or complete rollback, no stale hit
    assert missing/disabled/version-mismatched hook refuses coverage activation
    restore older derived epoch with newer permanent fence; assert no writer revival
    assert all derived/orphan/cursor copies in authoritative account inventory
    assert actual-ID domain edge cases too, not only short maintenance-port IDs

    compare fixed logical lookup rows/statements and logarithmic indexed work
    vary changed input bytes independently of unrelated population
    for relational model assert its declared q-dependent ledger, not additive claim
    for additive native producer require proof/measure of one-pass bytes,
        direct branch navigation, bounded changed-path cleanup and no residual scan

for every actual SDK dispatch before I/O:
    spy on original reserveIdentityHistoryWork in same Pool/frame/deadline
    assert inclusive current fence + hook + GC cost reserved once
    refuse each axis one unit short; assert no affected dispatch happened
    assert rollback funded before BEGIN; prior reservations never refunded
    repeat genuine verification entries; deduct full V anew
    enumerate complete successful and refusal call paths through final receiving
    assert componentwise body sums fit adopted parent; smaller balances refuse
    require actual Library producer's separate complete literal, never zero stub
```

No fixture-only coverage switch, substitute resolver, SHA identity, fabricated
native receipt, copied authority or private frame can satisfy these assertions.
The SHA in the existing long-key fixture generates entropy only. Native/growth
measurement must observe function statements and design-visible points/bytes,
not only application query count or elapsed time. Pool close ownership and
lifecycle nonmutation remain acceptance obligations too.

## Handoff recommendation and file inventory

Adopt option 1 unless the owner explicitly selects the fixed-domain interpretation
and its literal admission consequences. In either case retain the exact original
legacy relation and two fixed group refresh operations. Do not restart the
stopped producer or treat this report as permission for an implementation,
installation or retry. Put an adopted model choice and producer/deployment
requirements in the owning contract; this report is evidence only.

The unresolved boundary is specifically **a proved and priced navigable exact
key producer in the chosen PostgreSQL cost model**, including its native lock
placement and reclamation. Ordinary B-tree failure proves no broader
impossibility; theoretical additive dictionaries prove no installed availability.
The additional complete-success aggregate dependency is the unavailable Library
producer and literal source bodies, not the superseded historical parent ceiling.
No relaxed equality, new cap, child increase or unbounded maintenance is selected.

The only committed file is this report. No product/test/frozen file changed.
Outside the declared report path, the permitted reference clone
`.reference/work-client-exact-reservation-key/rax/` and its index line in
`.reference/INDEX.md` were created under the main checkout's explicitly writable
reference directory to preserve the primary source pin and licence. No other
main-checkout path was written. No new source was copied into the product.
