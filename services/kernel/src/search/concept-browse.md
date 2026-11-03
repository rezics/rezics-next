# Concept hierarchy traversal

Search's hierarchy traversal is derived work beneath the existing retained-plan worker. It does not establish
Semantic graph coverage, release admission, disclosure or authorization. Indexed storage and worker dispatch
are installed; the native source adapter, current matcher and public hierarchy journey remain to be connected.
Absent a native source adapter the worker leaves the plan preparing; it cannot seal an empty closure.

Decision: hierarchy continuation follows sortable full native edge keys independently of returned child IDs, so
duplicate or irrelevant rows can advance without being mistaken for an empty closure.

Decision: each worker step owns an immutable copy of its admitted allowance before asynchronous reads, so caller
mutation cannot enlarge its page, edge or working-set budget.

Decision: the worker's 64-key page size bounds one dispatch only; larger closures continue through retained frontier and membership rows and are never lowered to a 64-value filter list.

`startConceptBrowse` copies and freezes the exact property/concept/scheme selection and the release, graph,
scheme, membership, principal and request binding before retaining the root. The state contains only this
bounded definition and a revision-fenced storage locator. It contains neither discovered keys nor frontier arrays.
An old version-one array state is rejected rather than imported as complete evidence.

`createConceptBrowseStore` implements the internal derived-storage seam within the existing retained-plan
lifecycle. The owning plan supplies immutable identity, leases, expiry, cancellation and worker dispatch. No
separate capture, scheduler, coverage record or public cursor is introduced. The store must persist membership
and frontier rows with full-key indexes, seed the root once, and atomically apply each bounded delta with a
revision CAS. Every operation compares the supplied selection and full binding with the retained definition;
reusing a locator with a changed root, property or binding must fail. A conflict must change no rows. A discovered key is enqueued only on its first insertion; cycles,
polyhierarchy, duplicate edges and interrupted-step replay must not expand it again. `read` returns at most one
frontier row. `seal` requires an empty indexed frontier. `contains` returns null unless the same retained revision
is sealed and usable; a membership Boolean includes the selected root but supplies no statement disclosure.
Retirement must invalidate membership immediately, with bounded row cleanup by the owning lifecycle.

Decision: traversal uses the owning scope plan revision for every CAS and retains its retired plan as a tombstone after derived-row cleanup, preventing locator reuse from reviving an old membership observation.

`scope_preparation_concept_member` has a `(partition_no,prefix,scope_id,concept)` primary key;
`scope_preparation_concept_frontier` has the equivalent full parent key. Both use C collation. The
frontier seek fixes partition zero, prefix and scope, orders by parent and returns one row. Each delta
updates the owning plan only at the supplied revision, full JSON definition, live expiry and claimed
worker lease, then changes exactly the expected frontier. Its bounded child input inserts membership
with `ON CONFLICT DO NOTHING`; only inserted keys feed new frontier rows in the same transaction.
Root seeding is atomic with plan creation. Re-retaining a plan neither reseeds nor renews it.

For f frontier pages with b_i admitted child keys, storage reserves at most `6f + f + 2` statements
for delta transactions, next-frontier reads, and initial read/seal. This excludes the native source's
two observations and f adjacency reads, which the adapter must charge independently. Rollback paths
are included in the six-statement delta reservation. Each delta reserves `3 + 2b_i` physical rows
and `32768 + 8192b_i` bytes for plan, frontier, member and full index keys; a read or seal reserves
two rows and 32768 bytes. Retaining the definition reserves six statements, four rows and 32768 bytes.
The definition has nine keys of at most 1024 UTF-8 bytes, and a stored member/frontier key has at most
128 prefix bytes, 64 locator bytes, 1024 concept bytes and 1024 edge-cursor bytes, plus fixed tuple and
index overhead. These are conservative pre-dispatch storage reservations, not measured all-pool work.
The worker fixes four pages, 256 edges and 64 child keys per page before dispatch, independently of V/E.
Unseen edges and terminal empty seeks remain native source work, even when no member is inserted.

