# Personal MyAnimeList import

Web owns this signed-in Library journey at `/library/import-mal`. Commerce owns native preview, review, apply,
cancel, delete, matching, XML parsing and retained evidence. This page binds those methods; it does not parse XML,
fetch catalogue entities in the browser, or merge this source with VNDB.

Decision: keep the upload identifier and private review state in the mounted visit. They never enter the URL,
persistent browser storage, logs or public metadata. Viewer, CSRF-session or source replacement retires rendered
rows, late delivery and retry authority.

## Native methods

Mounted under `/v1/libraryImports/mal` after Commerce dependency `029513f7`. Web binds
`KernelClient.libraryImports.mal` when present (`$preview`, page GET, `source`, `review`, `apply`, `cancel`,
DELETE). The generated client snapshot may lag the kernel source; missing methods render unavailable rather than a
local parser or successful fixture.

| Step    | Native                                                                 | Page                                                                               |
| ------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Upload  | `POST :preview` `{ xml }` with Idempotency-Key                         | File stays local until submit; bytes are dropped after the call                    |
| Preview | `GET :id?after=` pages of 20                                           | Current page only; titles assist display/search, never automatic identity          |
| Review  | `POST :id/review` `{ row, target, skip, replace }`                     | Unmatched rows may set an explicit subject; skip and replace are deliberate        |
| Confirm | `POST :id/apply` `{ confirm: true, rows: [{ row, version, fields }] }` | Only native-admitted `status` is selectable; other fields remain retained evidence |
| Stop    | `POST :id/cancel`                                                      | Stops future dispatch; acknowledged effects remain                                 |
| Discard | `DELETE :id`                                                           | Clears this upload's evidence now                                                  |

Anime uses `mal_anime` / `https://myanimelist.net/anime`; manga uses `mal_manga` / `https://myanimelist.net/manga`.
Match states are matched, already-matched, unmatched, unavailable and ambiguous as delivered. Skipped is a review
choice. Unreadable exports fail the preview (malformed, size or DTD/entity refusal) without a row list.

Score zero is no rating on the original 1–10 scale. Chapter and volume measures stay independent. Partial dates keep
their native precision; zero components stay unknown. Repeat totals, private comments, tags, privacy and source
timestamps are retained evidence. Neither a score nor a comment creates a vote or public review. Existing local facts
stay unless `replace` was reviewed.

Apply is not atomic. Partial outcomes are applied, skipped, stale, unsupported, failed and unattempted (remaining).
Unknown delivery retries the original command, credentials, key and operands. A stale row needs a visible refresh and
a new review version. Source timestamps are display only.

Bounds follow the native page `limits` and [personal MAL import](../../../docs/library-import-mal.md): 2 MiB XML,
4 MiB JSON wire, 500 rows, depth 16, 20-row pages and apply batches, 64 fields, three retained uploads, seven-day
lifetime. Native provider catalogue ingestion remains Imports-owned.
