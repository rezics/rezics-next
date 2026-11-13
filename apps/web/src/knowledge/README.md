# Private document lifecycle

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
