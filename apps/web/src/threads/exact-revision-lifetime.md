# Exact revision caller lifetime

The route loader captures a visit from its original QueryClient before starting the existing exact read. The visit
binds the post, immutable revision, locale, credential mode and the session cache source/revision/tuple. Only that
visit can publish the returned page or expose the edition creation entry.

The caller observes the existing `['session']` cache without starting a query, transport or poll. A successful
signed-in cache replacement or removal advances its authority revision synchronously, including a same-account
credential or readiness replacement and an away/back change inside one React batch. Anonymous reads stay current
while the cache remains anonymous; the first signed-out session preparation is the same public read authority as
the route's original unknown state. A session-mode result requires the exact original signed-in cache revision and
tuple. Hydration can attach a serialized visit to its browser QueryClient only when the original cache markers still
match; a first signed-out preparation is the sole public exception.

Target, locale and credential-mode changes retire the old visit. Unmount invalidates its connection in the next
microtask, allowing React StrictMode's same-turn effect replay to reconnect while making a real remount with the
old loader result inert. Retained retry callbacks check the visit, route target, cache authority and mounted
connection immediately before invalidating the route. A late result is reduced to loading if its original authority
changed while the existing read was pending. A new loader visit or retry captures current authority explicitly.

The page keeps the native exact-revision states and existing loader/read contract. The reader and edition entry
remain unchanged; stale visits render only the loading state and cannot expose the document, media, author,
provenance, thread backlink or edition entry.
