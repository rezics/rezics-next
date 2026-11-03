# Native personal archive holdings recovery

The installed first part admits the actual personal Library v1 artifact and privately inspects retained live
holdings. It performs no copy commands. Review, create/reuse confirmation, per-item command outcomes, scheduled
expiry removal and the final Web recovery allocation remain a continuation. This is not account restoration.

Decision: deliver v1 admission and evidence inspection first, with seven-day read admission, one retained upload
per owner and 100-row removal pages; native review/effects follow separately. Validate the installed manifest's
total `rows` and `recordBytes` and its exact section inventory; v1 has no per-section counters.

## Installed interface

All requests require the receiving owner's bearer identity, `copy:list`, current account admission and the
`personal_library` gate. Operational reads hold the native account barrier through the page transaction.
Responses are private and no-store. Upload IDs never authorize another account, even on a shared route.

| Method                                     | Input                                                       | Result                                                |
| ------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------- |
| `POST /v1/libraryCopyArchives`             | Actual JSON file bytes, structured-string `Idempotency-Key` | `{uploadId,holdings,expiresAt}`                       |
| `GET /v1/libraryCopyArchives/{id}?after=…` | Original archive ordinal; default -1                        | Manifest, section coverage, ten evidence rows, `next` |
| `POST /v1/libraryCopyArchives/{id}:cancel` | No body                                                     | `{uploadId,cancelled:true}`                           |
| `DELETE /v1/libraryCopyArchives/{id}`      | No body; repeat while incomplete                            | `{uploadId,removed,complete}`                         |

`createCopyArchive` owns these methods; `ArchivedHolding`, `CopyArchiveManifest`, `ArchiveSectionCoverage` and
`COPY_ARCHIVE_LIMITS` are defined in `services/kernel/src/library/copy-archive-format.ts`. Client declaration
generation and adoption belong to the continuation. Web's existing personal Library/export interface remains its
own allocation; no recovery interface is complete or ready for adoption yet.

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
installed source as a completed capture: absent expected sections are rejected. Non-holding sections are explicitly
`unsupported` and their records are not retained. Entries/labels, occurrences, Collections, annotations, sessions,
import evidence and financial facts receive no effects here. Unknown section names are unsupported envelopes.

Every row returns `resolution:"unresolved"`; the page returns `effectsSupported:false` and `fullRestoration:false`.
Two copies with equal Subject, note or dates remain independent rows. There is no duplicate search or current-copy
enumeration. The remaining journey must offer explicit create or named-copy reuse, bind current canonical identity
and profile meaning, and execute only the existing copy commands. Archive UUIDs, pins, timestamps and revisions
must never become authority for those effects.

## Bounds, lifetime and cleanup

Admission authenticates and checks the private gate/account before decoding or parsing. Ingress limits the raw
file to 32 MiB. A pre-parse scanner limits nesting to 16; the manifest limits total records to 100,000. At most
4096 holdings and 32 MiB of manifest/holding evidence are admitted, with at most 66,000 encoded bytes per record.
Notes admit the native maximum of 1000 Unicode characters; source/location admit 200 each. Only typed holdings,
the manifest and bounded coverage counts are stored, never the raw file or unsupported section payloads.

One retained upload occupies an owner's keyed slot, including cancelled and expired uploads. Read admission ends
seven days after native upload command time; it never extends on retry or cancellation. Upload receipts contain
only the new upload identity, count and expiry. Replaying an upload cannot recreate removed evidence.
Cancellation is idempotent and keeps inspection available until expiry; it has no native copy effects to undo.
DELETE makes the upload unreadable immediately and removes at most 100 evidence rows per call, then the empty
root. Expired evidence can still be removed by its owner. Automatic expiry scheduling is not yet installed and is
required in the continuation before the complete recovery journey ships. The appended `copy_archive` terminal
graph phase removes the same bounded rows through the existing account erasure worker.

## Cost and verification boundary

Validation is O(U+N) over bounded bytes/records once per upload request. Persistence uses one owner-slot insert and
one bounded `jsonb_to_recordset` insert, with ordinary command authorization, History/receipt costs and rollback.
The preliminary admission and final receipt-currentness check each use a native operational account transaction.
These costs include account and exposure admission; the raw upload digest enters command identity without notes
entering receipt/event payloads. Recovery evidence is not a new export section or Search input.

Each inspection selects P+1=11 rows after an indexed ordinal, plus one locked owner root and native account/current
authority checks. Response evidence is bounded by ten records plus the bounded manifest. An exhausted/deep page
uses the same keyset. Removal addresses one root and at most 100 indexed child keys; terminal cleanup reuses it.
No query scans same-owner live or retained copies. Identity/profile preparation and native copy effects are absent
from this first part, not zero-cost operations. Their complete caller cost, including retry, stale/no-op, cancellation,
locks and command receipts, belongs to the continuation.

`services/kernel/test/library/copy-archive.test.ts` uses the installed producer after authentic native copy creation.
It covers independent siblings, maximum notes, all pins, null/day dates, old vocabulary, bounded pages, malformed
envelopes, upload replay, another owner, cancellation, expiry, removal and terminal denial/erasure. Focused execution
and compiler results are reported by the worker. Native64/512/4096 caller measurements, effect scenarios and broad
acceptance remain deferred; index derivation does not establish executed growth. Performance has been asked to
review the uncertain caller costs and static caps before final recovery admission.
