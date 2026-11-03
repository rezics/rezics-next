# Concept hierarchy traversal

Search's hierarchy traversal is derived work beneath the existing retained-plan worker. It does not establish
Semantic graph coverage, release admission, disclosure or authorization. Indexed storage and worker dispatch
are installed, including the admitted native hierarchy source. Native classified-statement windows
and a complete first-prefix absence proof are available through SubjectSource. An explicitly budgeted
multi-window prefix matcher composes these windows; Search dispatch and the public hierarchy journey
remain to be connected.
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
statement evidence before publishing results. Source cost derivation and universal Search and page
installation remain separate work.

Conflicting explicit spoiler levels on one selected statement remain `not_proven`; duplicate identical
levels retain their meaning.

## Native hierarchy closure source

Decision: descendant closure reads ready selected `skos:broader` edges scoped by selected `skos:inScheme`, confirms both relations through current native witnesses, and uses a short raw page or an empty terminal seek to prove exhaustion.

`relationSource.conceptBrowse` binds each worker step to the active release, the canonical generation and the selected root's current identity and scheme membership. It reads a bounded keyset page of ready selected broader edges, then confirms each edge and its scheme membership through the native relation matcher. The full raw edge key advances the retained frontier even when a candidate is rejected or duplicates an existing member. Full pages require another bounded seek; a short page or empty terminal seek closes that parent. The worker reserves the observation or seek allowance before native I/O, including replayed pages. Changes to statement disclosure also advance the canonical generation so a changed witness restarts the retained cut.

## Native classified-statement windows

`subjectSource.readConceptStatements` reads the full selected statement prefix for one subject/property,
using `search_selected_page (route,subject_id,property,slot_id,candidate_id) WHERE active`. It accepts
one full `(slot,candidate)` continuation and at most 64 raw rows per dispatch. Hidden, rejected,
retracted and withheld candidates count towards that bound. The native cursor advances past them;
matching never replaces a closure with `in:64` and never refills a window implicitly. Exactly full
windows require a later terminal seek. A cursor carries the source identity/revision/security, canonical generation and
active release observation; replacement discards it. These internal cursors are not public Search cursors.

Decision: native statement windows remain internal. A complete-absence proof is valid only when
Semantic establishes the complete selected prefix from its start; a terminal continuation suffix is
not proof for the omitted prefix.

The reader uses the current release to admit the property, Concept condition and all qualifiers,
then reads the stored immutable releases to interpret each selected statement. The existing native
relation reader establishes current candidate eligibility, disclosure, imported tuple fences, source
identity, and original/terminal target and qualifier identities. Per-attempt observations retain native
identity and tuple versions, including rejected dependencies. Final revalidation rereads the same raw
prefix and compares its eligibility, source subject and active release observation; it also repeats
native dependency/tuple reads and compares both witnesses and their versions. No reusable permission
or synthetic coverage producer is returned.

`matchNativeConceptStatements` composes these native windows with the sealed-cut membership batch.
Qualifiers and the independently supplied spoiler threshold constrain each statement separately.
Semantic marks `complete` only when `selection_ready` holds, the first request has no cursor, and the
raw selected prefix contains fewer rows than the bounded window. The raw traversal includes hidden,
rejected and withheld candidates, but enumeration alone supplies no negative disclosure evidence.
`nativeConceptStatementCoverage` certifies a window only when every examined raw candidate has a
current disclosed witness. Concealed, malformed, fenced or otherwise undisclosed candidates remove
both the first-window absence certificate and the multi-window ready-prefix certificate. A disclosed
witness that fails the current property/value, qualifier or spoiler condition can still contribute
false. Certificates are returned only after the full prefix and its native dependencies are
revalidated. A full window or a terminal continuation suffix stays incomplete. This single-window
proof covers only prefixes that fit one dispatch. Each ready native window also carries its
selected-prefix observation for the bounded multi-window composition below.
After membership the reader revalidates native evidence even if the candidate was rejected. Any
changed raw candidate or native dependency retires the retained cut and returns restart without a
verdict or cursor. Unavailable evidence discards provisional positives.

