# My Realms caller lifetime

Each My Realms read captures one QueryClient, route cursor and locale, credential mode, session tuple and cache
revision, source revision, and actual reader origin. A per-QueryClient visit generation is reserved before the caller's
asynchronous CSRF fingerprint. A newer route capture supersedes an older pending capture even when the session values
are equal. The old capture cannot activate after the new one or borrow its query/result owner.

The existing query function checks the caller and exact Query object before the native read, after its asynchronous
action import, and after the response. `publishResponse` admits only the original page whose actual session origin
matches the captured reader, and tags that page with the same caller and query object before TanStack Query can publish
success. Query data is usable only while the exact query, page object, update revision, route, locale, credential mode
and session source still belong to that visit. Successful equal-data session replacement, error/removal, observed ABA,
route changes, abort, a replaced query or final unmount retire the visit. Fetch and observer activity alone do not.

Retirement removes only the exact owned query object. Its cancellation and removal filters include that object identity,
so a replacement query sharing the cursor key survives reentrant cleanup. A late read, query error, `finally` callback
or verification from a retired visit cannot publish or clear a newer query. StrictMode's synchronous effect replay
reconnects the current caller; an asynchronous hydration verification is scoped to its own connection attempt, and an
older completion cannot unlock the replayed connection.

The current route still returns its accepted loader page for server rendering and adopts it in the browser. The existing
`acceptsHydrationSeed` branch can render private data before post-mount verification; that branch is an explicit
reserved contract and is not proven safe by this lifetime or by matching receipt fields. This work does not change
private SSR or first-render output, claim `renderToString`/`hydrateRoot` first-paint proof, or add a trusted synchronous
shared hydration/session producer. Independent QueryClients still cannot reveal an unobserved away-and-back session
transition; the known independent-cache/ABA limit remains.

The source boundary is the existing My Realms caller's capture, admission, verification, query ownership and
post-verification effects; its route host; this document; and the three connected regression files. The route loader,
membership query, page reader, session producer, native query, and renderer remain unchanged. The existing first-page
request, cursor recovery and continuation, order, private disclosure and null-CSRF read-only behavior are preserved.
No extra session read, authentication preflight, polling, per-row hydration or native request is added.

Decision: offer first-page recovery only for cursor failures without an HTTP status or with status 408 or 5xx; other HTTP failures, including admission denial and platform-closed, keep their existing retry or closed handling. The localized action targets `/realms` with empty search so the route guard and a fresh caller own the visit.
