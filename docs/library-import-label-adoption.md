# Reviewed VNDB private label adoption

The [VNDB producer](library-import-vndb.md) owns uploaded XML, retained typed rows, matching, source review,
state commands and source deletion. This separate consent adds only native private labels and assignments.
Ordinary upload, review and entry-state apply still create no labels. Web303 integrates these additional methods
into its existing provider journey; there is no additional importer page or cross-provider adapter.

Decision: admit at most eight selected source rows and eight explicit source-name mappings per consent; new names
must already equal the native normalized spelling, and one upload retains one consent until source removal/expiry.
A reviewed consent may be replaced before apply starts. Applying or cancelled consent is immutable. Its expiry is
the producer's 24-hour expiry, with at most four uploads/consents per owner. The owner can remove the source and
start another upload; adopted native effects survive source removal. No source privacy flag implies publication.

## Installed methods for Web303

All responses are private, no-store. The mounted `vndbLabelAdoptionRoutes` and exported
`createVndbLabelAdoption` return types are the receiving contract. Authentication, current active account,
`library_entry:read`, `library_entry:update` and personal Library exposure are required. First use the installed
producer page and `:review` to inspect and explicitly resolve each row. A retained-only source review can select
`{ordinal,action:'retain',targetId}` without changing an Entry. Source review IDs bind the selection below.

- `POST /v1/libraryImports/vndb/{uploadId}/labels:review` with quoted `Idempotency-Key` and
  `{rows:[{ordinal,reviewId}],mappings:[{source,target:{labelId,revision}}|{source,target:{name}}]}` creates the
  preview and returns `{previewId,total,expiresAt}`. Existing IDs must belong to the owner and be live at the
  selected revision. New names use native NFC, whitespace normalization, case-sensitive uniqueness, no controls
  or lone surrogates and at most 100 Unicode scalars; non-normalized spelling is rejected. A collision is refused,
  never converted into a selected existing label. Equal spellings on different retained identities do not merge.
- `GET /v1/libraryImports/vndb/{uploadId}/labels?after=-1` returns the consent, explicit mappings, original target
  revisions, creation proposals, admission/refusal reasons, item count, and at most eight items. `next` is the
  last item number when another page exists. Read each affected canonical Subject before confirmation; an item
  includes source ordinal/review ID and mapping index. Only explicitly selected producer rows participate.
- `POST /v1/libraryImports/vndb/{uploadId}/labels:apply` with `{previewId,items:[0,1]}` confirms at most eight
  displayed item numbers. No separate idempotency header is needed: the consent retains original native command
  keys and operands. Repeat the exact selection after an uncertain response. Results retain `applied`,
  `already_present`, `stale`, `unsupported` or `refused`; `result` includes the native label/assignment identities,
  a fixed reason, and whether the original operation can retry. A review item starts `ready`. An existing native
  assignment is shown before apply and confirmed through the native command at effect time.
- `POST /v1/libraryImports/vndb/{uploadId}/labels:cancel` with `{previewId}` and quoted `Idempotency-Key` stops
  subsequent dispatch. A request abort or five-second scheduling budget also stops new items; `stopped` distinguishes
  cancellation and deadline, and omitted items remain pending. Acknowledged effects persist. Source cancellation
  also fences native admission. Source DELETE removes this entire consent and its items through foreign-key cascade.

An unknown native response returns refused/native-unavailable with `retryable:true`, preserving original operands.
Known capacity refusal returns refused/assignment-capacity. Stale evidence requires a new source review and consent
before work starts, or a new upload after start. Old review receipts cannot reinstall superseded consent. New-label
creation and assignment are separate native commands: a newly created private label can remain empty if later
assignments are stale, full, refused or cancelled. A repeated creation acknowledgement returns its original native
identity even if that identity has since been retired; fresh assignments still reject its changed revision.

