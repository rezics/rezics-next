# Private heap-TID WorkClient: complete-design review and concrete counterexample

## Result

The selected immutable heap-TID direction removes the _per-byte ordinary-index
descent_ in the earlier relational radix model. It does not yet supply a complete
compatible producer. In particular, the concrete candidate that uses PostgreSQL
`inputs::jsonb #>> ...` to produce keys fails the required uniform
`O(d log N + B)` byte-work bound. This report gives a source-level counterexample:
an object-valued reservation with many distinct, equal-length, long-common-prefix
member names causes repeated prefix comparison during PostgreSQL's object sort.
Some input permutations require `Omega(B log m)` byte examination for `m` members,
before any private node is visited. Short native workflow IDs suffice.

This is a rejection of that concrete extraction body, **not** an impossibility
result for immutable heaps, exact dictionaries, SQL, or compatible custom
canonicalization. A byte-linear producer reproducing the server's extraction and
error semantics could change the result. No such producer is delivered or priced
here. Calling the PostgreSQL cast, wrapping it in one function, or moving it from
lookup into a trigger does not establish its linearity.

There is also a separate, concrete restore counterexample to using only root
reachability as the authoritative inventory. A logically restored heap tuple can
have a different physical TID while a restored root still contains its old numeric
TID. An invalid root cannot locate, delete, or prove absence of that tuple. A
complete independent inventory/removal producer remains necessary. The accepted
invalidation policy deliberately does not waive this requirement.

Consequently this report does **not** certify a complete implementable positive
design or publish new dispatch or parent literals. It records the precise failing
bodies, the portions that can be bounded conditionally, the complete obligations
that survive those failures, and the minimum remaining callable bodies. This is
the contract's counterexample outcome, not another comparison of ordinary exact-key
indexes. All SQL examples and pseudocode below are analysis, not installation.

All compiler, test, SQL, native, concurrency, restore, accounting, growth and
physical-proof execution is **UNRUN**. The nonempty-report acceptance command is
also deferred under this launch's execution policy. This documentation change has
no workspace typecheck. No product source, migration, dependency, existing test,
frozen file, installed package or original authority is changed.

## Evidence boundary and source inventory

Repository behavior is pinned to
`30d6045d9829bc07d022380265381965804f6eac`, abbreviated `30d6045d` below.
The two preceding reports were read in full at their committed versions:

| Evidence                   | Commit                                     | Report                                                           |
| -------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Primary model analysis     | `d7666822d6fa00edd90120d013e4beecbc8cebdc` | `docs/research/work-client-exact-reservation-key-primary.md`     |
| Independent model analysis | `e1b230d1397418ea9c538e3c840644ca1f02972b` | `docs/research/work-client-exact-reservation-key-independent.md` |

Both analyze `1556f48ef91b0aee8719fa6321e9b35d500c7dc0`, not `30d6045d`.
Their node-slot examples are conditional models, not deployed tables or installed
prices. Their ordinary-index counterexample is retained without repeating that
survey. The historical accounting report at
`1196dc8d59bf3e91b335e473db13d719b70ed9d4` was also read through `git show`;
it is evidence, not the current source pin or permission to resume implementation.

The applicable `AGENTS.md`, development workflow and Goal definitions, architecture
and scope documents, complete Kernel README, complete Work README and History
README were read. Source analysis follows the actual resolver, repository SDK
patch, native writer bodies, retirement/fence wrapper, Source frame, History
staging/readiness/closure/physical cleanup and receiving paths. Source absent from
the checkout was read with `git show`; filesystem absence was not treated as an
absent committed implementation.

The following complete owner documents define the receiving boundary. They were
read by these exact absolute paths. They are references to existing authority;
this report neither duplicates their authority nor adopts new product decisions.

| Document                          | Absolute path below `/home/edge/projects/rezics/rezics-next/`                           |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| Bounded legacy contract           | `.temp/goal/performance/decisions/work-client-bounded-legacy-contract.md`               |
| Primary receiving/model selection | `.temp/goal/performance/decisions/work-client-exact-key-primary-receiving-20261101.md`  |
| Additional-copy disposition       | `.temp/goal/accounts/work-client-legacy-locator-owner-disposition-20261102.md`          |
| Private-TID Source receiving      | `.temp/goal/search/work-client-private-tid-source-receiving-20261102.md`                |
| Heap-TID accounting receiving     | `.temp/goal/semantic/work-client-heap-tid-owner-receiving-20261102.md`                  |
| Fixed aggregate disposition       | `.temp/goal/semantic/work-client-fixed-aggregate-owner-disposition-20261102.md`         |
| Maintenance accessor review       | `.temp/goal/performance/decisions/accounts-source-maintenance-owner-review-20261101.md` |

The source delta from `1556f48e` to `30d6045d` matters:

| Area                                                            | Change at the new pin                                                           | Consequence                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `work/client.ts`, `work/sdk-retirement-fence.ts`, SDK patch     | No change                                                                       | Original lookup, native fences and dispatch-string admission remain the baseline.                                     |
| `history/agent-identity-inventory-work.ts` and callers          | Explicit maintenance context propagation plus implicit active-frame observation | Observation does not create, renew or fund a frame. The implicit-null success remains an owner correction dependency. |
| History inventory, recovery receiving, source and receipt paths | Additional original recovery/copy receiving work                                | Extra reached reservations cannot be omitted from a complete original invocation.                                     |
| `semantic/identity-source-consumer-maintenance.ts`              | Additive active-frame accessor                                                  | Same-Pool observation alone is not live admission.                                                                    |
| Work registry/transport                                         | Separate Kind-consent participant wiring                                        | It installs no compatibility heap, quote producer or copy inventory.                                                  |
| Source custody/config and Library successful adapter            | No replacement complete composition                                             | The old native ceiling is insufficient evidence; Library's successful body is still unavailable.                      |

Source visibility and runtime installation are separate. This launch has no
dependency receipt proving installed source and satisfied preconditions. Nothing
here infers installation from a readable function, package manifest or prior
completion prose.

### Reused primary reference sources

Existing clones were reused. No clone was installed, built, tested or executed.
Only permitted reference-index metadata is updated outside the worktree.

| Label | Local reference directory below `.reference/`     | Exact revision                             | Licence                         |
| ----- | ------------------------------------------------- | ------------------------------------------ | ------------------------------- |
| PG    | `library-shelf-maintenance/postgres`              | `700b422af7e26cf310caf3fb76d78f4c8ca39c1f` | PostgreSQL License, `COPYRIGHT` |
| SDK   | `native-scheduler-funded-design/dbos-transact-ts` | `627990fc59619d3584ce88511ab546bc7483f4b9` | MIT, `LICENSE`                  |
| Rax   | `work-client-exact-reservation-key/rax`           | `1927550cb218ec3c3dda8b39d82d1d019bf0476d` | BSD-2-Clause, `COPYING`         |

PG is an exact development-source model, not a claim about the deployed server
major, build options, page size, encoding or collation. The SDK revision is the
existing indexed reference for `5.5.3-preview`; repository patch semantics take
precedence over its unpatched bodies. Reuse of that clone reads SDK source only;
no independent scheduler draft or worker output is used.

Primary source links and inspected bodies:

- [PG JSON input](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/jsonb.c):
  `jsonb_from_cstring`, object-end/scalar callbacks, `JsonbToCStringWorker`.
- [PG JSON representation](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/jsonb_util.c):
  `pushJsonbValueScalar`, `uniqueifyJsonbObject`,
  `lengthCompareJsonbPair`, `lengthCompareJsonbString`, object conversion.
- [PG extraction](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/jsonfuncs.c):
  `get_jsonb_path_all`, `jsonb_get_element`, `JsonbValueAsText`.
- [PG comparison sort](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/include/lib/sort_template.h):
  comparison-based insertion/pivot/partition paths instantiated by
  `src/port/qsort_arg.c`.
