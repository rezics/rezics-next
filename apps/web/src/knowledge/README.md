# Knowledge interface

The document workspace composes the existing private editor, native outline reader, revision comparison
and saved-head publication controls. Browsing is explicit and independent of the writing body. One outline page
retains native order and at most twenty rows; it never hydrates sibling bodies or infers a child count. A denied
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
