# Personal Library archive review and merge

The [installed personal export](library-export.md) produces a completed local `{manifest,records}` file.
Its v1 manifest, section order and encoded-record limits are shared by the producer and the archive decoder;
there is no second archive schema. Export coverage and its integration evidence status remain unchanged.

## Delivered validation boundary

`services/kernel/src/library/library-archive.ts` exposes `decodeLibraryArchive(bytes: Uint8Array)`.
This is an internal, inert decoder, not an authenticated upload endpoint or a native merge command. There are
currently **no installed archive-consumer HTTP methods**. No UI completion or successful restoration is claimed.

Decision: accept completed v1 artifacts within 34 MiB and depth 32, reject duplicate rows and exact stored label
names, and keep expired capture timestamps as evidence rather than treating them as permission or file expiry.

Validation requires the producer's final manifest, all fourteen declared installed sections in producer order,
the global `rows` count and the sum of compact UTF-8 `JSON.stringify(record)` bytes in `recordBytes`. The format
does not declare per-section counts; the decoder computes them without inventing declarations. A missing final
manifest, missing section declaration or absent assignment label parent is incomplete, never explicitly empty.
Malformed envelopes, unsupported formats/versions, inconsistent counts, duplicate JSON keys, invalid Unicode,
unknown record sections, repeated native record identities and out-of-order sections are refused. Failures expose
only fixed codes, without raw JSON parser messages, archive values or private names.

The output preserves records and manifest omissions as private evidence. Every installed section reports its
computed count, `present` or `empty` capture, and one of these treatments:

| Sections | Treatment |
| --- | --- |
| entries, labels, assignments | `requires-explicit-mapping`; validation admits no native effect |
| sessions, units, history, holdings, collections, collectionPins, occurrences | `retained-unsupported` |
| bangumiUploads, bangumiEvidence, malImports, malEvidence | `retained-unsupported` |

Excluded trash, Commerce/financial evidence, publication output and unavailable sources remain the producer's
explicit omissions. Source observations, annotations, ratings and other absent sources gain no synthetic section,
empty count or successful restoration claim. Unsupported records retain inert evidence; their payloads receive
structural/identity checks, not a claim of native semantic admission.

Archived Subjects and references, accepting meanings and pins, revisions, incarnations, state text and label names
never establish current admission. In particular, unavailable old states remain readable; equal names do not map
labels, and archive IDs do not address the receiving account's private facts. The decoder has no account access,
does not fetch Subject URLs and does not install dates, revisions, receipts or pins.

## Remaining native journey

An authenticated owner must be able to upload once, inspect indexed private preview pages, resolve canonical
Subjects through current identity/profile rules, explicitly choose current state and label IDs or validated new
labels, review current conflicts and preserve local work by default. Selected effects must bind the reviewed
current incarnation/revision, canonical identity and operands, and revalidate through the installed native command
owners, including entry History. No replace-all, implicit label removal, inferred holding, progress completion,
vote or publication belongs to this journey.

A bounded per-item journal must preserve original command identities across uncertain acknowledgements and
partial success. Cancellation stops new effects while preserving acknowledged ones. Retained uploads, previews,
reviews and results need a fixed lifetime, indexed finite pruning and the existing owned-graph account-erasure
phase. Evidence deletion does not undo acknowledged Library effects. Another account and terminal deletion must
deny every read, review, apply and retry. These methods, storage, admission and effect composition remain pending.

The decoder is the preparatory boundary for this work; it stores no private artifact, command intent or result.
Only the eventual authenticated private handlers may expose decoded records. Public DTOs, Search, events and
unredacted errors must never receive them.

## Bounds and verification

The producer admits at most 100,000 records and 32 MiB of encoded records, with at most 120,000 record bytes per
page. The decoder checks upload bytes before text decoding or allocation of a parsed tree, checks depth before
JSON parsing and limits each encoded record to that producer page cap. Its 34 MiB upload bound includes the record
commas, manifest and limited formatting whitespace; excessive pretty-print whitespace may be refused. All bounds
are static and checked before a future native upload can be admitted. Validation is O(U+N), with O(U+N) retained
memory, and performs no database queries or native effects. This is source derivation, not an executed growth pass.

Focused decoder cases cover completed/empty sections, unavailable old vocabulary, wrong/incomplete format,
duplicates, required references, size/depth bounds and non-reflecting failures. The existing native export HTTP
scenario additionally decodes its actual assembled producer records, including retained unsupported sections.
No existing export assertion is removed. Broader native acceptance, current-state merge scenarios, physical upload
admission and the complete cost derivation remain pending. Performance must review unresolved composed bounds
before completion; native64/512/4096 growth must separately observe upload, page traversal, effects, replay,
stale refusal and cleanup.

## Web ownership

Web323 retains the private export interface. After the remaining native contract is installed, Commerce must send
Web the exact mounted consumer methods and supported coverage for an adjacent explicit import/recovery allocation.
Web must adopt that contract before any UI completion is claimed. The decoder neither changes the export producer's
interface nor promises a mounted re-import endpoint.
