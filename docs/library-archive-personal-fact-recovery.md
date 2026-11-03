# Personal archive annotation and journal recovery

This journey extends the existing private [archive review and merge](library-archive-merge.md) consumer. It uses the
installed V2 export sections and the native Entry and Session commands; it adds no archive format, retention store,
exporter, or restoration path. [Library export](library-export.md) remains the authority for producer facts and format
limits.

Decision: Recovered annotations remain private; V2 exports and native setters expose no visibility field, and source visibility never authorizes publication.

## Evidence and supported operations

`decodeLibraryArchive(bytes)` accepts completed V1 and V2 manifests. V1 continues to admit only its declared
sections. V2 annotations and journals require explicit current-target mapping; V2 provenance and all other
unimplemented sections remain retained unsupported evidence. Missing sections are not synthesized. Archived
account, Subject, Entry, Session, pin, revision, capture, audit, completion, and source-observation values never grant
authority.

The mounted interface remains the existing `POST /v1/libraryArchiveMerges`, `GET /:id`, `GET /:id/preview`,
`PATCH /:id/review`, `POST /:id/apply`, `GET /:id/results`, `DELETE /:id`, and `POST /:id/prune` journey. Review
and preview are private and no-store. Web323 owns the only archive interface; Web318 continues to own manual Entry
and journal editing.

| Retained row | Explicit current target | Selected fields | Native operation |
| --- | --- | --- | --- |
| `annotations` | Canonical Subject, existing Entry incarnation | `note`, `priority` | `createEntryPersonalCommands().saveAnnotations` |
| `journals` | Canonical Subject, existing non-retired Session | `startDate`, `finishDate` | `createSessionCommands().patchSessionJournal` |

Each field choice is `preserve`, `set`, or `clear`. Missing selection preserves the current field. An explicit clear
uses the native null/clear operation. Setting an absent or null archived value is unsupported. Empty notes and
invalid priorities are rejected by the installed native parsers. Journal dates retain year, year/month, or
year/month/day precision and pass through the existing calendar-date parser. Reflection is evidence only; no
archived reflection, Session creation, completion, repeat counter, state, progress, or unit checklist is replayed.

Entry application binds the current incarnation, Entry revision, annotation revision, canonical Subject anchor,
profile pin, and selected field values. The native annotation command rechecks that binding and always records the
visibility outcome as private. Journal application binds current Session and journal revisions, state, Subject,
profile anchor, and selected dates. Journal application also needs the caller's current `progress_session:update`
scope for the native journal command; the archive route's `library_entry:update` scope alone is insufficient. The
native journal command rechecks owner authority and that binding. Imported consumption dates do not change Session
start/completion timestamps, progress history, or native command audit time.

Outcomes are per item: `accepted`, `unchanged`, `stale`, `unsupported`, or `failed`. A changed target, incarnation,
revision, profile, or review epoch cannot reuse an earlier confirmation or native receipt. Item keys retain the
original upload/ordinal/review-revision identity. Stored review JSON is canonicalized so JSONB key order does not
change a binding. Lost acknowledgements replay through the native receipt and return the original field outcomes.
Partial application is retained across cancellation and evidence expiry.

## Retention and cost

The consumer keeps its existing single retained upload per owner for seven days. Uploads are capped at 34 MiB,
100,000 records, 32 MiB of encoded records and nesting depth 32. Preview pages contain at most 100 rows; review and
apply accept at most 20 selected rows; cleanup and account-erasure steps remove at most 100 retained rows. Selected
annotation and journal rows share the existing retained item table and lifecycle.

For bounded evidence rows `N`, selected targets `R`, selected fields `F`, page size `P`, and bytes `B`, upload work
is bounded by `O(B+N)`. Preview/results read at most `P+1` indexed rows. Review performs addressed owner/profile
and current-target reads for `R`; apply performs at most `R×F` native field decisions and at most `R` native
commands, including each command's preparation, transaction, receipt, History/events, export-source fence and
summary maintenance. Profile/Subject authority and journal/Entry controls are charged per addressed target.
Cleanup is capped at 100 rows per call; it does not scan owner history. Source-derived bounds do not establish
measured growth. Performance has been asked to review the composed native bounds; native64/512/4096, final-page,
negative-target, maximum-field, replay, disclosure-cancellation, and cleanup measurements remain deferred to
integration.

## Verification and ownership

Focused native coverage uses an actual V2 export, adopts one existing Entry and Session, proves partial-date
precision, preserve/set/clear, source-visible provenance remains unsupported, stale revision/incarnation handling,
missing targets, per-item replay, cancellation, expiry pruning, foreign-owner denial and terminal erasure. It also
checks Session progress and command timestamps remain separate from imported dates. Focused tests and workspace
typechecks are worker checks; frozen acceptance and composed native growth measurements run after integration.

After landing, Commerce receives the exact installed review/apply methods and field outcomes. Web323 remains the
single coordinated archive consumer; no second restoration interface is introduced.
