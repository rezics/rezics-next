# Native personal archive recovery

The installed owner admits the actual personal Library V1, V2, V3 and V4 artifacts and privately inspects retained holdings and
supported progress evidence. Holdings remain evidence-only. Progress can be explicitly reviewed and applied as a
fresh native Session through the existing Session and episode commands. This is not account restoration.

Decision: recovery is per occurrence: the owner maps the source Subject to its current canonical Subject, and each
review creates a distinct fresh Session. Validate the installed manifest's total `rows` and `recordBytes` and exact
section inventory; V1 has no per-section counters. V2/V3/V4 require exact per-section row and byte totals. The progress flow and its supported/unsupported matrix are in
[native progress recovery](library-archive-progress-recovery.md).

## Installed interface

All requests require the receiving owner's bearer identity, `copy:list`, current account admission and the
`personal_library` gate. Operational reads hold the native account barrier through the page transaction.
Responses are private and no-store. Upload IDs never authorize another account, even on a shared route.

| Method                                                               | Input                                                       | Result                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| `POST /v1/libraryCopyArchives`                                       | Actual JSON file bytes, structured-string `Idempotency-Key` | `{uploadId,holdings,progressRecords,expiresAt}`               |
| `GET /v1/libraryCopyArchives/{id}?after=…`                           | Original archive ordinal; default -1                        | Manifest, coverage and ten unresolved holding rows            |
| `GET /v1/libraryCopyArchives/{id}/progress`                          | Session ordinal; default -1                                 | Ten archived Session occurrences and `next`                   |
| `GET /v1/libraryCopyArchives/{id}/progress/{sessionId}/units`        | Session occurrence and unit ordinal                         | Ten exact archived unit IDs and `next`                        |
| `POST /v1/libraryCopyArchives/{id}/progressReviews`                  | Selected occurrence, current Subject/mode/unit mappings     | Typed current review and support report                       |
| `POST /v1/libraryCopyArchives/{id}/progressReviews/{reviewId}:apply` | Idempotency key                                             | Bounded native Session outcomes                               |
| `GET /v1/libraryCopyArchives/{id}/progressReviews/{reviewId}`        | Review ID                                                   | Review, application status and current accepted Session facts |
| `POST /v1/libraryCopyArchives/{id}:cancel`                           | No body                                                     | `{uploadId,cancelled:true}`                                   |
| `DELETE /v1/libraryCopyArchives/{id}`                                | No body; repeat while incomplete                            | `{uploadId,removed,complete}`                                 |

`createCopyArchive` owns these methods. Archived Session/unit records remain private evidence. Apply calls the
existing native Session create/record/transition commands and exact current episode-membership command; it adds no
entry, entitlement, copy, repeat-history or publication effects. Client declarations are emitted with the kernel
routes. Web activates the adjacent recovery interface only after those installed types are available; Web319 remains
the episode checklist, Web320 the measure editor, and Web323 the export interface.

