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

| Step    | Native                                                                              | Page                                                                                          |
| ------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Upload  | `POST :preview` `{ upload, scoreFormat? }` with quoted Idempotency-Key              | File stays local until submit; bytes drop after native ownership                              |
| Preview | `GET :importId?after=-1` pages of 20                                                | Current page only; titles assist display/search, never automatic identity                     |
| Review  | `POST :importId:review` `{ ordinal, subjectId?, skip?, fields, replace }`           | Default `replace:false`; only `status` is selectable; REPEATING stays unsupported             |
| Confirm | `POST :importId:apply` `{ confirmations: [{ ordinal, reviewId }] }` batches of 20   | Exact stored review ids; `complete:false` is resumable                                        |
| Stop    | `POST :importId:cancel` `{ remove:false }`                                          | Stops new admission; acknowledged effects remain                                              |
| Discard | `POST :importId:cancel` `{ remove:true }`                                           | Clears this upload's evidence now; Library facts stay                                         |

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

Bounds follow native caps: 1 MiB UTF-8, depth 24, 200 rows, 65,536 bytes/128 fields per row, 100-character
field names, 8,192-byte group metadata, five owner uploads and 20 rows per read/apply. Web retained work is
the upload during submission, the current response page without `rawUpload`, bounded per-row metadata for N
rows and exact uncertain-command operands.

## Cost

- Operation: personal AniList upload preview, paged read, per-row review, batched apply and cancel/remove.
- Touched neighbourhood: installed `libraryImports.anilist` methods, the mounted visit, current page evidence
  and N bounded row metadata. No client matching, parser or per-field native fan-out.
- Formula: `1 + K + M + Q + lifecycle + R` native calls for K returned pages, M reviewed rows, Q apply
  batches, cancel lifecycle calls and explicit retries R, with `M <= N`, `Q <= M`, page size `<= 20` and
  apply size `<= 20`. Full 20-row batches reduce Q to `ceil(M/20)`; single-row choices keep `Q = M`.
- Retained bound: `O(U + 20 × page-row bytes + N × metadata bytes)` with U the upload during submission only.
- Installed caps: `ANILIST_LIMITS` in `list-import-anilist-parser.ts` (1 MiB, 200 rows, depth 24, page/apply 20).
- Test reference: `apps/web/tests/personal-anilist-import.test.tsx` growth cases at 20/100/200 rows.
