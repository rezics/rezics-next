# Immutable history reading lifetime

`ThreadReadingPost` still supplies the original post, viewer and `readAuthority` to `PostHistory`.
The default disclosure observes its existing `QueryClientContext` session cache directly. It does not depend
on the route rendering a different authority object: each successful session-cache replacement, cache removal
or addition, and state/subject/CSRF transition advances a synchronous revision. This includes same-account
replacement and an away/back pair inside a React batch. An identical successful cache write also conservatively
starts a fresh reading lifetime, even when QueryClient structural sharing retains the old data object.
Fetch/status/observer notifications alone do not retire history. One read-only observation per QueryClient
serves these disclosures; it starts no query, polling, transport or identity survey.

The original post, viewer, authority object, session source and source revision identify one visit. A replacement
retires that visit irreversibly and presents a fresh collapsed control. Returning the original tuple cannot
restore its documents, media, bylines, mentions, subjects, provenance, author-vote comparisons or cursor.
All of that data belongs to the visit's store and is cleared together with its pending guard on retirement
or layout disconnection. A retained callback checks its original visit and connection before changing state.

Layout cleanup invalidates the connection immediately. Same-visit Strict Mode effect replay can reconnect,
but every old callback and pending request retains its former connection generation. A still-disconnected
visit is permanently retired in the next microtask. Reconnection clears prior disclosure; an expanded visit
shows unavailable and offers an explicit retry from the beginning. It does not automatically restart a read.
Each request also owns a distinct read ticket. The ticket is checked at the queued call to `readPostHistory`,
after its await, and on unavailable, rejection and finally paths. An obsolete finally cannot release a
successor's pending guard. Cancellation is not used as proof of ownership.

A real browser cache must be ready. Signed-in admission requires its subject and a nonempty CSRF token, and
any supplied viewer must match that subject. Unknown, preparing, unavailable, missing-token and mismatched
sessions show unavailable/retry without calling the history reader. A signed-out cache admits an anonymous
viewer without CSRF. Prepared standalone fixtures without a QueryClient keep the existing optional props
and explicit read behavior. An isolated anonymous QueryClient seeded with signed-out state works unchanged.
Readiness grants no native permission and reconstructs no credentials: the sole existing `readPostHistory`
validator, generated client and native request still decide disclosure from the real request session.

Current readers retain the same explicit native limit of 20, opaque continuation and exact failed-cursor
retry, including sparse empty pages with a next cursor. Duplicate requests are suppressed per visit and
connection. Version links, document-before-provenance order, licence, byline and current independent media
disclosure use the existing renderers. Work grows only with explicitly requested pages and their bounded
related data; session observation and caller guards add no native reads.

The existing [composition acceptance](../../tests/post-history-recovery.test.ts) retains its assertions and
adds real QueryClient session replacements, queued and retained callbacks, disclosure retirement, stale
settlement/finally ownership, anonymous and signed-in recovery, and effect reconnect coverage. It continues
through the default component, original reader/validator, generated client and controlled native transport.
Browser/native acceptance, Storybook, growth and integration regression verification remain separate
integration obligations; workspace typing does not establish those outcomes. Routes, shared session producers,
native authorization and shared document/media rendering are outside this binding's implementation scope.
