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

Mounted under `/v1/libraryImports/bangumi` after Commerce dependency `fd3f1482`. Web binds the installed
`KernelClient.libraryImports.bangumi` methods (`$preview`, page GET, `$review`, `$apply`, `$cancel`, DELETE).
`$review` and `$apply` use the installed score types and methods; Web does not create a client-side native engine.

| Step     | Native                                                                                     | Page                                                                                     |
| -------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Upload   | `POST :preview` `{ upload }` with quoted Idempotency-Key                                   | File stays local until submit; bytes drop after native ownership                         |
| Preview  | `GET :uploadId?after=-1` pages of 10                                                       | Current page only; titles assist display/search, never automatic identity                |
| Review   | `POST :uploadId:review` `{ ordinal, target?, score? }`                                     | Target and native score choice are reviewed together; target IDs are explicit            |
| Tags     | `GET :uploadId/rows/:ordinal/tags?after=-1` pages of 32                                    | Original values and validity stay visible; only supported values can be mapped           |
| Labels   | `POST :uploadId:reviewLabels`, then `POST :uploadId:applyLabels`                           | Explicit label ID or deliberate new name, exact native review and separate confirmation  |
| Readback | `GET /v1/libraryLabelAssignments?subjectId=…&view=FULL&limit=32`                           | Fresh current assignments show actual label and assignment identities                    |
| Confirm  | `POST :uploadId:apply` `{ rows: [{ ordinal, reviewToken, state, skip, score }] }`, up to 5 | Default score action is `preserve`; set and clear repeat the choice with `consent: true` |
| Source   | `POST /v1/libraryEntries/{subjectId}/sourceObservations` after apply                       | Separate typed command; record id is `subject_id`; date-like failed parse is unsupported |
| Inspect  | `libraryEntries({ subjectId }).get(libraryFullQuery())` and, when supplied,                | One deliberate point read after an acknowledged effect; explicit Refresh can repeat it   |
|          | `subjects({ id }).ratings({ questionId }).vote.get()`                                      | Current facts stay distinct from apply receipts                                          |
| Stop     | `POST :uploadId:cancel`                                                                    | Stops new admission; acknowledged effects remain                                         |
| Discard  | `DELETE :uploadId`                                                                         | Clears this upload's evidence and reviews now; Library facts stay                        |

The envelope is `{ "format": "rezics.bangumi-collection.v1", "collections": [...] }`. It is a REZICS wrapper, not an
official Bangumi export. Types 1/2/3/4/6 are book/anime/music/game/live action. Collection types 1–5 map to unique
released planned/completed/active/paused/dropped roles. Score 0 is unrated on the original 1–10 scale. The source
score remains evidence unless a reviewed native action is selected. A supplied native question carries its meaning,
grain, revision and units; the UI never converts Bangumi's 1–10 value into native units. Preserve has no score effect.
Set and clear each require separate per-row native-vote consent at confirmation. The producer's `native.admission`
value `{ status: "reviewed", reason: "native_review_observed" }` is an observation, not successful admission. The
native Content guard may still return an unavailable cause; Web displays it while keeping any independently
acknowledged state outcome. `ep_status` and `vol_status` keep independent chapter/volume/episode meaning. Tags,
comments, notes, source privacy, `updated_at` and unknown fields stay private evidence.

Match states are matched, already_matched, unmatched, unavailable, chosen and ambiguous as delivered. Native provider
claims are unique, so automatic ambiguous candidates cannot currently arise; the page still renders that state if a
row returns it. Apply outcomes are applied, skipped, stale, unsupported and failed. Stale rows need a new review.
Exact token, target, state, revision and key survive retry. Cancellation does not roll back admitted rows.

Bounds follow native caps: 256 KiB UTF-8, 1–100 rows, 8 KiB source row, 32 KiB expanded evidence, depth 16, 10-row
reads and 5-row apply batches. Score review, choice and outcome caps are 71,680, 8,192 and 16,384 bytes per row. A
page is capped at `10 × (32,768 + 71,680 + 16,384) + 4,096` encoded bytes; an apply request is capped at 4,096 bytes.
Web retained work is the upload during submission, one native page, bounded per-row metadata for N rows and exact
uncertain-command operands. Evidence expires after seven days; the existing 24-hour recovery is linkage/receipt-only,
does not renew evidence or admit a new effect, and is owned by Commerce.

## Cost

- Operation: personal Bangumi upload preview, paged read, per-row review, batched apply, deliberate Entry/vote point
  reads, cancel and delete.
- Touched neighbourhood: installed `libraryImports.bangumi` methods, the mounted visit, current page evidence and
  N bounded row metadata. No client matching, parser or per-field native fan-out.
- Formula: `1 + K + M + Q + E + V + lifecycle + R` native calls for K returned pages, M reviewed rows, Q apply
  batches, E explicit Entry point reads, V explicit own-vote point reads, cancel/delete lifecycle calls and explicit
  retries R, with `M <= N`, `Q <= M`, page size `<= 10` and apply size `<= 5`. E and V are zero until the user
  inspects an acknowledged target; V is zero if the apply result supplies an acknowledged current own-vote value.
  No row background hydration or directory scan runs. Full 5-row batches reduce Q to `ceil(M/5)`; single-row choices
  keep `Q = M`. Source admission is a
  separate typed command after apply and is omitted from this import cost formula.
- Label work adds `Rr * (P + S + V + A + F) + X`,
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
- Test reference: `apps/web/tests/personal-bangumi-import.test.tsx` growth cases at 10/50/100 rows.

Decision: Bangumi score remains source evidence by default; only an exact review plus separate per-row consent can request a native set or clear, and results distinguish command receipts from supplied or deliberately read current Entry and own-vote facts.

## Remaining native acceptance

Web consumes the producer's score fields and renders unavailable and admitted score outcomes through the same result
component. The Content atomic vote authorization/write guard and its positive producer result are outside Web; full
positive producer/journey acceptance remains open until Content supplies that result. Browser, native and root
acceptance run after integration. Stories and authored fixtures demonstrate presentation only.

- Label adoption references: `apps/web/tests/personal-bangumi-label-adoption.test.tsx` and
  `services/kernel/test/library/list-import-bangumi-labels-web.test.ts`.
