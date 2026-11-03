# Personal archive annotation, journal, assessment and source-observation recovery

This journey extends the existing private [archive review and merge](library-archive-merge.md) consumer. It uses the
installed V2/V3 export sections and the native Entry and Session commands; it adds no archive format, retention store,
exporter, or restoration path. V3 keeps the V2 section inventory and adds a private occurrence assessment; V4 appends
provider sections and remains unsupported for recovery. [Library export](library-export.md) remains the authority for
producer facts and format limits.

Decision: Recovered annotations, source observations and occurrence assessments remain private; archived identity, visibility, revisions and audit times never authorize publication or select a current occurrence.

## Evidence and supported operations

`decodeLibraryArchive(bytes)` accepts completed V1, V2 and V3 manifests using exact per-version section inventories
and final record/byte totals. V1/V2 retain their original shapes; V2/V3 annotations, journals and provenance require
explicit current-target mapping. V3 adds the required `assessment:{meaningRevision,units}` journal object without
changing the V2 inventory. Only meaning revision 1 and integer units 0–20 are adoptable; null is an explicit archived
absence, while unknown meanings remain visible unsupported evidence. V1/V2 assessment absence is never zero or clear.
Other unimplemented sections and V4 provider sections remain retained unsupported evidence. Missing sections are not
synthesized. Archived account, Subject, Entry, Session, pin, revision, capture, audit, completion and source-observation
values never grant authority.

The mounted interface remains the existing `POST /v1/libraryArchiveMerges`, `GET /:id`, `GET /:id/preview`,
`PATCH /:id/review`, `POST /:id/apply`, `GET /:id/results`, `DELETE /:id`, and `POST /:id/prune` journey. Review
and preview are private and no-store. Canonical archive8bb/Web323 owns the only archive interface; Web318/142 continues to own the existing
occurrence editor.

| Retained row  | Explicit current target                         | Selected fields                             | Native operation                                                                      |
| ------------- | ----------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `annotations` | Canonical Subject, existing Entry incarnation   | `note`, `priority`                          | `createEntryPersonalCommands().saveAnnotations`                                       |
| `journals`    | Canonical Subject and one owner-supplied existing non-retired Session | `startDate`, `finishDate`, `reflection`, `assessment` | `createSessionCommands().patchSessionJournal`                                         |
| `provenance`  | Explicitly mapped readable canonical Subject    | `privacy`, `sourceCreated`, `sourceUpdated` | `createEntryPersonalCommands().admitSourceObservation` or `.correctSourceObservation` |

Each field choice is `preserve`, `set`, or `clear`. Missing selection preserves the current field. An explicit clear
uses the native null/clear operation. For V1/V2, a missing assessment is unsupported and never clears. For V3, setting
supported `{meaningRevision:1,units:null}` adopts the archived absence by sending native `assessment:null`; clearing a
supported non-null assessment sends the same native clear operation. Unknown revisions/scales remain unsupported and
are never converted. Setting absent or null annotation, date or reflection values remains unsupported. Empty notes and
invalid priorities are rejected by the installed native parsers. Journal dates retain year, year/month, or
year/month/day precision and pass through the existing calendar-date parser. Reflection uses the same native parser:
`set` preserves exact plain text, including empty text and whitespace; `clear` explicitly writes null. Absent fields
and null cannot be set. Unsupported reflection evidence remains visible with `unsupported-field-value` or
`invalid-journal-reflection`; no text is truncated. The native bounds are 2,000 Unicode characters, 4,096 UTF-8 bytes
and a 16,384-byte escaped PATCH frame. Malformed Unicode reflection evidence is retained encoded for review, while
other malformed archive strings remain rejected. Session creation, completion, repeat counters, state, progress,
assessment and unit checklists are never replayed.

Decision: native reflection text excludes malformed Unicode and U+0000, which the native text column cannot store;
archive review retains that evidence and explicitly refuses its adoption. Archived assessment remains separate from
public Subject votes and aggregate enjoyment.

Decision: V3 assessment `set` with archived `units:null` sends native `assessment:null`; V1/V2 absence and unknown
meaning revisions remain unsupported.

Each field choice is `preserve`, `set`, or `clear`. Missing selection preserves the current field. An explicit clear
uses the native null/clear operation. For admission, an archived cleared fact requires `clear`; absent and unknown
values require an explicit `set` to remain distinct. Correction binds the exact current observation revision and
requires a deliberate `preserve`, `set`, or `clear` for each selected field. Admission inserts only when the exact
provider/record address is currently absent. Duplicate addresses, cap exhaustion, changed canonical identity,
changed target, and competing correction refuse the write or require fresh review. Unsupported provider/privacy
tokens and declared timestamp precision/zone mismatches remain private evidence with a reason. Supported unknown
tokens pass through native bounds. Timestamp values retain their original string, year/month/day/minute/second/
fractional precision and utc/offset/unknown zone; parsing never normalizes through a timezone or `Date`.

Empty notes and invalid priorities are rejected by the installed native parsers. Journal dates retain year,
year/month, or year/month/day precision and pass through the existing calendar-date parser. Reflection is evidence
only; no archived reflection, Session creation, completion, repeat counter, state, progress, or unit checklist is
replayed.

