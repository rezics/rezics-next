# My Realms caller lifetime

The private My Realms route captures one visit from the route QueryClient before it starts the existing collection
read. The visit binds the route target, native cursor, locale, session credential mode, original signed-in subject,
CSRF fingerprint, session readiness, QueryClient session revision and the prior `['my-realms', cursor]` cache revision.
The query key remains exactly `['my-realms', cursor ?? '']`.

The existing query function checks that visit before and after the deferred `space-actions` import, before and after
the BFF read, and before returning the result to React Query. Session-cache changes advance a monotonic source revision
from QueryCache notifications, including same-account CSRF replacement and batched away/back changes. Retirement
cancels the exact query and removes its owned cache entry. The loader accepts a result only after the same caller,
query object and a newer cache revision are observed. The route host accepts either that caller-tagged query result
or the exact loader envelope that completed the read. A retained loader fallback cannot restore a retired visit.

The route abort signal, route address, cursor, locale, session readiness, QueryClient and mounted connection all fence
the caller. A disconnected component invalidates its callbacks immediately; final cancellation is deferred to a
microtask so React StrictMode's synchronous effect replay remains one mounted connection. A later navigation creates
a new caller and can read the current signed-in visitor's list. The route continues to use `requireSignedIn`, its
existing unavailable error page, noindex metadata, search validation, native next cursor and `MyRealmsPageView`.
`realm-membership-queries.ts` changes only the My Realms query/import region; RealmMembership and its refresh cycle
retain their existing cache keys, signatures and behavior.

## Hydration boundary

The server loader and browser may use separate QueryClient objects. The loader therefore serializes only the session
state, subject, readiness, SHA-256 CSRF fingerprint and source/cache revision metadata with its page; it does not
serialize the raw CSRF token. The browser adopts that envelope only after its session-cache revision and CSRF
fingerprint match, then keeps observing the browser QueryClient for later transitions.

One transition remains unobservable by this route: if an account or CSRF change happens after the server snapshot but
before the browser creates its QueryCache observer, and the final hydrated QueryClient has lost the intervening cache
revision, a signed-in A-to-B-to-A sequence cannot be distinguished from no transition. React also uses the server
snapshot for the first hydration render, so the exact server loader markup can remain visible until browser adoption
finishes. Detecting both cases requires a monotonic session revision that survives server-to-browser hydration, or a
shared hydration admission hook that can withhold this private page before React hydrates it. Neither authority is
available to this route. The implementation fails closed as soon as the browser observer or fingerprint check can
establish a change; it does not treat the final signed-in tuple alone as proof of the original caller.
