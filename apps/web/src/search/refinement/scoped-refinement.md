# Scoped Search refinement

Scoped Search results and property facets are built from the same `discoveryRequest` predicate. The additive facet
request carries `scope: {kind,id}` plus `conditions` with the complete effective filter, including the scope leaf,
alongside the existing text, filter, languages and facets fields. The `subjects:facets` route runs the shared Search
scope admission with the verified actor, current reader, Access instance and request deadline before cursor or native
producer work. Its response DTO and opaque per-property continuation remain owned by
[Public facet discovery](../../../../../docs/search-facets.md).

Collection facets use the installed service-bound Search Scope candidate and current-membership interfaces. Search
prepares canonical values from the complete authorized Collection population and rechecks the same scope, contributor,
target and source observations before disclosing each page. Missing or changed evidence returns preparation/restart
inside the selected scope. Realm facets stay unavailable until Content installs its canonical enumerator.

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
presented as exhaustion. Short terminal pages retain their exact native values and order. Desktop and narrow layouts
share the same ready, pending-preparation and currentness-restart states; a scope change while a value page is pending
retires its displayed values and continuation before retrying in the selected scope.
