# Native Realm rating Search

`createRealmRatingNativeSource` in [realm-rating-native.ts](realm-rating-native.ts) is installed as
`realmRatings` in [server.ts](../server.ts). The installation supplies the same configured
`rated.source` used by the outer Search reader. Its route fences, native relation capabilities
and current Subject facts remain authoritative for predicate execution.

## Current execution

Observation reads live Realm Access and ban authority, question identity/revision/provenance,
prior eligibility and generation, figure publication, canonical Subject population, Search
generation and current release digest/head. These observations and the admitted principal,
text and filter bind the continuation. Internal before/after observations retain the original
request and do not renew its work allowance or grant authority.

The native `readScoredCanonicalPartition` supplies score descending, canonical name ascending
(missing last, C collation), Subject ID ascending seeks. Search opens the union of canonical
and scored homes under the complete observation, including `scoredHomes` and
`canonicalPopulation`. Canonical-only homes must pass the native coverage gate; retained
scored-only homes must prove their scored set empty. Missing or stale canonical publication
remains `index_not_ready`, even on an empty continuation.

Each scored head must match the observed native generation, epoch and position and carry a
current security revision and complete figure. Stored standard-question scores stay on the
0–10 scale, including zero. Search merges one head per home with numeric score and UTF-8 byte
name/ID comparisons. It preserves each returned `candidate.key` verbatim through internal
refills, including the decimal score string. Full predicate and live Access rejects spend the
same raw allowance before the next head is read. Accepted rows return as partition frontiers
to the existing outer merge and three-round useful-page collector. A short scored window
permits the unscored complement only after complete empty seeks retire every scored frontier.

The native `readCanonicalPartition` supplies bounded name/ID seeks across the complete
canonical Subject population, independent of Realm membership, threads and Spaces. Each raw
row carries native figure eligibility, including proven absence. Search validates the complete
figure before suppressing a scored row from the unscored complement; zero remains scored.
Canonical Subject and figure evidence retain their native snapshots. Indexed absence and a
fetched scored prefix prove neither membership nor exhaustion. Only complete empty native
seeks retire homes; a short page alone does not.

[realm-rating-native-read.ts](realm-rating-native-read.ts) evaluates the full admitted predicate
on current facts through `checkHits`, with the original filter expression and `currentText`.
The configured source must return each Subject at the exact canonical home position observed
for the request. Text uses the analyzer installed on the selected Search generation, including
term, phrase and Boolean semantics. Relations retain native overflow, qualifier, inverse and
before/after release checks. `not_proven` refuses the window, including under negation; it
cannot establish a rejection or a consumed continuation. Definitive rejects are charged and
refilled within the existing raw allowance.

Subject Access is prepared and evaluated before current hydration and again for accepted
candidates. Native Realm observations bracket reads and final disclosure, including empty
pages. Changed source cuts, release heads, names, identity, question, prior or publication
evidence restart or refuse; live authority denial keeps the owner's outcome. Compatibility
compositions may omit `source` only for predicate-free traversal, leaving facts to their outer
reader. The production composition always supplies it.

## Request lifetime

All native calls and Access preparation retain the original Pool and absolute deadline.
Release observations use separate `withBoundedReadOnlyTransaction` calls, including the
before/after relation observations. Each local snapshot finishes before Subject, relation,
Rating or engine work starts. Checkout, queries and cleanup share that deadline; uncertain
clients are retired by the bounded read owner.

Current predicate work propagates that same deadline with `withRequestDeadline` through the
existing configured source and its retained relation operations. The Search transport caps
generation and analyzer requests to the remaining time and checks expiry after completion.
No source or permission adapter is reconstructed from Pool, and no observation caches Access.

The shared rated source also enriches Subjects through Rating's
[public-rating-source.ts](../rating/public-rating-source.ts). That owner's `read` still uses
unbounded `withConnection`; propagating the ambient deadline does not retrofit physical
checkout/query/cleanup bounds there. Bounding that existing owner is a separate dependency;
Search must preserve the configured source rather than substitute a new one.

## Native continuation and publication

The signed Search cursor carries the last consumed global score/name/ID tuple. Its Subject ID
can belong to a different home from the next native seek. Search passes that ID unchanged;
only the public cursor's numeric score is converted back to its stored decimal representation.
Subsequent native seeks use the exact returned key. The producer's
`copyScoredCanonicalRequest` must validate the key's score, name and routable Subject ID without
requiring `partitionOf(routeOf(after.subjectId)) === request.partition`. Returned candidates
still must belong to the requested home. That seek-validator amendment belongs to Content.

Search does not use the score/UUID compatibility port, sort a compatibility prefix, scan a
whole tie or rebuild a generation during a read. Rating retains canonical publication and
its durable startup/resume binding; complete Semantic canonical-generation delivery remains
with the existing Content owner. The callable alone does not establish publication coverage.

## Cost and deferred acceptance

For P homes in the canonical/scored union and R selected raw scored rows, the scored merge
retains one head per home plus the requested window and reserves at most P+R seeks and rows.
It keeps these frontiers through predicate refills. The unscored merge retains at most 16 rows
per canonical home plus raw window B, reserving at most P+B seeks and 16P+16B rows per raw
window. P <= 4096 and B <= 200; native reobservations add O(P) metadata work per seek. The
unchanged request caps permit at most three outer calls per phase, 6*4096+600 seeks,
51*4096+9600 reserved rows, and
min(600, 3*B0) selected raw candidates, where B0 is its first requested window. Empty seeks,
unused buffered candidates, suppressed rows and predicate rejects do not refund work. A cap
hit is unavailable, never successful exhaustion. Current source, relation and analyzer work
retain their existing bounded batches and share the request deadline.

Installed runtime acceptance and 1x/4x/16x growth remain deferred and unmeasured. The smallest
next check covers multiple scored homes, equal scores/names, rejected predicates and a
cross-home continuation. Final acceptance still requires complete scored/unscored discovery
on the existing native Realm/default-worker journey, including first/next/empty pages, current
text and advanced filters, changed source cuts/Access and finite expiry. Record native
statements, examined/returned rows, seeks and retained candidates; source changes alone do
not prove installed complete order.
