# Community and site read costs

G-1026 derives these models from `realm-reads/read-realm.ts`,
`realm-reply/thread-contract.ts`, `realm-reply/thread-store.ts`,
`access/roster.ts`, `zone/route-cost.ts` and `zone/publication.ts`.
The APIs precede web fan-out qualification. Request profiles observe round
trips, bytes and request duration; they do not observe native TDB2 visits.

Let P be the requested discussion page, R the authored rules (at most 12),
B the banners (at most six), C the ranked candidate cohort (currently 256),
T the shown thread nodes (at most 192 plus 32 ancestors), H retained history,
F a reader's follows, M their memberships, and N unrelated data.

| API | Required model and current selection | Owner round trips |
| --- | --- | --- |
| Realm header, about and rules | Exact Realm/Space/profile identities. O(R) rendering and O(R log H) rule-head probes; independent of community population, F, M and N. Exact membership count comes from its maintained counter. | Existing 13-query hydrator envelope plus two outer graph-position fences; one rules-document statement plus one scoped rule-head statement for nonempty references. Optional icon/banner use exact media probes. |
| Discussion New | Complete keyset traversal. Only P+1 candidates should be selected, with O(P) bounded hydration and O(log H + P) indexed selection. | Current graph candidate query, one Content admission statement, one vote batch, ceil(P/64) Content body batches, bounded root/author summary batches; counts visit at most 64P+1 replies. |
| Discussion Best/Top | Preserve Home's monotone log-vote/linear-age Best signal and net-score Top. Ordered selection should seek a bounded page independently of Realm history. | Current implementation selects and ranks C newest candidates on every page, then hydrates P. This does not qualify full-history ranking or eliminate prefix rescans. |
| Focused thread | Indexed parent traversal bounded by T and depth 32, independent of other Realm threads, F, M and N. Live Content approval and disclosure still gate the exact placed bodies. | One subtree and one ancestor statement, one Content admission batch, one vote batch, ceil(T/64) exact body batches, bounded author/root summary and disclosure batches; final live root/Realm/block fences. |
| Public roster | Indexed candidate keyset, P+1 listings, live membership/ban/profile joins; independent of F, M, N and retained episodes. | Existing two graph policy probes and nine-statement Access transaction envelope. A bearer does not turn this public roster into a private membership inventory. |
| Zone root route | Exact Zone/configuration/visibility identities. No population or history traversal is needed for the home branch. | Fixed owner/configuration and live visibility probes; immutable configuration object reads. |
| Zone presentation | O(configured modules + returned navigation), with independent query/collection modules retaining their own contracts. Banner metadata is O(B log H) exact Use probes and O(B) output, independent of F, M and N. | One Content statement for all distinct banner Uses, preserving exact representation, clearance, target Realm, public disclosure, moderation, lifecycle and dimensions. A one-Use adapter also needs only one statement. |

Signed reads add the existing active-principal, language preference and reader
vote/block checks. Private Realm reads additionally need the same live membership
proof before disclosure and at the final fence. Neither path should enumerate
the reader's complete follow/membership inventories to read one community.
This fixture covers anonymous and ordinary signed public membership; private
Realm qualification remains separate.

## Decision and verification limits

The fixes batch rule-head and media probes rather than caching their results.
The scope and revision tests survive a linked rule update; a missing or differently
scoped head leaves its public text intact and suppresses only the stale link.
PostgreSQL's [array equality semantics](https://www.postgresql.org/docs/18/functions-comparisons.html#FUNCTIONS-COMPARISONS-ANY-SOME)
support one statement with the existing primary-key identities. This does not
by itself establish the physical plan's rows or buffers at production scale.

The existing ranking decision in `feed/ranking.ts` is retained. It compares
the [original Reddit implementation](https://github.com/reddit-archive/reddit/blob/master/r2/r2/lib/db/_sorts.pyx)
and explicitly selects REZICS' monotone variant. The cohort restriction is a
selection/layout problem, not a reason to change that ranking signal. G-1025
owns the running feed projection task; integrating its complete indexed order
with Realm selection requires a manager-coordinated follow-up.

`tests/qa/integration/g-1026-community-cost.test.ts` varies Realm top-level
discussion count, retained reply draft history, follows, memberships and
unrelated public Works through public commands. Relationship targets exist
before the sweeps; automatic join follows are removed so memberships vary
independently. Each axis retains the values reached by earlier axes as its
fixed background and records the actual dimensions. Rules and banners also
vary within their owner bounds to expose per-item SQL round trips.
The corpus author has a fixture operator role; the reader remains an ordinary
member. Account verification is the existing fixture verifier, so these
profiles qualify Main and native PostgreSQL/Fuseki, not Account HTTP/SQL cost.

The diagnostic `G1026_PHASE=before` reconstructs the former per-reference
rule and per-Use media lookup loops against those same native owners. Default
runs assert the fixed batch costs. Captured evidence labels the first request
as first, not engine-cold: preparation already touched the stores. A retained
stopped backup/isolated restore and true cold/warm experiments are still needed.
[ARQ explanation](https://jena.apache.org/documentation/query/explain.html)
reports optimized algebra; it does not report native operator work. The pinned
Fuseki also lacks the native engine timer. Neither limitation is a measured zero.
