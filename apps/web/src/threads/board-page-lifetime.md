# Board page caller lifetime

The Board detail loader owns one caller visit from before its existing `boardPageQuery` read through route rendering.
The visit captures the QueryClient, Board id, cursor, sort, locale, credential mode and the exact session cache source,
revision and tuple. Its serializable observation identifies that originating QueryClient and its local generation; it is
never compared to a browser generation. A private read also gets a visit-specific query key, so a later visit cannot
reuse its cached result.

The query wrapper checks the visit before the read starts and after it settles. The loader checks it again before
registering thread slugs and before returning route data. The mounted host checks the same result binding before it
mounts `BoardCommunity` and the existing participation, start-thread and menu controllers. A successful session-query
replacement (even with equal data), session-query error/removal, route or locale movement, an aborted load, a retained
retry from an old connection, a replaced owned page-query result or a real unmount permanently retires that visit.
Fetch-state and observer notifications do not retire it. Retirement removes its private query cache entry. StrictMode's
synchronous effect replay can reconnect the same visit; a real unmount cannot.

The original Board read returns its actual reader origin beside the unchanged native page. A session origin contains
only the subject and a SHA-256 CSRF fingerprint captured from the same prepared request and credential passed to the
native read; an unavailable subject stays unavailable. The loader receipt also carries the expected reader and the
original QueryClient observation. It contains no bearer, token, raw CSRF or authentication seal. An independent browser
cache adopts a private result only after its current signed-in subject and CSRF fingerprint match that actual origin.
This is an identity comparison for the original read, not proof of unobserved events between two QueryClients. Anonymous
transfers remain anonymous and bind the original route inputs. A missing or mismatched origin stays undisclosed until a
fresh route load.

The route keeps its search validation, loader dependencies, `boardPageQuery` signature, native result, slug loop,
indexability calculation, head metadata, pending state and shared renderer. The caller governs admission around those
existing surfaces; it does not change thread detail, slug, personal, community, or participation behavior.
