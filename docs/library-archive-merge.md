# Personal Library archive review and merge

Collection archive recovery is owned by [Native Library archive Collection recovery](library-archive-collection-recovery.md).
The installed v1 export and its producer-side guarantees remain owned by [Library export](library-export.md).

The [installed personal export](library-export.md) produces a completed local `{manifest,records}` file.
Its v1 manifest, section order and encoded-record limits are shared by the producer and the archive decoder;
there is no second archive schema. Export coverage and its integration evidence status remain unchanged.

## Delivered validation boundary

`services/kernel/src/library/library-archive.ts` exposes `decodeLibraryArchive(bytes: Uint8Array)`. The mounted
private consumer is `POST /v1/libraryArchiveMerges`, owner status `GET /:id`, indexed `GET /:id/preview` and
`GET /:id/results`, `PATCH /:id/review`, selected `POST /:id/apply`, cancellation `DELETE /:id`, and expired
evidence pruning `POST /:id/prune`. These methods do not change the producer's export interface or claim Web UI
completion.

Decision: accept completed v1 artifacts within 34 MiB and depth 32, reject duplicate rows and exact stored label
names, and keep expired capture timestamps as evidence rather than treating them as permission or file expiry.

Decision: retain one seven-day archive per account; cap preview/result pages and review/apply batches at 100/20;
replay uncertain effects with journaled native request keys and prune expired evidence in 100-row pages.

Validation requires the producer's final manifest, all fourteen declared installed sections in producer order,
the global `rows` count and the sum of compact UTF-8 `JSON.stringify(record)` bytes in `recordBytes`. The format
does not declare per-section counts; the decoder computes them without inventing declarations. A missing final
manifest, missing section declaration or absent assignment label parent is incomplete, never explicitly empty.
Malformed envelopes, unsupported formats/versions, inconsistent counts, duplicate JSON keys, invalid Unicode,
unknown record sections, repeated native record identities and out-of-order sections are refused. Failures expose
only fixed codes, without raw JSON parser messages, archive values or private names.

The output preserves records and manifest omissions as private evidence. Every installed section reports its
computed count, `present` or `empty` capture, and one of these treatments:

| Sections                                                                     | Treatment                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| entries, labels, assignments                                                 | `requires-explicit-mapping`; validation admits no native effect |
| sessions, units, history, holdings, collections, collectionPins, occurrences | `retained-unsupported`                                          |
| bangumiUploads, bangumiEvidence, malImports, malEvidence                     | `retained-unsupported`                                          |

Excluded trash, Commerce/financial evidence, publication output and unavailable sources remain the producer's
explicit omissions. Source observations, annotations, ratings and other absent sources gain no synthetic section,
empty count or successful restoration claim. Unsupported records retain inert evidence; their payloads receive
structural/identity checks, not a claim of native semantic admission.

Archived Subjects and references, accepting meanings and pins, revisions, incarnations, state text and label names
never establish current admission. In particular, unavailable old states remain readable; equal names do not map
labels, and archive IDs do not address the receiving account's private facts. The decoder has no account access,
does not fetch Subject URLs and does not install dates, revisions, receipts or pins.

## Current native journey

An authenticated owner uploads once, inspects indexed private preview pages, resolves canonical Subjects through
current identity/profile rules, explicitly chooses current state and label IDs or validated new labels, reviews
current conflicts and preserves local work by default. Selected effects bind the reviewed
current incarnation/revision, canonical identity and operands, and revalidate through the installed native command
owners, including entry History. No replace-all, implicit label removal, inferred holding, progress completion,
vote or publication is supported.

A bounded per-item journal preserves original command identities across uncertain acknowledgements and partial
success. Cancellation stops unstarted effects and retains acknowledged ones. Uploads, previews, reviews and results
expire after seven days; explicit pruning and the owned-graph erasure phase delete at most 100 child rows per step.
Evidence deletion does not undo acknowledged Library effects. Another account and terminal deletion deny reads,
review, apply and retry. Native entry, label and assignment commands own each admitted effect and its History.

The decoder remains an inert validation boundary; it stores no private artifact, command intent or result. Only the
installed owner-scoped private handlers expose decoded records. Public DTOs, Search, events and unredacted errors
must never receive them.

## Bounds and verification

The producer admits at most 100,000 records and 32 MiB of encoded records, with at most 120,000 record bytes per
page. The decoder checks upload bytes before text decoding or allocation of a parsed tree, checks depth before
JSON parsing and limits each encoded record to that producer page cap. Its 34 MiB upload bound includes the record
commas, manifest and limited formatting whitespace; excessive pretty-print whitespace may be refused. The owner
and exposure checks precede parsing; decoder limits run before any archive persistence. Validation is O(U+N), with
O(U+N) retained memory, and performs no database queries or native effects. This is source derivation, not an
executed growth pass.

Focused consumer scenarios use an actual installed export and cover explicit conflict resolution, preserved local
work, created and mapped labels, assignment review, stale revision/incarnation refusal, original native replay,
cancellation, owner denial and account erasure. Existing decoder and export tests continue to cover malformed,
incomplete, duplicate and unsupported evidence; no export assertion is removed.

Derived cost is `C_upload(U,N) + C_fixed-authority + C_identity-review(R) + C_native-effects(R,K) +
C_journal/cleanup`: upload reads at most U=34 MiB, validates O(U+N) with N≤100,000, and inserts one root plus a
bounded bulk child statement; each request performs fixed owner/admission checks; review does indexed per-item
current identity/profile and native fact reads for R≤20; apply delegates up to R≤20 effects to the entry, label and
assignment command owners (including nested History); journal writes address one `(route,account,upload,ordinal)`
row; preview/results inspect at most 101 indexed rows; prune and erasure delete at most 100 child rows per step.
These are source-derived bounds, not observed growth results. Performance review of unresolved composed bounds is
requested. Native64/512/4096 observations for upload, first/deep/terminal pages, selected apply, stale refusal,
original replay and cleanup remain deferred to integration; acceptance and broader native placement are also
controller responsibilities.

## Web ownership

Web323 retains the private export interface. Commerce has sent the exact mounted consumer methods and supported
coverage for an adjacent explicit import/recovery allocation. Web must adopt that contract before any UI completion
is claimed. The decoder does not change the export producer's interface.
