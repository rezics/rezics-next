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
session stamp, locale and mounted connection that started it. Cancellation owns only a full revert `setState` event on
the exact query objects present during that synchronous `cancelQueries` call. Removal owns only the `removed` events
for the exact query objects present during that synchronous `removeQueries` call. A successful commit, error, partial
`setState`, unrelated removal or query recreation remains external, including a successful commit whose data is equal
and structurally shared with the previous value. The refresh does not suspend query-currentness across an await; after
the old caller hands off its direct query comparison, its continuation still observes cache events while the successor
read is in flight. Only the exact success event following that guarded read's result is owned.

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
disclosure is hidden without dropping dirty drafts or uncertain command intent.

The anonymous page result carries no viewer authority and can survive session preparation and ordinary rerenders.
Personal reads remain the existing bounded query over the visible page's post ids. A personal result is selectable
only after its query function completed for the exact current target, session revision and mounted connection, and
only when its viewer still matches the session subject. Old callbacks cannot invalidate, remember a slug, refresh or
navigate after their admission retires.

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
  healthy own-cancellation recovery. The connected regressions authored for this implementation remain UNRUN until
  the deferred acceptance pass.
