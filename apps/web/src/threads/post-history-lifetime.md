# Immutable history reading lifetime

## Native page admission

The prepared `readPostHistory` server function delegates one explicit address to `loadPostHistoryPage`.
The loader derives its types directly from the installed KernelClient revisions GET. Before any dependent
identity, Subject, vote or media read, it checks the maximum 100 rows, requested post identity, shared thread
identity and unique revision identities. An inconsistent page is unavailable; none of its keys can start a
dependent read. It neither reorders rows nor repairs an inconsistent response.

Decision: keep the installed revisions/next loader behind a typed page seam until the native current-context
and exact-revision enrichment variants are published; do not fabricate optional browser fields.

The installed `RevisionPageResponseSchema` and generated revisions GET still contain only revisions and next.
They supply no admitted conversation/head context, author disclosure variant, historical question scale,
original/terminal Subject proof, per-revision enrichment source or navigation advice. Existing optional joins
and exact-reader media inspection remain in use. Their availability cannot establish those missing facts.
This seam is a partial implementation: the current-context visit, removal of redundant joins, one-page
replacement and comparison return still require the native publication and consumer continuation.

### Cost

- **Touches:** one revisions GET at default 20 with the prepared credential and exact opaque cursor. Admission
  scans N revision identities once before the existing bounded optional page helpers. No current-head read,
  cursor decoding, history walk or automatic retry supplies missing context.
- **Bound:** the schema admits at most 100 revisions, 128 Subject keys and 32 media keys per revision. Native
  document validation caps canonical bytes at 2 MiB per document: at most 40 MiB for 20 bodies and 200 MiB for
  100, before metadata and transport serialization. UTF-8 canonical bytes already include multibyte text;
  server-function escaping, parsed-object memory and the unpublished context/enrichment need separate bounds.
  The existing disclosure still accumulates explicit pages; this loader does not claim bounded retained memory.
- **Growth check:** supplied-client regressions consume 1/20/100 revisions with repeated maximum Subject/media
  keys, preserve historical zero and native order, and reject cross-address/duplicate/oversized pages before
  hydration. These checks do not establish producer scans, represented homes, currentness or native growth at
  256/1024/4096. Full envelope bytes, O(N+K) enrichment projection and one retained page remain required.

## Prepared reader and disclosure

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

## Loaded revision inspection

`HistoryDisclosure` remains the only history request owner. `RevisionHistoryNavigation` receives the admitted
window, page media, labels, subjects and author-private vote comparisons. It cannot call a read or enumerate
history. Selection, keyboard movement, collapse and exact-address copying perform no native calls. Only the
original History, More and Retry controls request a bounded page, with the original binding and failed cursor.

The navigation subtree is keyed by the disclosure's connection inside its already lifetime-keyed parent.
Retirement therefore clears the selected index, destination, inspector, pending focus and clipboard interaction
without matching an old account tuple. Local callbacks also check the live connection immediately before acting.
A retired callback cannot select or collapse a successor's body. Closing unmounts the inspector and its copy
helper but retains the selected loaded position; reopening uses the owner's admitted window without another
read. A native unavailable response clears that window and its navigation state.

The initial list is collapsed. It contains only actual returned revisions, in native order. Its ordinals mean
positions in **loaded history**, never global version numbers, a total, a gap count, or a claim that the first
row is current. Each row retains its original immutable address. Revision time uses the delivered `revisedAt`,
or explicitly labels the delivered `createdAt` as creation time when there is no revision time. No timestamp
is minted from an identifier.

Summary projection is one pass over the supplied array and allocates one small record per row. It never accesses
or copies a body. Author labels are bounded to 120 code points and licence labels to 80, together below the
240-code-point metadata budget. Iteration stops at the bound without materializing a long string as an array.
Deleted authors follow the existing Byline disclosure and do not reveal retained names or handles. Missing
identity batches remain unknown; selecting a row cannot fetch an author. Counts and provenance presence use
only admitted metadata, without comparing neighbouring revisions or deriving an edit explanation.
Removed and unavailable rows use only their originating page's author disclosure, retained by the history
owner beside that entry. A merged identity batch from another page cannot fill in a missing author.

One selected index and one destination value describe the entire inspection state. No expansion map or per-body
cache is created. At most one inspector mounts, using the original DocumentBody, media authorization and
RevisionProvenance composition, in document-before-provenance order. The complete admitted snapshot goes to the
installed renderer; the presentation does not trim documents or replace removed bodies. Removed revisions show
their admitted metadata, exact address and an explanation, with no body reconstructed from cached content.
Recorded ratings and differing own current votes remain distinct in the selected inspector.

## Focus and exact-address return

Decision: start with collapsed rows and open immutable destinations in a new tab, retaining this tab's admitted
history, selected revision, focus and scroll position without navigation storage or a return URL.

Every exact link retains the canonical localized post/revision path, and deliberately opens a separate tab with
`noopener noreferrer`. The reader returns by closing that tab or switching to the original tab. The exact
reader's existing return-to-thread link and authorization rules remain unchanged. No private text, author name,
credential or cursor is added to an exact address. Copy uses the installed CopyDiscussionLink helper in copy-only
mode because the row already supplies the explicit new-tab link. Its failed-copy field remains selectable; it
contains only the canonical path resolved against the current origin.

Each row has a normal expand/collapse button. Up/Down and Home/End move focus between those buttons without
selecting or reading; Enter and Space use native button activation. The loaded-only select and explicit Inspect
button can reach any returned position, while Previous/Next stop at the ends of the loaded window. Inspector
collapse returns focus to its row only when focus was inside that inspector. It never steals focus from another
control. Each target has a 44px minimum and labels wrap at phone width.

Continuation retains the selected index and destination. The original keyboard intent still focuses the first
returned boundary (or an empty-page boundary), while pointer activation retains its original focus behaviour.
An additional live announcement counts only returned additions. Retry does not discard readable summaries or
move the inspector. Empty history, initial transport error, sparse continuation, failed continuation and terminal
history retain their original meanings; loaded counts never claim to be a total.

The compact author label is bounded, while the selected inspector retains the original full Byline disclosure
from the admitted identity. Explicit navigator inspection scrolls its focused row into view; continuation keeps
the owner's existing no-scroll focus handoff. A footer action returns focus to the loaded-only selector without
collapsing the document. Terminal pages explain the end of returned history while keeping ordinal scope local.