The window has two native prefix reads (initial and revalidation), each examining at most B raw
selected rows for B <= 64, plus one canonical-generation point read and point joins for candidate, hidden candidate, disclosure, acceptance
and latest retraction on those exact keys. Each prefix read has one source home/identity observation
and one active-release read; at most B distinct stored-release lookups interpret the rows. Each
native disclosure pass visits the source, target and item qualifier identities along at most eight
redirect levels, grouped by home, plus imported tuple-owner reads in batches of at most 100.
Final release observations also apply to both disclosure passes. Replays and empty terminal windows
use these same reads. Retained membership adds the D + 1 statements documented above and two graph
observations; no native window performs graph traversal per candidate.

This expands the operation structure, not an all-pool dispatch reservation: stored-release/body byte
bounds, qualifier fanout, owner control-query work and physical tuple/identity footprints must still
be composed before enabling this port in the Search dispatcher. The statement port is exposed by
SubjectSource but is not activated by Search. The native hierarchy
adapter is installed in the retained worker. All-pool reservation composition, native growth and
useful-page guarantees, universal Search installation, hierarchy APIs and the localized page remain
in the continuation. Focused tests do not measure native growth or connected browser work.

## Bounded complete statement prefixes

Decision: multi-window absence starts at the native prefix origin on each attempt and spends an explicit raw-row and window allowance; exhausted allowances remain unknown and never trigger an implicit refill.

Decision: native window enumeration cannot prove absence when any raw candidate lacks a disclosed witness; each attempt retains at most 32 window revalidators and admits at most 2048 raw rows, with larger prefixes left preparing for retained ownership.

`matchNativeConceptStatementPrefix` owns the request, retained cut and allowance before awaiting.
Each native seek admits at most 64 raw rows and consumes its full admitted row limit, even for
rejected candidates, replay or an empty terminal seek. A full window requires another seek; a
short window proves termination only when every window carries the same native ready-prefix
observation and the complete full-key continuation advances through all raw candidates. A suffix
cannot be supplied as the starting point. Missing native prefix evidence preserves uncertainty.

The matcher probes membership in bounded windows and combines property, value, qualifiers and
spoilers on the same statement. It keeps each native revalidator until after the last membership
read and runs them even when an earlier window already supplied a positive. A mutation in any
rejected window retires the cut and discards all provisional results. Unavailable evidence also
discards positives. The final membership read confirms the root still belongs to the same sealed
retained cut before those native revalidations; no further membership I/O follows them. Each native
prefix observation also binds the canonical generation, fencing hierarchy mutations during native
revalidation.
Only a certified terminal prefix can supply false to Boolean exclusion.

Working memory is bounded by the admitted row and window allowances, including attempt-local
native revalidation closures. The returned counts describe traversal progress, not native work
receipts. This seam deliberately remains outside universal Search until its caller composes the
native owner, retained membership, release/body, identity and tuple-fence reservations before
dispatch. It introduces no lifecycle, public cursor, retained permission or closure-size cap.

## Native Boolean concept conditions

Decision: one Boolean concept attempt shares its native window and raw-row allowance across deduplicated leaves and revalidates every visited witness after all leaves' membership work.

`matchNativeConceptFilter` admits scheme-bound exact and descendant concept conditions, then uses
`compileCurrentFilter` for deduplication and the current three-valued AND, OR and NOT semantics.
Each first-occurrence leaf resolves its retained cut before native I/O. A missing cut returns
preparing without native reads. Conditions, qualifiers, spoiler meaning and retained definitions
are owned before asynchronous work. Exact and descendant leaves may share the same scheme-bound
closure; each statement still supplies its own property, value and qualifier witness.

All leaves together admit at most 32 native windows and 2048 raw rows. A spent allowance leaves
unvisited evidence unknown, including under exclusion, and never starts a refill. Empty terminal
seeks consume their full admitted limit. The final root-membership checks for every leaf precede
all native revalidators. A changed candidate in an earlier, rejected leaf therefore retires the
attempt's cuts even if another leaf already matched. Unavailable native evidence discards the
whole provisional expression. A lost retained cut leaves the expression unknown.

The single-prefix matcher uses the same bounded scanner and finalization. This internal Boolean
port accepts only concept leaves; callers must use the current native owner for other conditions.
It retains no permissions or public cursor. Native all-pool reservations, retained ownership of
larger prefixes, universal Search dispatch and the localized browsing journey remain required
before public activation. The live useful-page owner interface remains unchanged.
