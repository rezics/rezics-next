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
and preview are private and no-store. Canonical archive8bb/Web323 owns the only archive interface; Web318/142 continues to own the existing
occurrence editor.

| Retained row  | Explicit current target                         | Selected fields                         | Native operation                                |
| ------------- | ----------------------------------------------- | --------------------------------------- | ----------------------------------------------- |
| `annotations` | Canonical Subject, existing Entry incarnation   | `note`, `priority`                      | `createEntryPersonalCommands().saveAnnotations` |
| `journals`    | Canonical Subject, existing non-retired Session | `startDate`, `finishDate`, `reflection` | `createSessionCommands().patchSessionJournal`   |

Each field choice is `preserve`, `set`, or `clear`. Missing selection preserves the current field. An explicit clear
uses the native null/clear operation. Setting an absent or null archived value is unsupported. Empty notes and
invalid priorities are rejected by the installed native parsers. Journal dates retain year, year/month, or
year/month/day precision and pass through the existing calendar-date parser. Reflection uses the same native parser:
`set` preserves exact plain text, including empty text and whitespace; `clear` explicitly writes null. Absent fields
and null cannot be set. Unsupported reflection evidence remains visible with `unsupported-field-value` or
`invalid-journal-reflection`; no text is truncated. The native bounds are 2,000 Unicode characters, 4,096 UTF-8 bytes
and a 16,384-byte escaped PATCH frame. Malformed Unicode reflection evidence is retained encoded for review, while
other malformed archive strings remain rejected. Session creation, completion, repeat counters, state, progress,
assessment and unit checklists are never replayed.

Decision: native reflection text excludes malformed Unicode and U+0000, which the native text column cannot store;
archive review retains that evidence and explicitly refuses its adoption. Omitted assessment remains native-owned;
its coordinated producer uses journal-local CAS and version 3 exports, with V1/V2 absence never inferred.

Entry application binds the current incarnation, Entry revision, annotation revision, canonical Subject anchor,
profile pin, and selected field values. The native annotation command rechecks that binding and always records the
visibility outcome as private. Journal application binds current Session and journal revisions, state, Subject,
profile anchor, and the selected dates/reflection. Review exposes current reflection for comparison. Journal application also needs the caller's current `progress_session:update`
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
native key and entire PATCH body before dispatch, combining dates and reflection at one reviewed journal revision.
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

For fixed addressed selections `R <= 20`, journal fields `F <= 3`, reflection bytes `B <= 4096` and
escaped frame `J <= 16384`, whole-caller work is `Cupload + Cpages + R × (Creview + Cintent + Cnative + Cresult)

- Ccleanup`, repeating only the reached terms on retries. Upload remains `O(encoded bytes + N)`under existing caps;
  preview/results seek at most`P+1 <= 101`indexed retained rows. Review performs exact retained-row, canonical
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

Focused native coverage uses an actual V2 export, adopts one existing Entry and Session, proves partial-date
precision, preserve/set/clear, source-visible provenance remains unsupported, stale revision/incarnation handling,
missing targets, per-item replay, cancellation, expiry pruning, foreign-owner denial and terminal erasure. It also
checks Session progress and command timestamps remain separate from imported dates. Focused tests and workspace
typechecks are worker checks; frozen acceptance and composed native growth measurements run after integration.

After landing, Commerce receives the exact installed review/apply methods and field outcomes. Web323 remains the
single coordinated archive consumer; no second restoration interface is introduced.

The route/schema producer is implemented in this source. Generated client snapshot emission remains unavailable
until the shared compiler/check host can run; the existing snapshot must not be presented as the reflection handoff.
The remaining generation and focused verification are recorded in the reflection client continuation.
