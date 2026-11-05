# Public Collection discovery

Decision: the public directory is `/collections` and appears in primary navigation for every visitor. It requests only Search's native `collection` kind and keeps Search's result order and continuation; each disclosed hit links to the existing `/collections/$id` route.

The localized route accepts an opaque `cursor` (up to 4,864 characters), optional presentation kind, canonical curator and Subject IDs, and recent/popular order. It requests `POST /v1/subjects:search` with `representation: 'discovery-v1'`, the sole Collection kind filter, the complete directory selection and a 24-hit page. It omits Search kind metadata and client sorting. A ready page contains only current native Collection summaries and the native `next` cursor.

Decision: retain only admitted cursor coordinates in a QueryClient-scoped directory visit, capped at eight predecessors plus current; bind it to locale and Search `as_of`, stage one target until its exact ready result, and retire it on route departure, source replacement or disposal. Previous and First replace one current 24-hit window; failed movement keeps its exact opaque target for deliberate Retry, and direct later URLs have no invented predecessor. First clears only cursor fields while preserving unrelated query bytes and the hash. No predecessor DTOs, extra query cache, storage, hidden history parameters, prefetch or page-chain replay are used. A native next cursor outside the route's 4,864-character bound is unavailable because it cannot form an admitted route address.

The existing Collection page remains the authority for whether a destination is readable. A discovery hit is not inferred from a follow edge and does not disclose members, owner-only facts, saved rules or private counts. Preparing, empty, denied, unavailable and stale/refused continuation states are localized; a failed continuation can be retried or restarted from the first page where its state permits.

The caller binds to Search's current `subjects.$search.post` method. Search admits the directory request only when Commerce's Collection owner registry advertises the exact indexed predicates and order; otherwise it returns `index_not_ready`. The page never substitutes text search, previews, client filtering or an unfiltered listing for missing native directory evidence.

## Directory selection address

Decision: the public address carries `presentationKind`, `curator`, `subject` and `order`
(`recent` or `popular`) in the public address. An omitted kind means all kinds; explicit `mixed` selects unset
presentation kind. Curator and Subject values are canonical identities, never mutable labels. A committed
selection starts at page one; continuation, restart and browser return preserve the complete selection. The native
request binds every selection value and order to the opaque cursor. The browser carries only the order name; native
recency units, nullability and follow-count authority remain Commerce facts.

The mounted form accepts an explicit presentation Type ID or `mixed`, curator UUID, Subject UUID and order. It
does not search display names or infer a Collection kind from its members. A not-ready Search/Commerce directory
contract is presented as preparing; the page never falls back to an unfiltered Collection result.
