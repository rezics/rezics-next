# Personal AniList collection import

Web owns this signed-in Library journey at `/library/import-anilist`. Commerce owns native preview, row reads,
review, apply, cancel, matching, JSON admission and retained evidence. This page binds those methods. It does
not parse the file in the browser, fetch an AniList account, refresh the catalogue, or write provider mappings.

Decision: keep the import identifier, native review ids and private row state in the mounted visit. They never
enter the URL, persistent browser storage, logs or public metadata. Viewer, CSRF-session or source replacement
retires rendered rows, late delivery and retry authority. Unmatched target search reuses the existing
authenticated subject picker; only the UUID submitted as `review.subjectId` is identity. Native review owns
`commandKey`, `clientId` and `requestedBy`; the page never supplies actor attribution or a new command identity.

## Native methods

Mounted under `/v1/libraryImports/anilist` after Commerce dependency `69b73c6a`. Web binds
`KernelClient.libraryImports.anilist` when present (`$preview`, page GET, `$review`, `$apply`, `$cancel`).
The generated client snapshot may lag the kernel source; missing methods render unavailable rather than a
local parser or successful fixture.

Decision: read the standard Rating question through its installed point method on visit entry and before each
score review; use the import page's supplied `currentScore` as the post-apply vote readback, with no parallel
per-row vote hydration.

| Step     | Native                                                                                                       | Page                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Upload   | `POST :preview` `{ upload, scoreFormat? }` with quoted Idempotency-Key                                       | File stays local until submit; bytes drop after native ownership                            |
| Preview  | `GET :importId?after=-1` pages of 20                                                                         | Current page only; titles assist display/search, never automatic identity                   |
| Question | `GET /v1/rating-questions/{standard-question-id}`                                                            | One current point read on visit entry, before a vote/clear review, and on refresh           |
| Review   | `POST :importId:review` `{ ordinal, subjectId?, skip?, fields, replace, score? }`                            | Status and native score choices are reviewed together; source score is never converted      |
| Confirm  | `POST :importId:apply` `{ confirmations: [{ ordinal, reviewId, confirmNativeVoteEffects? }] }` batches of 20 | Vote consent is separate and bound to the exact score review; `complete:false` is resumable |
| Readback | `GET :importId?after=...` owner page supplies each reviewed row's `currentScore`                             | Fresh owner observation after apply/refresh; not a command receipt                          |
| Source   | `POST /v1/libraryEntries/{subjectId}/sourceObservations` after apply                                         | Separate typed command; only after privacy and original-timestamp confirmation              |
| Stop     | `POST :importId:cancel` `{ remove:false }`                                                                   | Stops new admission; acknowledged effects remain                                            |
| Discard  | `POST :importId:cancel` `{ remove:true }`                                                                    | Clears this upload's evidence now; Library facts stay                                       |

Accepted shapes are a MediaList array, `{lists:[{entries:[]}]}`, `{MediaListCollection:…}` or
`{data:{MediaListCollection:…}}`. Deprecated `statusLists`/`customLists` wrappers are refused. Repeated
entries in groups remain independent review rows. `hasNextChunk:true` and wrapper/group evidence make this
the uploaded slice, never a complete-account claim. `mediaId`/`media.id` identify AniList media; entry `id`
never does. `media.idMal` is a separate MyAnimeList tuple. Scores need an explicit POINT_* declaration;
omission is unknown scale. Only unique released CURRENT/PLANNING/COMPLETED/DROPPED/PAUSED roles may apply.

Match states are matched, unmatched, ambiguous and unavailable as delivered. Apply outcomes are applied,
skipped, stale, unsupported and failed. Stale unstarted reviews refresh; started original work is inspected
or retried with its identity. Exact review id, fields, replace flag and key survive retry. Cancellation does
not roll back admitted rows.

Score review keeps the exact source score value, lexeme, declared scale, validity and reason. Owners choose
native units within the current question or explicitly clear; source zero means unrated and native zero is a
real vote. Keep is the default. Replacing a present own vote uses the existing explicit Replace choice.
Review observations and atomic write availability are distinct: an available review does not promise that
the guarded writer can apply, and the owner may return `atomic_guard_unavailable`. The page shows the supplied
score outcome independently from the state outcome and displays the owner's `currentScore` observation as
separate readback. A positive vote receipt does not replace readback; an unavailable vote effect does not
undo an acknowledged state effect. Exact Retry keeps the original confirmation and review/consent identity.

Bounds follow native caps: 1 MiB UTF-8, depth 24, 200 rows, 65,536 bytes/128 fields per row, 100-character
field names, 8,192-byte group metadata, five owner uploads and 20 rows per read/apply. Web retained work is
the upload during submission, the current response page without `rawUpload`, bounded per-row metadata for N
rows and exact uncertain-command operands.

## Native label adoption

The [label adoption owner](../../../../../docs/library-import-anilist-labels.md) defines the retained evidence and
immutable native review. The same page calls generated `:reviewLabels` and `:applyLabels` with separate label epochs,
exact review UUIDs and ordered source selections. Positive native evidence supplies checkbox choices; false and
unsupported representations remain visible evidence. Subject identity uses native match or explicit Subject choice.
A bounded owned-label search offers live label IDs, while explicit proposals preserve source text beside the normalized
native review. Confirmation never calls the state/score writer. Results show per-item label and assignment identities,
partial work and independent current assignments through the installed Subject assignment reader. Unknown delivery
keeps its original command and encrypted sender; a current read cannot release it.
The existing upload screen accepts an explicit retained import ID and calls the native page reader. The active
import ID stays visible for reopening; no retained-upload catalogue or browser evidence cache is added.

## Cost

- Operation: personal AniList upload preview, paged read, current-question point read, per-row review, owner
  current-vote readbacks, batched apply and cancel/remove.
- Touched neighbourhood: installed `libraryImports.anilist` methods, the mounted visit, current page evidence
  and N bounded row metadata. No client matching, parser or per-field native fan-out.
- Formula: `1 + K + M + Q + lifecycle + R + H + V`, where H counts explicit point reads of the current
  rating question and V counts owner-page current-vote reads for rows with score review. K is returned pages,
  M reviewed rows, Q apply batches, lifecycle counts cancel/remove and R counts explicit retries. `M <= N`,
  `Q <= M`, page size `<= 20` and apply size `<= 20`. Full 20-row batches reduce Q to `ceil(M/20)`;
  single-row choices keep `Q = M`. Source admission is a separate typed command after apply and is omitted
  from this import cost formula.

Decision: a missing AniList list-entry `id` uses the AniList media identifier from preview identifiers as the
provider record identity. Unix `createdAt`/`updatedAt` stay unknown. Confirm without the two source checkboxes
still applies the import; the confirmation page disables Confirm until both are checked.

- Label work adds L native reviews, A confirmations of at most 20 rows × 8 values, S explicit 20-label search
  pages and C explicit 32-assignment Subject reads. Native work prices all R×T decisions, bounded identity/name
  probes, up to four normalized creations per row, assignments, account/Subject preparation, source/label locks,
  receipts, History/export fences, serialization, exact retries and cancellation in the linked owner. No fetch-all
  label loop, page archive or second evidence store is retained.
- Retained bound: `O(U + 20 × page-row bytes + N × metadata bytes)` with U the upload during submission only.
- Installed caps: `ANILIST_LIMITS` in `list-import-anilist-parser.ts` (1 MiB, 200 rows, depth 24, page/apply 20).
- Test reference: `apps/web/tests/personal-anilist-import.test.tsx` growth cases at 20/100/200 rows.
