# My Realms caller lifetime

The private My Realms route captures one visit from the route QueryClient before it starts the existing collection
read. The visit binds the route target, native cursor, locale, session credential mode, expected signed-in subject,
CSRF fingerprint, session readiness, original QueryClient session revision and the prior `['my-realms', cursor]` cache
revision. Those revision values describe that source only; they are not compared with counters in a separately hydrated
browser QueryClient. The query key remains exactly `['my-realms', cursor ?? '']`.

The existing query function checks that visit before and after the deferred `space-actions` import, before and after
the BFF read, and before returning the result to React Query. The server reader records the subject and CSRF fingerprint
from the same prepared request and credential used for the native read. Session-cache success, error and removal events
advance a monotonic source revision; ordinary fetch-state and observer events do not. A successful replacement retires
the visit even when its data is equal, and a batched away/back sequence advances once for each observed replacement.
The caller also owns the exact page-query object: its first tagged success is accepted, while a later success, error or
removal retires the ready result. Retirement cancels the exact query and removes its owned cache entry. The loader
accepts a result only after the same caller, query object and newer local cache revision are observed. The route host
accepts either that caller-tagged query result or the exact serialized loader envelope that completed the read. A
retained loader fallback cannot restore a retired visit.

The route abort signal, route address, cursor, locale, session readiness, QueryClient and mounted connection all fence
the caller. A disconnected component invalidates its callbacks immediately; final cancellation is deferred to a
microtask so React StrictMode's synchronous effect replay remains one mounted connection. A later navigation creates
a new caller and can read the current signed-in visitor's list. The route continues to use `requireSignedIn`, its
existing unavailable error page, noindex metadata, search validation, native next cursor and `MyRealmsPageView`.
`realm-membership-queries.ts` changes only the My Realms query/import region; RealmMembership and its refresh cycle
retain their existing cache keys, signatures and behavior.

## Hydration boundary

The server loader and browser may use separate QueryClient objects. The serialized page therefore carries two distinct
facts: the expected session and source observation captured before the read, and the actual reader origin captured from
the same prepared request and credential as the native read. It also carries a caller/route binding. The envelope has no
bearer, token, raw CSRF or authentication seal. The browser validates that the actual origin matches the server's
expected reader, then compares its current signed-in subject and SHA-256 CSRF fingerprint with that origin. Once
adopted, it observes the browser QueryClient's own monotonic source generation and page-query object.

The server's revision and the browser's revision belong to independent QueryClients and are never compared. A matching
current subject/fingerprint establishes which reader produced the serialized result and that the current reader has the
same identity; it does not claim to reconstruct an unobserved account or credential history between caches. Changes
observed after browser adoption, including same-account credential replacement and observed batched away/back changes,
retire the page monotonically. If the actual origin or current identity is missing or mismatched, the browser withholds
the serialized private list and requires a fresh route read.
