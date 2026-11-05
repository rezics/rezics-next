# Thread page reader lifetime

The thread route admits one loader read against the QueryClient that owns its session cache. The admission records the
thread id, original cursor, requested slug, locale, credential mode, session tuple and monotonic cache observation.
The existing slug and page query options keep their keys and transports. The caller checks the admission around the
existing query function and before accepting the exact result that QueryClient published. It does not start another
read.

The cache observation records session success, error, replacement and removal transitions. A private caller also
binds the exact page cache entry. A same-account CSRF change, readiness transition, sign-out, away-and-back change,
route identity change, locale change, cache removal, error or cancellation retires that caller. A retired result cannot
be selected again after values happen to return to their earlier shape. The old private page entry is removed when it
is still the exact entry owned by the caller. A current explicit refresh captures a new admission and uses the
existing page query; it does not grant the old result new authority.

An admitted refresh keeps the exact QueryClient and cache source, source query/result generation, route identity,
session stamp, locale and mounted connection that started it. During the synchronous `cancelQueries` or
`removeQueries` call only, the predecessor continuation and its captured fresh caller join one boundary. Cancellation
owns only the exact full-revert `setState` event that the cache source identified for a query object present at call
entry. Removal owns only the `removed` event for one of those exact query objects. The boundary is removed before the
operation can await; it does not confer ownership on a later event or a successor caller. Preparing an unusable
private cache entry uses a separate one-query, synchronous removal boundary on that loader caller. The entry is still
discarded, then the loader performs its existing bounded native read.

Successful read ownership is tied to QueryClient's actual structural-sharing output and the synchronous cache event
that commits it. The guard delegates to any configured structural-sharing function, preserves `false`, and otherwise
uses the installed default deep-sharing algorithm. The guarded query function must have produced the result; the exact
Query object, one-step data update count, unchanged error count, non-manual success event and committed output must all
match. A raw response reference is insufficient. An external success remains external even when its value compares
equal and default sharing returns the same cached reference, including a nested success notification during the owned
commit. A cached loader hit is accepted only when the previously stamped successful entry and its query generations
remain unchanged. Errors, partial `setState`, unrelated removals and query recreation remain external.

The refresh does not suspend query-currentness across an await; after the old caller hands off its direct query
comparison, its continuation still observes cache events while the successor read is in flight. An external mutation of
the exact pending read retires it synchronously. If that same query still has the retired read in flight, it is silently
cancelled without reverting the external cache state, so its late response cannot overwrite the successor.

A cancellation, removal, session success/error/removal, provider replacement, route or locale transition, connection
change, superseding refresh or final unmount from outside that operation retires it. Each queued and awaited boundary
rechecks the captured route, source, session, locale and connection before the next removal, native read, result/cache
publication, slug remember or navigation. A committed external result is retained as the successor; stale cleanup
cannot remove it or touch a newer operation. Refreshed route state remains scoped to its original provider and route
identity, including away-and-back provider transitions.

Ordinary query fetch-status and observer changes do not by themselves retire a page result. A query cancellation,
removal, error or replacement does. Once the refresh hands cache authority to its newly admitted caller, that caller
guards the page query through result acceptance; the previous caller cannot accidentally clear or retire the new one
during cleanup. `ThreadReading` keeps the same keyed posts and composer while these source scopes change, so stale
disclosure is hidden without dropping reply targets, editor focus intent, dirty drafts, departure protection or an
uncertain command's immutable payload and idempotency key.

The anonymous page result carries no viewer authority and can survive session preparation and ordinary rerenders.
Personal reads remain the existing bounded query over the visible page's post ids. A personal result is selectable
only after its query function completed for the exact current target, session revision and mounted connection, and
only when its viewer still matches the session subject. Old callbacks cannot invalidate, remember a slug, refresh or
navigate after their admission retires.

## Review header handoff

Decision: the mounted review header consumes only the official installed `ReadingPageResponse.reviewContext`. It
passes citation references through the existing [post-history reader and return lifetime](post-history-lifetime.md),
preserving source post, source revision, question and vote revision as independent identities. Historical question
labels and scales remain unavailable; no second history reader or lifetime host is added.

The disclosure uses `browserObservation` and `subscribeCache` with a retiring lease scoped to the mounted page.
Invalidation or fetching, equal session replacement, remount and an observed away-and-back session transition retire
the old advice. Re-entry requires a new page admission.

`ThreadReading` keeps its keyed post components mounted while a private page is unavailable. It replaces their page
input with an empty document and removes page authors, title, board and realm, media, subjects, provenance and personal
reaction or vote state. This keeps dirty editor and reply drafts, departure protection and uncertain command state in
place while the old disclosure is hidden and inert. Existing reply-parent, post-history, provenance, erasure and
native command owners keep their own lifetimes. A new explicit refresh or route visit can display a newly admitted
page.

## Unresolved hydration contradiction

The router starts server reads in anonymous mode, so public anonymous page data can hydrate on a different browser
QueryClient. A private page admission includes a process-local QueryClient source id and monotonic session-cache
history. A browser QueryClient cannot prove that history from serialized values alone, even when the account and CSRF
tuple compare equal. The browser therefore keeps that page unavailable until a fresh client-side read or route visit
establishes a new caller. The private server render is redacted as well, so it does not emit markup that the browser
must reinterpret as trusted. This preserves the public anonymous SSR and hydration path without inventing private
authority across QueryClient instances.

The unresolved contradiction is specific: a server loader can complete a session-credential page read before SSR,
while hydration must use a different browser QueryClient whose session-cache history starts independently. Showing
that page during hydration would rebind private data to an unproven browser authority; hiding it means the server
loader's private result cannot provide the same first paint. This change chooses redaction and a fresh client read as
the safe runtime behavior, but does not claim that private SSR and private hydration share one authority.

## Cost

### Thread refresh and recovery

- Touches: existing bounded page and personal query invalidation, cancellation, read and local result publication.
- Bound: unchanged native request count, page limits, personal targets and cursor ordering; constant local state per
  active refresh, with no per-row reads or polling.
- Growth check: retain original page and personal bounds, prevent obsolete queued reads and publication, and exercise
  first and repeated healthy refresh, recovery followed by refresh, private-cache discard, exact external successor
  retention and own-cancellation recovery. These paths add only constant per-read ownership and boundary state; they
  do not add native requests, per-row work, polling or authentication. The connected regressions authored for this
  implementation remain UNRUN until the deferred acceptance pass.
