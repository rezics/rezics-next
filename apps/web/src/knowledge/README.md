# Private document lifecycle

The private document URL reads native lifecycle metadata before opening the existing editor. The signed-in viewer
supplies the account coordinate; a document ID supplies neither ownership nor publication authority. Lifecycle
metadata, command reviews and credentials belong to one session/exposure/address/locale visit and are never cached
in browser storage or a shared query.

Decision: require saved edits and explicit confirmation for leaf-document trash, retain exact uncertain commands,
and reread native lifecycle and the private document before reopening editing after restore.

The native [routes](../../../../services/kernel/src/content/knowledge-routes.ts),
[schemas](../../../../services/kernel/src/content/knowledge-schemas.ts) and installed generated
[client declaration](../../../../packages/client/src/kernel/content/knowledge-routes.d.ts) own the request contract.
Lifecycle mutations compare both the observed notebook structure revision and lifecycle generation. They reuse the
private editor's session-bound encrypted credential, CSRF header and native idempotency key. Retrying an uncertain
operation preserves the complete reviewed intent, including its original key and credential. A definite conflict
discards that intent and rereads the lifecycle before another review. Permission or session loss retires the visit.

The native command decides leaf eligibility. `complete: false` with `subtree_work_required` is displayed as no
completed change. This route does not traverse or mutate a subtree and does not provide a trash inventory.

Trashed documents render metadata and their native restore deadline at the same private URL, without the title,
body, history, transfer or publication controls. Expired windows disable new restore reviews; a late request can
still receive the native not-found response. Exact retries remain possible after local expiry because only native
authorization and retention determine whether an earlier receipt can be recovered. Restore never implies a
publication selection. The private head is reread before editing resumes; returning to the notebook rereads its
outline with the existing navigation flow.

Unsaved edits and other pending authoring operations prevent lifecycle review. Confirmation locks editing and
other mutations. Pending or uncertain lifecycle commands join the existing departure protection; cancelling an
unsubmitted review does not discard a draft.

Focused lifecycle wire and mounted acceptance tests cover reload, restore readback, unsaved edits, exact retries,
subtree refusal, conflicts, expiry and visit retirement. Browser and native acceptance belong to the dev verifier.
