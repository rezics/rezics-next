# Native personal archive recovery

The installed owner admits the actual personal Library v1 artifact and privately inspects retained holdings and
supported progress evidence. Holdings remain evidence-only. Progress can be explicitly reviewed and applied as a
fresh native Session through the existing Session and episode commands. This is not account restoration.

Decision: recovery is per occurrence: the owner maps the source Subject to its current canonical Subject, and each
review creates a distinct fresh Session. Validate the installed manifest's total `rows` and `recordBytes` and exact
section inventory; v1 has no per-section counters. The progress flow and its supported/unsupported matrix are in
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

The only accepted format is `https://rezics.com/formats/library-export`, version 1, assembled as `{manifest,records}`
from the [installed export's final page](library-export.md). Unfinished pages, null manifests, missing sections,
duplicate JSON names, invalid UTF-8, unsupported versions, inconsistent totals and malformed holdings are rejected.
Expired export capture timestamps do not invalidate a previously completed local file. They never set command time.

Every admitted holding retains its original copy and Subject UUID/reference, all three nullable profile pins,
kind/status text, source/location, acquired/disposed dates, note, revision and audit timestamps. Missing native
holding operands are malformed; null means unstored. Native v1 uses full SQL calendar dates, so partial dates are
rejected rather than widened or guessed. Old vocabulary remains raw evidence beside its original pins.
No current identity, profile meaning or copy admission is inferred by inspection.

Section coverage counts records actually present. A declared section with zero records is empty. `omissions` retains
the producer's explicit exclusions; it is not interpreted as an empty section. v1 cannot represent an unavailable
installed source as a completed capture: absent expected sections are rejected. Sessions and exact unit rows are
retained for review; History, journal/reflection, entries/labels, occurrences, Collections, annotations, provider
import evidence and financial facts receive no effects. Unknown section names remain unsupported envelopes.

Every holding row returns `resolution:"unresolved"`; its page returns `effectsSupported:false` and
`fullRestoration:false`. Two copies with equal Subject, note or dates remain independent rows. There is no duplicate
search or current-copy enumeration. Archive UUIDs, pins, timestamps and revisions never authorize native effects.

## Bounds, lifetime and cleanup

Admission authenticates and checks the private gate/account before decoding or parsing. Ingress limits the raw
file to 32 MiB. A pre-parse scanner limits nesting to 16; the manifest limits total records to 100,000. At most
4096 holdings and 32 MiB of retained manifest/row evidence are admitted, with at most 66,000 encoded bytes per record.
Notes admit the native maximum of 1000 Unicode characters; source/location admit 200 each. Only typed holdings,
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
one bounded `jsonb_to_recordset` insert, with ordinary command authorization, History/receipt costs and rollback.
The preliminary admission and final receipt-currentness check each use a native operational account transaction.
These costs include account and exposure admission; the raw upload digest enters command identity without notes
entering receipt/event payloads. Recovery evidence is not a new export section or Search input.

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