Entry application binds the current incarnation, Entry revision, annotation revision, canonical Subject anchor,
profile pin, and selected field values. The native annotation command rechecks that binding and always records the
visibility outcome as private. Journal review binds one exact current Session creation/identity, state, canonical
Subject/profile guard, journal revision, current assessment meaning/value and selected operation. The owner compares
the archived and current facts and supplies the occurrence; no title/time search, historical inference, new Session or
progress transition occurs. Journal application uses one PATCH containing all selected dates, reflection and assessment
at the reviewed journal revision. Review exposes current reflection and assessment for comparison. Journal application also needs the caller's current `progress_session:update`
scope for the native journal command; the archive route's `library_entry:update` scope alone is insufficient. The
native journal command rechecks owner authority and that binding. Imported consumption dates do not change Session
start/completion timestamps, progress history, or native command audit time. Journal patch state and its native
receipt remains independent of archive progress recovery commands, revisions and checkpoints. Observation review
reads the exact native address;
the native transaction rechecks the owner, canonical Subject/profile anchor, retained row fingerprint, review
revision, selected fields, and expected absence or revision before using the native receipt, source fence, event,
audit time, and writer. Archived timestamps and `recordedAt` never set native `recordedAt`. No Entry, Session,
account link, catalogue contribution, or provider grant is created.

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

Let `N≤100,000` be uploaded records, `B≤34 MiB` uploaded bytes, `R≤20` selected review/apply rows, `Fj≤4` selected
journal fields, `Fo≤3` selected observation fields, `O≤32` observations on one Subject, `P≤100` returned page rows,
`J≤4096` reflection bytes, and `E≤16,384` escaped patch-frame bytes. Upload parses and serializes `O(B+N)` input, checks and writes one indexed
owner upload slot, and inserts `N` child rows in one bounded batch. Preview and results do one owner/upload lookup plus
one ordinal-index seek returning at most `P+1` rows and serialize at most `P` rows.

Review reads one upload and `R` indexed ordinals, performs the relevant current Subject/profile and Entry/Session
reads, and performs one exact provider/record observation read for each selected observation. It persists `R` bounded
review rows with their next immutable revision. Parsing, equality, hashing, and full serialization are bounded by the
selected evidence and fields, including the simultaneous source, review, and operand copies.

Apply preflights `R` retained keys under the upload lock and begins each effect with locked upload/ordinal reads and
one persisted native binding. Native commands charge current owner/scopes/currentness and terminal fencing, profile
checks, cancellation/lifetime lock, original receipt lookup, target/address locking, and any selected-field CAS.
Admission locks the parent personal-fact row and counts at most `O` observations; correction reads only its exact
address and expected revision. Successful native writes use the ordinary receipt, event, and source-fence path once;
native observation serialization reads at most `O` records, then a bounded archive result is acknowledged. Journal
patches persist one original key and entire bounded body, with text kept within `E`.

Work is bounded by upload bytes/rows, returned `P`, and `R×(Fj+Fo+O)` plus addressed authority/profile work; it is
independent of unrelated account or observation history. A lost acknowledgement retries the same stored key and
operands, repeating only that bounded path. Cancellation fences pending effects while preserving acknowledgements.
Expiry and terminal erasure drain the existing retained graph; cleanup deletes at most 100 indexed rows and checks
one remaining-row key before deleting the upload. There is no GET repair, refill, account-wide matching, new payer,
or reservation. Native64/512/4096, final-page, negative-target, maximum-field, replay, cancellation, cleanup, and
composed growth measurements remain deferred to integration.

## Verification and ownership

Focused native coverage uses actual V2/V3 exports, adopts assessment zero/nonzero/null on separate repeated occurrences,
preserves V1/V2 absence and unknown meaning, and verifies combined journal PATCH replay and separation from public
votes. It also admits exact source observations with source-visible, unknown,
absent, cleared, fractional, partial, and unknown-zone values, and reads the values back through the addressed native
reader. It also covers duplicate admission, observation-cap refusal, competing corrections, changed canonical
identity, immutable confirmation, commit-before-checkpoint replay, partial cancellation, expiry pruning,
foreign-owner denial, and terminal erasure. Annotation and journal coverage retains partial-date precision,
preserve/set/clear, stale revision/incarnation handling, missing targets, per-item replay, and checks that Session
progress and command timestamps remain separate from imported dates. Frozen acceptance and composed native growth
measurements run after integration.

The route/schema producer is implemented in this source. The [generated confirmation journey](library-archive-merge.md#current-native-journey)
requires raw JSON text or `{manifest, records}` upload and the exact `reviewRevision` returned by review when applying
selected personal facts. The retained client snapshot still lacks assessment, reflection and immutable review-revision
confirmation, so generated handoff remains pending the existing Kernel compiler errors; declarations must come from
the producer and never be handwritten. The [assessment client continuation](../.temp/continuation/archive-assessment-client.md)
tracks this remaining delivery alongside the existing archive client installation work.