- [PG text equality and order](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/varlena.c):
  `texteq`, `text_cmp`, `varstr_cmp`.
- [PG direct TID executor](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeTidscan.c):
  `TidNext`; [heap access](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/heap/heapam.c):
  `heap_fetch`; `src/include/storage/itemptr.h`,
  `src/include/utils/array.h`, `src/include/access/htup_details.h`.
- [SDK native bodies](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/system_database.ts):
  `insertWorkflowStatus`, cancellation/resume, four-table deletion, rewind,
  `bulkForkWorkflows`; [client boundary](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/client.ts):
  transactional enqueue and ordinary client delegation.
- [Rax implementation](https://github.com/antirez/rax/blob/1927550cb218ec3c3dda8b39d82d1d019bf0476d/rax.c):
  `raxRemove`, `raxSeek`, iterator next/previous steps and `raxSeekGreatest`.
  The useful patterns are terminal markers, ordered child labels and an explicit
  ancestor stack. Its compressed-node merge/copy and mutable in-memory lifetime
  are not adopted as PostgreSQL persistence or deletion proofs.

No reference files or long passages are proposed for copying into this stack.

## The behavior that the representation must implement

At `30d6045d:services/kernel/src/work/client.ts`, the recognized legacy pattern is
`^realm:leave:([0-9a-f-]{36}):([0-9a-f-]{36})$`. These captures are strings, not
new UUID-validation opportunities. The original native `getWorkflow` hit has
precedence. Nonmatching IDs and native hits delegate to the original bound SDK
method. A compatibility miss delegates using the **original** requested ID.

The fallback joins actual status and split-input rows. Its complete predicate is:

| Half   | Status predicate                       | Extracted equality                                            |
| ------ | -------------------------------------- | ------------------------------------------------------------- |
| Parent | `name = 'community.leave'`             | `realmId = realm`, `memberAccountId = member`                 |
| Child  | `name = 'accounts.membership'`         | `principal.id = realm`, `memberAccountId = member`            |
| Pair   | Both halves present for each actual ID | Child and parent extracted `reservationId` text compare equal |

There is no additional status-value, application, role, `principal.kind`,
authorization, parent-link, current-membership or deterministic-ID predicate.
Matching retained children from other native applications remain candidates.
The new ordering may refine only former ties:

```text
parent.created_at DESC NULLS FIRST
parent.actual_id ASC COLLATE "C"
child.actual_id ASC COLLATE "C"
```

The best pair within a reservation group is its best parent and best child.
Only groups with both components are eligible. A lookup must seek the best
eligible group for the realm/member, including an old hit behind arbitrarily
many newer unmatched parents. It cannot scan those parents or trust a latest-only
alias. For one changed native source, old and new membership touch at most two
groups. Recompute **both** component heads for each: four head probes, a global
eligible seek, and up to four original status/input half rereads. A reread that
finds absence still consumes its probe. There is no parent-by-child expansion.

Actual workflow IDs are unrestricted native text for this analysis. A native
full-ID primary key fitting its own B-tree tuple does not prove a composite
`group/time/full-ID` key fits. The additive SDK writer-state API's 1024-byte fence
validates that API, not all historical native IDs. Logical intern allocation order
cannot replace actual-ID C order.

SDK options, errors, original method binding and return values remain unchanged.
An injected Pool is borrowed; SDK-owned resources remain SDK-owned; the fallback
Pool is private, lazy and `max: 1`. `close` memoizes one promise, destroys the SDK
once, and ends only the lazily created private Pool in `finally`. A replacement
that eagerly creates or ends a borrowed Pool changes the contract independently
of its index performance.

## Concrete heap model under examination

Call the concrete candidate **H**. It uses original SQL casts for extraction,
uncompressed fixed-alphabet heap nodes for exact keys, transactional path copying,
and small indexed logical roots/terminals. This fixes the candidate enough to
give it a falsifiable body. It is not a statement that its missing installer,
inventory, lock and quotation code exists.

An exact byte sequence ends by setting a terminal at its node; it has no digest
or collision bucket. Empty text ends at the root. SQL NULL has no terminal and
cannot equal another NULL in the original equality predicate. Realm/member
capture matches are exact original expression equality. H's byte dictionary is
valid only after proving that equality uses deterministic collation; it cannot
silently substitute C equality for a nondeterministic expression collation.

The following diagnostic DDL defines the local immutable-node and scratch
shapes. It intentionally does **not** purport to be the complete Work installer.
DDL below was not executed.

```sql
CREATE SCHEMA work_private;

CREATE TABLE work_private.node (
  children tid[] NOT NULL,
  terminal bigint NOT NULL,
  terminal_refs bigint NOT NULL,
  minimum_terminal bigint NOT NULL,
  CHECK (cardinality(children) = 256),
  CHECK (array_ndims(children) = 1),
  CHECK (array_lower(children, 1) = 0),
  CHECK (array_upper(children, 1) = 255),
  CHECK (array_position(children, NULL::tid) IS NULL),
  CHECK (terminal >= 0 AND terminal_refs >= 0 AND minimum_terminal >= 0)
);
ALTER TABLE work_private.node ALTER COLUMN children SET STORAGE PLAIN;

CREATE TABLE work_private.scratch (
  previous_frame tid NOT NULL,
  old_node tid NOT NULL,
  byte_position bigint NOT NULL
);

CREATE TABLE work_private.root (
  root_id bigint PRIMARY KEY,
  revision bigint NOT NULL,
  node_tid tid NOT NULL
);
```

The distinguished invalid downlink is `(0,0)::tid`; offset zero is not a valid
heap item. Zero terminal ID means absent. No `node` or `scratch` index is used to
follow a byte. Constraint definitions are not a corruption/restore validator:
they do not prove a TID belongs to this generation or that every retained tuple
is reachable. Epoch, account association, inventory, installer and publication
tables would add real data and work; they are not hidden in these widths.

### Layout and direct access

Under the inspected conventional layout (six-byte TIDs, 8-byte MAXALIGN, 8 KiB
pages, non-null flat one-dimensional arrays):

| Shape                                                    | Logical attribute bytes | Aligned heap tuple plus line pointer |
| -------------------------------------------------------- | ----------------------: | -----------------------------------: |
| 256 child TIDs                                           |     `24 + 256*6 = 1560` |                         Part of node |
| Primary's children plus three int8 fields                |      `1560 + 24 = 1584` |               `24 + 1584 + 4 = 1612` |
| Ordered variant with an additional maximum-terminal int8 |                  `1592` |               `24 + 1592 + 4 = 1620` |
| Scratch: two TIDs, padding, int8                         |                    `24` |                   `24 + 24 + 4 = 52` |
| Root attributes: two int8, one TID                       |                    `22` |         `MAXALIGN(24 + 22) + 4 = 52` |

Five of either node shape fit in the model's page after the 24-byte page header;
this is a layout calculation, not measured occupancy, index overhead or WAL.
Any added ownership/refcount/epoch/ordered metadata must change this table.
PLAIN prevents the child array from becoming an out-of-line TOAST dependency;
it does not eliminate tuple headers, page space, WAL or tuple checks.

At the PG pin, `TidNext` passes a requested TID and the executor snapshot to
`table_tuple_fetch_row_version`. `heap_fetch` addresses the named block and line
pointer, checks item validity and snapshot visibility, and does not follow HOT
chains. Thus an _actual single-TID plan_ can address one inline node without
searching a node-ID B-tree. It is not enough to write `WHERE ctid = ...` and
declare every future planner choice proved. Future supported-server plans must
show the single-TID access, no function-hidden scan and the real nested work;
production planner settings are not pinned to force an acceptance result.

### Conditional path-copy body and local operation counts

The local algorithm consumes one already materialized byte buffer with an offset.
It must not repeatedly detoast/convert a whole key or append a growing path array.
The unindexed scratch heap is a linked stack in the original transaction:

```text
mutate(root, old_or_new_key, terminal_delta):
    acquire a version-changing root lock using the original transaction
    walk root and each byte by exact TID, checking the same protected snapshot
    for each position, insert (previous_frame, old_tid, position) RETURNING ctid
    alter the terminal/refcount at the final position
    unwind frames by exact TID:
        fetch old node again; copy its fixed child array once
        replace the changed child with the new downlink
        recompute terminal and cached subtree summaries
        insert a replacement node, or omit it if the subtree is empty
        delete the superseded old node and this scratch frame by exact TID
    publish replacement root and increment root revision
    commit together with the native change, or roll everything back
```

For a path of `q = L + 1` positions, the primary's equality model has the
following finite **algorithm-slot** bound. These slots are not yet inclusive
`NativeStepWork` prices; a result row, trigger statement, inventory write or lock
cannot be silently omitted when converting them.

| Per position                      | Heap row action slots | Exact-TID probes/actions | Internal SQL slots |
| --------------------------------- | --------------------: | -----------------------: | -----------------: |
| Forward node read                 |                     1 |                        1 |                  1 |
| Scratch insert / returned TID     |                     1 |                        0 |                  1 |
| Scratch read                      |                     1 |                        1 |                  1 |
| Old node reread                   |                     1 |                        1 |                  1 |
| Replacement insert / returned TID |                     1 |                        0 |                  1 |
| Superseded-node delete            |                     1 |                        1 |                  1 |
| Scratch delete                    |                     1 |                        1 |                  1 |
| **Total upper bound**             |                 **7** |                    **5** |              **7** |

The earlier seven charged row/point/statement slots per position is a conservative
slot envelope, not evidence that an INSERT has a direct-TID probe. It also is not
a count of both examined input and returned result rows. Typed node transfers
in that envelope used `2*1584+12 = 3180` bytes per charged slot. This is a
conservative local buffer bound, **not** an installed returned-content-byte price.
Internal PL/pgSQL rows need separate accounting from bytes returned to JavaScript.

Root access, terminal lookup/refcount and allocator work occur once per changed
key, using fixed-width indexed keys. Old and new keys both count; equal/no-op,
absent-old and absent-new branches need real distinguishing bodies before receiving
smaller quotes. Each failed/aborted attempt still pays its reached traversal.

Terminal identity is a logical positive integer, never a hash or TID. Concurrent
equal inserts must reuse the one terminal under root serialization. Different
byte strings reach different terminals. Candidate/source references own terminal
refcounts. Reuse requires a coalescing free-interval allocator with predecessor
and successor interval probes and checked arithmetic, not a permanent sequence
ledger whose retained history outlives all account state. A reused ID is legal
only after every live association to the old terminal is gone in the same current
generation. Generation and old snapshot isolation cannot be inferred from numeric
equality.

Last-reference release walks only the changed key, clears its terminal and drops
empty ancestors while unwinding. It leaves nonempty shared prefixes/subtrees in
place. It does not recompress a survivor or fetch the whole successor's key bytes.
Deleting all unreachable historical versions is PostgreSQL vacuum's separate
physical maintenance, not an application traversal that may be priced zero.

### Ordered candidate and eligible structures

Equality interning is not ordered head selection. A conditional extension of H
would need these exact ordered roots, rather than a full-text composite B-tree:

| Root              | Ordered key                                                               | Payload                          |
| ----------------- | ------------------------------------------------------------------------- | -------------------------------- |
| Group parent root | Parent time DESC NULLS FIRST, terminated actual parent ID in C byte order | Parent terminal/source identity  |
| Group child root  | Terminated actual child ID in C byte order                                | Child terminal/source identity   |
| Eligible root     | Realm/member prefix, best parent time, actual parent ID, actual child ID  | Group and both source identities |

The group equality identity is realm/member plus exact extracted reservation
terminal; fixed intern IDs may identify a group but may not order full IDs.
Time is a fixed-width sortable encoding with a leading NULL tag and reversed
signed-bigint order. A binary-safe order-preserving ID encoding can map each
byte `b` to `(1,b)` and end the field with `0`. End-of-field sorts before any
extension. Thus `x < xy`, and subsequent fields do not intermix with an ID's
bytes. The encoding doubles ID bytes; those bytes are chargeable. No field is
truncated to make a composite tuple fit.

For a lexicographic trie, minimum checks the terminal before ascending-byte
children; maximum checks descending-byte children before the terminal. A
successor search walks the query path while retaining ancestor/next-label state,
then chooses the nearest greater branch and its cached minimum terminal. Reverse
search uses the maximum. Returning a cached logical terminal avoids walking an
unrelated survivor's entire suffix merely to choose a head.

Adding maximum cache makes the node 1592 logical bytes. Recomputing minimum and
maximum can read the first and last occupied child summaries directly, at most
two extra fixed-size child fetches per changed ancestor. The corresponding local
upper bound is `9q` row-action and SQL slots, with at most `7q` TID probe/action
slots, before root/terminal/allocator/inventory work. Scanning the fixed 256 child
entries costs a fixed 256 per position, not `log N`. The local byte-slot envelope
becomes `2*1592+12 = 3196`, again not a returned-byte quotation.

This describes a way to avoid copying unrelated survivor _bytes_. It does not
prove a complete ordered producer: cached-summary corruption checks, source
versions, lock/abort behavior, authoritative inventory and exact quotes still
need bodies. The extraction counterexample below rejects H even if this ordered
extension is granted all of its conditional bounds.

Lookup would consume the fixed realm/member prefix, return the first eligible
payload, reread the four original native halves with exact predicates/versions,
and delegate with unchanged options. A disagreement invalidates coverage; it is
not permission for a hidden scan or to return an arbitrary stale pair. Variable
changed-key paths belong to maintenance, not to a supposedly constant-row lookup.
Both component heads per old/new group and the global selection remain mandatory.

## Exact extraction semantics and the decisive counterexample

The input column is native `TEXT`. The producer must reproduce the actual
`inputs::jsonb #>> path` behavior, not JavaScript value equality or a canonical
JSON library's different numeric/member-order rules.

At the PG pin, `jsonb_from_cstring` parses the **whole** input and builds JSONB.
Every object-end goes through the object uniqueification/sort path.
`jsonb_get_element` then walks the path. `JsonbValueAsText` returns de-escaped
strings, `numeric_out` for numbers, fixed lower-case Boolean text, and
`JsonbToCString` for arrays/objects. Missing paths and JSON null return SQL NULL.
Array/scalar traversal failures also return NULL as defined by that function;
invalid input conversion can error before extraction.

| Native value at the path                    | Extracted behavior that must be retained                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| SQL NULL input, missing path, JSON null     | SQL NULL; equality is not TRUE even against another NULL                                                              |
| `""`                                        | Empty non-NULL text, distinct from NULL                                                                               |
| `1` and `"1"`                               | Both can extract text `1`; JSON type is not an equality discriminator                                                 |
| `true` and `"true"`                         | Both extract `true`                                                                                                   |
| `1.0`, exponent forms, negative zero        | Server numeric input/output semantics; do not assume all numerically equal spellings produce identical extracted text |
| Object/array                                | Server-rendered structured text, including spacing, escaping, duplicate-key resolution and object ordering            |
| A string containing structured-looking text | Can equal structured output when its de-escaped bytes equal that exact server output                                  |

Object order is not general lexicographic order: PG's representation compares
member-name byte lengths first and bytes second. Duplicate member handling and
last-value selection follow original pair order. A custom extractor must preserve
these facts, server encoding/Unicode failures, numeric range errors and the
observable success/error boundary. It cannot replace structured values with a
digest or reject them as non-string reservations.

Expression equality also carries collation. PG `texteq` uses byte equality for
deterministic collations; nondeterministic collations use `text_cmp` and can equate
different byte sequences. Explicit C order for the newly refined _ID ties_ does
not change the original extraction expressions' equality collation. No deployment
collation was queried here. A byte terminal implementation must establish and
record its supported deterministic expression collation, or supply an exact
equivalence-class producer with its own bound. It may not silently publish coverage
for a nondeterministic collation that it cannot implement.

### A concrete family of valid inputs

Fix ordinary valid 36-byte realm/member captures and short unique native IDs.
Let `m >= 8`, `w = ceil(log_16 m)`, and `p >= w`. Make `m` distinct ASCII member
names:

```text
k_i = "a" repeated p times || fixed_width_hex(i, w),  0 <= i < m
R_pi = { k_pi(0): 0, k_pi(1): 0, ..., k_pi(m-1): 0 }
parent input = {"json":[{"realmId":realm,"memberAccountId":member,
                         "reservationId":R_pi}]}
child input  = {"json":[{"principal":{"id":realm},"memberAccountId":member,
                         "reservationId":R_pi}]}
```

All names have equal byte length and share their first `p` bytes. There are no
duplicates, escapes, invalid numbers, ambiguous Unicode or hash collisions.
The reservation itself is relevant, so skipping an unrelated subtree cannot
remove the required object canonicalization. Updating just one relevant input,
with the other half already present, is sufficient; both inputs need not change
in the measured operation. The former short reservation can be fixed-size.

Select a permutation `pi` taking a maximum-comparison path of the pinned
comparison sort for these distinct keys. This defines a precise deterministic
family: choose the lexicographically first maximizing permutation if more than
one exists. It is an existence/source proof, not generated fixture output.
Some permutation requires at least `log_2(m!) = Omega(m log m)` comparisons:
the comparator-based sort must distinguish the `m!` possible relative orders.
The presorted fast path handles some permutations; it cannot handle all of them
with a linear number of comparisons. No execution of a fixture generator or
upstream sorter is needed for this lower bound.

The exact source chain is:

```text
jsonb input object-end
  -> pushJsonbValue / uniqueifyJsonbObject
  -> qsort_arg(pairs, nPairs, sizeof(JsonbPair), lengthCompareJsonbPair, ...)
  -> lengthCompareJsonbString
       equal lengths -> memcmp(member_name_a, member_name_b, length)
```

Each compared pair is distinct but shares `p` prefix bytes. Each comparison
therefore examines `Omega(p)` bytes in the ordinary fixed-word machine model,
even with a vectorized `memcmp`. This is designed parser/comparator work, not
invisible MVCC visibility skipping. The changed native input length is
`B_native = Theta(m*(p+w+1))`. Its canonical reservation output is of the same
order for this family, so including extracted output in B does not rescue it.
Choosing `p >= w`, for example `p = m`, gives:

```text
d = 1; short old/new native IDs
B = Theta(m*p)
extraction byte work >= Omega(p*m*log m) = Omega(B*log m)
```

N can grow only with the rows needed for these inputs and their representation;
the additive `d log N` term cannot absorb `B log m`. The failure occurs before
the first dictionary mutation. It survives perfect O(B) TID traversal, zero
ordered-head overhead and a collision-free reservation dictionary. High-entropy
reservations separately require reading/copying every byte; this common-prefix
family demonstrates why reading every byte only once has not been proved.

PostgreSQL's finite allocation/string limits bound each physical instance. They
do not select the prohibited finite-domain coefficient interpretation of the
uniform requirement. The family is understood over growing supported instances
before those limits, exactly as the uniform key-length model requires. No new
legacy-ID/reservation cap or huge fixed coefficient is adopted.

### Scope of the negative result

H with this original cast cannot be called a complete uniform design. Charging
more rows or a very large parent does not make the algorithm additive in B.
Moving extraction to backfill does not solve later relevant native input changes.
Caching an extracted key avoids repeated work only after the first paid production;
it does not prove the first production linear. A correct radix-based member sort
with explicit duplicate-order handling might avoid the comparator lower bound.
That is a different concrete parsing/canonicalization body and needs its own
proof, exact server compatibility and quotation. This report neither rules it
out nor supplies it as an unpriced placeholder.

Numeric formatting creates an additional accounting issue, independently of the
sort counterexample. A compact exponent can produce much longer extracted text.
Therefore extracted length E must be derived or quoted; setting E equal to wire
input length is unsound. This report does not rely on a numeric complexity lower
bound, or assume that reproducing PostgreSQL numeric conversion is free.

Eager parsing introduces a second semantic hazard. Original native status/input
writes can retain invalid TEXT, including rows irrelevant to this fallback.
An unconditional compatibility trigger that casts every input can make an
otherwise legal native enqueue/update fail. Checking relevant status first is
necessary but not sufficient: input-first arrival has no status yet, and a later
name change can make that retained input relevant. A validity/result cache must
defer or preserve the original observable error rather than invent an input
validation rule. Publication cannot claim full coverage while silently excluding
a relevant invalid input. Planner evaluation of the original query is not a
licence to promise one arbitrary cast-error order among unrelated rows.

## Native producers, transaction boundaries and failures

The actual SDK writers explain why an application-only callback cannot cover H.
The reference `insertWorkflowStatus` upserts status (including a no-op conflict
update) and separately inserts split input with `ON CONFLICT DO NOTHING`. The
repository's patched caller-owned enqueue preserves the caller's transaction and
reuse/error policy. A compatibility delta must use actual retained rows after
conflict resolution, not assume that the attempted NEW input replaced a winner.
`enqueueWorkIntent` also validates returned name/queue and, when captured, actual
stored input on that same connection. No helper may open a new transaction to
make compatibility maintenance convenient.

The SDK's `src/sysdb_migrations/internal/migrations.ts` supplies another actual
writer: `113_enqueue_workflow_split_input` replaces `enqueue_workflow` with a
status upsert followed by split-input INSERT/DO NOTHING in the calling SQL
transaction. Its conflict branch changes status `updated_at`, not the retained
input. Its portable `positionalArgs`/`namedArgs` serialization does not acquire
the resolver's `json` path merely because the workflow has a relevant name.
Migration `109_workflow_payload_tables` declares input TEXT without a foreign key
to status. These bodies establish both a raw-SQL writer and legal orphan survival;
they must not be replaced by an assumed application enqueue callback. Standalone
`initWorkflowStatus` owns its original retried transaction; caller-supplied-client
initialization joins the caller's transaction, while child initialization also
records the parent's operation result before its original commit/rollback.

| Native path                                         | Required old/new/private behavior                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status INSERT, input absent                         | Record half-liveness; no joined candidate until actual input exists.                                                                                                          |
| Input INSERT, status absent                         | Preserve orphan association/inventory; no invented status or eager unrelated cast error.                                                                                      |
| Either half arrives second                          | Reread both actual halves; produce exactly one current candidate.                                                                                                             |
| INSERT conflict / speculative insert / no-op UPDATE | Maintain the stored winner, handle pre-trigger work and rollback; no leaked terminal/scratch allocation from the losing attempt.                                              |
| Status UPDATE                                       | Handle actual ID, name, time and every predicate-relevant change, including relevant-to-irrelevant and reverse.                                                               |
| Input UPDATE                                        | Remove old extraction and add new extraction; old and new complete key bytes are charged.                                                                                     |
| Either-half DELETE                                  | Remove eligibility immediately in the original deleting transaction; retain any still-existing orphan copy under its owner.                                                   |
| Bulk or raw SQL                                     | Same native hooks and caller transaction; not an optional SDK-only path.                                                                                                      |
| Fork/bulk fork                                      | Copied status and split input, originals' metadata update, copied steps/events/streams and conflicts all use original native fence semantics.                                 |
| Cancellation/resume/rewind/recovery                 | Preserve original status predicates; relevant name/time/ID/input changes still maintain the projection. A queue or status change alone must not add a new eligibility filter. |
| Retention                                           | Original four explicit deletes plus FK cascades; additional private removal is same-original-transaction owner work.                                                          |
| Failure/abort/retry                                 | Original transaction rolls back roots, nodes, allocator, candidate and inventory changes together. Already spent admission is not refunded; a repeat reserves again.          |

The repository patch's ALWAYS writer guards cover INSERT/UPDATE on the eight
native families. They do **not** currently cover private compatibility copies,
and DELETE does not invoke those guards. Those guards and the existing permanent
writer fences must remain authoritative. `retire_workflow_writers` takes the
original status row lock before fence upsert, clears owner state under the row
guard and closes the permanent fence. The guard collects NEW/OLD and parent/fork
IDs as applicable, sorts each row's set and upserts the current open fence.
The same-command writer check locks restore domain then exact permanent fence.

A private-root order written in isolation is not a complete deadlock proof.
For example, a bulk writer can lock native A/fence A, take private root R, then
touch native B. Another transaction can already hold native B/fence B and wait
for R. Per-row sorted IDs do not establish a total order across both complete
transactions. Starting with R in one adapter also conflicts with original native
retirement that already locked status before reaching R. An AFTER trigger can
still hold R across a later statement in a caller-owned transaction.

This concrete cycle rejects the simple claim that “native fence, then root”
alone proves every writer compatible. It is not a claim that PostgreSQL cannot
abort a deadlock safely. A complete producer must give its actual exhaustive
locking/admission bodies, permitted whole-transaction failure behavior and costs
for those abort paths, without retrying a statement inside a partially used
original transaction. No new ordering is asserted installed here.

Callable boundaries that a positive implementation would have to deliver are
specific, rather than another interface-consent request:

```text
Work-owned install(version, actual SDK schema/domain)
native source-change producer(OLD/NEW, actual transaction, both-half identity)
quote/preflight + admitted apply producer for each original owner invocation
group/head/eligible mutations and exact resolver in that original Pool
owner inventory/select/remove/probe producer, including invalid-link restore
bounded backfill/reconcile page producer and coverage publication verifier
```

The consent for a narrow supported extension and original accounting seam is
already settled. Those are absent concrete bodies, not missing permission to
agree on that seam. No upstream migration number is appropriated and no installed
`node_modules` file is edited.

## Snapshot, publication, restart and restore lifetime

Physical TIDs identify table-local slots, not durable workflow identities. H must
prohibit private node UPDATE, move, partition relocation, CLUSTER, VACUUM FULL,
table rewrite and independent logical restoration while coverage is valid.
Native tables and operations retain their original maintenance authority. The
restriction belongs to Work's rebuildable private heap only.

Ordinary MVCC can protect an old immutable version while the transaction's
snapshot remains registered. It cannot protect a saved root followed later using
a newer snapshot after vacuum/reuse. A sound traversal needs one pinned repeatable
snapshot for the **entire** root-to-terminal traversal, or a root lock retained
across every read with the specified fresh-snapshot protocol. Root locking must
actually change the version; an old repeatable snapshot cannot lock a stale root,
ignore the serialization failure and traverse current TIDs.

| Event                                 | Required complete behavior                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path copy commits                     | Root, terminal counts, candidates, inventory and replaced-node deletions publish atomically.                                                                                       |
| Path copy aborts                      | No new root or allocation becomes visible; original root remains valid; funding stays spent.                                                                                       |
| Old reader spans commit               | It sees its original root and all linked old node versions in one protected snapshot.                                                                                              |
| New reader after commit               | It sees current root plus current nodes; never mixes old pointer with a later visibility horizon.                                                                                  |
| Missing/mismatched node               | Refuse covered lookup and invalidate; do not treat it as a legitimate miss.                                                                                                        |
| Long whole transaction                | Price every visited node and copy; impose actual admissible resource/deadline limits or refuse before affected work. Splitting into unprotected later snapshots is not a solution. |
| Process restart                       | Discard in-process traversal state; use durable validated coverage/progress and actual current authority.                                                                          |
| TRUNCATE / bypass / rewrite / restore | Coverage becomes invalid before any subsequent lookup may trust it. Restore-domain rotation alone does not reconstruct private links.                                              |

A future versioned Work installer must run after supported SDK migration, inspect
the expected native schema/patch/trigger coverage and publish its own version.
Backfill must read bounded authoritative native pages, reconcile both halves and
their current versions in the original maintenance transactions, and be idempotent
under input-first/status-first writes, deletes, restarts and coverage invalidation.
Live hooks must converge with backfill; elapsed time or a cursor alone is not
coverage. Final publication needs a transactionally sound complete native boundary,
not a scan followed by an unlocked Boolean. Progress, pending/orphan and failure
state are additional inventoried copies and charged owner work.

This is a list of obligations, not a delivered backfill/installer algorithm.
H's extraction failure already prevents it from satisfying the required class.
Missing backfill and inventory costs are explicitly unavailable in the ledger,
not assigned zero. Independently funded reconciliation is required after invalidation;
the resolver does not gain a population scan or repair allowance.

## Complete copy inventory and the untrusted-link counterexample

The existing `hasRetainedWorkCopies` checks exact ID keys in eight native tables:
status, input, output, operation outputs, events, event history, notifications by
destination ID and streams. History's physical inspector independently reads those
families under its admitted limits. Neither enumerates private heap copies.
Native absence, a root miss, invalid coverage or a Source terminal receipt cannot
prove the new copies gone.

Every following class must participate in the owner-authorized same-original-
transaction source deletion and later actual native absence probes:

| Copy class                                    | Retained information / association                                          | Removal condition                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Equality/ID/ordered trie nodes                | Prefix bytes implicit in topology, terminals, child links and summaries     | Remove only dead changed paths; preserve shared live prefixes.                                 |
| Roots and publication state                   | Private heap links, generation, realm/member/group relationship             | Delete empty associations; do not leave account tombstones.                                    |
| Terminal records/refcounts                    | Exact-key logical identity, native source/candidate relations               | Release all actual references before reuse.                                                    |
| Allocator/free intervals                      | Reusable logical identities and ownership metadata                          | Coalesce/remove emptied per-owner state; no history-only ledger.                               |
| Scratch/path-copy state                       | Old TIDs, byte positions and transaction/source association                 | Remove on success, abort atomically on failure; inventory any durable retained state.          |
| Source and orphan associations                | Actual ID, half-presence, generation and account relationships              | Handle either surviving native half, including pre-mapping input orphans.                      |
| Parent/child candidates                       | Extracted realm/member/reservation relationship and full actual-ID terminal | Remove old membership in the original source-deletion transaction.                             |
| Group heads and eligible entries              | Best parent/child relationships, time and ordered root links                | Recompute both components; remove empty/ineligible entries.                                    |
| Backfill/reconcile progress and pending state | Native source locators and account-derived links                            | Minimize/remove together with owner custody; never treat cursor EOF as erasure.                |
| Inventory itself                              | Physical/logical associations sufficient to find all the above              | Remove its final links only after actual selected copies are removed and independently probed. |

Account associations must cover all relationships the original extraction can
produce, including orphan-derived rows; an association only to the currently
winning candidate is incomplete. Shared prefixes may be retained for another
live source, but their remaining attribution and references must be truthful.
An empty account cannot keep an immortal synchronization/root tombstone merely
to make restore bookkeeping convenient.

### Concrete restored-TID failure

Consider one account-owned terminal and one retained node X before backup:

```text
native input I owns a private path containing X at physical TID (12,3)
root/link metadata records (12,3)
logical restore inserts X into the private heap at (48,1)
restored root/link metadata still contains the numeric value (12,3)
coverage is marked invalid before lookup
```

The native input and account relationship still exist. Following `(12,3)` can
find no row, the wrong row, or a structurally plausible unrelated row. No absence
result at `(12,3)` discovers the retained bytes at `(48,1)`. A generation check
can reject the wrong row but cannot enumerate X. Deleting reachable nodes and
then deleting the invalid root leaves X retained. A fresh native eight-table
inspection does not inspect X. Thus invalidation plus reachability cannot justify
copy deletion, physical absence, receiving closure or Source discharge.

A source-independent authoritative inventory must discover X without trusting
invalid links. Possible designs include independently verifiable logical node
identities and a bounded owner-addressable inventory, or a separately funded full
restore reconciliation that reconstructs such an inventory **before** bounded
erasure uses it. These are different complete bodies; neither exists in H.
An ordinary per-node inventory B-tree introduces byte-proportional index work,
which must itself satisfy the uniform bound. A whole private-heap scan at account
erasure is not a bounded per-account native probe. A background scan without its
own admission, completion and non-revival boundary is not a solution either.

This counterexample does not say authoritative inventory is impossible. It says
the primary's root/terminal/path model, even with safe lookup invalidation, does
not supply it. The owner-authorized restore/removal port is prospective. The
existing SDK restore hook rotates the native writer domain and preserves permanent
fences; it is not a private-copy inventory rebuild or removal hook.

## Prepaid quotation and the real accounting seam

Use vector order `rows / points / statements / bytes / engineRequests` below.
`engineRequests = 0` means no external engine request in these PostgreSQL bodies,
not zero parser, heap, index, trigger, WAL or control work. Internal designed
traversal/path copies are visible costs. Returned-content bytes, parameter/input
bytes and stored bytes must not be conflated merely because one axis has a
particular existing measurement convention.

Original Source calls must use `maintainSdkWorkflowOnce`'s callback, then
`reserveIdentityHistoryWork`, in the original live exact-Pool invocation and original
deadline. Rollback is reserved before checkout/BEGIN. Missing, expired, exhausted,
wrong-Pool or settled authority refuses before the affected dispatch. Failure,
miss, stale result, SQL error, rollback and a repeated call keep all spent charges;
a repeated call reserves anew. Nested work is counted once in its enclosing
dispatch, not omitted and not double charged as both a leaf and an inclusive body.

The new active-frame accessor is observational. In the pinned History helper,
`if (!active) return` on the implicit branch can permit unreserved success when
the frame is absent or the Pool is wrong. The disclosed correction is an original
owner dependency; this research neither implements nor copies it as authorization.
Checking an observed object is not sufficient: actual reservation must verify
live invocation, exact Pool, deadline, settled state and every remaining axis.

### What the current dispatch actually knows

The original SDK callback sends fixed strings (`begin`, `lock`, `retire`, the four
deletes, etc.). It supplies no changed-input length, extracted length, trie-depth,
inventory cardinality, old/new key data or GC count. It has no free preflight.
Therefore a dynamic heap body cannot be included by guessing a constant from
those strings. It needs either a finite sound admitted maximum from concrete
bodies and bounded operands, or a real separately prepaid quotation body.

A proposed quote boundary would have to be as explicit as:

```text
admit fixed quote-probe cost from this caller's actual authority
read and lock authoritative small metadata using the original Pool/deadline
quote lengths/cardinalities/versions, including the quote's own I/O and failures
derive checked inclusive operation vector from those bounded operands
reserve that vector from the same still-live original authority
apply only while those exact operands/versions remain valid
if stale: refuse/rollback; another attempt pays another quote and operation
```

For an arriving parameter, its in-memory byte length may be known to that writer;
this does not provide old retained input lengths to every SQL/bulk/native caller.
An `octet_length` metadata probe can be useful, but it is still an admitted native
probe and does not reveal structured canonical-output length or sort work for
free. A quotation that first parses/fetches the whole affected input must already
have funded that I/O and parsing. No Source token may be retained for a later
background operation or used to create a new Source frame.

| Caller                                       | Funding required before quote and apply                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Original Source/History unit                 | Existing live invocation, exact Pool, original deadline, actual callback reservations through final receiving commit. |
| Ordinary/native enqueue, conflict or raw SQL | Actual owning invocation's admission covering trigger work; no manufactured Source context.                           |
| Caller-owned bulk/SQL transaction            | That caller's real whole-transaction admission and complete old/new body; no hidden second checkout.                  |
| Retention/cancellation/rewind/recovery       | Original owner allowance including all reached private and native work.                                               |
| Backfill/live reconciliation                 | Independently admitted page/attempt, failure and rollback, with actual bounded operands.                              |
| Restore inventory repair                     | Independent restore/reconciliation funding before scanning or publication; invalidation supplies none.                |

### Existing exact Work literals, unchanged

These are source facts from `30d6045d:services/kernel/src/work/README.md`,
`sdk-retirement-fence.ts` and the repository SDK patch, not new H prices:

| Original dispatch                                  | R/P/S/bytes/engine     |
| -------------------------------------------------- | ---------------------- |
| Prepaid rollback                                   | `0/0/1/0/0`            |
| BEGIN                                              | `0/0/1/0/0`            |
| Local timeout settings                             | `1/0/1/128/0`          |
| Current native writer/domain check                 | `4/2/4/8192/0`         |
| Native retirement, including existing nested guard | `8/5/9/32768/0`        |
| Delete input                                       | `1/1/1/0/0`            |
| Delete output                                      | `1/1/1/0/0`            |
| Delete operation outputs                           | `64/1/1/0/0`           |
| Delete status, including four original FK cascades | `73/5/5/0/0`           |
| COMMIT                                             | `0/0/1/0/0`            |
| **One complete original retirement attempt**       | **`13/7/17/41088/0`**  |
| **One complete original deletion attempt**         | **`144/10/16/8320/0`** |

Deletion assumes the independent physical limits: events 8, history 64,
notifications/streams zero, operations 64. It is children=false. No new DELETE
hook is included in those old literals. New retirement status-trigger work,
input/status deletion hooks, quote, node/ordered/allocator/scratch/GC/inventory
work must be rederived inclusively; original full totals cannot be reused as if
they already include them. `SDK_TRANSACTION_FENCE_COST` is separately
`4/2/4/8192/0`; reprice it only if its actual body changes.

### Complete cost status for H

Let B include every changed old/new native input and actual-ID byte; retain E
for actual extracted/encoded key bytes, Q for visited positions, A for allocator
operations, I for authoritative inventory/removal work and C for control/fences.
Do not redefine B to mean “the work the algorithm happened to do.” In the decisive
family E is Theta(B), so even a more generous B definition cannot hide the failure.

| Body                                              | Finite derivation available here                                                               | Status for an inclusive operation price                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Equality path mutation, already extracted key     | At most `7Q` local row-action/SQL slots; direct-TID accesses as tabulated                      | Conditional local model only.                                                             |
| Ordered summaries                                 | At most two extra child-summary fetches per changed position; `9Q` local slots                 | Conditional local model only; all actual ID bytes included.                               |
| Scratch and rollback                              | Explicit inserts/reads/deletes above; rollback control prepaid; rolled-back work remains spent | Must be included, never amortized away by eventual vacuum.                                |
| Native both-half rereads                          | Four original halves; two heads per changed group; global eligible seek                        | Fixed operation count, but actual statement/parameter/return widths need concrete bodies. |
| SQL JSONB canonicalization                        | Counterexample `Omega(B log m)` byte examination                                               | **Fails uniform requirement.**                                                            |
| Exact expression collation                        | Byte equality valid for deterministic expression collation                                     | Deployment fact/alternative exact producer unproved; not zero.                            |
| Terminal allocator/root publication               | Fixed-width identities can use O(log N) operations per changed key                             | Complete lock, reuse, owner-state and failure bodies absent.                              |
| GC and invalid-link copy inventory/removal        | Root-only inventory has explicit restored-TID counterexample                                   | Complete authoritative producer absent; not zero.                                         |
| Exhaustive native hooks and old-writer lock order | Original paths identified; simple root-order cycle identified                                  | Complete compatible producer absent; not zero.                                            |
| Quote, installer/backfill/restore reconciliation  | Required paid boundaries identified                                                            | Concrete bounded bodies/operands absent; not zero.                                        |

The correct inclusive expression is a sum of actual bodies, not a literal guess:

```text
new_dispatch(op, operands) = original_dispatch(op)
                          + admitted_quote(op, operands)
                          + extraction(old, new)
                          + equality_paths(old, new)
                          + ordered_paths(old, new)
                          + root_terminal_allocator_work
                          + source_orphan_and_copy_inventory_work
                          + both_half_head_global_native_validation_work
                          + release_GC_restore_work_if_reached
                          + added_controls_fences_abort_work
```

Each term must supply all five axes and literal bounded operands before affected
I/O. Here several terms are absent and extraction violates the chosen bound.
They cannot be set to zero to turn the expression into a finite certified price.
Nor can a safe-integer maximum, deadline or finite PostgreSQL string limit stand
in for the concrete admitted operation derivation. This report deliberately
does not publish a bogus “complete” native quote or new parent ceiling.

## Original Source/History composition that remains mandatory

The old five-verifier subtotal is historical evidence only. Five fresh verifier
entries cost 696320 bytes, exceeding the old 630784 parent by 65536 before other
work. The fixed-aggregate disposition now authorizes the componentwise maximum
of **complete finite original path sums**. It does not authorize a five-entry
parent, eliminate fresh checks, enlarge children, or price a missing producer at
zero. The old default is no longer the reason to reject a new design.

Exact operands below come from the pinned Source custody contract and actual
History/Source implementations. They preserve all original child literals:

| Operand                                  | R/P/S/bytes/engine    | Actual entry/body                                                                                                             |
| ---------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| V                                        | `100/100/22/139264/0` | Every `verifyIdentitySourceConsumerCustody` entry, including rejected/copied handles and post-commit/terminal reconstruction. |
| Account current verification             | `64/64/15/65536/0`    | Independently reserved subject reversal verification in its owner.                                                            |
| Account settlement read                  | `64/64/20/65536/0`    | Actual released same-source settlement reader.                                                                                |
| History-only handoff recheck             | `32/32/8/131072/0`    | Original barrier/source/association recheck, separate from V.                                                                 |
| Receiving binding                        | `160/80/6/131072/0`   | Real mapping/work/role/barrier reads.                                                                                         |
| Source native guard                      | `17/15/2/32768/0`     | Outer SELECT and fifteen-input native joined body.                                                                            |
| Current SDK check                        | `4/2/4/8192/0`        | Same-original-command native domain/fence lock.                                                                               |
| H, complete conservative subject handoff | `377/293/57/507904/0` | Sum of recheck, V, Account verification, binding, Source guard and SDK check.                                                 |
| G, native History guard                  | `92/87/11/40960/0`    | Includes nested Source/SDK native functions; not another TS H/V call.                                                         |
| Absence guard                            | `9/9/9/0/0`           | Separate actual absence checks.                                                                                               |
| C, History command control               | `3/1/8/256/0`         | Original BEGIN/settings/time/no-effect fence/commit/rollback envelope.                                                        |
| SDK released observation O               | `3/2/1/8192/0`        | Native domain/current fence observation.                                                                                      |
| Work invalidation I                      | `846/846/261/0/0`     | Original enrolled work invalidation body.                                                                                     |
| Wake W                                   | `128/65/65/0/0`       | Original wake fanout.                                                                                                         |
| Locator invalidation LI                  | `1678/1678/518/0/0`   | Original locator minimization fanout.                                                                                         |
| Receiving invalidation RI                | `845/845/261/0/0`     | Original receiving invalidation body.                                                                                         |

For H, the explicit sum is
`32/32/8/131072 + V + 64/64/15/65536 + 160/80/6/131072 +
17/15/2/32768 + 4/2/4/8192 = 377/293/57/507904`, engine zero.
Leaving out the independently reserved Account verifier would undercount H.

The original path has these additional reached operands; they are not replaced
by H or the native SDK totals:

| Stage                              | Reservation operands / call graph                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advanceInFrame`                   | Receiving snapshot `72/72/6/32768 + C`; original native Account source read `70/68/25/73984`; accepted lookup `86/80/59/205920` including its own up-to-three command controls/six RR snapshots.               |
| Initial retirement stage           | Source handoff read `73/71/26/82176` when actual context is present; then `readIdentitySourceConsumerCustody`. Retained-terminal reconstruction spends a new V and reached Account settlement/verification.    |
| Source staging                     | Entry `32/32/29/32768` before checkout. Binding work reader first `9/9/5/8192`, then `4/4/5/8192` before its released snapshots. Missing first result spends only the first prefix.                            |
| Source directory and scoped effect | Actual current directory page and current cut verification; actual Library page, receiving selection, current seal and durable fence before advancement. A planning ceiling is not a reservation.              |
| Source finish                      | Original accepted claim/current progress/source lock; actual settlement for subject or actual technical receiver for transfer; native commit provenance; then a separate post-commit command invoking fresh V. |
| `retireAgentIdentitySDKWork` entry | `71/71/19/82048 + C`, then fresh stage verification; separate receiving binding and released writer O.                                                                                                         |
| Readiness command                  | C; saved association `1/1/1/106496`; H; reached readiness write `1/1/1/0 + G`; History readiness `2/2/2/0 + G + I + W`.                                                                                        |
| Committed readiness reread         | C plus `1/1/1/65536`; no portable earlier check replaces it.                                                                                                                                                   |
| Released SDK retirement            | Original `13/7/17/41088`, plus all new inclusive Work deltas when supplied.                                                                                                                                    |
| Closure command                    | Released O, then C plus H and `3/3/2/0 + G`.                                                                                                                                                                   |
| Recorded handoff L                 | Saved state `1/1/1/122880` plus H plus `1/0/1/256 + G`, with caller C separately.                                                                                                                              |
| Preparation                        | C + L; seal `16/16/7/64`; work `1/1/1/64`; roles `65/65/1/8192`; owner readiness `74/74/7/49152` and another L; reached update `2/2/2/0 + G + I`.                                                              |
| Bound physical selection           | C + L; actual SDK receipt before/after; no skipped current authority.                                                                                                                                          |
| Each physical inspection           | Controls `1/0/4/128`, plus eight `(limit+1)/1/1/(80*(limit+1))` probes; limits `[1,1,1,64,8,64,0,0]`, total `148/8/12/11888`.                                                                                  |
| Physical delete                    | Original `144/10/16/8320`, new inclusive Work deltas separately, O, and second actual inspection/receipt.                                                                                                      |
| Cleanup/absence                    | C + L; seal `16/16/7/64`; absence `2/2/2/0 + G + Absence + I + W`; locators `4/4/4/0 + G + Absence + LI`.                                                                                                      |
| Later receiving                    | Two fresh L/H checks, actual absence and roles, original receiving proof and cursor in one commit; record body includes `1/0/1/256 + Absence`, roles `65/65/1/8192`, and `72/71/7/0 + G + Absence + RI`.       |
| Additional released receiving read | `76/75/17/132000 + G + Absence`; same-command verifier `76/75/13/131872 + G + Absence`, caller controls separate.                                                                                              |
| Independent snapshots/reschedule   | Mapping `6/5/8/16640`; saved SDK/work/mapping `7/6/8/33024`; reached delayed reschedule `C + 1/1/1/0`.                                                                                                         |

The complete original successful History consumer expansion has eight H calls:
readiness, closure, two preparation checks, bound selection, absence, and two
later receiving checks. Six enter through L. Eight H alone sum to
`3016/2344/456/4063232/0`. Thirteen G add native checks independently; they do
not call the TS verifier. Together those cause twenty-one current SDK checks,
plus three separately charged released O observations. Five receiving-binding
calls include four bracketing the two SDK receipt reads and the initial later
receiving call. Two inspections, three work invalidations, two wakes, one locator
invalidation, one receiving invalidation and two seals remain reached work.
The published original expansion has fourteen separate C controls; costs that
already include their own controls must not be expanded a second time.

The published `11588/9856/2731/6843136/0` is a History **consumer envelope**.
It is not the complete Source parent: independently reserved initial staging,
terminal/post-commit Source verification, independent inventory/receiving entries,
recovery receiving and Library remain additional. At `30d6045d`, recovery can
also add actual outbox receiving fanout: for q events and c associated consumers,
`q*(33/33/1/65536) + c*(8/8/1/16384 + 69/69/4/24576 + Rcurrent)`,
with `q <= 2`, `c <= 64` per complete native cut. A recovery guard is
`174/174/12/65536/0` per invocation, reached twice in the corresponding transition.
These paths need actual original admission and cannot borrow a successful normal
branch's envelope or silently enter while its original funding gate is closed.

The directory pre-split envelope remains `100/200/36/229376/0`, with effective
children `50/100/18/114688/0`; smaller configured/current remainder stays smaller.
The native raw page ceiling stays 100. Library retains its original eight axes:
candidateKeys 1, identityMetadataRows 0, nativeRows 8192, nativePoints 128,
witnessKeys 1, statements 128, bytes 1048576, emptySeeks 2. There is no conversion
from Library allocation to NativeStepWork and no replacement ledger.

### The minimum remaining original owner body

`services/kernel/src/library/identity-scope-effects.ts` at the pin returns
unavailable for `readLibraryScopeEffectsPage` and false for
`verifyLibraryScopeEffectsSeal`.
A successful page/verifier/locked-plan/current-plan/seal/fence SQL footprint,
including failure/repeat/rollback and actual nested reservation identity, is not
available. Unknown SQL remains refused. Its unsuccessful stub is not a successful
zero-cost implementation.

The minimum remaining original composition input is that actual successful
Library callable/body and its footprint consumed by Source's existing `compose`
path, together with the owner correction for implicit-null History reservation.
It is not another generic SDK/Source interface agreement. Separately, the new
Work bodies listed above must supply their concrete complete vectors after the
extraction and inventory counterexamples are resolved. Only then can the finite
set of real admitted original invocation paths be enumerated and a componentwise
maximum selected. No new parent literal is derivable from the available bodies
by treating either missing class as zero.

## Future proof matrix, with original acceptance preserved

These are requirements for a future positive implementation, not authored or
executed product tests in this research task. Existing tests/frozen assertions
are unchanged. No fixture cap, allowance increase, hidden repair, token renewal
or shortened original call chain may make a case pass.

| Class                   | Required future proof and observation                                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unrestricted values     | Empty, NULL/missing, numeric/string, Boolean/string, structured/string equality, duplicate fields, object key ordering, escaped text, Unicode and numeric range/error cases against original SQL semantics.                                                            |
| Byte adversaries        | High-entropy long keys and the exact equal-length/common-prefix object family above; measure/count parser comparisons, copies and complete old/new paths, not only final storage.                                                                                      |
| Collation               | Actual expression collation/encoding recorded; deterministic equality and C ID order preserved; unsupported nondeterministic equality never receives false complete coverage.                                                                                          |
| Full-ID order           | Native-valid IDs near their standalone-key limit whose composite would not fit; long common prefixes; parent NULL time; equal times; parent/child ID ties; all previously uniquely ranked results unchanged.                                                           |
| Lookup selection        | Exact native-ID precedence; original-ID miss fallback; eligible old hit behind unmatched parents; complete miss; parent/child multiplicity; options/errors unchanged.                                                                                                  |
| Half-liveness           | Both arrival orders, either-half deletion, retained orphan input/status, ID/name/time/input updates and old/new group moves. Exactly two groups implies all four component probes and native-half rereads.                                                             |
| Conflict/native writers | Native INSERT/UPDATE/DELETE, speculative/no-op conflicts, rollback/reuse, raw SQL, caller-owned and bulk enqueue, fork, cancellation/resume/rewind/recovery, retention and every original SDK route.                                                                   |
| Concurrency             | Native fence/root lock-order graph for whole transactions, competing equal/different keys, opposite half arrival, cross-group changes, old snapshots, aborted root publication, deadlock/serialization/ambiguous commit.                                               |
| Release/GC              | Shared live prefix preserved; deleted last reference removed without copying unrelated suffixes; allocator reuse/no ABA; no leaked scratch/progress/inventory; no empty-account tombstone.                                                                             |
| Copy custody            | All table classes in the inventory above, pre-mapping orphan associations, same-original-transaction owner removal, actual private and native absence probes and no inferred Source/receiving closure.                                                                 |
| Restore                 | Numeric TIDs deliberately remapped/reused or out of range; root links invalid; retained unreachable tuple found by authoritative inventory; invalidation before lookup; independent funded rebuild; permanent native fences/domain non-revival.                        |
| Restart/backfill        | Interruption at every phase; live mutation between page/read/apply/publication; old and new writers; bounded authoritative convergence; no unlocked coverage gap or lookup repair scan.                                                                                |
| Funding refusal         | Missing, expired, exhausted axis, wrong actual Pool, copied/settled frame, malformed quote, stale quote operands, unknown SQL/dispatch, absent owner admission, unavailable Library, implicit-null correction, original deadline expiry and repeat/rollback no-refund. |
| Whole-call sum          | Every original Source entry, Account check, eight H, thirteen G, independent receiving/recovery branch and actual Library/Work nested body; componentwise path maxima; every original child literal unchanged.                                                         |
| Resource lifetime       | Borrowed Pool not ended, private Pool lazy/ended once, SDK destruction once even on error, one close promise, no extra checkout inside caller-owned transaction.                                                                                                       |

Keep actual growth scales **64 / 512 / 4096** and the original production-shaped
fixtures in `services/kernel/test/work/growth-work-client.test.ts`. They use
16 history units per scale and both parent and child rows: baseline native status
populations per family pair are **2048 / 16384 / 131072**, plus actual probe rows.
They populate split input, output and operation history, not merely a tiny alias
table. Each scale has its real warm-up and measured probe. The returned page
remains ten steps (`limit: 10`, `offset: 0`) with twelve seeded child steps.

The original fallback test records linear rows/blocks and constant statements;
preserve it as historical acceptance. Add a separate stronger bounded group for
constant lookup examined rows/statements and logarithmic indexed blocks, plus
the new actual maintenance/deletion/quote/inventory costs. Do not rewrite the
old test's fixture, remove physical population, weaken comparisons or call a
source-predicted result a measured failure. The native-hit read case already
requires constant rows/statements and logarithmic blocks and remains unchanged.

## Recommendation and handoff

Keep the private immutable heap direction provisional. Adopt this concrete
negative finding: the original SQL JSONB-cast extraction body is not a demonstrated
uniform additive-byte producer, and the source family above disproves its claimed
linearity in the selected model. A future positive design must provide an actual
compatible canonicalization body and a bounded authoritative inventory that
survives untrusted restored links. Neither can be replaced by an unpriced label.

The shared useful source patterns are exact bytes with separate terminals,
direct protected storage references, explicit ancestor stacks, atomic root
publication, native snapshot visibility and pre-dispatch reservation in an actual
owner invocation. PG also shows the limits of that composition: direct TID access
does not canonicalize JSON, bind collation, enumerate invalid links or quote a
complete transaction. Rax supplies ordered traversal concepts, not PostgreSQL
ownership/WAL/restore or survivor-copy guarantees. The SDK supplies real native
transaction/fence paths, not a compatibility trigger/inventory admission port.

No product choice is made to cap legacy values, use digest equality, add collision
buckets, switch to a finite-domain coefficient, change tie semantics, relax native
authority, enlarge a child allowance, or authorize an extension. No peer research
or stopped implementation is resumed. The exact remaining bodies are identified
above; no further external research beyond this task is asserted necessary to
establish this counterexample.

Only this report is committed in the worktree. The sole outside-path write is
permitted metadata in
`/home/edge/projects/rezics/rezics-next/.reference/INDEX.md`, recording reuse of
the three existing source pins, licences and research date. No reference code is
modified. All original acceptance/native/browser/physical obligations are deferred
and **UNRUN**. A completed research counterexample is not whole-feature delivery.
