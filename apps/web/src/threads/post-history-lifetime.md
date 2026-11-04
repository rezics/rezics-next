# Immutable history reading lifetime

## Native page admission

The installed KernelClient now declares the closed `page` context alongside `revisions` and `next` through supported
shared publication. The consumer retains its original `NativeHistoryPage['page']` binding and existing transport;
service schemas and constructed fixtures alone cannot admit current-context disclosure.

The loader derives both revisions and the closed `page` context from the installed Kernel client. One native
GET supplies the admitted conversation, Board, place, current head identity and current author presentation,
plus revision-keyed citations, question scales, subjects, mentions, media and navigation. Before projecting
any presentation, the consumer checks the requested post, shared conversation and Board, prepared viewer,
unique immutable revisions and the native maximum of 100 rows. Comparison destinations must name that page's
admitted head and a distinct available selected revision. Recorded citation identity and values must match
their exact revision. A malformed association admits no page.

Native context requires no identity, Subject, media or private-vote hydration. Legacy revisions/next recordings
retain the compatible bounded optional joins; those joins cannot invent current context or historical scales.
One replacing page owns every derived index, summary, selected document and comparison reader. Starting a page
request clears them synchronously; failure retries the exact failed cursor. An unavailable context owner uses
the delivered same-cursor retry, independently of whether there is another page.

Current names are presentation and never immutable authorship. Original Subject keys remain visible beside the
separate delivered terminal Subject identity. Concealed presentation and failed owner reads remain distinct.
failed Subject presentation retains every recorded target ID without displaying a terminal summary. An empty
recorded target list remains absent even when the Subject owner is unavailable.
An undisclosed citation is never labelled an unscored review. Zero, recorded question revision, delivered question
revision, scale and lifecycle are displayed as separate supplied facts. The consumer does not infer a past scale
from a current private vote.

Decision: exact destinations open a new tab; an admitted comparison opens the existing exact read-only reader
inside the selected inspector and returns selection and focus to its trigger without storing a cursor or credential.
The comparison reads only its explicit immutable destination and remains fenced by both the page lifetime and
its exact-reader provenance. It cannot read the current head endpoint or create command authority.

### Cost

For N returned revisions and K supplied related keys/references, the installed closed-page consumer's validation and projection
use O(N + K) work and
memory. Maps index scores by revision identity, comparisons by their from-revision, subjects by their original
key, identities by account key and images by media key. Documents are retained by reference and never copied
for summaries. Only the selected inspector mounts, and only an explicit comparison opens an exact destination.
No continuation accumulates earlier pages, rehydrates native enrichment or refills a sparse native page.
Installed declaration and factory delivery enable this path; O(N + K) at 1/20/100 rows remains a consumer source
bound until controller acceptance executes the original mounted variants. Source review and constructed envelopes
do not establish native execution or growth.

The native 20-row default, 100-row maximum, opaque cursor and unchanged retry/media/exact-reader assertions remain.
Native growth256/1024/4096, browser inspection and frozen integration acceptance are controller work.

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

Every page request is fenced before its queued call to `readPostHistory`, after its response, before replacement and on
failure/finally. A request owns one connection, cursor and read ticket; an obsolete callback cannot mutate the
current view or clear a successor's pending work. A page must match the visit's actual originating reader before
it can be admitted. A provenance mismatch clears the disclosure and offers a retry from the first page.

Layout cleanup invalidates the connection immediately. Same-visit Strict Mode replay can reconnect, while each
old callback and request keeps its former connection generation. A still-disconnected visit is permanently
retired in the next microtask. It does not automatically restart a read. A standalone caller without a QueryClient
can use its explicit `viewerId` as the expected reader for comparison; the server must still return that subject
from the prepared request before a session result is admitted.

Current readers retain the native limit of 20, opaque continuation and exact failed-cursor retry, including sparse
pages with a next cursor. Version links, document-before-provenance order, licence, byline and independent current
media disclosure use the existing renderers. Work grows only with explicitly requested pages and their bounded
related data.

Decision: requesting a new cursor retires the previous page immediately; failed and denied pages retry that
exact cursor, while account/provenance replacement starts a new visit.

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
original History, More and Retry controls request a bounded history page, with the original binding and failed cursor.

The navigation subtree is keyed by connection and page generation inside its already lifetime-keyed parent.
Retirement therefore clears the selected index, destination, inspector, pending focus and clipboard interaction
without matching an old account tuple. Local callbacks also check the live connection and page generation immediately before acting.
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

The selected inspector exposes the admitted revision ID and immutable author account ID separately from current
Byline presentation. One selected index and one destination value describe the entire inspection state. No expansion map or per-body
cache is created. At most one inspector mounts, using the original DocumentBody, media authorization and
RevisionProvenance composition, in document-before-provenance order. The complete admitted snapshot goes to the
installed renderer; the presentation does not trim documents or replace removed bodies. Removed revisions show
their admitted metadata, exact address and an explanation, with no body reconstructed from cached content.
Recorded ratings and differing own current votes remain distinct in the selected inspector.

## Focus and exact-address return

Decision: keep exact-address and copy links receipt-free in new tabs; the explicit same-tab action carries one
opaque tab-local receipt and re-admits only the current bounded history page before restoring its exact selection.

Every revision heading retains the canonical localized post/revision path and opens a separate tab with
`noopener noreferrer`. Copy uses the installed CopyDiscussionLink helper in copy-only mode. The selected inspector
also offers an explicit same-tab action. It creates one opaque receipt from that admitted page at activation and
navigates to the same immutable post/revision address with only the receipt token. The receipt stays in one
in-memory slot; it contains the safe thread route, post/revision identity, source generation, reader/page
generation and the native cursor needed to request that exact history slice. It grants no disclosure and carries
no body, author snapshot, session value or cursor in the exact URL.

The exact reader continues its fresh current read. A current receipt provides a direct return to the thread route
even while exact bytes are unavailable. Clicking it consumes a one-shot command and requests the recorded history
cursor through the existing native history reader. Only a successful response matching the same post and revision
restores selection; a withdrawn or missing revision offers a fresh first-page restart. Failed reads retry their
same cursor. Reloads, new tabs, stale account/source generations and changed routes have no active receipt and
show only the existing safely admitted thread fallback, when available. No cursor chain or browser storage is used.

Each row has a normal expand/collapse button. Up/Down and Home/End move focus between those buttons without
selecting or reading; Enter and Space use native button activation. The loaded-only select and explicit Inspect
button can reach any returned position, while Previous/Next stop at the ends of the loaded window. Inspector
collapse returns focus to its row only when focus was inside that inspector. It never steals focus from another
control. Each target has a 44px minimum and labels wrap at phone width.

Continuation clears the selected index, destination and full inspector before requesting the new page. The
original keyboard intent still focuses the first returned boundary (or an empty-page boundary), while pointer
activation retains its original focus behaviour. A live announcement describes the newly loaded page without
claiming accumulated additions. Retry preserves its exact address without reviving former summaries. Empty history, initial transport error, sparse continuation, failed continuation and terminal
history retain their original meanings; loaded counts never claim to be a total.

The compact author label is bounded, while the selected inspector retains the original full Byline disclosure
from the admitted identity. Explicit navigator inspection scrolls its focused row into view; continuation keeps
the owner's existing no-scroll focus handoff. A footer action returns focus to the loaded-only selector without
collapsing the document. Terminal pages explain the end of returned history while keeping ordinal scope local.
