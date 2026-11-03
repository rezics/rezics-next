# Public Collection discovery

Decision: the public directory is `/collections` and appears in primary navigation for every visitor. It requests only Search's native `collection` kind and keeps Search's result order and continuation; each disclosed hit links to the existing `/collections/$id` route.

The localized route accepts one opaque `cursor` query value (up to 4,864 characters) and requests `POST /v1/subjects:search` with `representation: 'discovery-v1'`, the existing kind filter, descriptions and a 24-hit native page. It omits Search kind counts and exposes no query, predicates, facets, account enumeration, membership reads, follows or client sorting. A ready page contains only native Collection summaries and the native `next` cursor.

The existing Collection page remains the authority for whether a destination is readable. A discovery hit is not inferred from a follow edge and does not disclose members, owner-only facts, saved rules or private counts. Preparing, empty, denied, unavailable and stale/refused continuation states are localized; a failed continuation can be retried or restarted from the first page where its state permits.

The caller binds to Search's current `subjects.$search.post` method. Search's current native mixed-discovery runtime still needs its production `semantic/public-filter-source.ts` and `search/public-filter-consumer.ts` providers; without them it returns `index_not_ready`. Commerce's documented remaining public dynamic-Collection boundary is the complete explicit Publication provider; Commerce also owns emitting public Collection summaries for Search indexing. This route does not fabricate successful rows while either boundary is unavailable.
