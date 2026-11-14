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

## Remaining scored dependency

Content's existing `RealmRankOrderSource` owns the indexed scored canonical seek. The retained
`readScoredPartition` orders by score descending and ID descending, without a canonical name.
Search uses it only to distinguish an empty scored population from unavailable complete order.
A returned scored candidate still produces typed `index_not_ready` with Retry-After. No active
prior, or complete empty native scored seeks, permits the current unscored traversal.

The required scored key is score descending, canonical name ascending (missing last, C
collation), then ID ascending. The delivered callable must accept strict cross-home keys and
bounded limits under the same observation, live actor and deadline; return native generation,
epoch/position, name/security revision and complete figure proofs; and reobserve empty reads.
The existing scored-only compatibility API and sole Rating publication writer remain owned
by Content. Search's consumer update must use the exact committed API when delivered. No
callable is assumed here, and no local tie sort or filtered prefix replaces the native seek.

## Cost and deferred acceptance

For P occupied canonical homes and raw window B, the merge retains at most 16 rows per home
plus B selected rows. Each call reserves at most P+B seeks and 16P+16B rows, with P <= 4096
and B <= 200; native reobservations add O(P*(P+B)) frontier metadata work. The request permits
at most three calls per phase, 6*4096+600 seeks, 51*4096+9600 reserved rows, and
min(600, 3*B0) selected raw candidates, where B0 is its first requested window. Empty seeks,
unused buffered candidates, suppressed rows and predicate rejects do not refund work. A cap
hit is unavailable, never successful exhaustion. Current source, relation and analyzer work
retain their existing bounded batches and share the request deadline.

Installed runtime acceptance and 1x/4x/16x growth remain deferred and unmeasured. The smallest
next check is installed Realm discovery with current text plus an advanced filter, a changed
source cut/Access and a finite expiry. Final acceptance still requires the existing
Realm/default-worker discovery with complete scored/unscored order after the sole Rating
callable is received, including first/next/empty pages, sparse rejection and currentness
invalidation. Record native statements, examined/returned rows, seeks and retained candidates;
source inspection or refusal alone does not prove installed complete order.
