# Exact revision reader lifetime

The route loader captures the original post, immutable revision, locale and credential mode together with a
read-only session-cache observation before the existing exact read starts. That serializable binding travels to
the exact server wrapper and returns with the result. It records an expected reader for comparison, the original
observation generation, the request generation and a distinct response generation. It contains no bearer, access
token or raw CSRF value.

The server wrapper prepares the request once, uses that same prepared request credential for the unchanged native
read and derives actual credential mode and subject from that request. Expected route identity never supplies or
fills missing actual provenance. A prepared anonymous fallback remains anonymous. An incomplete or mismatched
session provenance cannot admit a private page. The native exact post and revision checks, current thread read,
status handling and bounded author, mention, vote and media enrichment remain the disclosure authority.

The exact reader is read-only. A healthy signed-in cache with a subject can read even when its CSRF token is
missing; the caller does not create a token or grant command authority. The independent Edition creation entry
keeps its existing eligibility and write guards.

One observer reads the existing `['session']` cache and starts no query, transport or poll. Each successful cache
replacement advances its synchronous generation, including equal-value replacement. Session error, removal,
account, credential or readiness change, unknown/sign-out transition and an observed away/back batch also retire
the owner. Fetching and observer notifications alone do not. Existing results, retained views and retry callbacks
are cleared or fenced before they can publish, retry, mount the Edition entry or affect a replacement visit.

An independent browser QueryClient adopts a serialized visit only when the session query preserves the same
serialized lineage and generation along with its observation. Matching only the final reader tuple is insufficient.
The sole
SSR exception is an actually anonymous route read from an unknown session observation followed by the first
signed-out browser preparation. Preparing a viewer retires that public visit and the route's existing
`sessionReread` refresh supplies the next read.

Target, revision, locale, credential mode, connection and final unmount retire the old owner. Strict Mode's
same-turn effect replay can reconnect a healthy visit; old connection generations remain inert. A current retry
captures a fresh binding and uses the existing route invalidation. Exact revision state, native request count,
history isolation and public fallback remain unchanged.
