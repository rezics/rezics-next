# Board page caller lifetime

The Board detail loader owns one caller visit from before its existing `boardPageQuery` read through route rendering.
The visit captures the QueryClient, Board id, cursor, sort, locale, credential mode and the exact session cache source,
revision and tuple. A private read also gets a visit-specific query key, so a later visit cannot reuse its cached result.

The query wrapper checks the visit before the read starts and after it settles. The loader checks it again before
registering thread slugs and before returning route data. The mounted host checks the same result binding before it
mounts `BoardCommunity` and the existing participation, start-thread and menu controllers. Session cache replacement,
route or locale movement, an aborted load, a retained retry from an old connection or a real unmount permanently retires
that visit. Retirement removes its private query cache entry. StrictMode's synchronous effect replay can reconnect the
same visit; a real unmount cannot.

Only an anonymous server result can cross into browser hydration without its server-side visit object. Its receipt also
binds the original route inputs and can be consumed once. A missing private receipt stays undisclosed until a fresh
route load. The Board read still receives only the existing id, cursor, sort and credential mode; session credentials
remain in the existing session/server boundary.

The route keeps its search validation, loader dependencies, `boardPageQuery` signature, native result, slug loop,
indexability calculation, head metadata, pending state and shared renderer. The caller governs admission around those
existing surfaces; it does not change thread detail, slug, personal, community, or participation behavior.
