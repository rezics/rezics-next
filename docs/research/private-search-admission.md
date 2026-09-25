# Private phrase search admission boundary

This is the implementation brief for the first bounded SEARCH11/SEARCH12 lane.
It does not qualify private full-text until the owner-boundary tests pass.

## Selected first lane

Admit one current Contribution and at most 32 exact, eligible field-level
MatchUnits under a verified Account principal and an Access read admission.
Resolve the Content head and selected revision before matching. Match only the
admitted unit identities in a private graph and predicate, with a 33rd-hit
exhaustion probe. Return an eligible-only count and stable unit-identity order;
do not expose Lucene score, snippets or facets in this lane. Wider private
queries need a separately qualified eligible-set operator or scoped index.

The initial limits are a phrase of 2–80 characters, one Contribution, two
fields, 32 units, two attempts, 1,500 ms and a 1 MiB response. The query plan
must also cap aggregate Account, Access, Content and Fuseki calls and bytes.
Over-cap or unsupported shapes return typed errors; a missing projection or
unprovable fence returns unavailable, never a complete empty result.

Access owns the principal, acting-subject representation, grants, scope epoch
and finite read admission. Content owns the exact body revision and current
head. Main owns graph/index generation and the field-level projection. The
admission binds these positions and a deadline. Strong scope closure must drain
or cancel reads on all Main replicas before acknowledging that no old-authority
result can be delivered. Main rechecks Access and Content at delivery, discarding
results when authority, head or index generation changed. The existing
`canReadContributionDraft` boolean ends its transaction before matching and
does not provide this fence.

## Why the existing public path cannot be reused as authorization

The installed assembler indexes public MatchUnits. Jena's
[`TextQueryPF`](https://raw.githubusercontent.com/apache/jena/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/TextQueryPF.java)
and [`TextIndexLucene`](https://raw.githubusercontent.com/apache/jena/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/TextIndexLucene.java)
show graph and concrete-subject constraints reaching the Lucene adapter.
A later SPARQL `FILTER` or post-hit Access check cannot prove that hidden units
were excluded before hit collection. This is a source-level inference that
requires a runtime test against the pinned image and query plan.

A separate private named graph in the same index does not isolate ranking
statistics. Jena pins Lucene 10.3.1 in its
[POM](https://raw.githubusercontent.com/apache/jena/jena-6.2.0/pom.xml), and
Lucene's [BM25 documentation](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/similarities/BM25Similarity.html)
uses collection term/document statistics. The first private lane therefore
does not return a score. A future scored lane must prove that changing hidden
documents cannot change another user's visible score or ordering.

## Falsification gates

- SEARCH11: put a matching hidden field beside a visible nonmatching field,
  then reverse visibility. Compare hits, count, ordering and every diagnostic
  surface. No private literal may enter the public graph or projection.
- SEARCH12: place barriers before Access admission, after Content head
  resolution, during Lucene read and before delivery. Race scope/principal
  closure across two Main replicas, expiry, restart and Access outage. No result
  may be delivered after a completed strong closure.
- Rebuild from currently eligible exact Content revisions after reconciling
  disclosure and erasure. Check RDF and Lucene membership, source positions,
  projection lag and changed generations; missing bodies keep search unavailable.
- Trace the entire request, including retries and nested owner calls, against
  the declared time, call, byte and hit budgets. Test a hidden-match-heavy
  corpus so the lane cannot pass by filtering a public top-K afterward.

This lane is a required step toward the retained private-search capability,
not acceptance of broad private graph search or private paging.
