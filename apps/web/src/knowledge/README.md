# Knowledge interface

The document workspace composes the existing private editor, native outline reader, revision comparison
and saved-head publication controls. Browsing is explicit and independent of the writing body. Each explicit outline request
reads at most twenty native rows; browsing retains only revealed placements and never hydrates sibling bodies or infers a child count. A denied
outline affects that reading while the editor retains its independently admitted document and local draft.

Routine identity and revision metadata use labelled details. Reviewed destructive operands and uncertain-command
warnings remain visible at their action. Shared controls keep keyboard focus, wrapping labels and touch targets
consistent across the eight launch locales. The private document title and body lead the page; comparison and
publication keep their saved-source identity distinct from unsaved writing.

Publication reading links retain one ephemeral return coordinate in the current QueryClient lifetime. Ordinary
clicks use the installed public route; modified clicks carry no private origin. Session or exposure replacement,
locale change and departure to unrelated routes clear the coordinate. The return never enters a URL parameter,
query result, persistent storage or SSR. Returning opens the original private route and requires fresh admission;
it supplies neither public permission nor a saved draft. A direct notebook return reads the installed notebook route.
A link callback captured before session/exposure retirement cannot reinstall the old return coordinate. Existing
notebook-frontier return semantics stay separate.

The routed `knowledge-workspace.stories.tsx` examples provide a three-document notebook, a long scene study, public
reading and independent outline/history recovery. Notebook, Writing, LongDocument and PublicReading are manual
review entries. PublicationReturn and IndependentRecovery pin the new navigation outcomes for the later verifier.
Existing History and Publication examples retain saved comparison, local draft review, explicit confirmation and
original command replay. The reader fixture now contains a long body. The private-story interactions open details
before asserting exact identities; the asserted identity values are unchanged. These are contract-shaped examples,
not native recordings or a new publisher.

Sources read before this composition: [the product owner](../../../../docs/knowledge-workspaces.md),
`private-page.tsx`, `navigation-page.tsx`, `page.tsx`, `history-panel.tsx`, `publication-panel.tsx`, their native
operation types, source-lifetime callers and existing routed stories, plus the read-only main reference index.
Installed Impeccable documents were absent from the permitted skill and reference directories; no launcher or
installation is required for this source composition.

Remaining API limits: exact private heads and outline pages do not supply a notebook title or unvisited ancestor
labels. The interface uses document identity and visited breadcrumbs rather than inventing those labels. The
private publication observation supplies a publication identity, not the selected public revision body; exact
reading links therefore follow the existing acknowledged selection receipt. Each public read admits its result
independently. Native authorization and all command contracts remain with their existing owners.

This frontend source-only window defers typing, tests, builds, browser, visual and native acceptance to the dev
verifier. Formatting source is independent of those acceptance claims.

## Revision history navigation

Decision: keep one replacing metadata page, exact left/right revision IDs and a bounded window of successful
request coordinates; reserve the twenty opaque-cursor slots for previous requests, the current request and native
continuation. At the retained edge, Previous stops and explicit Restart reads the first page. Keyboard navigation
alone requests focus, and unrelated movement cancels that request. The parent editor retains its draft and uncertain
save intent throughout history actions.

Each explicit traversal or Retry performs one read through `history.ts`. Previous rereads the last retained request
cursor; More uses the admitted native continuation, including on sparse pages. Only a successful read commits its
coordinates. Failure conceals the former page and retains the exact attempted request for Retry; stale history
requires explicit Restart. Oldest previous coordinates are dropped to keep at most twenty prior entries and twenty
opaque cursors in total, each with the existing 4096-character admission cap. No previous page bodies are cached.

Comparison reads one oriented exact pair, including selections made on different pages. Back restores the supplying
page and its selections without another read. Return to draft and retirement discard pages, comparisons, selections,
coordinates and deferred focus. Current native status, credentials, exposure and locale remain authoritative; late
results cannot redisclose a retired page or move focus. Pointer actions do not request focus. Keyboard requests are
cancelled by pointer use, focus movement, unrelated keys, departure or a superseding action, and land on the visibly
focused heading or returning control only while their action remains current.

