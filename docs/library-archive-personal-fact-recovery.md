# Personal archive annotation, journal and assessment recovery

This journey extends the existing private [archive review and merge](library-archive-merge.md) consumer. It uses the
installed V1/V2/V3 export sections and the native Entry and Session commands; it adds no archive store, journal writer,
or restoration path. [Library export](library-export.md) remains the authority for producer facts and format limits.

Decision: Recovered annotations remain private; V2 exports and native setters expose no visibility field, and source visibility never authorizes publication.

## Evidence and supported operations

`decodeLibraryArchive(bytes)` accepts completed V1, V2 and V3 manifests with exact section lists and complete byte
accounting. V1 and V2 keep their installed meanings and inventories. V2 annotations and journals require explicit
current-target mapping. V3 keeps the V2 sections and adds only the journal assessment. V2/V3 provenance and other
unimplemented sections remain retained unsupported evidence. Missing V1/V2 assessment is preserved and is never
treated as zero or clear. Unknown assessment meanings remain explicit unsupported evidence. Archived account,
Subject, Entry, Session, pin, revision, capture, audit, completion, and source-observation values never grant authority.

The mounted interface remains the existing `POST /v1/libraryArchiveMerges`, `GET /:id`, `GET /:id/preview`,
`PATCH /:id/review`, `POST /:id/apply`, `GET /:id/results`, `DELETE /:id`, and `POST /:id/prune` journey. Review
and preview are private and no-store. The canonical archive consumer owns the only archive interface; manual
Entry and journal editing retain their existing interface owners.

| Retained row  | Explicit current target                         | Selected fields           | Native operation                                |
| ------------- | ----------------------------------------------- | ------------------------- | ----------------------------------------------- |
| `annotations` | Canonical Subject, existing Entry incarnation   | `note`, `priority`        | `createEntryPersonalCommands().saveAnnotations` |
| `journals`    | Canonical Subject, existing non-retired Session | `startDate`, `finishDate`, `reflection`; V3 also `assessment` | `createSessionCommands().patchSessionJournal`   |

Each field choice is `preserve`, `set`, or `clear`. Missing selection preserves the current field. An explicit clear
uses the native null/clear operation. Setting an absent or null archived value is unsupported. Empty notes and
invalid priorities are rejected by the installed native parsers. Journal dates retain year, year/month, or
year/month/day precision and pass through the existing calendar-date parser. V2/V3 reflection is independently
selectable and retains empty string versus null. V3 assessment is `{meaningRevision:1,units:number|null}` with integer
units 0–20 step 1; set requires a supported non-null value, clear is explicit, and preserve omits the PATCH field.
Unknown revisions or values cannot be rescaled, rounded, or interpreted as the Content standard question. No
Session creation, completion, repeat counter, state, progress, or unit checklist is replayed.

Entry application binds the current incarnation, Entry revision, annotation revision, canonical Subject anchor,
profile pin, and selected field values. The native annotation command rechecks that binding and always records the
visibility outcome as private. Journal application binds the current Session identity and creation time, Session and
journal revisions, state, Subject, profile anchor, and selected field operands. Journal application also needs the caller's current `progress_session:update`
scope for the native journal command; the archive route's `library_entry:update` scope alone is insufficient. The
native journal command rechecks owner authority and that binding. Imported consumption dates do not change Session
start/completion timestamps, progress history, or native command audit time. Journal patch state and its native
receipt remain independent of archive progress recovery commands, revisions and checkpoints.

Outcomes are per item: `accepted`, `unchanged`, `stale`, `unsupported`, or `failed`. A changed target, incarnation,
revision, profile, or review epoch cannot reuse an earlier confirmation or native receipt. Preview/review expose `reviewRevision`; apply requires `{items:[{ordinal,reviewRevision}]}` and checks the
whole selection before effects (409 for any replaced review, including a mixed batch). A second revision check
precedes each native execution or receipt replay. Accepted items cannot be reviewed again. Item keys retain the
original upload/ordinal/review-revision identity. Stored review JSON is canonicalized so JSONB key order does not
change a binding. Lost acknowledgements replay through the native receipt and return the original field outcomes.
Partial application is retained across cancellation and evidence expiry.

## Retention and cost

The consumer keeps its existing single retained upload per owner for seven days. Uploads are capped at 34 MiB,
100,000 records, 32 MiB of encoded records and nesting depth 32. Preview pages contain at most 100 rows plus one
lookahead; review and apply accept at most 20 selected rows; cleanup and account-erasure steps remove at most 100
retained rows. A selected journal row has an explicit maximum of four field choices (`F<=4`): two partial dates,
reflection and assessment. One selected page therefore has at most 80 journal field choices; each is validated and
serialized into the retained reviewed operation, while one native PATCH body carries only changed fields. Reflection
retains the native 2,000-character/4,096-byte bound. Assessment adds one nullable small integer and no extra scan.
Selected annotation and journal rows share the existing retained item table and lifecycle.

The [merge owner's complete caller derivation](library-archive-merge.md#bounds-and-verification) charges every archive
operation and repeated caller authority/receipt read, producer pages (16 rows/120,000 bytes), consumer pages
(100 rows plus lookahead), retained canonical operands, full simultaneous JSON serialization, and each native
command's target/profile/journal preparation, locks, receipts, History, export fences and summaries. Each apply
attempt adds preflight, one begin per reached selection and one acknowledgement/refusal per completed dispatch;
retries repeat their actual work. The added journal field is bounded by `F<=4`, so selected-field decoding and
reviewed PATCH serialization cover all at most 80 choices in `R<=20`; the old `F<=2` bound is not reused. Cleanup
selects at most 100 retained keys; native cascades retain their own bounds. No payer allowance is increased.
Source-derived bounds do not establish measured growth; native64/512/4096, first/deep/final/empty pages,
denial/stale targets, maximum bytes, lost acknowledgement, partial cancellation, final disclosure, expiry and physical
cleanup measurements remain deferred to integration.

## Verification and ownership

Focused native coverage uses a real V3 export, adopts assessment against an explicit current occurrence and reads back
its native journal revision. It also checks zero/nonzero/null/absent assessment, repeated occurrence targets, unknown
meaning, exact V1/V2 preservation, partial-date precision, reflection preservation, one combined PATCH, stale
revision/incarnation handling, missing targets, per-item replay, cancellation, expiry pruning, foreign-owner denial
and terminal erasure. Focused tests and workspace typechecks are worker checks; frozen acceptance and composed native
growth measurements run after integration.

After landing, Commerce receives the exact installed review/apply methods and field outcomes. The canonical archive consumer remains the
single coordinated archive consumer; no second restoration interface is introduced.
