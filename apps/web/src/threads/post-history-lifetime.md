# Immutable history reading lifetime

`ThreadReadingPost` still supplies the original post, viewer and `readAuthority` to `PostHistory`. The default
disclosure observes the existing `QueryClientContext` session cache directly. It starts no query, polling,
transport or identity survey. The route/caller binds each original post, cursor, locale, credential mode,
connection and read generation before calling the existing `readPostHistory` server function.

That serializable request binding contains the expected reader only for comparison and records the original cache
observation. The server prepares one request and derives its actual credential mode and subject from the same
prepared request that supplies the existing native credential. The returned response carries that actual reader
and its response generation. No bearer, access token, seal or raw CSRF token crosses the boundary. The original
native validator, generated client and request still decide what the reader can see.

A healthy signed-in cache with a subject may read history without a CSRF token; CSRF remains a write guard and
this caller creates no token or command authority. Signed-out readers stay anonymous. Unknown, preparing,
unavailable, errored, missing-subject and viewer-mismatched sessions show retry without borrowing credentials.
If a session-mode server request falls back anonymously, its result remains explicitly anonymous. An incomplete
or mismatched session reader cannot contribute private rows, votes or media.

Each successful session-cache replacement advances a synchronous generation even when the value is equal.
Removal, error, account/credential/readiness change, unknown/sign-out transition and observed away/back updates
also retire the existing visit. Fetch/status/observer notifications alone do not. An owner replacement clears
revision bodies, media, bylines, mentions, subjects, provenance, vote comparisons, pending guards and cursors.
Returning to the old account or tuple cannot revive them.

Server and browser caches share an owner only when QueryClient dehydration preserves the same session-query
lineage and generation. A matching account tuple alone cannot adopt old private disclosure.

Every page request is fenced before its queued call to `readPostHistory`, after its response, before merge and on
failure/finally. A request owns one connection, cursor and read ticket; an obsolete callback cannot mutate the
current view or clear a successor's pending work. A page must match the visit's actual originating reader before
it can merge. A provenance mismatch clears the disclosure and offers a retry from the first page.

Layout cleanup invalidates the connection immediately. Same-visit Strict Mode replay can reconnect, while each
old callback and request keeps its former connection generation. A still-disconnected visit is permanently
retired in the next microtask. It does not automatically restart a read. A standalone caller without a QueryClient
can use its explicit `viewerId` as the expected reader for comparison; the server must still return that subject
from the prepared request before a session result is admitted.

Current readers retain the native limit of 20, opaque continuation and exact failed-cursor retry, including sparse
pages with a next cursor. Version links, document-before-provenance order, licence, byline and independent current
media disclosure use the existing renderers. Work grows only with explicitly requested pages and their bounded
related data.

Transport failures on a continuation keep the admitted window and retry the exact cursor; native unavailable or denied responses clear it and restart from the first page.

The connected [composition regression](../../tests/historical-reader-compatibility.test.tsx) joins the actual
exact and history wrappers, cache admissions and callers through a real server-function serialization roundtrip
and a separate browser QueryClient. The existing [recovery suite](../../tests/post-history-recovery.test.ts)
retains its assertions and exercises the default component, validator, generated client and controlled native
transport. Browser/native acceptance, Storybook, growth and integration verification remain separate obligations;
workspace typing does not establish those outcomes.
