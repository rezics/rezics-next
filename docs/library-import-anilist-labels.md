# Adopt retained AniList custom-list membership as private labels

This extends the [installed AniList upload](library-import-anilist.md). Web325's `/library/import-anilist`
remains the complete AniList import interface. No additional upload, parser, matching service or catalogue adapter
is introduced. Native labels remain [independent personal assignments](library-labels.md), with no publication,
Collection, Entry state, progress, notes, rating, privacy or timestamp adoption.

Decision: admit the retained documented `customLists` boolean map and `group.name` only with `isCustomList:true`;
array variants and retained tags have no installed membership schema and remain explicitly unsupported.

The retained primary reference is AniList docs commit `03281c0a4bbf0c7f2097e0c935cddaed1096aa65`,
`object/medialist.md` (`customLists`: map of booleans; `asArray` has no object-field schema) and
`object/medialistgroup.md` (`name`, `isCustomList`, `isSplitCompletedList`, `status`), under
`.reference/api-first-platform-coverage/anilist-docs/docs/reference`. No provider account is fetched.

## Review and outcomes

`GET /v1/libraryImports/anilist/{importId}` adds `labelEvidence` and, when present, `labelReview` and `labelWork`
to each existing retained row. `labelEvidence.membership` distinguishes missing, unknown (null), invalid, empty,
available, unsupported (array representation), and oversized evidence. Boolean false is visible nonmembership.
A mixed-invalid map remains visible but its map values cannot be selected. Grouping is missing, unknown, invalid,
empty, custom or default. A default or split-completed display group supplies no selectable value. An explicitly
custom container is distinct from a per-entry membership. Tags remain missing, unknown or unsupported; no tag
is silently reclassified as a custom-list name or official state. Values expose exact source keys, original text,
origin and membership; `selectable` contains only supported positive evidence.

`POST /v1/libraryImports/anilist/{importId}:reviewLabels`, with the ordinary quoted Idempotency-Key, takes:

```json
{"ordinal":0,"subjectId":"canonical-uuid","selections":[
  {"key":"customLists:Favourites","target":{"labelId":"owned-live-label-uuid"}},
  {"key":"group:name","target":{"name":"Private favourites"}}
]}
```

It returns `{ordinal,review}` with a fresh `review.id`. The Subject defaults to the row's existing explicit review
choice, or its unique current provider match; an ambiguous/unavailable match without an explicit reviewed Subject
is not resolved by list text. Provider identifiers and existing independent AniList/MAL claims retain identity
authority. Native name normalization is NFC, Unicode whitespace collapse/trim, case preserving, 1..100 scalars.
New names must be unoccupied in the same owner's live normalized-name index; occupied names require an explicit
label-ID mapping. Repeated proposed normalized names within a review share one explicitly reviewed creation.

The review binds owner/upload/ordinal, canonical retained-source digest, selected keys/values/origins in order,
Subject and identity epoch, claim fingerprint, label IDs/revisions or normalized proposed names, client attribution
and a fresh review UUID. JSON object ordering is canonicalized; meaningful array order is preserved. Labels have
an independent review epoch so reopening an admitted state row does not reapply or replace its state/progress choice.
Refreshing either label selections or target mappings invalidates the old confirmation. State review and outcomes
remain independent.

`POST /v1/libraryImports/anilist/{importId}:applyLabels` takes
`{confirmations:[{ordinal,reviewId}]}` and returns `{outcomes,complete}`. Each row result has
`{ordinal,reviewId,items,complete}`. Each item has `key`, `status` and, where known, native `label:{id,revision}`
and `assignment:{id,revision}`. Statuses are applied, unchanged, stale, capacity, failed and pending. Duplicate
membership or an already assigned target returns unchanged with the same native assignment identity. Pending means
a label was created but cancellation/deadline stopped its assignment; creation alone never reports adoption success.
An unstarted item may be absent on cancellation. Failed/pending items remain resumable using their original keys.
A full 32-effective-assignment Subject yields capacity, retaining any successful earlier items and created label.

Native `library_label.create` and `library_label.assign` own receipts, History/events and export-source fences.
Each per-item command has its own retained key and original operands. A lost acknowledgement resumes that command
and returns its original identities. Fresh effects recheck Subject identity/access and lock the source header/row;
assignment also locks the exact live label and reviewed revision. An old creation, assignment or Entry receipt
cannot authorize a new operand. Parent deletion/restoration/recreation requires new label review. Existing native
32-slot reservation and deleted-parent reclamation rules remain unchanged.

All methods require current owner standing, Library read/update scopes, personal Library exposure and current Subject
access. Responses are private, no-store. Cancel/remove uses the installed producer's `:cancel` method. Cancellation
stops new admission; admitted native commands can finish. Removal deletes source review/work but leaves committed
personal labels and assignments. All new evidence lives in the existing account-leading store and is covered by its
100-key terminal-erasure owner. The installed producer has five-upload retention and explicit removal, with no timed
expiry contract; this extension adds no new allowance or timer.

## Cost and limits

`ANILIST_LABEL_LIMITS` fixes R=20 selected rows per apply, T=8 selected values per row, at most four distinct new
names per row (M<=80 per apply), 32 map entries per retained row, the installed P=20 retained-row page and an encoded
page/output limit B=8,388,608 bytes. Oversized membership maps remain evidence and cannot supply selected map values.
The producer's existing upload cap, byte cap and payer remain unchanged.

Reads address `(route,account_id,import_id,ordinal)` through the installed primary key. First/deep/final pages seek
that key. Subject and external-claim observations address existing native keys. Existing labels use identity points;
new-name preparation uses the partial `personal_label_live_name(route,account_id,normalized_name)` index with
`deleted_at IS NULL`. No owner catalogue/history walk or provider graph traversal is introduced.

Application charges R*T decisions, at most M native creations and R*T native assignments. Each command includes
owner admission, source header/row locks, current Subject preparation, receipt authorization/replay, native effect,
History/events and export fences, result serialization and bounded progress updates. Native assignments inspect at
most 32 reserved slots and addressed label parents, including deleted-parent reclaim predicates. Cancellation and
rollback are per native command. Original replay uses the same operands and current owner admission; removal and
terminal cleanup use the existing finite upload/100-key cleanup bounds. JSON encoding includes raw retained evidence,
source and review output and does not use object-key order as a review identity.

Focused tests pin the composed outcome and edge cases. The native64/512/4096 complete-caller statements,
rows/buffers, encoded-byte and nested-effect growth acceptance remains an integration measurement; derivation is not
an executed growth result.
