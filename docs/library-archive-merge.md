# Personal Library archive review and merge

Collection archive recovery is owned by [Native Library archive Collection recovery](library-archive-collection-recovery.md).
The installed v1 export and its producer-side guarantees remain owned by [Library export](library-export.md).

The [installed personal export](library-export.md) produces a completed local `{manifest,records}` file.
Its V1, V2 and V3 manifest, section order and encoded-record limits are shared by the producer and archive decoder;
there is no second archive schema. Export coverage and its integration evidence status remain unchanged. V2/V3
personal fact recovery is specified in
[Personal archive annotation, journal and assessment recovery](library-archive-personal-fact-recovery.md).

## Delivered validation boundary

`services/kernel/src/library/library-archive.ts` exposes `decodeLibraryArchive(bytes: Uint8Array)`. The mounted
private consumer is `POST /v1/libraryArchiveMerges`, owner status `GET /:id`, indexed `GET /:id/preview` and
`GET /:id/results`, `PATCH /:id/review`, selected `POST /:id/apply`, cancellation `DELETE /:id`, and expired
evidence pruning `POST /:id/prune`. These methods do not change the producer's export interface or claim Web UI
completion.

Decision: accept completed V1, V2 and V3 artifacts with their exact installed manifests within 34 MiB and depth 32;
preserve the V1/V2 inventories, reject duplicate rows and exact stored label names, and keep expired capture timestamps
as evidence rather than treating them as permission or file expiry.
V3 keeps the exact V2 section order and adds journal assessment; V4's appended provider sections are refused as a whole
until their consumer coverage is explicitly installed.

Decision: retain one seven-day archive per account; cap preview/result pages and review/apply batches at 100/20;
replay uncertain effects with journaled native request keys and prune expired evidence in 100-row pages.

Validation requires the producer's final manifest, all version-declared installed sections in producer order, the
global `rows` count and the sum of compact UTF-8 `JSON.stringify(record)` bytes in `recordBytes`. V2/V3 section totals
are verified against the records. A missing final manifest, missing section declaration or absent assignment label
parent is incomplete, never explicitly empty.
Malformed envelopes, unsupported formats/versions, inconsistent counts, duplicate JSON keys, invalid Unicode,
unknown record sections, repeated native record identities and out-of-order sections are refused.
Journal reflection strings are the one retained Unicode exception: malformed text remains encoded evidence with an
explicit unsupported adoption reason under [personal fact recovery](library-archive-personal-fact-recovery.md). Failures expose
only fixed codes, without raw JSON parser messages, archive values or private names.

The output preserves records and manifest omissions as private evidence. Every installed section reports its
computed count, `present` or `empty` capture, and one of these treatments:

| Sections                                                                     | Treatment                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| entries, labels, assignments, annotations, journals                          | `requires-explicit-mapping`; validation admits no native effect |
| sessions, units, history, holdings, collections, collectionPins, occurrences | `retained-unsupported`                                          |
| bangumiUploads, bangumiEvidence, malImports, malEvidence, provenance         | `retained-unsupported`                                          |

Excluded trash, Commerce/financial evidence, publication output and unavailable sources remain the producer's
explicit omissions. V2 provenance remains evidence only; it cannot grant visibility or become an annotation.
Unsupported records retain inert evidence; their payloads receive structural/identity checks, not a claim of native
semantic admission.

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

V2/V3 annotation and journal rows use the same retained item, review epoch, cancellation and pruning lifecycle; V3
assessment is part of its exact journal evidence and supported-field review.
Supported fields, private visibility behavior, native setters, and exact per-item outcomes are owned by
[Personal archive annotation and journal recovery](library-archive-personal-fact-recovery.md).

Decision: confirm `{items:[{ordinal,reviewRevision}]}` from the exact private review. Every saved review,
even an identical refresh, increments `reviewRevision`; preview includes it (zero means unreviewed), and review
returns it with each ordinal/status. The revision addresses the owner's upload row and its canonical target/profile,
current incarnation/revisions, field choices and values. It is not authority on its own.

Apply rejects a stale or mixed selection with HTTP 409 before starting any item. Missing/foreign uploads return
404; expired evidence returns 404; cancelled selections with unstarted effects return 409. Duplicated ordinals,
missing revisions and out-of-range selections are invalid requests. Each item repeats the revision check before
receipt replay or native execution, closing a concurrent refresh race. A later concurrent change may leave already
accepted items intact; retry the original confirmation to recover their original receipts. Native target changes
continue to report per-item `current_conflict`/`unresolved` for Entry/label work and `stale` for personal fields.
A refresh cannot change an applying/acknowledged item. Those items keep their original key and canonical operands;
accepted receipts can be retried after cancellation, while expiry/pruning never undoes native effects.

The route producer declares the revised `KernelClient.libraryArchiveMerges` upload, preview, review and apply contract. Upload's declared body is
`string | {manifest: Record<string,unknown>, records: Record<string,unknown>[]}`. Original JSON text is sent unchanged;
ingress still preserves raw bytes and the
strict bounded decoder alone admits the artifact. Web's canonical archive consumer retains the existing
`/library/recover-archive` interface and all file/recovery ownership; it receives these generated methods, without
a handwritten client, proxy cast or alternate upload route.