Only exact non-state names present in the installed VN row's `labels` can be selected. Playing, Finished, Stalled,
Dropped and Wishlist remain the producer's entry-state evidence. Metadata rows and unresolved/ambiguous/unavailable
identity cannot supply guessed assignments. Source review identity, immutable row digest, canonical Subject,
identity/type/profile fingerprint, owner, upload, target label ID/revision and original membership identity/revision
bind every fresh native admission. A membership edit after review returns stale, preserving the concurrent edit.
Two selected rows resolving to one Subject require choosing one row, avoiding duplicate canonical review authority.
Repeated source labels and multiple names mapped to the same target yield one intent per Subject/target. Unsupported
per-label attributes remain in exact private source evidence; only the name participates in adoption. No annotations,
sessions, copies, votes, Entry state or public output changes. Native label events contain IDs, never source text.

## Storage, lifecycle and cost

`vndb_label_adoption` has one owner/upload primary key. `vndb_label_adoption_item` has the owner/upload/item primary
key used by first, deep and terminal keyset pages; pages examine at most P+1=9 retained adoption rows. One consent
has at most 64 item rows, mappings occupy at most 16 KiB encoded JSONB, each operand at most 4 KiB, and each result
at most 1 KiB. Request choices also fit 16 KiB UTF-8 JSON; the HTTP wire bound is 32 KiB. These are static physical
admissions in addition to source bounds, not per-owner allowances widened for historical native labels.

The installed producer has no independent per-row retained-label count cap. Its XML bound gives the conservative
K <= floor(2 MiB / 8) for minimum `<label/>` elements; its retained JSONB is independently capped at 16 MiB.
Adoption selects M<=8 distinct source names, so at most R*min(K,M)<=64 assignment intents and M native creations
can occur. The native Subject slot limit remains 32. The installed label-create command has no owner-wide label
count quota; adoption adds no full live/deleted catalogue scan or substitute quota. Exact label-ID and live-name
index probes, and the existing native reservation/parent checks, retain their native cost and authority boundaries.

The bound is Cfixed-authority + Csource-review(R,K) + M*Cnative-label-create +
R*min(K,M)*Cnative-assignment + Cresult/cleanup. Source review includes exact upload lookup, bounded document
extraction/decompression, retained row hashing and R*M label membership comparisons, plus native source matching,
Subject/profile/Entry observations and final account checks. Each fresh native command repeats current source
admission and locks the addressed producer row; a projected row avoids transporting all historical decisions, but
PostgreSQL can decompress the bounded producer JSONB document. Charge those bytes/CPU on every such observation.
Creation uses one fixed reviewed operand per target, shared by duplicate mapping targets. Receipts preserve original
creation/assignment keys; result acknowledgements use native owner commands. Include their no-op, uncertain retry,
History, receipts, events, index maintenance and cleanup work in whole-caller comparisons.

Source DELETE, next-upload expiry pruning and the existing `vndb_import` terminal-erasure phase cascade through at
most one consent and 64 items per upload (four uploads per owner). No native label/assignment is a cascade child.
Their native erasure phases remain independent. Expired/deleted consent returns 404 and grants no read authority
from receipts. Cancellation uses the same source row lock as fresh effects. Final active-account checks clear read
authority at terminal account fences, including native receipt replay. No additional erasure or receipt engine exists.

Focused cases are in `test/library/list-import-vndb-labels.test.ts` and the source cascade case in
`test/library/erasure-owned-graph.test.ts`. Native64/512/4096 whole-caller measurements remain deferred to the
controller: fix R/M/P and source bytes, grow same-owner live/retired labels, source rows and unrelated owners, and
retain statement counts, examined rows/buffers, encoded request/response and cleanup bytes for review, mapping,
apply, first/deep/terminal pages, replay, refusal and partial cancellation. Source derivation is not executed growth
evidence. Ambiguous native claims remain a reserved producer shape (its native tuple is unique), not a fabricated
second importer resolver. Performance review of document-byte and nested native-command bounds is requested
before claiming the growth outcome complete.

Read sources: installed `list-import-vndb.ts`, parser/row and admission types, native label/assignment commands,
reservation SQL, the Library erasure graph, and `.reference/INDEX.md` (no VNDB adapter entry).
