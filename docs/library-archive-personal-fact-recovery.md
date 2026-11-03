# Personal archive annotation, journal and assessment recovery

This journey extends the existing private [archive review and merge](library-archive-merge.md) consumer. It uses the
installed V2/V3 export sections and the native Entry and Session commands; it adds no archive format, retention store,
exporter, or restoration path. V3 retains the V2 section inventory and adds an occurrence assessment; V4 appends provider
sections and remains unsupported for recovery. [Library export](library-export.md) remains the authority for producer
facts and format limits.

Decision: Recovered annotations and occurrence assessments remain private; archive IDs, source visibility, revisions and audit times never authorize publication or select a current occurrence.

## Evidence and supported operations

`decodeLibraryArchive(bytes)` accepts completed V1, V2 and V3 manifests using each exact section inventory and final
record/byte totals. V1 and V2 retain their original shapes; V2 annotations and journal date/reflection rows require
explicit current-target mapping, and missing assessment never means zero or clear. V3 adds the required
`assessment:{meaningRevision,units}` journal object without changing the V2 section inventory. Only meaning revision 1
and integer units 0–20 are adoptable; null is an explicit archived absence, while unknown meanings and scales stay
visible unsupported evidence. V2 provenance, V3 provenance and all other unimplemented sections remain retained
unsupported evidence. V4 provider sections are refused. Missing sections are not synthesized. Archived account,
Subject, Entry, Session, pin, revision, capture, audit, completion, visibility and source-observation values never grant
authority.

The mounted interface remains the existing `POST /v1/libraryArchiveMerges`, `GET /:id`, `GET /:id/preview`,
`PATCH /:id/review`, `POST /:id/apply`, `GET /:id/results`, `DELETE /:id`, and `POST /:id/prune` journey. Review
and preview are private and no-store. Canonical archive8bb/Web323 owns the only archive interface; Web318/142 continues to own the existing
occurrence editor.

| Retained row  | Explicit current target                         | Selected fields                         | Native operation                                |
| ------------- | ----------------------------------------------- | --------------------------------------- | ----------------------------------------------- |
| `annotations` | Canonical Subject, existing Entry incarnation   | `note`, `priority`                                             | `createEntryPersonalCommands().saveAnnotations` |
| `journals`    | Canonical Subject and one owner-supplied existing non-retired Session | `startDate`, `finishDate`, `reflection`, `assessment` | `createSessionCommands().patchSessionJournal`   |

Each selected field choice is `preserve`, `set`, or `clear`. Missing selection preserves the current field. An explicit
clear uses the native null/clear operation. For V1/V2, a missing assessment is unsupported and never clears. For V3,
setting supported `{meaningRevision:1,units:null}` adopts the archived absence by sending the native `assessment:null`
PATCH; clearing a supported non-null assessment sends the same native clear operation. Empty notes and invalid
priorities are rejected by the installed native parsers. Journal dates retain year, year/month, or year/month/day
precision and pass through the existing calendar-date parser. Reflection uses the same native parser: `set` preserves
exact plain text, including empty text and whitespace; `clear` explicitly writes null. Absent or null date/reflection
fields cannot be set. Unsupported reflection evidence remains visible with `unsupported-field-value` or
`invalid-journal-reflection`; no text is truncated. The native bounds are 2,000 Unicode characters, 4,096 UTF-8 bytes
and a 16,384-byte escaped PATCH frame. Malformed Unicode reflection evidence is retained encoded for review, while
other malformed archive strings remain rejected. Session creation, completion, repeat counters, state, progress and
unit checklists are never replayed. An occurrence assessment is private to its exact Session; it is independent of the
Content standard question and does not write vote rows or public enjoyment aggregates.

Decision: native reflection text excludes malformed Unicode and U+0000, which the native text column cannot store;
archive review retains that evidence and explicitly refuses its adoption. An owner who chooses `set` for a supported V3
null assessment adopts no assessment; V1/V2 absence and unknown meaning revisions remain unsupported and preserved.

Entry application binds the current incarnation, Entry revision, annotation revision, canonical Subject anchor,
profile pin, and selected field values. The native annotation command rechecks that binding and always records the
visibility outcome as private. Journal review binds one exact current Session creation/identity, state, canonical
Subject/profile guard, journal revision, current assessment meaning/value, archived evidence and selected operation.
The owner compares archived and current values and supplies a specific occurrence; no title/time search, historical
inference, new Session or progress transition is performed. Journal application uses one PATCH containing all selected
dates, reflection and assessment at the reviewed journal revision. Review exposes current reflection and assessment
for comparison. Journal application also needs the caller's current `progress_session:update`
scope for the native journal command; the archive route's `library_entry:update` scope alone is insufficient. The
native journal command rechecks owner authority and that binding. Imported consumption dates do not change Session
start/completion timestamps, progress history, or native command audit time. Journal patch state and its native
receipt remain independent of archive progress recovery commands, revisions and checkpoints.