The only accepted format is `https://rezics.com/formats/library-export`, versions 1, 2, 3 and 4, assembled as `{manifest,records}`
from the [installed export's final page](library-export.md). Unfinished pages, null manifests, missing sections,
duplicate JSON names, invalid UTF-8, unsupported versions, inconsistent totals and malformed holdings are rejected.
Expired export capture timestamps do not invalidate a previously completed local file. They never set command time.

Every admitted holding retains its original copy and Subject UUID/reference, all three nullable profile pins,
kind/status text, source/location, acquired/disposed dates, note, revision and audit timestamps. Missing native
holding operands are malformed; null means unstored. Native v1 uses full SQL calendar dates, so partial dates are
rejected rather than widened or guessed. Old vocabulary remains raw evidence beside its original pins.
No current identity, profile meaning or copy admission is inferred by inspection.

Section coverage counts records and encoded record bytes actually present. Byte counts absent on older retained
uploads are unavailable, never zero. A declared section with zero records is empty. `omissions` retains
the producer's explicit exclusions; it is not interpreted as an empty section. v1 cannot represent an unavailable
installed source as a completed capture: absent expected sections are rejected. Sessions and exact unit rows are
retained for review; History, journal/reflection, entries/labels, occurrences, Collections, annotations, provider
import evidence and financial facts receive no effects. Unknown section names are refused.

Every holding row returns `resolution:"unresolved"`; its page returns `effectsSupported:false` and
`fullRestoration:false`. Two copies with equal Subject, note or dates remain independent rows. There is no duplicate
search or current-copy enumeration. Archive UUIDs, pins, timestamps and revisions never authorize native effects.

Decision: the copy adapter uses the shared V2 section vocabulary for V3, with coverage
`private-library-owner-facts-v3` and journal-local `assessment:{meaningRevision:1,units:0..20|null}`;
V4 validates the original 21-section artifact at the shared native boundary before selecting holdings and progress.
Provider rows remain unsupported coverage, with their original totals. No completed artifact is relabeled or rebuilt
in the browser. This decoder does not adopt journal assessments.

V2/V3 require exactly the original 14 sections followed by `annotations`, `provenance`, `journals`,
`coverage:"private-library-owner-facts-v2"` or `"private-library-owner-facts-v3"`, and `sectionTotals` with
`{rows,recordBytes}` for every section, including empty ones. Counters must match every actual record before
anything is persisted. Current annotation/provenance/journal envelopes are recognized but their payloads are
discarded. Journal assessment is unsupported, has no votes or dates-to-progress effects, and enters no new store.
Provider evidence and all other unsupported sections likewise contribute only coverage counts/bytes.
V1 retains its original manifest and decoder, including the absence of section counters and new section claims.

## Bounds, lifetime and cleanup

Admission authenticates and checks the private gate/account before decoding or parsing. Ingress limits the raw
file to 32 MiB. A pre-parse scanner limits nesting to 16; the manifest limits total records to 100,000. At most
4096 holdings and 32 MiB of retained manifest/row evidence are admitted, with at most 66,000 encoded bytes per record.
Notes admit the native maximum of 1000 Unicode characters; source/location admit 200 each. Only typed holdings and Session/unit evidence,
the manifest and bounded coverage counts are stored, never the raw file or unsupported section payloads.

One retained upload occupies an owner's keyed slot, including cancelled and expired uploads. Read admission ends
seven days after native upload command time; it never extends on retry or cancellation. Upload receipts contain
only the new upload identity, count and expiry. Replaying an upload cannot recreate removed evidence.
Cancellation is idempotent and keeps inspection available until expiry; accepted progress remains in its native
Session. DELETE makes the upload unreadable immediately and removes at most 100 indexed archive/review/application
rows per call, then the empty root. Expired evidence can still be removed by its owner. The appended
`copy_archive` terminal graph phase removes the same bounded rows through the existing account erasure worker.

## Cost and verification boundary

Validation is O(U+N) over bounded bytes/records once per upload request. Persistence uses one owner-slot insert and
one bounded `jsonb_to_recordset` insert over retained holdings and Session/unit evidence, with ordinary command authorization, History/receipt costs and rollback.
The preliminary admission and final receipt-currentness check each use a native operational account transaction.
These costs include account and exposure admission; the raw upload digest enters command identity without notes
entering receipt/event payloads. Recovery evidence is not a new export section or Search input.

Wire bytes U include JSON framing, whitespace and the manifest; encoded record bytes B are the sum of
`JSON.stringify(record)` UTF-8 lengths, independently of U. A producer can emit B=32 MiB whose completed file
exceeds the consumer's U=32 MiB ceiling; upload refuses it before native effects. No producer bound promises fit.
Depth 16, 100,000 records, 4096 holdings, 66,000 encoded bytes per record and the retained-evidence bound are
independent admission constraints. Ingress bytes, decoded UTF-16 text, the parsed object graph, one record's
serialization, retained-row serialization and database-driver buffers can coexist; their sizes are additive,
not a single 32 MiB memory claim. Unsupported payloads exist only in bounded parse buffers. No transport or
admission reservation changes here; the mounted raw route keeps its existing payer and limit.

Each page selects P+1=11 indexed rows, plus one locked owner root and current owner/exposure checks. Review addresses
one occurrence and at most I=20 selected unit IDs, then checks one current profile/Subject anchor and one final
anchor fence. Apply is at most A+2 native commands for scalar measures and at most three for cursor or unit
progress, with one persisted reservation/checkpoint per command, native preparation, receipts, History/events and
source invalidation included. Removal addresses one root and at most 100 indexed child keys; terminal cleanup
reuses it. No step scans same-owner Sessions, units or History. Native64/512/4096 whole-caller measurements remain
deferred to integration acceptance; fixed page/index bounds alone do not establish those measurements.

`services/kernel/test/library/copy-archive.test.ts` uses the installed producer after authentic native copy and
Session commands. It covers equal-measure occurrences, explicit current mapping, exact decimals, fresh identity,
terminal transitions, lost-ack replay, review refresh key binding, unsupported old vocabulary, bounded parsing,
owner isolation, expiry and erasure. The focused test and compiler outcomes are reported by the worker. The frozen
native64/512/4096 caller acceptance remains deferred; it is not replaced by index derivation.