The existing maintenance tick retires at most eight expired plans through the concept expiry index,
then locks at most eight uncleaned retired prefixes through the retirement index. Each prefix deletes
at most 128 frontier and 128 membership rows by its full primary-key prefix. Each bounded key read feeds
full-key point deletes, avoiding a range/ANY deletion scan; working memory holds at most 128 keys.
Indexed empty seeks then mark cleanup complete; no cascade scans a closure. A tick uses at most 2077
SQL statements including rollback controls and at most 2048 derived-row deletions. Retired tombstones leave the cleanup index
and preserve the existing plan identity. Complete membership reads still check live plan expiry before
returning either true or false, including while cleanup is pending.

Each traversal step observes its entire binding, seeks at most P child pages and examines at most E native edge
rows, then observes the binding again before returning resumable or completed work. A native child page carries
its full edge cursor even when it contains no distinct new child. Empty terminal seeks still consume a page.
A withheld, unavailable or incomplete branch cannot become a successful empty child page. Preparing evidence
remains resumable; unavailable, rejected, malformed and changed evidence retires the attempted revision.

For page size B, one step retains at most one frontier key and B child keys in working memory, independent of
total V/E graph cardinality. P <= 32, E <= 4096 and B <= min(256, E) are working-set limits, not closure-size caps.
The engine makes two binding observations, at most P child seeks, at most P + 1 single-frontier storage reads,
at most P atomic delta applications and at most one seal. Each delta deduplicates at most B keys locally;
the storage implementation must charge its indexed membership checks/inserts and frontier changes, including
conflicts. Total graph preparation must charge every native edge examined and every empty child seek, not only
newly discovered concepts. Retained storage is O(V); no step serializes or copies that population.

These are logical operation limits, not a measured all-pool native cost. Semantic's installed seek/fanout
constants, binding observations, current disclosure, authorization, History/source/control reads, retained writes,
cleanup, and useful result-page costs still require native composition and measurement. There is no population-
independent whole-page claim or 1x/4x/16x measurement here.

`currentConceptMembership` observes the full binding before and after a sealed membership lookup, then confirms
that the same retained revision remains sealed. A changed,
retired, unavailable or unsealed closure yields `not_proven`, including for an absent concept. The shared current
Boolean interpreter must preserve this value under exclusion, and the shared statement matcher must independently
prove the property, concept value, disclosure and spoiler qualifier on the same statement. Membership must never
be lowered to a bounded `statement.in` list or truncated to the filter's 64-value admission limit.

Decision: exact and descendant statement matching share the same sealed, scheme-bound retained cut;
losing that cut invalidates every verdict in a bounded witness page, including negative verdicts.

`currentConceptMemberships` probes at most 256 requested keys with two source observations and one
final sealed-revision read. It copies the full definition and requested keys before awaiting, deduplicates
point probes and preserves input order. The scalar `currentConceptMembership` uses this same path.
For D distinct keys it invokes D full-primary-key `contains` queries against
`scope_preparation_concept_member`, each fenced by the owning plan's full-primary-key lookup,
revision, definition, expiry and ready state. Including the final `read`, retained storage reserves
D + 1 statements, 2D + 2 rows and 32768(D + 1) bytes. Source observation and exceptional retirement
costs remain additional owner work. Working memory holds at most 256 keys and Boolean results;
neither probe count nor memory grows with closure size. A changed cut, invalid point result or
unsealed revision returns `not_proven` for every requested key.

`matchCurrentConceptStatements` composes those probes with the existing three-valued statement
interpreter. Each native witness carries its own property and concept value and must prove current
disclosure and the admitted qualifiers, including spoiler level, on that same statement. Exact mode
retains only the selected concept; descendant mode probes retained membership without copying the
closure. An empty witness page still probes the selected root, so complete absence cannot bypass
retained currentness. The `complete` input is reserved for Semantic's current complete-absence proof;
partial or withheld native evidence cannot set it. The enclosing caller must revalidate native
statement evidence before publishing results. These ports do not implement that native producer,
its completeness proof, source cost derivation or the universal Search and page installation.
