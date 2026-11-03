# Review retained Bangumi tags as private labels

This extends the [installed Bangumi upload engine](library-import-bangumi.md). Web324 remains the complete
upload-to-result interface and consumes these generated methods; there is no additional page, parser, matcher,
upload format, catalogue producer or importer store. The REZICS collection wrapper is not an official Bangumi export.

Decision: label review has its own confirmation epoch, with at most 16 selected mappings per retained row and 16
native creations and 16 effective assignments over that row's lifetime, including refreshed reviews; unchanged assignments and original
receipt replay consumes no additional allowance. The Subject review token is the immutable retained row's revision.

## Installed owner methods

All three methods use the existing authenticated own-account Library actions, personal_library exposure,
request admission and `Cache-Control: private, no-store`. Mounted route types define the following client methods (declaration regeneration remains required):

- `libraryImports.bangumi({ uploadId }).rows({ ordinal }).tags.get({ query: { after: -1 } })`
- `libraryImports.bangumi({ uploadId }).$reviewLabels.post({ ordinal, rowRevision, mappings }, { headers })`
- `libraryImports.bangumi({ uploadId }).$applyLabels.post({ ordinal, reviewToken })`

`headers` supplies the ordinary quoted `Idempotency-Key`. Apply uses the separate label review token, with stable
original per-item create/assign keys. The wire routes are `GET /v1/libraryImports/bangumi/{uploadId}/rows/{ordinal}/tags`,
`POST /v1/libraryImports/bangumi/{uploadId}:reviewLabels`, and `POST /v1/libraryImports/bangumi/{uploadId}:applyLabels`.
Review returns `{ ordinal, labels: { review, confirmed, outcomes } }`. Review contains `token`, `rowRevision`,
`subject`, `evidence` and `items`. Each mapping is `{ index, target: { labelId } | { name } }`; the review captures
exact source text, native target identity/revision or explicitly reviewed normalized new name. Apply returns
`{ uploadId, ordinal, outcomes, remaining }`, with remaining source tag indices for an interrupted request.

Start from an admitted retained upload row and its existing Subject review. `rowRevision` is that review's token.
A refreshed Subject review invalidates label review. A refreshed label review retires its previous confirmation;
it never changes the separate state choice, exact operands, receipt or epoch. An accepted state cannot authorize
any label mapping. Unmatched, ambiguous and unavailable rows keep their outcomes until ordinary Subject review
resolves them. Label names and source text never identify Subjects.

Tag reads return the installed field's validity as `missing`, `empty`, `known`, `invalid` or `unknown`, then at most
32 indexed source values with `supported`/`invalid`/`unknown` status and a proposed native name. Missing fields have
no entry; an empty array is explicit evidence. An invalid mixed array never admits its string subset. Original text
is unchanged; only [native normalization](library-labels.md) proposes NFC, collapsed Unicode whitespace and a
case-sensitive name of 1–100 Unicode scalars without controls or lone surrogates. Invalid native-name evidence is
shown but cannot be adopted. Unknown meanings are not inferred as supported.

Select an existing owned live label by opaque ID or explicitly review a new name. A live-name collision refuses
creation; no text comparison authorizes reuse. Deleted/recreated names have different IDs. Revisions, canonical
Subject identity epoch, current profile release and the exact retained row/review are checked before fresh native
effects. A changed target requires new confirmation. Native commands hold the upload lock through effect commit,
serializing cancellation, removal and review replacement against admission. No source time backdates audit time.

## Outcomes and boundaries

Each selected item returns `index`, `status`, minimal `label` and `assignment` identities/revisions, and `created`.
Statuses are `assigned`, `unchanged` (already assigned), `duplicate` (same selected source text or explicit existing
target ID), `invalid`, `stale`, `capacity`, `conflict`, `limit`, and `failed`. A duplicate never creates another label
or consumes an assignment slot. Two different source tags requesting the same new name are not automatically merged.
A committed new definition may remain when its assignment is refused; its returned identity and original native
create receipt remain the retry authority. Lost acknowledgement retries replay native create/assignment receipts,
including the original unchanged disposition, and never generate a replacement definition. Failed items can retry
the original token; changing any mapping requires a fresh review. Previously accepted effects remain native facts.

Native assignment admission retains the 32-effective-assignment bound, same-row reservations, unchanged duplicates,
and one deleted-parent reclamation at the parent's original deletion/deadline. No owner catalogue or History scan
resolves an ID or name. Current native receipts, events, History and source fences supply their ordinary semantics.

Request abort/deadline stops new items and returns exact completed outcomes and remaining indices. Source cancellation
clears label review state and stops new effects; source deletion cascades the retained row. Both preserve accepted
native labels and assignments. The existing terminal account graph's `bangumi_upload` phase removes the same rows
in windows of at most 100 keys, including the new JSON state; labels remain with their native erasure phases.
The base Bangumi engine has no expiry column or scheduled expiry owner. Scheduled expiry, terminal erasure execution
and complete caller growth measurement remain continuation work, not evidence of completed acceptance.

Comments, notes, source privacy, timestamps, progress counts, scores, state and unknown provider fields are excluded
from label adoption. No Entry, Session, public Collection, review, follow or publication is created by tags. The state
engine and any subsequent metadata/progress confirmation keep their own exact operands and epochs.

## Cost and validation

Let R=1 selected row, T<=16 selections, M<=T new-label requests, P<=10 retained rows per existing source page,
and B be bounded retained/output bytes. Existing upload limits remain 256 KiB/file, 100 rows, 8 KiB/source row,
32 KiB/expanded evidence row and depth 16; the installed parser has no independent tag-count cap (the byte limit
bounds it). Label review JSON adds at most 32 KiB per row. Tag pages expose <=32 values plus that fixed review bound.
No source evidence admission limit or command payer is enlarged.

Review uses indexed owner/upload/row points, <=T addressed label or unique live-name probes and no History scan.
Apply uses <=R*T decisions and <=M native creations, current Subject/profile preparation, original receipt reads,
owner controls, upload locks, native History/events and source-fence work. Each assignment materializes <=32
reservations and <=33 sorted parent locks, returns effective duplicates before capacity refusal, and may reclaim
one reservation only when the current parent is deleted; missing/deleted targets fail instead of allocating a slot.
Native receipt replay and source serialization remain inside the same caller cost. Failed native preparation cannot
be counted as a measurement. Expiry work must retain this source owner's lifetime and payer once supplied.

Focused native scenarios are `services/kernel/test/library/list-import-bangumi-labels.test.ts`; existing state scenarios
are unchanged. Integration owns frozen acceptance, first/deep/final pages and native64/512/4096 whole-caller statements,
rows/buffers, bytes and effects with R/T/M/P/B fixed, including maximum admitted text, negative IDs, invalid evidence,
capacity, stale epochs, retry, cancellation and cleanup. Performance has been asked to review the complete caller terms.

Primary source read: retained `search-header-and-scopes/bangumi-api/open-api/v0.yaml` at
`65d29cff2331e08c0110d30d515f7f1b6488f845`, `getUserCollectionsByUsername`, `SubjectCollectionType`, `SubjectType`,
`UserSubjectCollection` and `UserSubjectCollectionModifyPayload`. Provider tags are evidence; native label name,
capacity and lifecycle rules come from this repository.