Design sources: `history-panel.tsx`, `history.ts`, the editor caller in `private-page.tsx`, this owner document,
existing `knowledge-history` tests/harness/stories, the private history contract in
[Knowledge workspaces](../../../../docs/knowledge-workspaces.md#native-first-loop-contract), and the read-only main
reference index. Source fixtures cover bounded previous/next, sparse continuation, failed exact retry, comparison
return and deliberate focus. Test execution, typing, builds, native acceptance and keyboard/phone/desktop browser
acceptance remain unverified until the separate integration verifier runs them; the single publisher owns publication.
Existing focus-return assertions use keyboard activation; pointer actions assert no requested heading focus. The
exact-pair fixture spans pages and retries the same operands while retaining its draft and original-save assertions.

## Private document lifecycle

The private document URL reads native lifecycle metadata before opening the existing editor. The signed-in viewer
supplies the account coordinate; a document ID supplies neither ownership nor publication authority. Lifecycle
metadata, command reviews and credentials belong to one session/exposure/address/locale visit and are never cached
in browser storage or a shared query.

Decision: require saved edits and explicit confirmation for subtree trash and restore; show durable native counts
with explicit refresh, retain exact uncertain commands, and reopen editing only after fresh active lifecycle and
private document reads. Mounted/native/browser acceptance is deferred to the dev verifier.

The native [lifecycle owner](../../../../services/kernel/src/content/README.md#trash-and-restore-lifecycle),
[implementation](../../../../services/kernel/src/content/knowledge-lifecycle.ts), installed generated
[client declaration](../../../../packages/client/src/kernel/content/knowledge-routes.d.ts) and
[access and lifecycle contract](../../../../docs/knowledge-workspaces.md#access-and-lifecycle) were read before this
adapter design. The native [routes](../../../../services/kernel/src/content/knowledge-routes.ts) and
[schemas](../../../../services/kernel/src/content/knowledge-schemas.ts) own the HTTP contract.

Lifecycle mutations compare both the observed notebook structure revision and lifecycle generation. They reuse the
private editor's session-bound encrypted credential, CSRF header and native idempotency key. Retrying an uncertain
operation preserves the complete reviewed intent, including its original key and credential. A definite conflict
discards that intent and rereads the lifecycle before another review. Permission or session loss retires the visit.
The lifecycle controls use the shared Web operation-admission hook with the exact native lifecycle, trash and
restore operation names. Its viewer-bound exposure query preserves independent decisions and fails closed for
unknown, denied and unavailable outcomes; native authorization remains authoritative.

Trash conceals the selected document and its primary descendants. Leaf restore can finish synchronously; subtree
restore can acknowledge `complete: false` with reason `restoring`. Native lifecycle state remains `trashed` with
non-null `restoreProgress` until the durable traversal finishes. The adapter admits `processedDocuments` and
`pendingPlacements` as canonical nonnegative decimal strings and displays them without number conversion. These are
counts of work already processed and placements still pending, not a total or percentage. Missing/malformed counts
or progress on an active response are invalid HTTP input: reads become unavailable and mutation outcomes uncertain.

Decision: each mounted lifecycle effect generation owns its reads, commands, completion flags and retained review.
Address, viewer, CSRF/session credential observation, operations or read-admission replacement immediately hides the
former metadata and intent and starts a fresh read. The parent session/exposure/locale owner still retires its
mounted editor. Late former completions cannot release a current read or command, retire the current visit, or
reopen editing. A former unresolved command remains unknown for its original document and is never retried against
the replacement; exact retries are retained only within the same live visit. Focused controller fixtures cover late
completion, replacement reads, current refresh and review/credential retirement; existing acceptance stays intact.

Reload reads the same owner metadata and recovers progress without submitting a command. The progress panel has an
explicit refresh control; neither it nor the controller starts polling, performs background writes, traverses a
subtree or starts another restore while progress exists. Acknowledged commands reread lifecycle once through the
existing flow. Receipts never optimistically open the editor; failed refreshes keep it closed. The route does not
provide a trash inventory.

Trashed and restoring documents render metadata and their native restore deadline at the same private URL, without
the title, body, history, transfer or publication controls. Expired windows disable new restore reviews; a late
request can still receive the native not-found response. Exact retries remain possible after local expiry because
only native authorization and retention determine whether an earlier receipt can be recovered. Restore never
implies a publication selection. After a fresh active lifecycle read, the existing editor reads the private head
again before exposing editing; returning to the notebook rereads its outline with the existing navigation flow.

Unsaved edits and other pending authoring operations prevent lifecycle review. Confirmation locks editing and
other mutations. Pending or uncertain lifecycle commands join the existing departure protection; cancelling an
unsubmitted review does not discard a draft. Refresh cannot interrupt a reviewed or unresolved command.

Focused lifecycle wire and mounted acceptance tests cover subtree trash, reload with durable progress, explicit
refresh, large decimal counts, fresh-head reopening without republication, unsaved edits, exact retries, conflicts,
expiry and visit retirement. The former subtree-refusal assertions now follow the durable restore contract; other
assertions remain. The boundary fixture includes native `restoreProgress: null`. Tests run after landing in the dev
verifier, including mounted/native/browser acceptance for reload, busy subtrees and no republishing.

## First-public mounted journey

Decision: one native mounted witness pins the complete private-to-public Knowledge loop through the existing pages
and installed APIs. Content native first-loop and the focused private, publication and transfer tests remain the
source owners. The fixture is `apps/web/tests/native/knowledge-journey.host.test.ts`. Invoke it after integration
with `bun apps/web/scripts/check.ts --host tests/native/knowledge-journey.host.test.ts`. Native/browser execution
stays with the Goal verification lane.

## Notebook navigation orientation

Decision: only a focused keyboard page action or deliberate keyboard document return requests orientation;
pointer actions and ordinary observations preserve the reader's focus. One ephemeral request is cancelled by
focus movement, pointer use, another key, window departure, a superseding request or owner replacement. Embedded
navigation leaves orientation to its caller. More and Retry may orient their own branch result or failure boundary; disclosure retains focus on its expanded control;
no focus request starts a read. The organization-enabled notebook caller shares this ownership while its
commands, history and native producer keep their existing state contracts. Native page order, sparse continuation, exact-cursor Retry and explicit first-page
Restart retain their existing contracts and twenty-row bound.

Sources read before design: this owner document, `navigation-page.tsx`, `navigation.ts`, `navigation-model.ts`,
`navigation-return.ts`, `navigation-return-link.tsx`, the mounted `knowledge-navigation.test.tsx` and existing
navigation stories, the writer/reader and organization contracts in [Knowledge workspaces](../../../../docs/knowledge-workspaces.md),
and the read-only main reference index. The separate history/comparison journey retains its own focus ownership.
Source review covers every request, arrival and cancellation; execution of mounted regressions, typing, builds,
native document return, and phone/desktop keyboard and visual acceptance belongs to the integration verifier.

A deliberate return consumes the existing one-slot frontier and selected document once, then makes the existing
fresh native observation. A matching current result restores the selected document link; a missing selection or a
failed/changed reading orients its boundary only while the keyboard request still owns focus. Pointer return restores
the position and selection without orientation. Expired or changed coordinates keep explicit Restart; return stores
no page rows, body, DOM target or private data in persistent storage. StrictMode reattachment preserves the same live
request, while actual unmount and reader, locale, source, selected target or embedding replacement cancel it.

The mounted source now exercises plain and organization-enabled outlines, embedded ownership, initial/pointer
non-interference, keyboard success/failure/exact Retry, focus/pointer/key/window cancellation, selection replacement,
document return with fresh admission, missing returned selections and retired late results. The existing wire
return assertion now includes its selected document identity; the frontier, expiry and identity assertions remain.
KeyboardCompletion and KeyboardRetry stories use the actual entry component with illustrative native DTOs admitted
through the existing adapter; they are not native acceptance recordings. The extra changed paths are the shared
`navigation-focus.ts`, existing return seam/link, organization caller, and wire return test.

## In-place notebook outline

Decision: all `KnowledgeNavigationEntry` outline readers share an in-place nested outline with independent
parent-placement pages, More and exact failed-cursor Retry; the private editor declares that outline through
[Shell contextual navigation](../shell/README.md#current-workspace-navigation), retaining one central draft canvas.
Organization commands and structure history remain an explicitly opened secondary panel with their existing
bounded destination reader and immutable command intents. The owned-notebook directory remains replacing.

This migrates routed notebook reading, plain and organization-enabled entries, embedded private editing and their
workspace stories. Knowledge owns native outline and document-return coordinates. Shell owns placement and responsive
hosting; [Book reading](../books/reader/README.md) owns its in-place reading convention and transport. Neither Book
transport nor its occurrence state is imported here. No route-navigation outline consumer remains to migrate;
organization destination selection and explicit historical/compare readers are independent secondary journeys.

A branch keeps supplied order and native placement identity, including repeated document IDs. Expand reads only
that placement's first page. More appends only its parent's supplied page, including sparse continuation; an
unavailable read retains revealed siblings and its exact attempted cursor. Collapse retains revealed state and
reopen makes no duplicate read. A pending explicit read may finish while collapsed, without moving focus. Storage
is O(revealed rows), with no prefetch, refill, body read or reconstructed whole notebook. Structure replacement
conceals the outline and requires explicit Restart; permission or lifetime retirement removes all branches.
Document return stores one supplying frontier, selected document and placement, never rows, and freshly admits that page. A missing returned placement falls back to the branch boundary for deliberate keyboard return. An acknowledged move or definite structure conflict conceals the browsing outline until explicit Restart, without altering the command intent or starting another read.
Disclosure, continuation and retry do not replace or remount the editor; document links retain its existing dirty
and uncertain-command departure protection. Account, credential, exposure, locale and source replacement retire
all old branch callbacks and pending responses.

Sources read before design: `workspace-navigation.tsx`, `private-page.tsx`, `navigation-page.tsx`, this README,
`navigation-read.ts`, `navigation-model.ts`, return/focus seams and their tests, the installed private outline DTO in
`packages/client/src/kernel/content/knowledge-routes.d.ts`, the organization consumer/model, Shell's installed
contextual-navigation seam and pattern, Book reader's owner document and the main checkout's read-only reference
index. `navigation-reading.ts` is introduced by this migration; it was absent on the base.

Authored interactions cover independent branches, sparse More, exact retry, collapse/reopen, selected return,
retirement and one-canvas private editing. Source-only delivery leaves compiler, tests, build, native, mounted
phone/desktop/keyboard and eight-locale acceptance unverified for the separate verifier.

Changed acceptance source: `knowledge-navigation.test.tsx` now asserts retained parent/sibling rows, per-branch
continuation and disclosure focus instead of replacing child frontiers; exact operands and retirement assertions
remain. `knowledge-private.test.tsx` adds the shell-hosted draft and dirty-departure case through an optional host in
`knowledge-history-harness.tsx`. Existing organization tests/stories explicitly open their secondary command panel;
their command assertions stay intact. The navigation KeyboardCompletion story retains disclosure focus, and continued
story rows use distinct native placements. Workspace NestedOutline and IndependentRecovery use the installed shell.
Other changed paths: `docs/knowledge-workspaces.md` points the superseded outline UI contract here; the optional
private test host and existing navigation/organization story/test fixtures are supporting consumer migrations.