The retained generated upload body is `unknown`; preview records and review results omit `reviewRevision`, and
`apply.post` still accepts `{ordinals: number[]}`. Existing upload/preview coverage in
`packages/client/tests/library-archive-merge.test.ts` preserves original JSON text and envelope operands. The complete
generated journey must additionally review selected changes and apply the exact returned revision, with type
assertions for upload and confirmation operands. Restore that journey together with refreshed declarations so the
consumer remains type-correct.
Decision: keep canonical Web file admission unavailable until generated declarations and the exact returned
review-revision handoff are installed together.
Client generation must preserve unrelated declarations, including label consolidation. Source-checked emission
precedes the full workspace compiler and construct checks; all checks still gate publication. The generated closure
also includes public client type exports that are independent of mounted routes. Installed client delivery and its
complete typed consumer proof continue in
[the generated transport continuation](../.temp/continuation/archive-client-installation.md).

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

For a complete caller, use `C_decode(U,N) + C_archive_operations + C_review_targets +
C_native_dispatches + C_serialization + C_cleanup`. Raw U≤34 MiB, compact evidence≤32 MiB, N≤100,000
and depth≤32 remain unchanged. Producer pages of 16 rows/120,000 record bytes do not bound consumer
preview/results: those read P+1≤101 complete retained items and return P≤100. Review/apply R≤20; annotation choices
are capped at two fields and journal choices at F≤4 (two dates, reflection and assessment). A selected page therefore
has at most 80 journal field choices; these explicit caps do not replace the nested owners' profile, Entry, Session or
History bounds.

For actual attempted calls, archive `operation()` invocations are bounded by
`2*n_upload + n_status + n_preview + n_results + 2*n_review + n_assignment_mapping +
n_apply + sum(R_apply) + sum(E_finished) + n_cancel + n_prune`.
The two upload operations surround its native upload runner; each review has a root/item read pass and a locked
CAS pass, plus an archive mapping lookup for each assignment target actually observed. Each apply adds one
whole-selection preflight, one begin per reached selection, and one acknowledgement/refusal per finished dispatch.
An already acknowledged item needs no new acknowledgement; an uncertain applying item dispatches its original
native key/operands and pays native preparation/receipt reads again. Count retries and consumed failed attempts
separately. Expired or cancelled early refusals may stop sooner; they never refund work already consumed.

Every archive operation independently charges fresh exposure admission, caller authorization, operational
transaction preparation, lifecycle/fence/authentication-epoch checks and its account observation. Its body adds
addressed upload/item queries and locks: preflight locks the upload and reads R full items; begin and each finish
lock/read both root and item, then persist the binding or outcome when needed. Review may evaluate 20 targets
concurrently; each target's identity time, Subject/profile and current Entry/annotation or Session/journal reads
are separate native terms, including repeated nested observations. Reported counts from the independent progress
journey (ten steps, twenty-one archive operations and nine Session reads before native costs) are not universal
constants for this Entry/label/annotation/journal caller.

Price every actual native dispatch, including receipt replay, rather than only distinct successful creations.
Include authorization/preparation/time, account/Subject currentness, locks, receipt lookups, trigger statements,
History/events, export-source fences, summaries and all participating pools/runners. Existing owners and payers
remain responsible; no allowance increases or blanket reservation is introduced.

Retained bytes include compact evidence, full canonical review/native operands, request keys and result JSON.
`readItem` obtains all four JSON payloads together even on preflight/replay: charge every actual acquisition and
its simultaneous driver/bind, parsing, canonicalization and response buffers, plus up to 20 concurrent target
observations. Charge UTF-8 bytes of complete serialized envelopes, including coverage, evidence, review,
revisions, results, escaping and punctuation, rather than `recordBytes` alone. Preview/results acquire P+1 full
items and serialize P; review/apply serialize their bounded selections/outcomes and exact native bindings.

Prune and owned-graph erasure select indexed keys and physically delete at most 100 child rows per step, including
all retained JSON/operands, triggers and bounded cascades. Charge the remaining-child probe and final root deletion
only after children are exhausted, plus fresh caller checks per step; native effects and their History/receipt
erasure remain separate owner terms. Seven-day expiry is eligibility, not proof of physical erasure. One retained
upload per owner bounds neither global uploads nor selected native histories. These are source-derived bounds,
not observed growth results. Performance review of unresolved composed bounds is
requested. Native64/512/4096 observations for upload, first/deep/terminal pages, selected apply, stale refusal,
original replay and cleanup remain deferred to integration; acceptance and broader native placement are also
controller responsibilities.

Decision: transport compatibility derives its maximum from mounted route limits and verifies that
`MAX_HTTP_BODY_LIMIT` admits the raw archive and base64 Collection envelope. Ordinary `DEFAULT_BODY_LIMIT`, release
`MAX_BODY_LIMIT`, per-route oversize rejection and ingress reservation release/reuse remain unchanged. Full shared
runtime acceptance belongs to the controller's complete Kernel suite; focused checks do not replace it.

## Web ownership

Web retains the private export interface. Commerce has sent the exact mounted consumer methods and supported
coverage for an adjacent explicit import/recovery allocation. Web must adopt that contract before any UI completion
is claimed. The decoder does not change the export producer's interface.
