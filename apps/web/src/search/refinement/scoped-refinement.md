# Scoped Search refinement

Scoped Search results and property facets are built from the same `discoveryRequest` predicate. It carries the query
text, ordered language chain, catalogue condition tree, existing filter, Realm or Collection leaf, type/value choices,
ranges and kinds. Initial facet reads and later value pages use that predicate and the existing `POST /v1/subjects:facets`
request; the native value and continuation contract remains owned by [Public facet discovery](../../../../../docs/search-facets.md).

For a scoped read, the server prepares the current request through the shared session reader, then uses that request's
credential and verified subject together for results, kinds and facets. The browser's installed session owner must
match the verified owner before a scoped request runs. A mismatch returns a session/restart state and does not retry
the request as Global. Signed-out readers use the anonymous principal only when their current session observation is
known.

The refinement identity binds the verified reader, source and resource ID, ordered languages, released catalogue
digest, text and complete effective filter. The result query key also includes reader and source, and scoped query data
is personal and immediately discarded when its observer leaves. A changed reader or resource remounts the existing
Refinement component, retiring its displayed values and bounded continuation ledger. Each property retains its own
opaque cursor history; retries after restart begin at that property's first page. A native restart clears the prior
observation pages. The UI never derives counts from result rows or invents numeric buckets, and range controls preserve
the released units and authored correction state.

A successful empty terminal page is the native absence of eligible values. Withheld coverage, preparation, malformed
or rejected requests, and stale continuations remain separate states; an unavailable or withheld page is never
presented as exhaustion. Short terminal pages retain their exact native values and order.
