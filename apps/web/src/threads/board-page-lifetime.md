# Board page caller lifetime

The Board detail loader owns one caller visit from before its existing `boardPageQuery` read through route rendering.
The visit captures the QueryClient, Board id, cursor, sort, locale, credential mode and the exact session cache source,
revision and tuple. Private reads use a visit-specific query key; the public anonymous key remains shared.

The query wrapper checks the captured route, session, abort state and the exact query object before the original read.
Once the original envelope returns, it compares the actual reader origin with the immutable expected reader and
rechecks the same source generation and query owner before returning the envelope to TanStack Query. A mismatch or
unavailable origin therefore cannot become a QueryClient success. `resultFor` accepts the same envelope only while that
exact query still owns it. The route awaits this acceptance before remembering any canonical thread slugs, then checks
the caller around the existing slug loop and before returning loader data.

Native `400 invalid_cursor` (expired, foreign, or pin-revision ABA) is a restart of this board/sort with no cursor,
not a denied or unavailable read and not a malformed query. Malformed search recovery stays with route validation.
Board, sort, viewer or reading replacement retires the old cohort, frontier and private query.

The mounted host binds the result to its current QueryClient and route inputs before it mounts `BoardCommunity` and the
existing participation, start-thread and menu controllers. A successful session-query replacement (even with equal
data), session-query error/removal, route or locale movement, an aborted load, a retained retry from an old connection,
a replaced owned page-query result or a real unmount permanently retires that visit. Fetch-state and observer
notifications do not retire it. Retirement removes only the exact private query object owned by that caller. StrictMode
effect replay can reconnect the same visit; a real unmount cannot. An asynchronous transferred-result verification is
bound to its exact result, receipt and mounted connection, so an earlier connection cannot unlock a later one.

Thread navigation captures only a bounded same-origin board/sort/continuation return descriptor in history state
(cursor capped at 32,768 characters; larger frontiers restart without a cursor). Private titles, credentials and
moderation content never enter URLs. A missing or foreign descriptor falls back to the existing board crumb. Returning
loads the current native reading for that board/sort/continuation, or the explicit restart if the cursor is obsolete.
Watch remains the existing thread toggle. After a pin or slow-mode command, the board reading is reconciled without
repeating the command.

The original Board read returns its actual reader origin beside the unchanged native page. A session origin contains
only the subject and a SHA-256 CSRF fingerprint captured from the same prepared request and credential passed to the
native read; an unavailable subject stays unavailable. The loader receipt also carries the expected reader and the
original QueryClient observation. It contains no bearer, token, raw CSRF or authentication seal. An independent browser
cache adopts a private result only after its current signed-in subject and CSRF fingerprint match that actual origin.
This is an identity comparison for the original read, not proof of unobserved events between two QueryClients.
Anonymous transfers remain anonymous and bind the original route inputs. A missing or mismatched origin stays
undisclosed until a fresh route load.

The private transfer-pending branch that renders before browser hydration remains an explicit reserved contract. Its
post-mount verification does not prove the first render safe, and this lifetime does not establish a `renderToString` or
`hydrateRoot` first-paint guarantee. No synchronous shared hydration/session producer is installed here. The known
independent-cache and unobserved-ABA limitation remains.

One selected page retains the active pinned cohort (P<=5) and ordinary page (L=20, Content's default), disclosed author
IDs (A<=P+L, batched at 100), the opaque cursor and the return descriptor. It does not retain historical pages.
Existing preview processing stays inside its 128-node / 280-character window. Native row/document byte bounds remain
Content-owned.

The source boundary is the Board loader's existing original-result acceptance, assertion and canonical slug ordering;
the caller's admission, verification and result-effect lifetimes; this document; and the connected regression files.
Query/read implementations, route validators and dependencies, head and pending metadata, renderer composition,
and native request shape remain owned by their existing contracts. No additional authentication read, preflight,
polling, per-row hydration or native request is introduced.