Outcomes are per item: `accepted`, `unchanged`, `stale`, `unsupported`, or `failed`. A changed target, incarnation,
revision, profile, or review epoch cannot reuse an earlier confirmation or native receipt. Preview and review expose
`reviewRevision`; apply requires `{items:[{ordinal,reviewRevision}]}` and rejects an old or mixed confirmation before
any effect. Accepted items cannot be refreshed. Item keys retain the
original upload/ordinal/review-revision identity. Stored review JSON is canonicalized so JSONB key order does not
change a binding. Lost acknowledgements replay through the native receipt and return the original field outcomes.
Partial application is retained across cancellation and evidence expiry. One selected journal item retains the original
native key and entire PATCH body before dispatch, combining dates, reflection and assessment at one reviewed journal revision.
The native admission guard checks the exact session/profile and live retained upload in the real command transaction;
receipt replay recovers an original commit without rechecking an obsolete CAS or applying at a later revision.
Native receipts and archive results contain identifiers, revision, change and field outcomes only. Current reflection
and selected text stay exclusively in existing retained review/intent rows, removed by existing prune/account erasure.

## Retention and cost

The consumer keeps its existing single retained upload per owner for seven days. Uploads are capped at 34 MiB,
100,000 records, 32 MiB of encoded records and nesting depth 32. Preview pages contain at most 100 rows; review and
apply accept at most 20 selected rows; cleanup and account-erasure steps remove at most 100 retained rows. Selected
annotation and journal rows share the existing retained item table and lifecycle.

The [merge owner caller derivation](library-archive-merge.md#bounds-and-verification) remains authoritative for
shared archive and nested native work.

For fixed addressed selections `R <= 20`, journal fields `F <= 4`, reflection bytes `B <= 4096` and
escaped frame `J <= 16384`, whole-caller work includes upload, pages, `R × (Creview + Cintent + Cnative + Cresult)`
and cleanup, repeating only the reached terms on retries. Upload remains `O(encoded bytes + N)` under existing caps;
preview/results seek at most `P+1 <= 101` indexed retained rows. Review performs exact retained-row, canonical
Subject/profile, owner/session and journal reads per selection; no owner-history search is involved. The native
current-profile/access reads and preparation remain charged per target, including their independent authority gates.
Apply preflights`R`retained keys under the upload lock, repeats each revision check at begin, serializes one original
patch and bounded guard into existing durable operands, then records one small result per reached item. Text appears
once in the original PATCH operands, keeping maximum escaped frames inside the existing 16,384-byte JSONB bound.
Review retains at most one bounded current reflection for comparison. JSON parsing, equality, hashing and full caller
serialization cost`O(R × (F + J))`, including simultaneous source, review and operand copies.

Each native command charges current owner/scopes/currentness and terminal fencing, exact session/journal locking,
profile checks, upload lifetime/cancellation lock, one native receipt lookup, at most one journal CAS, ordinary command
fence and ID-only event/export-source invalidation. Native receipts retain only identifiers/revision/change. Replay
repeats current native authority and receipt work, returns the original acknowledgement, and adds no write/event.
Cancellation/expiry blocks uncommitted native effects under the upload lock and preserves accepted edits. Cleanup
uses existing indexed pages of at most 100 retained keys and native account erasure; no new payer, reservation, scan,
side store or background task is added. Holding `R,F,B` fixed keeps this addressed work independent of unrelated
sessions/history/evidence. Native64/512/4096, browser/root and composed growth measurements remain controller-owned
and unmeasured here; source derivation does not establish those execution results.

## Verification and ownership

Focused native coverage includes a completed V3 producer artifact with private assessments on separate repeated
occurrences, zero/nonzero/null semantics, V2 absence and unknown meaning preservation, combined date/reflection/assessment
PATCH replay, stale targets, cancellation, expiry, foreign-owner denial and terminal erasure. It also verifies section and
byte totals and keeps assessment separate from public votes and Session progress. The V1/V2 validation and personal-fact
scenarios continue to prove existing date/reflection behavior. Whole-caller native64/512/4096 measurements and frozen
acceptance remain controller-owned and deferred after this focused worker verification.

The mounted route supplies upload, preview, review, apply, results and cancellation DTOs and the supported
`assessment` journal choice to the generated Kernel client producer. The declaration must expose immutable
`reviewRevision/items` confirmation and actual returned preview/review/result DTOs before the canonical archive client
uses this journey. Web keeps its existing manual occurrence interface and archive page ownership.
