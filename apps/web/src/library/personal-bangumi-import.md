# Personal Bangumi collection import

Web owns this signed-in Library journey at `/library/import-bangumi`. Commerce owns native preview, row reads,
review, apply, cancel, delete, matching, JSON admission and retained evidence. This page binds those methods. It
does not parse the file in the browser, fetch a Bangumi account, refresh the catalogue, or write provider mappings.

Decision: keep the upload identifier, review tokens and private row state in the mounted visit. They never enter the
URL, persistent browser storage, logs or public metadata. Viewer, CSRF-session or source replacement retires rendered
rows, late delivery and retry authority. Unmatched target search reuses the existing authenticated subject picker;
only the UUID submitted as `review.target` is identity.

Decision: the first retained tag read captures the existing encrypted private-entry credential envelope for this
mounted import session; label review and apply retries reuse the same envelope and exact command, while assignment
readback uses a fresh credential after current viewer/CSRF checks.

## Native methods

Mounted under `/v1/libraryImports/bangumi` after Commerce dependency `fd3f1482`. Web binds
`KernelClient.libraryImports.bangumi` when present (`$preview`, page GET, `$review`, `$apply`, `$cancel`, DELETE).
Missing methods render unavailable rather than a local parser or successful fixture.

| Step    | Native                                                                                  | Page                                                                                          |
| ------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Upload  | `POST :preview` `{ upload }` with quoted Idempotency-Key                                | File stays local until submit; bytes drop after native ownership                              |
| Preview | `GET :uploadId?after=-1` pages of 10                                                    | Current page only; titles assist display/search, never automatic identity                     |
| Review  | `POST :uploadId:review` `{ ordinal, target? }`                                          | Unmatched rows may set an explicit readable subject; titles never auto-match                  |
| Tags     | `GET :uploadId/rows/:ordinal/tags?after=-1` pages of 32                               | Original values and validity stay visible; only supported values can be mapped                |
| Labels   | `POST :uploadId:reviewLabels`, then `POST :uploadId:applyLabels`                      | Explicit label ID or deliberate new name, exact native review and separate confirmation      |
| Readback | `GET /v1/libraryLabelAssignments?subjectId=…&view=FULL&limit=32`                     | Fresh current assignments show actual label and assignment identities                        |
| Confirm | `POST :uploadId:apply` `{ rows: [{ ordinal, reviewToken, state, skip }] }` batches of 5 | Default `preserve`; `replace` authorizes the reviewed revision/incarnation, including absence |
| Source  | `POST /v1/libraryEntries/{subjectId}/sourceObservations` after apply                    | Separate typed command; record id is `subject_id`; date-like failed parse is unsupported      |
| Stop    | `POST :uploadId:cancel`                                                                 | Stops new admission; acknowledged effects remain                                              |
| Discard | `DELETE :uploadId`                                                                      | Clears this upload's evidence and reviews now; Library facts stay                             |

The envelope is `{ "format": "rezics.bangumi-collection.v1", "collections": [...] }`. It is a REZICS wrapper, not an
official Bangumi export. Types 1/2/3/4/6 are book/anime/music/game/live action. Collection types 1–5 map to unique
released planned/completed/active/paused/dropped roles. Score 0 is unrated on the original 1–10 scale. `ep_status`
and `vol_status` keep independent chapter/volume/episode meaning. Tags, comments, notes, source privacy, `updated_at`
and unknown fields stay private evidence.

Match states are matched, already_matched, unmatched, unavailable, chosen and ambiguous as delivered. Native provider
claims are unique, so automatic ambiguous candidates cannot currently arise; the page still renders that state if a
row returns it. Apply outcomes are applied, skipped, stale, unsupported and failed. Stale rows need a new review.
Exact token, target, state, revision and key survive retry. Cancellation does not roll back admitted rows.

Bounds follow native caps: 256 KiB UTF-8, 1–100 rows, 8 KiB source row, 32 KiB expanded evidence, depth 16, 10-row
reads and 5-row apply batches. Web retained work is the upload during submission, the current response page, bounded
per-row metadata for N rows and exact uncertain-command operands.

## Cost

- Operation: personal Bangumi upload preview, paged read, per-row review, batched apply, cancel and delete.
- Touched neighbourhood: installed `libraryImports.bangumi` methods, the mounted visit, current page evidence and
  N bounded row metadata. No client matching, parser or per-field native fan-out.
- Formula: upload calls remain `1 + K + M + Q + lifecycle + R`. Label work adds `Rr * (P + S + V + A + F) + X`,
  where `Rr` rows are opened for adoption, P is bounded 32-value tag-page reads, S is bounded owned-label searches,
  V is native label reviews, A is confirmations, F is current assignment readbacks and X is exact retries. The
  complete native label caller also includes addressed label/name probes, create/assign receipts, Subject/profile
  preparation, owner controls, upload locks, events/History, source fences, reservations and parent locks. Source
  admission is a separate typed command after state apply.

Decision: Confirm without the two source checkboxes still applies the import; the confirmation page disables Confirm
until both are checked. Date-like failed parses stay unsupported; non-date tokens stay unknown.

- Retained bound: `O(U + 10 × page-row bytes + N × metadata bytes)` with U the upload during submission only.
- Installed caps: `BANGUMI_LIMITS` in `list-import-bangumi-model.ts` (256 KiB, 100 rows, 8 KiB row, 32 KiB evidence,
  depth 16, page 10, apply 5).
- Test references: `apps/web/tests/personal-bangumi-import.test.tsx` growth cases and
  `apps/web/tests/personal-bangumi-label-adoption.test.tsx` label review/retry/readback; native composition is in
  `services/kernel/test/library/list-import-bangumi-labels-web.test.ts`.
