# Personal MyAnimeList XML import

Commerce owns native semantics; Web owns presentation. This imports the signed-in person's uploaded anime or
manga export, with no live provider credentials or catalogue ingestion. Native methods require both
`library_entry:read` and `library_entry:update`, current account authority and the personal Library exposure.
All responses and retained evidence are private. No notes, XML or titles enter public Search, logs or errors.

Decision: use `mal_anime` and `mal_manga` external claims and explicit confirmation of a unique released state
role; profiles have no MAL-specific mappings, so every other field remains visible private evidence.
Identifiers also retain `https://myanimelist.net/anime` or `/manga`. Existing admitted external claims are the
only automatic identity authority (the existing Semantic batch-create retains native history custody); an absent producer yields unmatched rows, never an invented provider service.
Titles assist display/search only. The page exposes readable candidates, unmatched, unavailable, matched and
already-matched rows. External claims are unique, so there is no ambiguous automatic candidate set in this slice.
An unmatched row can be explicitly assigned any currently readable canonical subject; this never changes a claim.

| Source                                                                                 | Native proposal or visible retention                                                                           |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Watching/Reading, Completed, On-Hold, Dropped, Plan to Watch/Read (or codes 1/2/3/4/6) | Unique released role active/completed/paused/dropped/planned, explicitly confirmed as `status`                 |
| Score                                                                                  | Original integer 1–10 scale; zero means no rating. Retained; no native vote or aggregate admission             |
| Episodes, chapters and volumes                                                         | Independent original measures, including simultaneous manga counts; retained, no invented subjects or sessions |
| Comments, tags, repeat totals                                                          | Private note, original tags and count; retained, no public review, inferred label or dated repeat session      |
| Start/finish dates                                                                     | Year/month/day precision, all-zero unknown, invalid calendar dates marked invalid; no invented first day       |
| Privacy, source timestamps, other fields and export metadata                           | Retained privately; never a command clock or publication decision                                              |

Each field distinguishes missing, empty/unknown, invalid, zero and a value as applicable. `fields` preserves every
row leaf, `retained` explains fields without admission, and the original XML retains metadata and attributes.
The existing upload's explicit date review and journal adoption contract is in
[adopting imported consumption dates](library-import-consumption-dates.md).
Importing a status is an explicit native entry command; it does not infer holdings, entitlements or public content.
The native command's own effects, including its documented active-entry follow behavior, remain authoritative.

Mounted JSON methods (UUIDs below denote values returned by native HTTP):

```ts
POST /v1/libraryImports/mal:preview // Idempotency-Key: "upload-1"
{ xml: "<myanimelist><anime><series_animedb_id>1</series_animedb_id><series_title>A</series_title><my_status>Completed</my_status></anime></myanimelist>" }
// 200 { id: string }
GET /v1/libraryImports/mal/:id?after=0
// 200 { id, canceled: boolean, total: number, rows: MalPreviewRow[], sourcePath: string, next: number | null, limits }
// MalPreviewRow = MalRow & { target: string | null, candidates: {subjectId: string}[],
//   match: "matched" | "already-matched" | "unmatched" | "unavailable",
//   state: string | null, current: {state,revision,incarnationId} | null,
//   binding, source, review: MalReview | null, outcome: MalOutcome | null }
GET /v1/libraryImports/mal/:id/source // 200 { xml: string }; exact original, including export metadata
POST /v1/libraryImports/mal/:id/review // Idempotency-Key: "review-1"
{ row: 0, target: null, skip: false, replace: false } // null uses the admitted identifier
// 200 { id }; GET the page to inspect proposed state, retained fields and conflict before confirmation
POST /v1/libraryImports/mal/:id/apply
{ confirm: true, rows: [{ row: 0, version: "review-1", fields: ["status", "score"] }] }
// 200 { id, outcomes: [{row:0,status:"applied",applied:["status"],retained:["series_animedb_id","series_title"],reason:null}], remaining: [], stopped: false }
POST /v1/libraryImports/mal/:id/cancel // Idempotency-Key and {} body; 200 { id }
DELETE /v1/libraryImports/mal/:id // Idempotency-Key; 200 { id }
```

These are constructed typed transport examples, not execution evidence. Exact exported types are `MalRow`,
`MalPreviewRow`, `MalReview`, `MalApplyInput`, `MalOutcome` and the mounted route's inferred page result. A custom `target` resolves
an unmatched row. `skip:true` yields skipped; unsupported-only selections yield unsupported. Conflicts preserve
current facts unless `replace:true` was reviewed; replacement uses the captured revision and incarnation.
A changed identity, release or local revision yields stale/refresh-review, allowing a new review version.
Failed dispatches resume the immutable original native command; receipt replay cannot duplicate acknowledged effects.

Bounds: 4 MiB JSON wire body (413 beyond it), 2 MiB decoded XML UTF-8 (400 beyond it), 500 rows, depth 16, pages/apply batches of 20, 64 selected fields, 12 MiB retained evidence per upload, three retained uploads per
owner, seven-day readable lifetime. DTD/external entities, malformed roots/rows/IDs and duplicate IDs/fields fail
safely with source row ordinals and no source text. Expired uploads are reclaimed at the next upload; explicit
DELETE clears evidence now. The account erasure graph owns the entire evidence/review/intent document.
Cancellation stops new dispatch; an already-started native command may finish. Request cancellation/deadline
stops subsequent rows without undoing prior effects. Return outcomes and remaining rows drive partial resumption;
failed rows are retried with their original review/operands, never a fresh identity. Preview changes only private
import evidence; native facts change only after review and explicit field confirmation.

The signed-in Web journey is `/library/import-mal`, documented in
[personal MAL import](../apps/web/src/library/personal-mal-import.md). Library navigation adds that entry beside
existing creation and discovery links. Upload, preview, review, confirmation, partial results and discard stay in
the mounted visit: XML, comments and private rows never enter the URL or persistent browser storage. A replacement
upload deletes the previous native document first. Viewer or CSRF replacement retires retry authority. Web binds the
generated `libraryImports.mal` methods when present and otherwise shows unavailable; it does not parse XML or fork
native matching.

Decision: unmatched target search is display assistance through the existing authenticated subject suggestions; only
the explicit UUID submitted to `review.target` is identity.

Integration decision: MAL and Bangumi retain their separate native review guards, routes and erasure phases.
