# Private phrase search admission boundary

This is the implementation brief for the first bounded SEARCH11/SEARCH12 lane.
It does not qualify private full-text until the owner-boundary tests pass.

## Selected first lane

The implemented candidate starts with one native TextContribution draft. Main
owns its current `draftHead`, immutable RevisionAnchor and object manifest. Its
guarded create/edit command projects one body MatchUnit for that exact head into
`urn:rezics:search:private`, replacing the prior unit on edit. The Lucene map
uses a distinct `rv:privateSearchBody`/`privateBody` field. The internal query
adapter checks the exact object bytes against the private graph literal and a
concrete-subject Lucene posting before a zero-or-one phrase result. It returns
stable unit identity without score, snippet or facet. Missing source,
projection, posting or a moved head/index fence makes the adapter unavailable.

The candidate adapter accepts a 2–80 character phrase, one Contribution, one
body field and one unit. It has a 1,500 ms abort timer, at most 10 Fuseki calls
and a 1 MiB Fuseki/response bound. These are adapter limits; Account and Access
calls have not yet been placed under one whole-request deadline. The public
`/v1/private-queries` profile is currently fail-closed with a typed 503 and
does not call Account, Access or Jena. The installed Elysia `afterResponse`
hook may run before socket delivery completes; using it to finish a delivering
Access lease could let a strong scope close acknowledge while response bytes
are still in flight. A proven send-completion/cancellation fence is required
before this route can return results.

Access owns the principal, acting-subject representation, grants, scope epoch
and finite read admission. Main owns this native draft's exact source, graph
head and index generation. The existing `canReadContributionDraft` boolean
ends its transaction before matching and does not provide a delivery fence.
Broader private Content search still needs a mapping from PostgreSQL Content
heads and revisions into Access-scoped MatchUnits, including multi-field and
up-to-32-unit admission, source reconciliation, erasure and whole-request
owner-call bounds. This candidate does not qualify SEARCH11 or SEARCH12.

## Why the existing public path cannot be reused as authorization

The installed assembler indexes public MatchUnits. Jena's
[`TextQueryPF`](https://raw.githubusercontent.com/apache/jena/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/TextQueryPF.java)
and [`TextIndexLucene`](https://raw.githubusercontent.com/apache/jena/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/TextIndexLucene.java)
show graph and concrete-subject constraints reaching the Lucene adapter.
A later SPARQL `FILTER` or post-hit Access check cannot prove that hidden units
were excluded before hit collection. This is a source-level inference that
requires a runtime test against the pinned image and query plan.

A separate private named graph in the same index does not isolate ranking
statistics for a shared field. The candidate maps the private body to its own
Lucene field so private documents do not enter the public `body` field's term
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
- SEARCH12: place barriers before Access admission, after the native draft head
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
